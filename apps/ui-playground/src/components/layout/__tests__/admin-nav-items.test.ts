/**
 * TASK-327 T5 / TASK-331 #1 — admin nav is scope-driven, not visibility-driven.
 *
 *  - Any admin (incl. TENANT_ADMIN) sees the full admin menu set EXCEPT
 *    Prisma Studio.
 *  - Global scope (SUPER_ADMIN) additionally sees Prisma Studio.
 *  - Non-admins see only Overview.
 *  - A global-scope admin with NO tenant selected has the tenant-scoped pages
 *    disabled (but still listed); Overview / Tenants / Users / Prisma Studio
 *    stay enabled. A TENANT_ADMIN is never gated.
 *  - The persisted order is honoured.
 */
import { buildAdminNavItems } from '../admin-nav-items';
import { DEFAULT_ADMIN_MENU_ORDER } from '@/features/admin/hooks/use-admin-preferences';

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const disabledIds = (items: { id: string; disabled?: boolean }[]) => items.filter((i) => i.disabled).map((i) => i.id);

describe('buildAdminNavItems (TASK-327 T5)', () => {
  it('TENANT_ADMIN sees every admin menu except Prisma Studio', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: false, tenantSelected: false, order: DEFAULT_ADMIN_MENU_ORDER }));
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

  it('global scope (SUPER_ADMIN) additionally sees Prisma Studio', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toContain('studio');
  });

  it('never includes Prisma Studio for a tenant admin even if a saved order lists it', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: false, tenantSelected: false, order: ['studio', 'overview', 'tenants'] }));
    expect(got).not.toContain('studio');
  });

  it('non-admin sees only Overview', () => {
    const got = ids(buildAdminNavItems({ isAdmin: false, isGlobalScope: false, tenantSelected: false, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toEqual(['overview']);
  });

  it('honours the persisted order (and appends unknown ids at the end)', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: ['users', 'tenants', 'overview'] }));
    expect(got.indexOf('users')).toBeLessThan(got.indexOf('tenants'));
    expect(got.indexOf('tenants')).toBeLessThan(got.indexOf('overview'));
    // an id not present in the saved order still renders (after the ranked ones)
    expect(got).toContain('studio');
    expect(got.indexOf('studio')).toBeGreaterThan(got.indexOf('overview'));
  });

  // TASK-331 #1 — tenant gating for global scope.
  describe('tenant gating (TASK-331 #1)', () => {
    it('disables tenant-scoped pages for a global-scope admin with no tenant selected', () => {
      const items = buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: false, order: DEFAULT_ADMIN_MENU_ORDER });
      expect(disabledIds(items).sort()).toEqual(
        ['audio-pipelines', 'audit-logs', 'backend-pipeline', 'configurations', 'departments', 'dna-reports', 'frontend-pipeline', 'prompts', 'storage'].sort(),
      );
      // Overview / Tenants / Users / Prisma Studio remain reachable.
      for (const item of items) {
        if (['overview', 'tenants', 'users', 'studio'].includes(item.id)) {
          expect(item.disabled).toBeFalsy();
        }
      }
      const departments = items.find((i) => i.id === 'departments');
      expect(departments?.disabledReason).toMatch(/select a tenant/i);
    });

    it('enables every page once a tenant is selected', () => {
      const items = buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER });
      expect(disabledIds(items)).toEqual([]);
    });

    it('never gates a TENANT_ADMIN (bound to their own tenant)', () => {
      const items = buildAdminNavItems({ isAdmin: true, isGlobalScope: false, tenantSelected: false, order: DEFAULT_ADMIN_MENU_ORDER });
      expect(disabledIds(items)).toEqual([]);
    });
  });
});
