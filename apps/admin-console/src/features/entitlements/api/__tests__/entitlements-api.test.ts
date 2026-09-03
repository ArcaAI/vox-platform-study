import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTenantOverride,
  getEnforcementEnabled,
  getPlanEntitlement,
  getTenantEntitlements,
  getTenantOverride,
  listPlanEntitlements,
  runTrialExpiry,
  setEnforcementEnabled,
  triggerDowngrade,
  updatePlanEntitlement,
  upsertTenantOverride,
} from '../client';
import { entitlementKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ enabled: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('entitlementKeys', () => {
  it('is stable and scoped per plan/tenant', () => {
    expect(entitlementKeys.plan('PRO')).toEqual(entitlementKeys.plan('PRO'));
    expect(entitlementKeys.plan('PRO')).not.toEqual(entitlementKeys.plan('TRIAL'));
    expect(entitlementKeys.tenant('t-1')).not.toEqual(entitlementKeys.override('t-1'));
    for (const key of [entitlementKeys.enabled(), entitlementKeys.plans(), entitlementKeys.tenant('x'), entitlementKeys.override('x')]) {
      expect(key[0]).toBe('entitlements');
    }
  });
});

describe('entitlements client', () => {
  it('reads and flips the enforcement kill-switch', async () => {
    const calls = installFetchMock();
    await getEnforcementEnabled();
    await setEnforcementEnabled(true);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/entitlements/enabled',
      'PUT /api/hope/admin/entitlements/enabled',
    ]);
    expect(calls[1].body).toEqual({ enabled: true });
  });

  it('updates a plan via body expectedVersion only (no If-Match on this route)', async () => {
    const calls = installFetchMock();
    await listPlanEntitlements();
    await getPlanEntitlement('PRO');
    await updatePlanEntitlement('PRO', { maxUsers: 50, expectedVersion: 3 });
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].url).toBe('/api/hope/admin/entitlements/plans/PRO');
    // phase 2: the route requires `If-Match`; the validator is the
    // version the caller already read and carries in the body.
    expect(calls[2].headers.get('if-match')).toBe('"3"');
    expect(calls[2].body).toEqual({ maxUsers: 50, expectedVersion: 3 });
  });

  it('manages per-tenant overrides and operational triggers', async () => {
    const calls = installFetchMock();
    await getTenantEntitlements('t-1');
    await getTenantOverride('t-1');
    await upsertTenantOverride('t-1', { maxUsers: 10, expectedVersion: 2 });
    await clearTenantOverride('t-1');
    await triggerDowngrade('t-1', 'STARTER');
    await runTrialExpiry();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/entitlements/tenants/t-1',
      'GET /api/hope/admin/entitlements/tenants/t-1/override',
      'PUT /api/hope/admin/entitlements/tenants/t-1/override',
      'DELETE /api/hope/admin/entitlements/tenants/t-1/override',
      'POST /api/hope/admin/entitlements/tenants/t-1/downgrade',
      'POST /api/hope/admin/entitlements/trial-expiry/run',
    ]);
    // The override PUT echoes the read version as `If-Match`; with no row the
    // client would send the create-intent validator `"0"` instead.
    expect(calls[2].headers.get('if-match')).toBe('"2"');
    expect(calls[4].body).toEqual({ plan: 'STARTER' });
  });
});
