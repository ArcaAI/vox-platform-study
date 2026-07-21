#!/usr/bin/env node
// @ts-check
/**
 * verify-traceability.mjs — TASK-538 Wave-4 checker
 *
 * Verifies that the per-domain traceability docs under docs/traceability/*.md do
 * not drift from the code they claim to map. It parses capability-table rows and
 * checks four kinds of claim:
 *
 *   1. backtick-quoted repo paths        -> exist on disk
 *   2. controller/router route strings   -> appear in an apps/**\/*.ts controller
 *                                           or an apps/**\/*.py FastAPI router
 *   3. Prisma model names (Prisma-models -> declared as `model X {` in
 *      table field only)                    packages/database/src/prisma/db_main/*.prisma
 *   4. test globs (Tests table field)    -> match at least one file on disk
 *
 * Exit 0 when every checkable claim resolves, exit 1 with a listed failure set
 * otherwise. `--coverage` instead reports apps/api/src/modules/* and
 * apps/admin-console/src/features/* that appear in NO traceability file.
 *
 * Standalone: Node >= 18, no dependencies. Conservative by design — a claim that
 * cannot be resolved to a concrete, rooted target is SKIPPED rather than flagged,
 * so a reported failure is a real one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const KNOWN_ROOTS = new Set([
  'apps',
  'packages',
  'docs',
  'scripts',
  'infrastructure',
  'deployment',
  'tests',
  '.claude',
  '.gitlab',
  '.github',
]);

// ---------------------------------------------------------------------------
// filesystem index
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'build',
  'out',
]);

/** @param {string} start @returns {string[]} repo-relative POSIX paths */
function walk(start) {
  /** @type {string[]} */
  const out = [];
  const abs = path.join(REPO, start);
  if (!fs.existsSync(abs)) return out;
  /** @param {string} dir */
  const rec = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.gitlab' && e.name !== '.github') {
        // hidden files/dirs are noise, but keep the dotted repo roots handled below
      }
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else out.push(path.relative(REPO, full).split(path.sep).join('/'));
    }
  };
  rec(abs);
  return out;
}

// index the code/test/doc trees once
const FILE_INDEX = [
  ...walk('apps'),
  ...walk('packages'),
  ...walk('tests'),
  ...walk('docs'),
  ...walk('scripts'),
  ...walk('infrastructure'),
  ...walk('deployment'),
];
const FILE_SET = new Set(FILE_INDEX);

// concatenated source for route-literal lookups
function readAllUnder(roots, exts) {
  let buf = '';
  for (const rel of FILE_INDEX) {
    if (!roots.some((r) => rel.startsWith(r + '/'))) continue;
    if (!exts.some((x) => rel.endsWith(x))) continue;
    try {
      buf += '\n' + fs.readFileSync(path.join(REPO, rel), 'utf8');
    } catch {
      /* ignore */
    }
  }
  return buf;
}
const TS_SOURCE = readAllUnder(['apps'], ['.ts']);
const PY_SOURCE = readAllUnder(['apps'], ['.py']);

// prisma models + enums (a Prisma-models cell legitimately names enums too, labelled inline)
const PRISMA_TYPES = new Set();
for (const rel of FILE_INDEX) {
  if (!rel.startsWith('packages/database/src/prisma/db_main/') || !rel.endsWith('.prisma')) continue;
  const txt = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const re = /^\s*(?:model|enum)\s+([A-Za-z0-9_]+)\s*\{/gm;
  let m;
  while ((m = re.exec(txt))) PRISMA_TYPES.add(m[1]);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** brace-expand a single-level `{a,b}` (handles one group, which is all the docs use) */
function braceExpand(tok) {
  const m = tok.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [tok];
  const [, pre, body, post] = m;
  return body.split(',').flatMap((part) => braceExpand(pre + part + post));
}

/** collect every `...` backtick token from a string */
function backticks(str) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1]);
  return out;
}

/** Resolve a backtick token to a repo-relative path to test, or null if not a checkable path. */
function asRepoPath(tok, docDir) {
  const t = tok.trim();
  if (!t.includes('/')) return null; // single segment: too generic
  // doc-relative link (./foo.md, ../bar)
  if (t.startsWith('./') || t.startsWith('../')) {
    const rel = path.normalize(path.join(docDir, t)).split(path.sep).join('/');
    return { rel, why: 'doc-relative' };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(t)) return null; // has spaces / parens / globs / quotes
  const first = t.split('/')[0];
  if (first === 'db_main') {
    return { rel: 'packages/database/src/prisma/' + t, why: 'db_main' };
  }
  if (KNOWN_ROOTS.has(first)) return { rel: t, why: 'rooted' };
  return null;
}

