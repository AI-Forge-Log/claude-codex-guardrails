#!/usr/bin/env node
// same-repo-warden.mjs
// Same-repo collision warden: when another "recently still-alive" Claude
// session shares the same git working tree (same `git rev-parse --show-toplevel`)
// as this session, emit a single non-blocking warning.
//
// DESIGN RED LINE -- FAIL OPEN:
//   Any error / uncertainty / not in a git repo -> silent exit(0), allow.
//   Only an *exactly confirmed* same-repo active session emits a systemMessage.
//   This script NEVER outputs permissionDecision:"deny" and NEVER exits with 2,
//   so it can never block any operation.
//
// Usage (invoked by settings.json hooks; event name is argv[2]):
//   node hooks/same-repo-warden.mjs SessionStart
//   node hooks/same-repo-warden.mjs PreToolUse
//
// Optional env vars (mainly for tests):
//   WARDEN_PROJECTS_ROOT  override the ~/.claude/projects scan root
//   WARDEN_WINDOW_MIN     "recently active" window in minutes (default 10)

import { readFileSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const EVENT = process.argv[2] || 'PreToolUse';

function ok() { process.exit(0); }

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function gitToplevel(cwd) {
  if (!cwd) return null;
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 4000,
    });
    const t = (out || '').trim();
    return t || null;
  } catch {
    return null;
  }
}

// Normalize a path for cross-case / cross-slash comparison.
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Read only a small tail of the file, scanning backwards for the last JSONL
// record carrying a cwd (a session may cd mid-run).
function tailCwd(file, maxBytes = 65536) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const txt = buf.toString('utf8');
    const lines = txt.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
      } catch { /* tail chunk may cut a line in half; skip and keep scanning back */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

function hhmm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function main() {
  let hook = {};
  try { hook = JSON.parse(readStdin() || '{}'); } catch { hook = {}; }

  const mySid = String(hook.session_id || '');
  const myCwd = hook.cwd || process.cwd();

  const myTop = gitToplevel(myCwd);
  if (!myTop) return ok();                 // not in a git repo -> nothing to collide with, stay quiet

  const normTop = norm(myTop);

  const projRoot = process.env.WARDEN_PROJECTS_ROOT || join(homedir(), '.claude', 'projects');
  const windowMin = Number(process.env.WARDEN_WINDOW_MIN || 10);
  const cutoff = Date.now() - windowMin * 60 * 1000;

  let projDirs;
  try { projDirs = readdirSync(projRoot); } catch { return ok(); }

  const others = [];
  for (const d of projDirs) {
    const dir = join(projRoot, d);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, '');
      if (mySid && sid === mySid) continue;          // exclude self
      const full = join(dir, f);
      let m;
      try { m = statSync(full); } catch { continue; }
      if (m.mtimeMs < cutoff) continue;              // not "recently active" -> skip
      const ocwd = tailCwd(full);
      if (!ocwd) continue;
      // Same working-tree test: resolve the OTHER session's own git toplevel and
      // compare it to mine for equality. Raw-prefix comparison was wrong both ways:
      //   - an alias of the same checkout (junction/symlink/subst) does NOT prefix
      //     myTop -> a real collision was MISSED;
      //   - a nested git repo / submodule UNDER my root DOES prefix myTop -> a
      //     spurious warning even though its toplevel differs.
      // FAIL-OPEN: if the candidate's git root can't be resolved (not a repo, gone,
      // git error), skip it silently — the warden must never block or error.
      const otop = gitToplevel(ocwd);
      if (!otop) continue;
      if (norm(otop) === normTop) {
        others.push({ id: sid.slice(0, 8), at: m.mtime });
      }
    }
  }

  if (others.length === 0) return ok();

  others.sort((a, b) => b.at - a.at);
  const who = others.map((o) => `${o.id}(${hhmm(o.at)})`).join(', ');
  const repo = myTop.split(/[\\/]/).filter(Boolean).pop() || myTop;

  const fix = "To run in parallel -> 'git worktree add ../<dir> -b feat/<slug>' for an isolated checkout, or make one side read-only review (no writes).";

  const msg = `⚠️ Same-repo parallel warning: ${others.length} other recently-active Claude session(s) are also in repo "${repo}" (${who}). `
    + `Two sessions writing the same repo at once corrupt shared git state (index/HEAD/branch). ${fix}`;

  if (EVENT === 'SessionStart') {
    // SessionStart: inject into context (so the assistant can see and relay it)
    // and also surface as a systemMessage to the user.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
      systemMessage: msg,
    }));
  } else {
    // PreToolUse etc.: only a systemMessage, no permissionDecision -> allow + show the warning.
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
  }
  return ok();
}

try { main(); } catch { ok(); }   // backstop: any leaked exception also fails open
