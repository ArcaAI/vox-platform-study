/**
 * TASK-1004 D-8 — `@arcaai/vox/compat` was removed outright (zero known consumers in hope-v2 or
 * ALaaS source, per the compat surface inventory). This pins the absence so a future change
 * cannot silently reintroduce the entry point without a deliberate decision.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..', '..');

describe('the ./compat entry point is gone (TASK-1004 D-8)', () => {
  it('package.json#exports has no ./compat entry', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      typesVersions?: { '*'?: Record<string, unknown> };
    };

    expect(Object.keys(pkg.exports)).not.toContain('./compat');
    expect(Object.keys(pkg.typesVersions?.['*'] ?? {})).not.toContain('compat');
  });

  it('src/compat.ts and src/compat/ no longer exist', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'compat.ts'))).toBe(false);
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'compat'))).toBe(false);
  });

  it('tsup.config.ts declares no compat build entry', () => {
    const config = readFileSync(join(PACKAGE_ROOT, 'tsup.config.ts'), 'utf8');
    expect(config).not.toMatch(/entry:\s*\{\s*compat:/);
  });
});