function pathExists(rel) {
  const clean = rel.replace(/\/$/, '');
  if (FILE_SET.has(clean)) return true;
  return fs.existsSync(path.join(REPO, clean));
}

// ---------------------------------------------------------------------------
// route-literal verification
// ---------------------------------------------------------------------------

/** @returns {boolean} whether a route literal is present in code */
function controllerRoutePresent(route) {
  return TS_SOURCE.includes(`@Controller('${route}')`) || TS_SOURCE.includes(`@Controller("${route}")`);
}
function pyRouterPresent(prefix) {
  return PY_SOURCE.includes(`prefix="${prefix}"`) || PY_SOURCE.includes(`prefix='${prefix}'`);
}
function wsPathPresent(p) {
  return TS_SOURCE.includes(`path: '${p}'`) || TS_SOURCE.includes(`path: "${p}"`);
}

// ---------------------------------------------------------------------------
// test-glob verification
// ---------------------------------------------------------------------------

/** glob (with `*` and `**`) -> regex source, honoring path-segment boundaries */
function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else {
      out += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

const HAS_TEST_EXT = /\.(test|spec)\.(ts|tsx)$|\.py$/;

/** does any indexed file satisfy this (possibly `*`/`**`-containing) candidate? */
function testGlobMatches(cand) {
  const c = cand.trim().replace(/^\.\//, '');
  if (c === '') return true;
  // simple directory form: "a/b/" or "a/b/*" (no deeper wildcard in the dir part)
  if ((c.endsWith('/*') || c.endsWith('/')) && !c.replace(/\/\*?$/, '').includes('*')) {
    const dir = c.replace(/\/\*?$/, '');
    if (dir === '') return true;
    return FILE_INDEX.some((p) => p.includes('/' + dir + '/') || p.startsWith(dir + '/'));
  }
  if (c.includes('*')) {
    const src = globToRegex(c);
    const rooted = KNOWN_ROOTS.has(c.split('/')[0]);
    const re = new RegExp(rooted ? '^' + src + '$' : '(^|/)' + src + '$');
    return FILE_INDEX.some((p) => re.test(p));
  }
  // concrete candidate
  if (c.includes('/')) {
    if (HAS_TEST_EXT.test(c)) return FILE_INDEX.some((p) => p === c || p.endsWith('/' + c)) || pathExists(c);
    // abbreviated fragment (no extension, e.g. "api/__tests__/client"): lenient — a real
    // file may append ".test.ts"; match the fragment on a segment boundary.
    return FILE_INDEX.some((p) => p.includes('/' + c) || p.startsWith(c + '/') || p === c);
  }
  // no slash: only reached with a real test extension (bare names are skipped upstream)
  return FILE_INDEX.some((p) => p.endsWith('/' + c) || p === c);
}

// ---------------------------------------------------------------------------
// main parse
// ---------------------------------------------------------------------------

const FIELD_PRISMA = 'Prisma models';
const FIELD_TESTS = 'Tests';

/** parse a "| field | value |" markdown row -> [field, value] or null */
function tableRow(line) {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line.split('|').slice(1, -1).map((s) => s.trim());
  if (cells.length < 2) return null;
  return [cells[0], cells.slice(1).join(' | ')];
}

function traceFiles() {
  const dir = path.join(REPO, 'docs/traceability');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/traceability/' + f);
}

function runVerify() {
  /** @type {{file:string, kind:string, claim:string, detail:string}[]} */
  const failures = [];
  let checked = 0;

  for (const rel of traceFiles()) {
    const docDir = path.dirname(rel);
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const lines = text.split('\n');

    // Extraction is scoped to TABLE ROWS (the verified capability mappings). Narrative
    // prose — which may deliberately name removed/legacy paths — is not a claim to check.
    const seenRoutes = new Set();
    const seenPaths = new Set();

    const scanRoutes = (value, re, kind, check) => {
      let m;
      const rx = new RegExp(re.source, 'g');
      while ((m = rx.exec(value))) {
        const val = m[1];
        const key = kind + ':' + val;
        if (seenRoutes.has(key)) continue;
        seenRoutes.add(key);
        checked++;
        if (!check(val)) failures.push({ file: rel, kind, claim: val, detail: 'route not found in code' });
      }
    };

    for (const line of lines) {
      const row = tableRow(line);
      if (!row) continue;
      const [field, value] = row;

      // (2) route/router literals in any cell
      scanRoutes(value, /@Controller\('([^']+)'\)/, 'controller-route', controllerRoutePresent);
      scanRoutes(value, /APIRouter\(prefix="([^"]+)"\)/, 'py-router-prefix', pyRouterPresent);
      scanRoutes(value, /@WebSocketGateway\(\{\s*path:\s*'([^']+)'/, 'ws-path', wsPathPresent);

      // (1) repo paths — backtick tokens in any cell
      for (const tok of backticks(value)) {
        const r = asRepoPath(tok, docDir);
        if (!r) continue;
        if (seenPaths.has(r.rel)) continue;
        seenPaths.add(r.rel);
        checked++;
        if (!pathExists(r.rel))
          failures.push({ file: rel, kind: 'repo-path', claim: tok, detail: `missing ${r.rel}` });
      }

      // (3) Prisma models / (4) test globs — scoped to their fields
      if (field === FIELD_PRISMA) {
        for (const tok of backticks(value)) {
          if (!/^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(tok)) continue; // PascalCase model/enum-ish
          checked++;
          if (!PRISMA_TYPES.has(tok))
            failures.push({
              file: rel,
              kind: 'prisma-model',
              claim: tok,
              detail: 'no `model`/`enum` in db_main/*.prisma',
            });
        }
      } else if (field === FIELD_TESTS) {
        for (const tok of backticks(value)) {
          if (/\s/.test(tok)) continue; // commands / prose (e.g. `pnpm --filter ... test:e2e`)
          for (const cand of braceExpand(tok)) {
            // only check things that actually look like a test path: a path, a glob,
            // or a file with a test/spec/py extension. Bare abbreviated names in a
            // parenthetical list (e.g. `harness-internal.service`) are informational.
            const looksLikeTestPath = cand.includes('/') || cand.includes('*') || HAS_TEST_EXT.test(cand);
            if (!looksLikeTestPath) continue;
            checked++;
            if (!testGlobMatches(cand))
              failures.push({ file: rel, kind: 'test-glob', claim: cand, detail: 'no matching file' });
          }
        }
      }
    }
  }

  report(failures, checked);
  return failures.length === 0 ? 0 : 1;
}

function report(failures, checked) {
  if (failures.length === 0) {
    console.log(`verify-traceability: OK — ${checked} claims checked, 0 failures.`);
    return;
  }
  console.log(`verify-traceability: ${failures.length} failure(s) out of ${checked} claims checked.\n`);
  const byFile = new Map();
  for (const f of failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, fs_] of [...byFile].sort()) {
    console.log(file);
    for (const f of fs_) console.log(`  [${f.kind}] ${f.claim}  — ${f.detail}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// coverage mode
// ---------------------------------------------------------------------------
function runCoverage() {
  const allText = traceFiles()
    .map((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'))
    .join('\n');

  const listDirs = (rel) => {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  };

  const modules = listDirs('apps/api/src/modules');
  const features = listDirs('apps/admin-console/src/features');

  // a name is "covered" if its exact identifier appears anywhere in the traceability text
  const covered = (name) => {
    const re = new RegExp('(^|[^A-Za-z0-9-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9-]|$)');
    return re.test(allText);
  };

  const missingModules = modules.filter((m) => !covered(m)).sort();
  const missingFeatures = features.filter((f) => !covered(f)).sort();

  console.log(`Coverage — apps/api/src/modules (${modules.length} total)`);
  if (missingModules.length === 0) console.log('  all modules referenced in a traceability file.');
  else missingModules.forEach((m) => console.log(`  UNREFERENCED  apps/api/src/modules/${m}`));

  console.log(`\nCoverage — apps/admin-console/src/features (${features.length} total)`);
  if (missingFeatures.length === 0) console.log('  all features referenced in a traceability file.');
  else missingFeatures.forEach((f) => console.log(`  UNREFERENCED  apps/admin-console/src/features/${f}`));

  const total = missingModules.length + missingFeatures.length;
  console.log(`\n${total} unreferenced surface(s).`);
  return total === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const code = args.includes('--coverage') ? runCoverage() : runVerify();
process.exit(code);
