/**
 * Clinical Review retirement guard (TASK-341 A2).
 *
 * The standalone `/clinical-review` fixture demo was fully consolidated into the
 * Clinical Workspace ("Review & sign" tab). This guards that the surface stays
 * retired: the route module is gone, the generated router table no longer
 * exposes it, and the sidebar no longer links to it. (Full removal was chosen
 * over a redirect — see the A2 notes.)
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('clinical-review surface retired (TASK-341 A2)', () => {
  it('removes the standalone /clinical-review route module', () => {
    expect(existsSync(resolve(srcRoot, 'routes/_authenticated/clinical-review.tsx'))).toBe(false);
  });

  it('drops clinical-review from the generated router table', () => {
    const tree = readFileSync(resolve(srcRoot, 'routeTree.gen.ts'), 'utf8');
    expect(tree).not.toContain('clinical-review');
  });

  it('removes the Clinician Review entry from the sidebar', () => {
    const sidebar = readFileSync(resolve(srcRoot, 'components/layout/app-sidebar.tsx'), 'utf8');
    expect(sidebar).not.toContain('/clinical-review');
  });
});
