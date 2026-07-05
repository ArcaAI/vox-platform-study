/**
 * TASK-392 Phase 5 — plan-entitlements endpoint constants.
 *
 * Verifies the admin surface stays on the admin plane (so the impersonation
 * admin JWT is used) while the self-view stays on the user plane, and that the
 * per-plan/per-tenant builders encode their segments.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { ENTITLEMENTS_ENDPOINTS, isAdminPlanePath } from '../constants';

describe('TASK-392 ENTITLEMENTS_ENDPOINTS', () => {
  it('exposes the full global-admin + self-view surface', () => {
    expect(Object.keys(ENTITLEMENTS_ENDPOINTS)).toEqual(
      expect.arrayContaining([
        'ENABLED',
        'PLANS',
        'PLAN',
        'TENANT_SNAPSHOT',
        'TENANT_OVERRIDE',
        'TENANT_DOWNGRADE',
        'TRIAL_EXPIRY_RUN',
        'ME',
      ]),
    );
  });

  it('builds per-plan/per-tenant paths with encoded segments', () => {
    expect(ENTITLEMENTS_ENDPOINTS.PLAN('PRO')).toBe('/admin/entitlements/plans/PRO');
    expect(ENTITLEMENTS_ENDPOINTS.TENANT_SNAPSHOT('t 1')).toBe('/admin/entitlements/tenants/t%201');
    expect(ENTITLEMENTS_ENDPOINTS.TENANT_OVERRIDE('t/1')).toBe('/admin/entitlements/tenants/t%2F1/override');
    expect(ENTITLEMENTS_ENDPOINTS.TENANT_DOWNGRADE('abc')).toBe('/admin/entitlements/tenants/abc/downgrade');
  });

  it('routes admin endpoints on the admin plane (admin JWT during impersonation)', () => {
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.ENABLED)).toBe(true);
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.PLANS)).toBe(true);
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.PLAN('PRO'))).toBe(true);
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.TENANT_OVERRIDE('abc'))).toBe(true);
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.TRIAL_EXPIRY_RUN)).toBe(true);
  });

  it('keeps the tenant self-view on the user plane (active token)', () => {
    expect(ENTITLEMENTS_ENDPOINTS.ME).toBe('/entitlements/me');
    expect(isAdminPlanePath(ENTITLEMENTS_ENDPOINTS.ME)).toBe(false);
  });
});
