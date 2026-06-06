import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TASK-335 #3 — the playground Overview must NOT host its own tenant picker.
 * The header `ScopeSwitcher` is the single working-tenant control; the old
 * `TenantSelector` ("Tenant Context" card) was a competing second picker and
 * has been deleted. These are real source-graph guards (not tautologies) so
 * the regression fails if the picker is ever re-introduced.
 *
 * Paths resolve from the package root (`process.cwd()`), which is the
 * ui-playground dir under both `pnpm --filter … test` and turbo.
 */

const overviewDir = resolve(process.cwd(), 'src/features/playground/overview');
const overviewSource = readFileSync(resolve(overviewDir, 'index.tsx'), 'utf8');

describe('Overview page — TenantSelector removal (TASK-335)', () => {
  it('does not reference a TenantSelector / in-page tenant picker', () => {
    expect(overviewSource).not.toMatch(/TenantSelector/);
    expect(overviewSource).not.toMatch(/tenant-selector/);
  });

  it('has deleted the dead tenant-selector component file', () => {
    expect(existsSync(resolve(overviewDir, 'components/tenant-selector.tsx'))).toBe(false);
  });

  it('still renders the UserList (impersonation entry point)', () => {
    expect(overviewSource).toMatch(/<UserList\s*\/>/);
  });
});
