/**
 * TASK-327 T5 — admin nav is scope-driven, not visibility-driven.
 *
 *  - Any admin (incl. TENANT_ADMIN) sees the full admin menu set EXCEPT
 *    Prisma Studio.
 *  - Global scope (SA/GA) additionally sees Prisma Studio.
 *  - Non-admins see only Overview.
 *  - The persisted order is honoured.
 */
import { buildAdminNavItems } from '../admin-nav-items';
import { DEFAULT_ADMIN_MENU_ORDER } from '@/features/admin/hooks/use-admin-preferences';

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('buildAdminNavItems (TASK-327 T5)', () => {
  it('TENANT_ADMIN sees every admin menu except Prisma Studio', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: false, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toEqual(
      expect.arrayContaining([
        'dna-reports',
        'tenants',
        'users',
        'prompts',
        'departments',
        'audio-pipelines',
        'storage',
        'configurations',
        'audit-logs',
      ]),
    );
    expect(got).not.toContain('studio');
  });

  it('global scope (SUPER_ADMIN / GLOBAL_ADMIN) additionally sees Prisma Studio', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toContain('studio');
  });

  it('never includes Prisma Studio for a tenant admin even if a saved order lists it', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: false, order: ['studio', 'overview', 'tenants'] }));
    expect(got).not.toContain('studio');
  });

  it('non-admin sees only Overview', () => {
    const got = ids(buildAdminNavItems({ isAdmin: false, isGlobalScope: false, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toEqual(['overview']);
  });

  it('honours the persisted order (and appends unknown ids at the end)', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, order: ['users', 'tenants', 'overview'] }));
    expect(got.indexOf('users')).toBeLessThan(got.indexOf('tenants'));
    expect(got.indexOf('tenants')).toBeLessThan(got.indexOf('overview'));
    // an id not present in the saved order still renders (after the ranked ones)
    expect(got).toContain('studio');
    expect(got.indexOf('studio')).toBeGreaterThan(got.indexOf('overview'));
  });
});
