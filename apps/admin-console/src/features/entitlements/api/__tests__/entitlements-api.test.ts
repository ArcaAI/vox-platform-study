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

  it('carries the workflow and provider-connection caps on both tiers', async () => {
    const calls = installFetchMock();
    await updatePlanEntitlement('PRO', {
      maxWorkflowDefinitions: 25,
      monthlyWorkflowInvocations: 50_000,
      maxAiProviderConnections: 4,
      expectedVersion: 3,
    });
    // The tenant tier expresses "inherit the plan default" as an explicit null.
    await upsertTenantOverride('t-1', {
      maxWorkflowDefinitions: null,
      monthlyWorkflowInvocations: 900,
      maxAiProviderConnections: 1,
      expectedVersion: 2,
    });

    expect(calls[0].body).toEqual({
      maxWorkflowDefinitions: 25,
      monthlyWorkflowInvocations: 50_000,
      maxAiProviderConnections: 4,
      expectedVersion: 3,
    });
    expect(calls[1].body).toEqual({
      maxWorkflowDefinitions: null,
      monthlyWorkflowInvocations: 900,
      maxAiProviderConnections: 1,
      expectedVersion: 2,
    });
  });

  it('carries the five monthly service allowances on both tiers', async () => {
    const calls = installFetchMock();
    await updatePlanEntitlement('PRO', {
      monthlySttSessionSeconds: 360_000,
      monthlyLlmTokens: 20_000_000,
      monthlyTtsCharacters: 1_500_000,
      monthlyNlpTextUnits: 80_000,
      monthlyEmbeddingTokens: 5_000_000,
      expectedVersion: 3,
    });
    // Same inherit-vs-set split the caps use: null inherits, a number overrides.
    await upsertTenantOverride('t-1', {
      monthlySttSessionSeconds: null,
      monthlyLlmTokens: 999,
      monthlyTtsCharacters: null,
      monthlyNlpTextUnits: null,
      monthlyEmbeddingTokens: null,
      expectedVersion: 2,
    });

    expect(calls[0].body).toEqual({
      monthlySttSessionSeconds: 360_000,
      monthlyLlmTokens: 20_000_000,
      monthlyTtsCharacters: 1_500_000,
      monthlyNlpTextUnits: 80_000,
      monthlyEmbeddingTokens: 5_000_000,
      expectedVersion: 3,
    });
    expect(calls[1].body).toEqual({
      monthlySttSessionSeconds: null,
      monthlyLlmTokens: 999,
      monthlyTtsCharacters: null,
      monthlyNlpTextUnits: null,
      monthlyEmbeddingTokens: null,
      expectedVersion: 2,
    });
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
