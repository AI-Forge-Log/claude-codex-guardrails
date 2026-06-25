#!/usr/bin/env node
/**
 * review-gate-autosync — toggle the codex plugin's "stop-review gate"
 * (config.stopReviewGate) automatically based on the current Codex quota.
 *
 * Background: the codex plugin's Stop review gate only reads config.stopReviewGate
 * from the per-workspace state.json; it does NOT look at quota on its own. When
 * quota is exhausted, the gate still runs the review -> the review fails ->
 * fail-closed blocks the session from stopping (it gets stuck every time). This
 * script flips the gate based on current quota: has quota = ON (the safety net is
 * in place), no quota = OFF (so it never blocks the session from stopping).
 *
 * Global: no allowlist anymore. The hook follows "the workspace of the current
 * session" — it derives the git top level from the hook stdin's cwd (falling back
 * to CLAUDE_PROJECT_DIR / process.cwd), reproducing the plugin's
 * resolveWorkspaceRoot, and only toggles that one project's gate. So opening a
 * session in any git project is managed automatically, with no registration.
 *
 * Design invariants:
 *  - Only touch the gate of "the current session's workspace"; never touch any
 *    other project's gate.
 *  - Cannot read quota -> treat as no quota -> gate OFF (fail-safe: never leave a
 *    gate that cannot run, blocking the session from stopping).
 *  - Any error/timeout -> exit 0, never emit a block, never interrupt the session
 *    (this script only flips the boolean in state.json; it never outputs
 *    decision:block. The thing that actually blocks stopping is the codex
 *    plugin's gate).
 *  - Does not depend on CLAUDE_PLUGIN_DATA (its meaning is uncertain inside the
 *    hook); the state path is reproduced via the plugin's own algorithm.
 *
 * FRAGILITY NOTE (honest): this hook depends on the codex plugin's internal
 * state.json shape AND on Codex's logs_*.sqlite layout. Neither has a public,
 * stable contract, so a plugin upgrade or a Codex version bump may break it. It
 * is pinned to the plugin version it was tested against; re-verify after upgrades.
 *
 * Usage:
 *   node review-gate-autosync.mjs SessionStart   # hook: sync, emit a systemMessage when it flips
 *   node review-gate-autosync.mjs Stop           # hook: silent side effect, never blocks stopping
 *   node review-gate-autosync.mjs                 # manual: print the gate state for the current dir's workspace (testing)
 *   options: --dry-run            compute but write nothing
 *            --force-quota=yes|no for testing, skip sqlite and assume has/no quota
 *            --cwd=<path>         for testing, skip stdin/process.cwd and pin the session dir
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// -- config -------------------------------------------------------------------
const HOME = os.homedir();
const PLUGIN_DATA_ROOT = process.env.CCG_PLUGIN_DATA_ROOT || path.join(HOME, ".claude", "plugins", "data", "codex-openai-codex");
const CODEX_HOME = path.join(HOME, ".codex");
// Global: no allowlist anymore; follow the current session workspace (see readSessionCwd/resolveWorkspaceRoot).
// A quota window with used_percent >= this value is considered "that window exhausted".
const EXHAUSTED_AT = 100;
const LOG_FILE = path.join(HOME, ".claude", "hooks", "review-gate-autosync.log");

// -- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const event = (argv.find((a) => !a.startsWith("-")) || "manual");
const dryRun = argv.includes("--dry-run");
const forceArg = argv.find((a) => a.startsWith("--force-quota="));
const forceQuota = forceArg ? forceArg.split("=")[1] : null; // "yes" | "no" | null
const cwdArg = argv.find((a) => a.startsWith("--cwd="));
const cwdOverride = cwdArg ? cwdArg.slice("--cwd=".length) : null; // testing: skip stdin/process.cwd

// -- state file path (exactly reproduce the codex plugin state.mjs slug+hash) --
function stateFileFor(workspaceRoot) {
  let canon = workspaceRoot;
  try { canon = fs.realpathSync.native(workspaceRoot); } catch { /* path missing -> use the original value */ }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  return path.join(PLUGIN_DATA_ROOT, "state", `${slug}-${hash}`, "state.json");
}

// -- current session workspace (git top level, reproduce plugin resolveWorkspaceRoot) --
function readSessionCwd() {
  if (cwdOverride) return cwdOverride;
  // Real hook context: stdin is a pipe (non-TTY) -> read the payload's cwd; an
  // interactive terminal (TTY) is not read, to avoid blocking.
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(0, "utf8").trim();
      if (raw) input = JSON.parse(raw);
    } catch { /* read/parse failed -> fall back */ }
  }
  return input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveWorkspaceRoot(cwd) {
  // Reproduce plugin lib/workspace.mjs: git top level; on failure/non-git, fall back to the bare cwd (same as the plugin).
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 4000 });
    if (r.status === 0) {
      const top = r.stdout.trim();
      if (top) return top;
    }
  } catch { /* git missing/timeout -> fall back */ }
  return cwd;
}

