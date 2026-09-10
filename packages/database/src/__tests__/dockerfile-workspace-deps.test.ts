/**
 * `packages/database/Dockerfile` builds a LEAN migrations image: it copies a
 * hand-listed subset of the monorepo, not the whole `packages/` tree. That list
 * is invisible to lint, typecheck and every other suite — a new workspace import
 * in this package compiles here and fails only in the `build` stage, on a
 * release-line branch, long after it merged.
 *
 * It fell behind once already: `@arcaai/types` became a dependency of this
 * package (the de-duplicated `AiModelAsrProfile` in
 * `src/prisma/db_main/seed/ai-models/shared.ts`) and no COPY line followed it,
 * so `build-database` died with `TS2307: Cannot find module '@arcaai/types'`.
 * Note the failure mode: `pnpm install --frozen-lockfile` does NOT abort on an
 * absent workspace project the way apps/api's `--no-frozen-lockfile` install
 * does — it trusts the lockfile, links nothing, and lets `tsc` discover it.
 *
 * This is the same shape of guard as
 * `apps/api/src/__tests__/dockerfile-workspace-manifests.test.ts`, narrowed to
 * what actually breaks this image: every `@arcaai/*` package IMPORTED by the
 * sources `tsc` compiles must have both its manifest (before the install) and
 * its sources (before the build) in the builder stage.
 *
 * If it fails: add the named COPY lines. Do not delete the assertion.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const DOCKERFILE = path.join(PACKAGE_ROOT, 'Dockerfile');

/** Every `.ts` file `tsc` compiles for this package (tsconfig `include`/`exclude`). */
function compiledSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'integration' || entry === 'generated') continue;
      compiledSources(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** `@arcaai/<pkg>` specifiers imported by those sources, as `packages/<pkg>` dirs. */
function importedWorkspaceDirs(): string[] {
  const names = new Set<string>();
  for (const file of compiledSources(path.join(PACKAGE_ROOT, 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]@arcaai\/([^'"/]+)/g)) {
      names.add(`packages/${match[1]}`);
    }
  }
  return [...names].sort();
}

describe('packages/database Dockerfile workspace deps', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const imported = importedWorkspaceDirs();

  it('imports at least one workspace package (guards the guard)', () => {
    // A refactor that removed every cross-package import would otherwise make
    // the assertions below vacuously true.
    expect(imported.length).toBeGreaterThan(0);
  });

  it('resolves every imported @arcaai package to a real workspace directory', () => {
    const unknown = imported.filter((dir) => !readdirSync(path.join(REPO_ROOT, 'packages')).includes(path.basename(dir)));
    expect(unknown).toEqual([]);
  });

  it('copies the manifest of every imported workspace package before pnpm install', () => {
    const missing = imported.filter((dir) => !new RegExp(`^COPY\\s+${dir}/package\\.json\\s`, 'm').test(dockerfile));
    expect(
      missing,
      `packages/database/Dockerfile is missing ${missing.length} workspace manifest COPY line(s). ` +
        `pnpm install --frozen-lockfile will silently skip the link and tsc will fail with TS2307. Add: ` +
        missing.map((dir) => `COPY ${dir}/package.json ./${dir}/`).join(' '),
    ).toEqual([]);
  });

  it('copies the sources of every imported workspace package before the build', () => {
    const missing = imported.filter((dir) => !new RegExp(`^COPY\\s+${dir}/\\s`, 'm').test(dockerfile));
    expect(
      missing,
      `packages/database/Dockerfile is missing ${missing.length} workspace source COPY line(s). Add: ` +
        missing.map((dir) => `COPY ${dir}/ ./${dir}/`).join(' '),
    ).toEqual([]);
  });
});
