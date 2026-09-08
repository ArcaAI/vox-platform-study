import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_USER_AGENT } from '../transport';

/**
 * `SDK_VERSION` in `core/transport.ts` is DERIVED from `package.json#version`, not
 * hand-maintained — it used to be a literal, and it drifted on the very first bump
 * (`3.0.0` shipped while the package was `3.0.1`). A wrong `User-Agent` is the kind
 * of thing nobody notices until they are trying to correlate SDK versions in gateway
 * logs during an incident, so the derivation has TWO halves and this file holds both:
 *
 *  1. **Unbuilt source** (this process): `core/version.ts` reads the manifest,
 *     because the build-time define is absent. Asserted below against the manifest.
 *  2. **The shipped bundle**: `tsup.config.ts` substitutes `__VOX_NODE_VERSION__`
 *     with a literal, so the manifest branch — and its `node:fs`/`node:path` imports
 *     — are dead-code-eliminated. That is what keeps the bundle runnable on Bun,
 *     Deno and edge runtimes, and it is asserted against `dist/` when a build exists.
 *
 * `node:fs` / `node:path` are fine here: this is a test, not shipped code. Resolved
 * from `process.cwd()` rather than `import.meta.url` — this package emits CommonJS,
 * and `import.meta` is a hard compile error under that target (TS1470).
 *
 * cwd differs by runner: `pnpm --filter @arcaai/vox-node test` runs from the package
 * root, while the repo-wide `pnpm test:unit` runs from the monorepo root and would
 * otherwise read the ROOT package.json. Both are resolved here, and the `name`
 * assertion below fails loudly rather than silently comparing the wrong file.
 */
const PACKAGE_JSON_CANDIDATES = [
  join(process.cwd(), 'packages', 'vox-node', 'package.json'), // repo-root runner
  join(process.cwd(), 'package.json'), // package-scoped runner
];

/** The resolved manifest path, or `undefined` when neither candidate exists. */
function resolveManifestPath(): string | undefined {
  return PACKAGE_JSON_CANDIDATES.find((candidate) => existsSync(candidate));
}

describe('SDK_VERSION', () => {
  it('matches package.json#version', () => {
    const packageJsonPath = resolveManifestPath();
    expect(packageJsonPath, `no package.json found at any of: ${PACKAGE_JSON_CANDIDATES.join(', ')}`).toBeDefined();

    const { name, version } = JSON.parse(readFileSync(packageJsonPath!, 'utf8')) as { name: string; version: string };

    // Guard the guard: proves we read THIS package's manifest, not another one.
    expect(name).toBe('@arcaai/vox-node');

    expect(SDK_USER_AGENT).toBe(`arcaai/vox-node/${version}`);
  });

  /**
   * Skipped, not failed, when `dist/` is absent: `pnpm --filter @arcaai/vox-node test`
   * is a legitimate thing to run on a clean tree, and a test that demands a prior build
   * would make the suite order-dependent. The build gate (`sdk-node:build`) and
   * `check:exports` run before this in every release path, so the assertion has a build
   * to look at exactly when it matters.
   */
  it('is substituted into the built bundle, leaving no filesystem read behind', () => {
    const packageRoot = dirname(resolveManifestPath()!);
    const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };

    for (const bundle of ['dist/index.js', 'dist/index.mjs']) {
      const bundlePath = join(packageRoot, bundle);
      if (!existsSync(bundlePath)) continue;
      const contents = readFileSync(bundlePath, 'utf8');

      // The define landed: the version is a literal in the bundle, not a lookup.
      expect(contents, `${bundle} does not carry the built version literal`).toContain(JSON.stringify(version));
      // ...and the manifest branch of `core/version.ts` did NOT survive it. Asserted
      // through that branch's own error text rather than through `node:fs`, which
      // esbuild is free to rewrite: the message is unique to the dropped code path.
      expect(contents, `${bundle} still carries the manifest fallback — the version define was not folded`).not.toContain(
        'could not resolve its own version',
      );
    }
  });
});
