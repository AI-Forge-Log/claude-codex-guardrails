import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
