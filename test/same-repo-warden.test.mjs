import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/same-repo-warden.mjs', import.meta.url));
function gitRepo() { const d = mkdtempSync(join(tmpdir(),'wr-')); execSync('git init -q',{cwd:d}); return d; }
function run(event, payload, env) {
  return spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(payload), encoding:'utf8', env:{...process.env, ...env} });
}

test('warns on a same-repo recent session, with a generic worktree hint', () => {
  const repo = gitRepo();
  const projRoot = mkdtempSync(join(tmpdir(),'proj-'));
  const sess = join(projRoot, 'projA'); mkdirSync(sess);
  writeFileSync(join(sess,'other.jsonl'), JSON.stringify({ cwd: repo })+'\n'); // recent by default mtime
  const r = run('PreToolUse', { session_id:'me', cwd: repo }, { WARDEN_PROJECTS_ROOT: projRoot });
  rmSync(repo,{recursive:true,force:true}); rmSync(projRoot,{recursive:true,force:true});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /parallel warning/);
  assert.match(r.stdout, /git worktree add/);
  // PreToolUse output must carry the warning via the event-specific channel
  // (Claude Code reads hookSpecificOutput.additionalContext for PreToolUse),
  // and stay non-blocking (no permissionDecision).
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /parallel warning/);
  assert.match(out.systemMessage, /parallel warning/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});

test('fail-open: not a git repo -> silent exit 0', () => {
  const notRepo = mkdtempSync(join(tmpdir(),'plain-'));
  const r = run('PreToolUse', { session_id:'me', cwd: notRepo }, {});
  rmSync(notRepo,{recursive:true,force:true});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

// A nested git repo (or submodule) UNDER my repo root is its OWN working tree:
// its `git rev-parse --show-toplevel` differs from mine, so a session sitting in
// it must NOT count as a same-repo collision. The old raw-prefix comparison
// (other cwd startsWith myTop + '/') spuriously matched it; the fix compares the
// candidate's RESOLVED git toplevel against mine for equality.
test('no false positive: a session in a nested git repo under my root does not warn', () => {
  const outer = gitRepo();
  const nested = join(outer, 'vendor', 'lib');
  mkdirSync(nested, { recursive: true });
  execSync('git init -q', { cwd: nested }); // independent inner working tree
  const projRoot = mkdtempSync(join(tmpdir(),'proj-'));
  const sess = join(projRoot, 'projN'); mkdirSync(sess);
  // The other session lives in the nested repo (string-prefixed by outer, but a different git root).
  writeFileSync(join(sess,'other.jsonl'), JSON.stringify({ cwd: nested })+'\n');
  const r = run('PreToolUse', { session_id:'me', cwd: outer }, { WARDEN_PROJECTS_ROOT: projRoot });
  rmSync(outer,{recursive:true,force:true}); rmSync(projRoot,{recursive:true,force:true});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), ''); // resolved toplevels differ -> no warning
});

// Portability note: a junction/symlink alias of the SAME checkout (which the raw-
// prefix logic also MISSED) would now be caught because both resolve to the same
// git toplevel. That scenario isn't portably constructed on Windows without
// elevated/junction support, so it's covered by the equality logic above rather
// than a dedicated symlink fixture.
