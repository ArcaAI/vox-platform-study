/**
 * This package's own version, resolved WITHOUT a runtime `package.json` read.
 *
 * `__VOX_NODE_VERSION__` is not a variable that exists at runtime: `tsup.config.ts`
 * substitutes it with a string literal at build time (esbuild `define`), read from
 * `package.json#version` by the build itself. `typeof __VOX_NODE_VERSION__` therefore
 * folds to `"string"` in the shipped bundle and the manifest branch below is dropped
 * by dead-code elimination — which is why this file may reference `node:fs` without
 * putting a filesystem read in a bundle that also has to run on Bun, Deno and edge
 * runtimes.
 *
 * The manifest branch exists for the ONE case where the define is absent: the source
 * running unbuilt under Vitest. It is deliberately not a hard-coded fallback string —
 * a literal is exactly what this replaces (it read `3.0.0` while the package was at
 * `3.0.1`, and nothing noticed until someone tried to correlate SDK versions in
 * gateway logs).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Substituted at build time by `tsup.config.ts`'s `define`; undeclared at runtime. */
declare const __VOX_NODE_VERSION__: string | undefined;

/** This package's npm name — also the guard that proves we read the right manifest. */
const PACKAGE_NAME = '@arcaai/vox-node';

/**
 * Where the manifest sits relative to `process.cwd()`, per runner: `pnpm --filter
 * @arcaai/vox-node test` runs from the package root, the repo-wide `pnpm test:unit`
 * from the monorepo root. Resolved from `cwd` rather than `import.meta.url` because
 * this package emits CommonJS too, and `import.meta` is a hard compile error under
 * that target (TS1470).
 */
const MANIFEST_CANDIDATES: readonly string[] = ['package.json', join('packages', 'vox-node', 'package.json')];

function versionFromManifest(): string {
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = join(process.cwd(), candidate);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== PACKAGE_NAME) continue;
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  }
  throw new Error(
    `${PACKAGE_NAME}: could not resolve its own version. The build-time \`__VOX_NODE_VERSION__\` define is absent ` +
      `(so this is unbuilt source), and no ${PACKAGE_NAME} package.json was found at any of: ` +
      `${MANIFEST_CANDIDATES.join(', ')} relative to ${process.cwd()}.`,
  );
}

/**
 * This package's version — the build-time define when present, else the manifest.
 *
 * The condition is EXACTLY `typeof __VOX_NODE_VERSION__ === 'string'` and nothing
 * more. esbuild folds `typeof <defined identifier>` to a literal and then folds the
 * whole comparison, which is what lets it drop {@link versionFromManifest} and the
 * `node:fs`/`node:path` imports with it. Adding a second term the compiler cannot
 * evaluate (`.length > 0`, say) keeps the false branch alive and puts a filesystem
 * read back into a bundle that has to run on edge runtimes — measured, not assumed.
 */
export function resolveSdkVersion(): string {
  return typeof __VOX_NODE_VERSION__ === 'string' ? __VOX_NODE_VERSION__ : versionFromManifest();
}
