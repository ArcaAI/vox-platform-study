/**
 * The image build cannot be allowed to discover a new workspace package the
 * hard way.
 *
 * `apps/api/Dockerfile` hand-maintains a list of
 * `COPY packages/<pkg>/package.json` lines, because pnpm resolves the FULL
 * workspace graph before pruning dev deps: a referenced package whose manifest
 * is absent aborts the install with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` and
 * nothing installs. That list is invisible to every other gate — lint,
 * typecheck and the whole test suite pass against a package the Dockerfile has
 * never heard of — so it only fails in the `build` stage, which runs on
 * release-line branches, long after the change merged.
 *
 * It has already fallen behind twice: `@arcaai/async-contract` (a direct dep of
 * apps/api) and `@arcaai/workflow-contract` (a dep of `@arcaai/applications`)
 * were both missing, and the second would have surfaced only after the first
 * was fixed.
 *
 * This test recomputes the closure from the manifests themselves and fails the
 * moment the list falls behind, in a job that runs on every branch. It is a
 * SOURCE sweep, not an example — the same shape as
 * `apps/api/src/filters/__tests__/downstream-error-leak-sweep.test.ts`.
 *
 * If it fails: add the named `COPY packages/<pkg>/package.json ./packages/<pkg>/`
 * line to EVERY stage that runs `pnpm install`. Do not delete the assertion.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOCKERFILE = path.join(REPO_ROOT, 'apps/api/Dockerfile');
const ROOT_PACKAGE = '@arcaai/api';

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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
 * ranges — deps, devDeps AND peerDeps, because pnpm resolves the whole graph
 * before it prunes anything.
 */
function requiredPackageDirs(): string[] {
  const byName = workspaceDirsByName();
  const seen = new Set<string>();
  const stack = [ROOT_PACKAGE];

  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = byName.get(name);
    if (!dir) continue;
    const manifest = readManifest(dir);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) stack.push(dep);
      }
    }
  }

  seen.delete(ROOT_PACKAGE);
  return [...seen]
    .map((name) => byName.get(name))
    .filter((dir): dir is string => Boolean(dir) && (dir as string).startsWith('packages/'))
    .sort();
}

type Stage = { name: string; base: string; body: string };

/** Split the Dockerfile into its stages, keeping each `FROM x AS y` edge. */
function parseStages(dockerfile: string): Stage[] {
  const stages: Stage[] = [];
  const lines = dockerfile.split('\n');
  let current: Stage | null = null;

  for (const line of lines) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
    if (from) {
      if (current) stages.push(current);
      current = { name: from[2] ?? `anonymous-${stages.length}`, base: from[1], body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) stages.push(current);
  return stages;
}

/**
 * Manifests visible to a stage: its own COPY lines plus everything inherited
 * from the local stage it is built `FROM`.
 */
function visibleManifests(stage: Stage, byName: Map<string, Stage>): { dirs: Set<string>; copiesWholeTree: boolean } {
  const dirs = new Set<string>();
  let copiesWholeTree = false;
  let cursor: Stage | undefined = stage;
  const guard = new Set<string>();

  while (cursor && !guard.has(cursor.name)) {
    guard.add(cursor.name);
    for (const match of cursor.body.matchAll(/^COPY\s+(packages\/[^/\s]+)\/package\.json/gm)) {
      dirs.add(match[1]);
    }
    // A whole-tree copy (`COPY packages/ ./packages/`) satisfies the graph by
    // construction — no per-package line is needed in that stage.
    if (/^COPY\s+packages\/?\s+\.\/packages\/?\s*$/m.test(cursor.body)) copiesWholeTree = true;
    cursor = byName.get(cursor.base);
  }

  return { dirs, copiesWholeTree };
}

describe('apps/api Dockerfile workspace manifests', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const stages = parseStages(dockerfile);
  const byName = new Map(stages.map((stage) => [stage.name, stage]));
  const installStages = stages.filter((stage) => /^\s*RUN\s+.*pnpm install/m.test(stage.body));

  it('has at least one stage that runs pnpm install', () => {
    // Guards the guard: a Dockerfile refactor that renames the install step
    // would otherwise make every assertion below vacuously true.
    expect(installStages.length).toBeGreaterThan(0);
  });

  it.each(['@arcaai/async-contract', '@arcaai/workflow-contract'])(
    'still reaches %s from @arcaai/api (the two that were missing)',
    (name) => {
      // Pins the regression itself: if either package stops being reachable the
      // closure below would silently shrink and this test would pass on a
      // Dockerfile that is once again short.
      expect(requiredPackageDirs()).toContain(name.replace('@arcaai/', 'packages/'));
    },
  );

  it.each(installStages.map((stage) => stage.name))(
    'stage %s copies every workspace manifest pnpm will resolve',
    (stageName) => {
      const stage = byName.get(stageName) as Stage;
      const { dirs, copiesWholeTree } = visibleManifests(stage, byName);
      if (copiesWholeTree) return;

      const missing = requiredPackageDirs().filter((dir) => !dirs.has(dir));
      expect(
        missing,
        `apps/api/Dockerfile stage "${stageName}" is missing ${missing.length} workspace manifest(s). ` +
          `pnpm install will abort with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Add: ` +
          missing.map((dir) => `COPY ${dir}/package.json ./${dir}/`).join(' '),
      ).toEqual([]);
    },
  );
});
