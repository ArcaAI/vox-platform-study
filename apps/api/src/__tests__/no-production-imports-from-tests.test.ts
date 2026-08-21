/**
 * Production code may not import out of a `__tests__` directory.
 *
 * This is not style. `.dockerignore` strips every `__tests__` directory from the image build
 * context, so such an import compiles locally, type-checks locally, passes lint
 * and passes the whole test suite — and then fails ONLY inside `docker build`,
 * on a release-line branch, with a bare `TS2307: Cannot find module`.
 *
 * That is exactly how `build-api` failed: `src/bootstrap/service-account-surface-audit.ts`
 * imported the TASK-773 evidence fixture from `./__tests__/fixtures/…`. The
 * reasoning in the comment there was sound about `tsconfig.build.json` (whose
 * `__tests__` exclude only filters the ENTRY glob, so tsc did compile it) and
 * missed that the file never reaches the container at all.
 *
 * The fix for a violation is to MOVE the module into `src/` proper — not to
 * poke a hole in `.dockerignore`. A module that production imports is
 * production code, wherever it was born.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_SRC = path.join(REPO_ROOT, 'apps/api/src');

/** Every `.ts` file under `src/` that is NOT itself inside a `__tests__` dir. */
function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      productionSources(full, found);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.ts$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

// `from '…__tests__/…'` / `require('…__tests__/…')`, relative or aliased.
const TEST_DIR_IMPORT = /(?:from\s+|require\(\s*)['"][^'"]*__tests__\/[^'"]*['"]/g;

describe('production code never imports from __tests__', () => {
  const sources = productionSources(API_SRC);

  it('found production sources to scan', () => {
    // Guards the guard: a moved src root would otherwise make this vacuous.
    expect(sources.length).toBeGreaterThan(100);
  });

  it('.dockerignore still excludes __tests__ (the reason this rule exists)', () => {
    const dockerignore = readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
    expect(dockerignore).toMatch(/^\*\*\/__tests__$/m);
  });

  it('no file outside __tests__ imports a module inside __tests__', () => {
    const violations: string[] = [];

    for (const file of sources) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(TEST_DIR_IMPORT)) {
        violations.push(`${path.relative(REPO_ROOT, file)} → ${match[0]}`);
      }
    }

    expect(
      violations,
      'These production modules import out of a __tests__ directory. `.dockerignore` ' +
        'strips `**/__tests__` from the image build context, so this fails ONLY in ' +
        '`docker build` (TS2307), never locally. Move the imported module into src/ proper:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });
});
