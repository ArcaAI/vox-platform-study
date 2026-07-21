#!/usr/bin/env node
// @ts-check
/**
 * verify-doc-claims.mjs — TASK-537 Wave-3 checker
 *
 * Scans docs/**\/*.md plus every README.md in the repo and verifies two kinds of
 * backtick-quoted claim:
 *
 *   1. repo-relative paths      -> exist on disk
 *   2. `pnpm <script>` refs     -> the script name exists in some package.json
 *
 * Conservative by design: a token is only checked when it resolves unambiguously.
 *   - paths are checked only when rooted at a known repo dir (apps/, packages/, …),
 *     `db_main/…`, or a `./`-relative doc link; anything with a glob/placeholder
 *     char (`<> * { } …`) or spaces is skipped.
 *   - for `pnpm …` only the first script token is validated (later words may be
 *     script args like `pnpm dev:stack down`); builtins and placeholders are skipped.
 *
 * Exit 0 when every checkable claim resolves, exit 1 with a listed failure set.
 *
 * docs/archive/** is EXCLUDED by default (it is a snapshot of superseded tickets and
 * is expected to reference removed paths). Pass --include-archive to scan it too.
 *
 * Standalone: Node >= 18, no dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const INCLUDE_ARCHIVE = process.argv.includes('--include-archive');

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

// pnpm builtin subcommands — a `pnpm <builtin>` is not a package script reference
const PNPM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'upgrade', 'exec', 'dlx',
  'create', 'init', 'publish', 'pack', 'store', 'prune', 'import', 'rebuild', 'link',
  'unlink', 'patch', 'patch-commit', 'deploy', 'fetch', 'licenses', 'audit', 'outdated',
  'config', 'setup', 'env', 'server', 'list', 'ls', 'why', 'dedupe', 'start', 'root',
  'bin', 'why', 'doctor', 'approve-builds',
]);

// ---------------------------------------------------------------------------
/** @param {string} start @returns {string[]} repo-relative POSIX paths */
function walk(start) {
  const out = [];
  const abs = path.join(REPO, start);
  if (!fs.existsSync(abs)) return out;
  const rec = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else out.push(path.relative(REPO, full).split(path.sep).join('/'));
    }
  };
  rec(abs);
  return out;
}

// package.json script keys, union across the workspace
const SCRIPTS = new Set();
for (const rel of walk('.')) {
  if (path.basename(rel) !== 'package.json') continue;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')).scripts || {};
    for (const k of Object.keys(s)) SCRIPTS.add(k);
  } catch {
    /* ignore malformed */
  }
}

// installed binaries — `pnpm <bin>` (e.g. `pnpm turbo`, `pnpm tsx`) is a valid launch of a
// node_modules/.bin executable, not a package script, so those must not be flagged.
const BINS = new Set();
try {
  for (const name of fs.readdirSync(path.join(REPO, 'node_modules/.bin'))) BINS.add(name);
} catch {
  /* .bin may be absent in a fresh checkout */
}

// full file index for "exists somewhere" suffix matching — many docs write a package-
// relative path (e.g. `tests/unit/...` under apps/harness) whose root collides with a real
// repo root. Accepting a suffix match keeps those out of the failure list.
const FILE_INDEX = [
  ...walk('apps'),
  ...walk('packages'),
  ...walk('tests'),
  ...walk('docs'),
  ...walk('scripts'),
  ...walk('infrastructure'),
  ...walk('deployment'),
];

// docs/**/*.md + all README.md
function targetFiles() {
  const files = new Set();
  for (const rel of walk('docs')) if (rel.endsWith('.md')) files.add(rel);
  for (const rel of walk('.')) if (path.basename(rel).toLowerCase() === 'readme.md') files.add(rel);
  return [...files]
    .filter((f) => INCLUDE_ARCHIVE || !f.startsWith('docs/archive/'))
    .sort();
}

// ---------------------------------------------------------------------------
/** strip fenced code blocks (``` … ``` and ~~~ … ~~~) — their contents are illustrative
 *  examples, and their triple-backticks corrupt inline-span extraction. */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n');
}

const PLACEHOLDER = /[<>*{}…]|\.\.\./; // includes the literal "..." ellipsis (e.g. packages/.../x.ts)

