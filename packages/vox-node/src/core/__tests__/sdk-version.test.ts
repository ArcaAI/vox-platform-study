import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_USER_AGENT } from '../transport';

/**
 * `SDK_VERSION` in `core/transport.ts` is a hand-maintained literal — this package
 * ships zero runtime dependencies, and importing `package.json` at runtime would
 * force a JSON-module divergence between the ESM and CJS outputs.
 *
 * The cost of hand-maintaining it is that it silently drifts on the first version
 * bump, and a wrong `User-Agent` is the kind of thing nobody notices until they are
 * trying to correlate SDK versions in gateway logs during an incident. This test
 * makes the release step fail loudly instead.
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

describe('SDK_VERSION', () => {
  it('matches package.json#version', () => {
    const packageJsonPath = PACKAGE_JSON_CANDIDATES.find((candidate) => existsSync(candidate));
    expect(packageJsonPath, `no package.json found at any of: ${PACKAGE_JSON_CANDIDATES.join(', ')}`).toBeDefined();

    const { name, version } = JSON.parse(readFileSync(packageJsonPath!, 'utf8')) as { name: string; version: string };

    // Guard the guard: proves we read THIS package's manifest, not another one.
    expect(name).toBe('@arcaai/vox-node');

    expect(SDK_USER_AGENT).toBe(`arcaai/vox-node/${version}`);
  });
});
