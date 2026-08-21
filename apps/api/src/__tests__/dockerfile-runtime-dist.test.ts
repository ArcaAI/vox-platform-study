/**
 * A workspace manifest in the production stage buys a symlink, not a module.
 *
 * `dockerfile-workspace-manifests.test.ts` guards the `COPY packages/<pkg>/
 * package.json` list, because pnpm resolves the whole workspace graph before it
 * installs. That check is necessary and NOT sufficient: `pnpm install --prod`
 * links `packages/applications/node_modules/@arcaai/workflow-contract` ->
 * `../../workflow-contract`, and is perfectly happy when the target holds only a
 * package.json. The failure moves from install time to BOOT time, in the
 * cluster, as a MODULE_NOT_FOUND on the package's own `main`.
 *
 * That is what shipped in dev-1c410d31 (pipeline #956): the manifest list had
 * just been repaired for `@arcaai/async-contract` and `@arcaai/workflow-contract`,
 * every gate went green, the image built — and hope-api crash-looped 750 times on
 *
 *   Cannot find module
 *   '/app/packages/applications/node_modules/@arcaai/workflow-contract/dist/index.js'
 *
 * So this is the second, independent obligation: every workspace package in the
 * RUNTIME closure of `@arcaai/api` (`dependencies` only — devDeps are pruned)
 * whose entry point resolves into `dist/` must have that `dist` copied into the
 * production stage. It is a SOURCE sweep, not an example.
 *
 * If it fails: add BOTH lines to the production stage for the named package —
 *   COPY --from=builder --chown=api:hope /app/packages/<pkg>/dist ./packages/<pkg>/dist
 *   COPY --from=builder --chown=api:hope /app/packages/<pkg>/package.json ./packages/<pkg>/package.json
 * Do not delete the assertion.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOCKERFILE = path.join(REPO_ROOT, 'apps/api/Dockerfile');
const ROOT_PACKAGE = '@arcaai/api';

type Manifest = {
  name?: string;
  main?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
};

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8')) as Manifest;

/** Every workspace package on disk, keyed by its declared name. */
function workspaceDirsByName(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const root of ['packages', 'apps']) {
    for (const entry of readdirSync(path.join(REPO_ROOT, root))) {
      const dir = `${root}/${entry}`;
      if (!existsSync(path.join(REPO_ROOT, dir, 'package.json'))) continue;
      const name = readManifest(dir).name;
      if (name) byName.set(name, dir);
    }
  }
  return byName;
}

/**
 * The `packages/*` closure reachable from `@arcaai/api` over `workspace:`
 * ranges in `dependencies` ONLY.
 *
 * Deliberately narrower than the manifest sweep's closure: that one includes
 * devDeps and peerDeps because pnpm resolves them all before pruning. Here the
 * question is what survives `--prod` and gets require()d at boot, so a devDep
 * that never ships is correctly out of scope.
 */
function runtimePackageDirs(): string[] {
  const byName = workspaceDirsByName();
  const seen = new Set<string>();
  const stack = [ROOT_PACKAGE];

  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = byName.get(name);
    if (!dir) continue;
    for (const [dep, range] of Object.entries(readManifest(dir).dependencies ?? {})) {
      if (String(range).startsWith('workspace:')) stack.push(dep);
    }
  }

  seen.delete(ROOT_PACKAGE);
  return [...seen]
    .map((name) => byName.get(name))
    .filter((dir): dir is string => Boolean(dir) && (dir as string).startsWith('packages/'))
    .sort();
}

/** Does this package's entry point resolve into a build output directory? */
function resolvesIntoDist(dir: string): boolean {
  const manifest = readManifest(dir);
  const dot = (manifest.exports?.['.'] ?? {}) as Record<string, string>;
  const entries = [manifest.main, dot.require, dot.import, dot.default].filter(
    (value): value is string => typeof value === 'string',
  );
  return entries.some((entry) => entry.includes('dist/'));
}

/** The production stage body — everything after its `FROM ... AS production`. */
function productionStage(dockerfile: string): string {
  const match = /^FROM\s+\S+\s+AS\s+production\s*$/im.exec(dockerfile);
  if (!match) return '';
  return dockerfile.slice(match.index + match[0].length);
}

/**
 * Packages whose build output the production stage actually receives — either a
 * targeted `dist` copy, or a wholesale copy of the package directory (which
 * `@arcaai/database` and `@arcaai/tools` use, and which brings dist with it).
 */
function distCopiedDirs(stageBody: string): Set<string> {
  const dirs = new Set<string>();
  for (const m of stageBody.matchAll(/COPY --from=builder[^\n]*?\/app\/(packages\/[^/\s]+)\/dist\b/g)) {
    dirs.add(m[1]);
  }
  for (const m of stageBody.matchAll(
    /COPY --from=builder[^\n]*?\/app\/(packages\/[^/\s]+)\s+\.\/packages\/[^/\s]+\/?\s*$/gm,
  )) {
    dirs.add(m[1]);
  }
  return dirs;
}

describe('apps/api Dockerfile runtime dist closure', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const stageBody = productionStage(dockerfile);

  it('finds the production stage', () => {
    // Guards the guard: a renamed final stage would make every assertion below
    // vacuously true against an empty body.
    expect(stageBody.length).toBeGreaterThan(0);
  });

  it.each(['@arcaai/async-contract', '@arcaai/workflow-contract'])(
    'still reaches %s from @arcaai/api at RUNTIME (the two that crash-looped)',
    (name) => {
      // Pins the regression: if either drops out of the runtime closure the
      // sweep below would shrink and pass against a short Dockerfile again.
      expect(runtimePackageDirs()).toContain(name.replace('@arcaai/', 'packages/'));
    },
  );

  it('copies the build output of every runtime workspace dependency', () => {
    const copied = distCopiedDirs(stageBody);
    const missing = runtimePackageDirs()
      .filter((dir) => resolvesIntoDist(dir))
      .filter((dir) => !copied.has(dir));

    expect(
      missing,
      `apps/api/Dockerfile production stage links ${missing.length} workspace package(s) ` +
        `whose dist it never copies. pnpm install --prod succeeds; the container then dies at ` +
        `boot with MODULE_NOT_FOUND. Add for each: ` +
        missing
          .map(
            (dir) =>
              `COPY --from=builder --chown=api:hope /app/${dir}/dist ./${dir}/dist (+ its package.json)`,
          )
          .join(' '),
    ).toEqual([]);
  });
});
