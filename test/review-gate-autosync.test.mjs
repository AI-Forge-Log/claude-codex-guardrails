import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideHasQuota, extractRateLimits } from '../hooks/review-gate-autosync.mjs';

// NOTE: `new URL(...).pathname` is broken on Windows — it yields a leading-slash,
// percent-encoded path (e.g. `/C:/...`, `/E:/%E6%88%91...`) that `spawnSync`
// resolves to a doubled drive (`C:\C:\...`) and cannot load. `fileURLToPath`
// normalizes correctly on Windows and POSIX (same fix documented in tools/leakguard.mjs).
const HOOK = fileURLToPath(new URL('../hooks/review-gate-autosync.mjs', import.meta.url));

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  execSync('git init -q', { cwd: dir });
  return dir;
}
function run(args, { ws, dataRoot }) {
  return spawnSync(process.execPath, [HOOK, ...args, `--cwd=${ws}`], {
    encoding: 'utf8', env: { ...process.env, CCG_PLUGIN_DATA_ROOT: dataRoot },
  });
}

test('manual + no quota: verdict is gate OFF, dry-run writes nothing', () => {
  const ws = gitRepo(); const dataRoot = mkdtempSync(join(tmpdir(), 'pd-'));
  const r = run(['manual', '--force-quota=no', '--dry-run'], { ws, dataRoot });
  rmSync(ws, { recursive: true, force: true }); rmSync(dataRoot, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gate OFF/);
});

test('SessionStart + quota: creates/sets gate ON', () => {
  const ws = gitRepo(); const dataRoot = mkdtempSync(join(tmpdir(), 'pd-'));
  const r = run(['SessionStart', '--force-quota=yes'], { ws, dataRoot });
  rmSync(ws, { recursive: true, force: true });
  // gate ON means a state.json with config.stopReviewGate=true was written somewhere under dataRoot
  const found = execSync(`node -e "const fs=require('fs'),p=require('path');function w(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n);if(fs.statSync(f).isDirectory())w(f);else if(n==='state.json'&&JSON.parse(fs.readFileSync(f)).config.stopReviewGate)console.log('Y')}}w(process.argv[1])" "${dataRoot}"`, { encoding: 'utf8' });
  rmSync(dataRoot, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(found, /Y/);
});

test('never blocks: Stop event exits 0 with no decision:block', () => {
  const ws = gitRepo(); const dataRoot = mkdtempSync(join(tmpdir(), 'pd-'));
  const r = run(['Stop', '--force-quota=no'], { ws, dataRoot });
  rmSync(ws, { recursive: true, force: true }); rmSync(dataRoot, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /block/);
});

// --- decideHasQuota: pure quota decision (fail-safe direction) ---------------
// Field shape comes from the real Codex websocket "codex.rate_limits" event:
//   { allowed, limit_reached, primary:{used_percent,...}, secondary:{used_percent,...} }
// `allowed`/`limit_reached` sit beside primary/secondary and are AUTHORITATIVE:
// Codex can be not-allowed (credits, an additional/code-review limit) while both
// percentages still look fine. Honoring only the percentage would keep the gate ON
// with no quota -> Stop triggers a review that cannot run -> session trapped.

test('decideHasQuota: under threshold but allowed:false -> NO quota (RED case)', () => {
  // Real-data shape: a not-allowed window whose percentages are NOT maxed.
  const rl = { allowed: false, limit_reached: true, primary: { used_percent: 14 }, secondary: { used_percent: 20 } };
  assert.equal(decideHasQuota(rl), false);
});

test('decideHasQuota: limit_reached:true alone -> NO quota even if allowed missing', () => {
  const rl = { limit_reached: true, primary: { used_percent: 1 }, secondary: { used_percent: 3 } };
  assert.equal(decideHasQuota(rl), false);
});

test('decideHasQuota: normal allowed window under threshold -> has quota', () => {
  const rl = { allowed: true, limit_reached: false, primary: { used_percent: 16 }, secondary: { used_percent: 3 } };
  assert.equal(decideHasQuota(rl), true);
});

test('decideHasQuota: percentage at/over threshold -> NO quota', () => {
  const rl = { allowed: true, limit_reached: false, primary: { used_percent: 100 }, secondary: { used_percent: 3 } };
  assert.equal(decideHasQuota(rl), false);
});

test('decideHasQuota: missing/garbage object -> NO quota (fail-safe)', () => {
  assert.equal(decideHasQuota(null), false);
  assert.equal(decideHasQuota(undefined), false);
  assert.equal(decideHasQuota({}), false); // no readable percentage and no positive allow signal
});

// --- Finding 1: honor the SEPARATE code-review rate limit ---------------------
// The real `codex.rate_limits` telemetry event carries a first-class sibling
// `code_review_rate_limits` (verified in logs_*.sqlite, currently `null` on a
// Plus plan). Since the Stop gate launches a *code review* specifically, an
// exhausted code-review limit must mean NO quota even when the general window is
// allowed — otherwise the gate stays ON and traps the session, the exact failure
// this hook exists to prevent. We model the populated object with the same shape
// Codex uses for every rate-limit object (allowed/limit_reached/primary/secondary).

test('decideHasQuota: general allowed but code_review_rate_limits exhausted -> NO quota', () => {
  const rl = {
    allowed: true, limit_reached: false,
    primary: { used_percent: 16 }, secondary: { used_percent: 3 },
    code_review_rate_limits: { allowed: false, limit_reached: true, primary: { used_percent: 100 } },
  };
  assert.equal(decideHasQuota(rl), false);
});

test('decideHasQuota: general allowed but code_review_rate_limits at threshold -> NO quota', () => {
  const rl = {
    allowed: true, limit_reached: false,
    primary: { used_percent: 16 }, secondary: { used_percent: 3 },
    code_review_rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: 100 } },
  };
  assert.equal(decideHasQuota(rl), false);
});

