#!/usr/bin/env node
// Fail the build if any committed file contains personal/identifying data.
// Structural rules only (committed file never embeds the personal values).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE_GLOBS = ['.mjs', '.ps1', '.json'];
const DOC_EXEMPT = (rel) => rel === 'README.md' || rel.replace(/\\/g, '/').startsWith('docs/');
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const RULES = [
  { rule: 'cjk-in-code', test: (rel, line) =>
      CODE_GLOBS.includes(extname(rel)) && !DOC_EXEMPT(rel) && /[\u3400-\u9fff\uf900-\ufaff]/.test(line) },
  { rule: 'abs-path', test: (_rel, line) =>
      /[A-Za-z]:\\(Users|\u6211\u7684)/i.test(line) || /\bC:\\Users\\/i.test(line) || /\bE:\\/.test(line) },
  { rule: 'email', test: (_rel, line) => {
      const m = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (!m) return false;
      const domain = m[0].slice(m[0].lastIndexOf('@') + 1).toLowerCase();
      return !(domain === 'example.com' || domain.endsWith('.example.com')); } },
];

export function scanDir(root) {
  const hits = [];
  const denyPath = join(root, '.leakguard-local.txt');
  const deny = existsSync(denyPath)
    ? readFileSync(denyPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const rel = relative(root, full);
      let text;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        for (const r of RULES) if (r.test(rel, line)) hits.push({ rule: r.rule, file: rel, line: i + 1 });
        for (const term of deny) if (line.includes(term)) hits.push({ rule: 'denylist', file: rel, line: i + 1 });
      });
    }
  };
  walk(root);
  return hits;
}

// CLI \u2014 cross-platform direct-invocation check (Windows-safe).
// NOTE: the original `file://${process.argv[1]}` form does NOT match on
// Windows (argv[1] has backslashes; import.meta.url is file:///X:/... with
// percent-encoded non-ASCII), so the CLI branch would silently never run.
// pathToFileURL normalizes both sides correctly on Windows and POSIX.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = scanDir(process.cwd());
  if (hits.length) {
    console.error('leak-guard: forbidden patterns found:');
    for (const h of hits) console.error(`  [${h.rule}] ${h.file}:${h.line}`);
    process.exit(1);
  }
  console.log('leak-guard: clean');
}