// -- read Codex quota ---------------------------------------------------------
function resolveCodexDbPath(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    if (!/^logs_\d+\.sqlite$/.test(n)) continue;
    const full = path.join(dir, n);
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { path: full, mtime };
  }
  return best ? best.path : null;
}

// Pull the rate-limit fields out of a logged Codex "codex.rate_limits" event body.
// Real shape (siblings inside the `rate_limits` object):
//   { allowed, limit_reached, primary:{used_percent,...}, secondary:{used_percent,...} }
// `allowed` / `limit_reached` are authoritative and DECOUPLED from the percentages:
// Codex can report allowed:false / limit_reached:true (credits drained, or an
// additional/code-review limit) while primary/secondary used_percent still look fine.
function extractRateLimits(body) {
  for (const text of [body, body.replace(/\\"/g, '"')]) {
    const p = text.match(/"primary"\s*:\s*(\{[^{}]*\})/);
    const s = text.match(/"secondary"\s*:\s*(\{[^{}]*\})/);
    if (p && s) {
      try {
        const primary = JSON.parse(p[1]);
        const secondary = JSON.parse(s[1]);
        if (primary && typeof primary === "object" && secondary && typeof secondary === "object") {
          const result = { primary, secondary };
          const a = text.match(/"allowed"\s*:\s*(true|false)/);
          if (a) result.allowed = a[1] === "true";
          const lr = text.match(/"limit_reached"\s*:\s*(true|false)/);
          if (lr) result.limit_reached = lr[1] === "true";
          return result;
        }
      } catch { /* try the next interpretation */ }
    }
  }
  return null;
}

const pct = (w) => (w && typeof w === "object" && typeof w.used_percent === "number" ? w.used_percent : null);

/**
 * Pure quota decision, separated from sqlite I/O so it can be unit-tested.
 * FAIL-SAFE direction: when in doubt, return false (no quota -> gate OFF -> the
 * gate can never be left ON with no quota, which would trap the session on Stop).
 *
 * @param {{ allowed?: boolean, limit_reached?: boolean, primary?: object, secondary?: object } | null | undefined} rateLimits
 * @returns {boolean} true only when Codex is allowed AND no window is exhausted.
 */
export function decideHasQuota(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return false;
  // Honor Codex's explicit not-allowed / limit-reached signals first. These can be
  // set for reasons (credits, additional/code-review limits) that the primary/
  // secondary percentages do NOT reflect, so they override the percentage check.
  if (rateLimits.allowed === false) return false;
  if (rateLimits.limit_reached === true) return false;
  const p = pct(rateLimits.primary);
  const s = pct(rateLimits.secondary);
  const known = [p, s].filter((v) => typeof v === "number");
  if (known.length === 0) return false; // no readable percentage -> fail-safe -> no quota
  return known.every((v) => v < EXHAUSTED_AT);
}

/**
 * @returns {{ readable: boolean, hasQuota: boolean, primary: number|null, secondary: number|null, detail: string }}
 */
function readQuota() {
  if (forceQuota === "yes") return { readable: true, hasQuota: true, primary: 0, secondary: 0, detail: "forced yes" };
  if (forceQuota === "no") return { readable: true, hasQuota: false, primary: 100, secondary: 100, detail: "forced no" };

  const dbPath = resolveCodexDbPath(CODEX_HOME);
  if (!dbPath) return { readable: false, hasQuota: false, primary: null, secondary: null, detail: "no logs_*.sqlite" };

  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT feedback_log_body AS body FROM logs
       WHERE feedback_log_body LIKE '%used_percent%' AND feedback_log_body LIKE '%reset_at%'
       ORDER BY id DESC LIMIT 25`,
    ).all();
    for (const r of rows) {
      if (typeof r.body !== "string") continue;
      const w = extractRateLimits(r.body);
      if (!w) continue;
      const p = pct(w.primary);
      const s = pct(w.secondary);
      const known = [p, s].filter((v) => typeof v === "number");
      if (known.length === 0) continue;
      const hasQuota = decideHasQuota(w);
      const flags = `allowed=${w.allowed ?? "?"} limit_reached=${w.limit_reached ?? "?"}`;
      return { readable: true, hasQuota, primary: p, secondary: s, detail: `primary=${p} secondary=${s} ${flags}` };
    }
    return { readable: false, hasQuota: false, primary: null, secondary: null, detail: "no rate-limit row found" };
  } catch (e) {
    return { readable: false, hasQuota: false, primary: null, secondary: null, detail: `read error: ${e.message}` };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// -- flip the gate ------------------------------------------------------------
function readGate(stateFile) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { exists: true, value: Boolean(j.config?.stopReviewGate), state: j };
  } catch {
    return { exists: false, value: false, state: null };
  }
}

function writeGate(stateFile, desired, existing) {
  // Preserve version / jobs; only change config.stopReviewGate. Atomic write (temp file + rename).
  const next = existing && typeof existing === "object"
    ? { ...existing, config: { ...(existing.config ?? {}), stopReviewGate: desired } }
    : { version: 1, config: { stopReviewGate: desired }, jobs: [] };
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, stateFile);
}

function syncWorkspace(workspaceRoot, desired) {
  const stateFile = stateFileFor(workspaceRoot);
  const cur = readGate(stateFile);
  // File missing AND target = OFF: no need to create the file (default is already OFF).
  if (!cur.exists && desired === false) {
    return { workspaceRoot, stateFile, before: false, after: false, changed: false, skippedCreate: true };
  }
  if (cur.value === desired) {
    return { workspaceRoot, stateFile, before: cur.value, after: cur.value, changed: false };
  }
  if (!dryRun) writeGate(stateFile, desired, cur.state);
  return { workspaceRoot, stateFile, before: cur.value, after: desired, changed: true };
}

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${event}] ${line}\n`, "utf8");
  } catch { /* logging failure must not affect the main flow */ }
}