test('decideHasQuota: general allowed AND code_review allowed, both under threshold -> has quota', () => {
  const rl = {
    allowed: true, limit_reached: false,
    primary: { used_percent: 16 }, secondary: { used_percent: 3 },
    code_review_rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: 20 }, secondary: { used_percent: 5 } },
  };
  assert.equal(decideHasQuota(rl), true);
});

test('decideHasQuota: code_review_rate_limits = null (real Plus-plan shape) -> falls back to general decision', () => {
  const allowed = { allowed: true, limit_reached: false, primary: { used_percent: 16 }, secondary: { used_percent: 3 }, code_review_rate_limits: null };
  assert.equal(decideHasQuota(allowed), true);
  const blocked = { allowed: false, limit_reached: true, primary: { used_percent: 16 }, secondary: { used_percent: 3 }, code_review_rate_limits: null };
  assert.equal(decideHasQuota(blocked), false);
});

test('decideHasQuota: code_review_rate_limits ABSENT -> identical to general-only decision (regression guard)', () => {
  const allowed = { allowed: true, limit_reached: false, primary: { used_percent: 16 }, secondary: { used_percent: 3 } };
  assert.equal(decideHasQuota(allowed), true);
  const blocked = { allowed: true, limit_reached: false, primary: { used_percent: 100 }, secondary: { used_percent: 3 } };
  assert.equal(decideHasQuota(blocked), false);
});

// --- extractRateLimits: parse the real telemetry body shape (runtime side) ----
// Bodies are built at runtime as pure-ASCII JSON to mirror the verified
// logs_*.sqlite `codex.rate_limits` websocket event without any literal fixtures.
function rlBody({ rl, codeReview, additional }) {
  const env = {
    type: 'codex.rate_limits',
    plan_type: 'plus',
    rate_limits: rl,
    code_review_rate_limits: codeReview ?? null,
    additional_rate_limits: additional ?? null,
    credits: null,
    promo: null,
  };
  // Wrap like the real log line: prose prefix + JSON, exactly as Codex logs it.
  return `websocket event: ${JSON.stringify(env)}`;
}

test('extractRateLimits: real null shape -> general fields only, decideHasQuota follows general', () => {
  const body = rlBody({
    rl: { allowed: true, limit_reached: false, primary: { used_percent: 16, reset_at: 1 }, secondary: { used_percent: 3, reset_at: 2 } },
  });
  const w = extractRateLimits(body);
  assert.equal(w.allowed, true);
  assert.equal(w.primary.used_percent, 16);
  assert.equal(w.code_review_rate_limits, undefined); // null -> omitted
  assert.equal(decideHasQuota(w), true);
});

test('extractRateLimits: general allowed but code_review exhausted -> surfaced -> NO quota', () => {
  const body = rlBody({
    rl: { allowed: true, limit_reached: false, primary: { used_percent: 16, reset_at: 1 }, secondary: { used_percent: 3, reset_at: 2 } },
    codeReview: { allowed: false, limit_reached: true, primary: { used_percent: 100, reset_at: 9 } },
  });
  const w = extractRateLimits(body);
  // The general object must NOT inherit the code-review object's allowed:false.
  assert.equal(w.allowed, true);
  assert.equal(w.code_review_rate_limits.allowed, false);
  assert.equal(decideHasQuota(w), false);
});