// narrative cues that mark a deliberately-nonexistent path. Two forms:
//  - endCue: the cue sits immediately before the path — "(NOT `x`)", "the former `x`".
//  - winCue: a strong historical word anywhere in the preceding window — catches list forms
//    like "removed components (e.g. `knowledge/`, `apps/admin`, `apps/tts`)".
const END_CUE =
  /(\b(not|former|formerly|removed|deleted|renamed|rename|renaming|considered|replaced|legacy|retired|deprecated|superseded|obsolete)\W*[([]?\W*$)|((no longer|rename[d]? to|instead of|used to be)\W*$)/i;
const WIN_CUE =
  /\b(removed|renamed?|deprecated|retired|superseded|obsolete|archived|declined|deleted|formerly|no longer|used to|describe removed|do not edit)\b/i;

/** Resolve a backtick token to a repo-relative path to test, or null if not checkable. */
function asRepoPath(tok, docDir) {
  const t = tok.trim();
  if (!t.includes('/')) return null;
  if (PLACEHOLDER.test(t)) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(t)) return null;
  if (t.startsWith('./') || t.startsWith('../')) {
    // `./x` in prose is ambiguous (doc-relative vs repo-root vs a code/barrel/export
    // subpath). Only doc-to-doc `.md` links are reliably doc-relative — check just those.
    if (!/\.md$/.test(t)) return null;
    return path.normalize(path.join(docDir, t)).split(path.sep).join('/');
  }
  const first = t.split('/')[0];
  if (first === 'db_main') return 'packages/database/src/prisma/' + t;
  if (KNOWN_ROOTS.has(first)) return t;
  return null;
}

function pathExists(rel) {
  const clean = rel.replace(/\/$/, '');
  if (fs.existsSync(path.join(REPO, clean))) return true;
  // "exists somewhere" fallback: a package-relative path whose root collides with a repo root
  return FILE_INDEX.some(
    (p) => p === clean || p.endsWith('/' + clean) || p.includes('/' + clean + '/'),
  );
}

const SCRIPT_NAME = /^[A-Za-z0-9:_.-]+$/;

/** Return the single reliably-a-script token from a `pnpm …` command, or null. */
function pnpmScript(cmd) {
  if (PLACEHOLDER.test(cmd)) return null; // e.g. `pnpm --filter <pkg> build`
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] !== 'pnpm') return null;
  let i = 1;
  while (i < parts.length) {
    const p = parts[i];
    if (p === '--filter' || p === '-C' || p === '--dir' || p === '-F') {
      i += 2; // flag + value
      continue;
    }
    if (p.startsWith('-')) {
      i += 1; // -w, -r, --recursive, --if-present, --filter=…
      continue;
    }
    break;
  }
  if (i >= parts.length) return null;
  let first = parts[i];
  if (first === 'run') first = parts[i + 1]; // `pnpm run <script>`
  if (!first || PNPM_BUILTINS.has(first) || BINS.has(first)) return null;
  if (!SCRIPT_NAME.test(first)) return null; // &&, |, …, shell noise
  return first;
}

// ---------------------------------------------------------------------------
function run() {
  /** @type {{file:string, kind:string, claim:string, detail:string}[]} */
  const failures = [];
  let checked = 0;

  for (const rel of targetFiles()) {
    const docDir = path.dirname(rel);
    let text;
    try {
      text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    } catch {
      continue;
    }
    const body = stripFences(text);
    const seenPath = new Set();
    const seenScript = new Set();

    const re = /`([^`\n]+)`/g; // inline code spans only (no newlines)
    let m;
    while ((m = re.exec(body))) {
      const tok = m[1];
      // (2) pnpm script reference
      if (/^pnpm(\s|$)/.test(tok)) {
        const script = pnpmScript(tok);
        if (script && !seenScript.has(script)) {
          seenScript.add(script);
          checked++;
          if (!SCRIPTS.has(script))
            failures.push({
              file: rel,
              kind: 'pnpm-script',
              claim: 'pnpm ' + script,
              detail: 'no such script in any package.json',
            });
        }
        continue;
      }
      // (1) repo path
      const p = asRepoPath(tok, docDir);
      if (!p) continue;
      if (seenPath.has(p)) continue;
      // deliberately-nonexistent path named in narrative ("(NOT `x`)", "former `x`",
      // "removed components (e.g. `x`, `y`)")
      const before = body.slice(Math.max(0, m.index - 80), m.index);
      if (END_CUE.test(before.slice(-32)) || WIN_CUE.test(before)) continue;
      seenPath.add(p);
      checked++;
      if (!pathExists(p)) failures.push({ file: rel, kind: 'repo-path', claim: tok, detail: `missing ${p}` });
    }
  }

  report(failures, checked);
  return failures.length === 0 ? 0 : 1;
}

function report(failures, checked) {
  const scope = INCLUDE_ARCHIVE ? '(incl. docs/archive)' : '(docs/archive excluded)';
  if (failures.length === 0) {
    console.log(`verify-doc-claims: OK ${scope} — ${checked} claims checked, 0 failures.`);
    return;
  }
  console.log(`verify-doc-claims: ${failures.length} failure(s) out of ${checked} claims checked ${scope}.\n`);
  const byFile = new Map();
  for (const f of failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of [...byFile].sort()) {
    console.log(file);
    for (const f of list) console.log(`  [${f.kind}] ${f.claim}  — ${f.detail}`);
    console.log('');
  }
}

process.exit(run());