// -- main flow ----------------------------------------------------------------
function main() {
  const sessionCwd = readSessionCwd();
  const workspaceRoot = resolveWorkspaceRoot(sessionCwd);
  // No workspace (extremely rare) -> do nothing, silently allow.
  if (!workspaceRoot) {
    log(`no workspace (cwd=${sessionCwd}); skip`);
    return;
  }
  const stateFile = stateFileFor(workspaceRoot);

  // Stop fast path: if this workspace's gate is not ON, there is nothing to turn
  // off -> exit silently without scanning sqlite (avoid a wasted scan every turn).
  // (SessionStart still reads quota every time, because it is also responsible
  // for "turning the gate back ON when quota recovers".)
  if (event === "Stop") {
    if (readGate(stateFile).value !== true) return;
  }

  const quota = readQuota();
  const desired = quota.hasQuota; // has quota = gate ON (safety net); no quota / unreadable = gate OFF
  const r = syncWorkspace(workspaceRoot, desired);

  log(`ws=${path.basename(workspaceRoot)} hasQuota=${quota.hasQuota} readable=${quota.readable} ${quota.detail}; ` +
      `desired=${desired}; ${r.changed ? `${r.before}->${r.after}` : "none"}${dryRun ? " (dry-run)" : ""}`);

  if (event === "manual") {
    // Human-readable mode: print the state, do not emit hook JSON.
    process.stdout.write(
      `Workspace: ${workspaceRoot}\n` +
      `Codex quota: ${quota.readable ? `readable (${quota.detail})` : `unreadable (${quota.detail})`}\n` +
      `Verdict: ${quota.hasQuota ? "has quota -> gate ON" : "no quota -> gate OFF"}\n` +
      `  gate: ${r.before} -> ${r.after}${r.changed ? " (changed)" : ""}${r.skippedCreate ? " (no file, default OFF, skipped)" : ""}${dryRun ? " [dry-run]" : ""}\n`,
    );
    return;
  }

  if (event === "SessionStart") {
    if (r.changed) {
      const msg = desired
        ? "✅ Codex quota recovered — the stop-review gate is re-enabled (Codex reviews changes before the session can stop)."
        : "⚠️ Codex quota exhausted — the stop-review gate is disabled so it won't block this session from stopping; it re-enables next session once quota recovers.";
      process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true, systemMessage: msg })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
    }
    return;
  }

  // Stop and others: pure side effect, silently allow.
  // (empty stdout + exit 0 = allow stopping)
}

// Only run the hook when invoked directly as a CLI. Importing this module (e.g.
// from unit tests, to exercise decideHasQuota) must NOT run main()/process.exit().
// pathToFileURL normalizes both sides on Windows and POSIX (same fix as leakguard).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    // Never interrupt the session: swallow any error, log it, exit 0.
    log(`FATAL ${e && e.stack ? e.stack : e}`);
  }
  process.exit(0);
}
