/**
 * TASK-327 T5 / TASK-331 #1 — admin nav is scope-driven, not visibility-driven.
 *
 *  - Any admin (incl. TENANT_ADMIN) sees the full admin menu set EXCEPT
 *    Prisma Studio.
 *  - Global scope (GLOBAL_ADMIN) additionally sees Prisma Studio.
 *  - Non-admins see no admin nav items (the Administration group is hidden).
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
  it('TENANT_ADMIN sees every admin menu except the global-scope ops surfaces', () => {
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
        // TASK-336 OB-02 — tenant-wide jobs view is available to any admin.
        'jobs',
        // TASK-330 Phase 6 — harness console is available to any admin.
        'harness',
      ]),
    );
    // Prisma Studio, System Health, Rate Limits and Queues & Jobs are global-scope only.
    expect(got).not.toContain('studio');
    expect(got).not.toContain('system-health');
    expect(got).not.toContain('rate-limits');
    expect(got).not.toContain('queues');
  });

  // TASK-336 OB-01 / IC-05 / OB-03 — System Health, Rate Limits and Queues & Jobs
  // are global-scope ops surfaces (global-admin only), surfaced alongside Prisma Studio.
  it('global scope (GLOBAL_ADMIN) additionally sees System Health, Rate Limits and Queues & Jobs', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toContain('system-health');
    expect(got).toContain('rate-limits');
    expect(got).toContain('queues');
  });

  // TASK-331 doc-03 #2 — the three pipeline nav entries are consolidated into a
  // single "Audio Pipelines" page; the standalone Frontend/Backend Pipeline
  // entries are removed.
  it('no longer lists the standalone Frontend/Backend Pipeline entries', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toContain('audio-pipelines');
    expect(got).not.toContain('frontend-pipeline');
    expect(got).not.toContain('backend-pipeline');
  });

  it('global scope (GLOBAL_ADMIN) additionally sees Prisma Studio', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toContain('studio');
  });

  it('never includes Prisma Studio for a tenant admin even if a saved order lists it', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: false, tenantSelected: false, order: ['studio', 'overview', 'tenants'] }));
    expect(got).not.toContain('studio');
  });

  it('non-admin sees no admin nav items', () => {
    const got = ids(buildAdminNavItems({ isAdmin: false, isGlobalScope: false, tenantSelected: false, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got).toEqual([]);
  });

  // TASK-331 doc-04 F7b — Prisma Studio (global-only raw-DB tool) is segregated
  // at the END of the default menu order.
  it('places Prisma Studio last in the default order for a global-scope admin', () => {
    const got = ids(buildAdminNavItems({ isAdmin: true, isGlobalScope: true, tenantSelected: true, order: DEFAULT_ADMIN_MENU_ORDER }));
    expect(got[got.length - 1]).toBe('studio');
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
        // TASK-336 OB-02 — `jobs` is tenant-scoped (needs a selected tenant).
        // TASK-330 Phase 6 — `harness` is tenant-scoped too.
        // TASK-356 Phase 1 — `ai-models` (tenant model catalog) is tenant-scoped.
        ['ai-models', 'audio-pipelines', 'audit-logs', 'configurations', 'departments', 'dna-reports', 'harness', 'jobs', 'prompts', 'storage'].sort(),
      );
      // Overview / Tenants / Users / Prisma Studio + the global-scope ops
      // surfaces (System Health, Rate Limits, Queues & Jobs) remain reachable
      // without a tenant.
      for (const item of items) {
        if (['overview', 'tenants', 'users', 'studio', 'system-health', 'rate-limits', 'queues'].includes(item.id)) {
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
