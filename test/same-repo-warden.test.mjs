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

test('warns on a same-repo recent session, with GENERIC worktree hint (no pc-wt)', () => {
  const repo = gitRepo();
  const projRoot = mkdtempSync(join(tmpdir(),'proj-'));
  const sess = join(projRoot, 'projA'); mkdirSync(sess);
  writeFileSync(join(sess,'other.jsonl'), JSON.stringify({ cwd: repo })+'\n'); // recent by default mtime
  const r = run('PreToolUse', { session_id:'me', cwd: repo }, { WARDEN_PROJECTS_ROOT: projRoot });
  rmSync(repo,{recursive:true,force:true}); rmSync(projRoot,{recursive:true,force:true});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /parallel warning/);
  assert.match(r.stdout, /git worktree add/);
  assert.doesNotMatch(r.stdout, /pc-wt/);
});

test('fail-open: not a git repo -> silent exit 0', () => {
  const notRepo = mkdtempSync(join(tmpdir(),'plain-'));
  const r = run('PreToolUse', { session_id:'me', cwd: notRepo }, {});
  rmSync(notRepo,{recursive:true,force:true});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});
