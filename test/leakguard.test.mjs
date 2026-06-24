import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDir } from '../tools/leakguard.mjs';

// Forbidden patterns are built at RUNTIME so this committed test source
// contains NONE of them literally (leak-guard scans test/ too).
const BS = String.fromCharCode(92);                // backslash
const CJK = String.fromCharCode(0x4e2d, 0x6587);   // two CJK characters
const EMAIL = 'a' + '@' + 'real.com';              // non-whitelisted email
const NEAR_EMAIL = 'x' + '@' + 'notexample.com';   // domain merely ENDS WITH example.com -> must still flag
const OK_EMAIL = 'u' + '@' + 'example.com';        // exact allowlisted domain -> must NOT flag
const WIN_PATH = 'C:' + BS + 'Users' + BS + 'bob'; // Windows-style absolute path

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lg-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('flags CJK in a code file', () => {
  const dir = fixture({ 'hooks/x.mjs': '// ' + CJK + ' comment\nexport const a = 1;\n' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(hits.some(h => h.rule === 'cjk-in-code'));
});

test('allows CJK in README and docs', () => {
  const dir = fixture({ 'README.md': '# ' + CJK + '\nhi\n', 'docs/a.md': CJK + ' doc' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(hits.length, 0);
});

test('flags windows absolute path and email', () => {
  const dir = fixture({ 'tools/y.mjs': 'const p = "' + WIN_PATH + '"; // ' + EMAIL + '\n' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(hits.some(h => h.rule === 'abs-path'));
  assert.ok(hits.some(h => h.rule === 'email'));
});

test('flags email whose domain merely ends with example.com', () => {
  const dir = fixture({ 'tools/near.mjs': 'const c = "' + NEAR_EMAIL + '";\n' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(hits.some(h => h.rule === 'email'));
});

test('does not flag exact example.com allowlisted email', () => {
  const dir = fixture({ 'tools/ok.mjs': 'const c = "' + OK_EMAIL + '";\n' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(hits.filter(h => h.rule === 'email').length, 0);
});

test('clean code file passes', () => {
  const dir = fixture({ 'hooks/ok.mjs': 'export const a = 1; // english only\n' });
  const hits = scanDir(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(hits.length, 0);
});
