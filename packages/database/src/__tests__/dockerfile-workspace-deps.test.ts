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
 * It then fell behind a SECOND time, in the RUNTIME stage, and the three
 * assertions above could not see it. That stage deliberately copies only
 * `packages/types/package.json`, on the reasoning that this package referenced
 * `@arcaai/types` with `import type` alone, which tsc erases. A later VALUE
 * import (`API_KEY_SCOPE_PRESETS` in `src/prisma/db_main/seed/02-apikey.ts`)
 * silently invalidated that premise: the manifest links, the symlink resolves,
 * and the directory it points at has no `dist/`. Nothing caught it because
 * `hope-db-migrate` runs `RUN_SEED=none` and never imports the seed — it
 * surfaced only when `hope-reset` seeded a live cluster, AFTER dropping the
 * schema, leaving `hope-v2-dev` with 107 correct tables and zero rows.
 *
 * So the fourth assertion below is about the runtime stage: a workspace package
 * imported for a VALUE must have its `dist` carried over, not just its
 * manifest.
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

/**
 * Of those, the ones imported for a VALUE — the subset that must still resolve
 * at RUNTIME, because tsc emits the import rather than erasing it.
 *
 * `import type { X } from '@arcaai/y'` and `import { type X } from '@arcaai/y'`
 * are both erased; a default, namespace, or bare-specifier import is not.
 */
function valueImportedWorkspaceDirs(): string[] {
  const names = new Set<string>();
  for (const file of compiledSources(path.join(PACKAGE_ROOT, 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]@arcaai\/([^'"/]+)/g)) {
      const [, typeOnly, clause, pkg] = match;
      if (typeOnly) continue;
      const named = clause.trim().match(/^\{([\s\S]*)\}$/);
      if (named) {
        const specifiers = named[1]
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        // `import {}` erases too, and an all-`type` clause emits nothing.
        if (specifiers.length === 0 || specifiers.every((entry) => /^type\s/.test(entry))) continue;
      }
      names.add(`packages/${pkg}`);
    }
  }
  return [...names].sort();
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

  it('carries the built dist of every VALUE-imported workspace package into the runtime stage', () => {
    const valueImported = valueImportedWorkspaceDirs();
    // Guards the guard: an all-`import type` refactor would make this vacuous.
    expect(valueImported.length).toBeGreaterThan(0);

    const missing = valueImported.filter(
      (dir) => !new RegExp(`^COPY\\s+--from=builder\\s+/app/${dir}/dist\\s`, 'm').test(dockerfile),
    );
    expect(
      missing,
      `packages/database/Dockerfile's RUNTIME stage is missing ${missing.length} workspace dist COPY line(s). ` +
        `The manifest alone links the symlink but leaves it pointing at a directory with no dist/, so the seed ` +
        `dies at import with ERR_MODULE_NOT_FOUND — after hope-reset has already dropped the schema. Add: ` +
        missing.map((dir) => `COPY --from=builder /app/${dir}/dist ./${dir}/dist`).join(' '),
    ).toEqual([]);
  });
});
