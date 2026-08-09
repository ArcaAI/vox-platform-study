/**
 * TASK-643 R6 (entitlement gate) × R4 (opt-out veto).
 *
 * Two independent reasons the SYSTEM tier may not serve a tenant, with
 * deliberately different errors because the remediation differs:
 *
 *   - NO GRANT (`featurePlatformDefaultCredential`) — tenant-wide, → 403. The
 *     tenant cannot fix it; their account owner can.
 *   - VETO (the tenant's own row for that (service, provider) is DISABLED) —
 *     per provider, → 409. A tenant admin fixes it in the console.
 *
 * The gate lives inside the ONE private cascade helper, evaluated BEFORE the
 * SYSTEM read, so a tenant with no grant costs exactly one query and the
 * platform's ciphertext is never fetched for a caller not allowed to use it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ProviderCredentialVetoedException, QuotaExceededException } from '@arcaai/exceptions';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { assertProviderAvailable } from '../assert-provider-available';

const TENANT_A = 'tenant-aaa';

function makeRow(overrides: { tenantId?: string; service?: string; provider?: string; enabled?: boolean; encryptedApiKey?: Uint8Array | null }) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? TENANT_A,
    service: overrides.service ?? 'tts',
    provider: overrides.provider ?? 'azure',
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : overrides.encryptedApiKey,
    keyVersion: 3,
  });
}

function makeService(opts: { rowsByTenant?: Record<string, unknown[]>; entitled?: boolean; entitlements?: unknown } = {}) {
  const rowsByTenant = opts.rowsByTenant ?? {};
  const repo = {
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      const rows = (rowsByTenant[tenantId] ?? []) as any[];
      return rows.find((r) => r.service === service && r.provider === provider) ?? null;
    }),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service),
    ),
  };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)) };
  const secrets = {
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = opts.entitlements === undefined ? { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) } : opts.entitlements;
  const svc = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    cls as any,
    secrets as any,
    entitlements as any,
  );
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo, entitlements: entitlements as { isFeatureEnabled: ReturnType<typeof vi.fn> } };
}

beforeEach(() => vi.clearAllMocks());

describe('the entitlement gate (R6)', () => {
  it('30. an UNGRANTED tenant gets nothing AND the SYSTEM read never happens', async () => {
    const { svc, repo } = makeService({
      entitled: false,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides).toEqual({});

    // ONE query — identical cost to the pre-cascade behaviour — and the
    // platform's ciphertext is never fetched for a tenant that may not use it.
    expect(repo.findByTenantIdAndService).toHaveBeenCalledTimes(1);
    expect(repo.findByTenantIdAndService.mock.calls[0][1]).toBe(TENANT_A);
  });

  it('31. a GRANTED tenant reaches the SYSTEM tier', async () => {
    const { svc, repo } = makeService({
      entitled: true,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides.azure).toMatchObject({ funding: 'platform' });
    expect(repo.findByTenantIdAndService).toHaveBeenCalledTimes(2);
  });

  it('32. resolveConnection is gated identically — one choke point, not two', async () => {
    const { svc } = makeService({
      entitled: false,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });
    await expect(svc.resolveConnection('tts', 'azure', TENANT_A)).resolves.toBeNull();
  });

  it('33. the suppression is REPORTED, never silently empty', async () => {
    const denied = makeService({ entitled: false, rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] } });
    const granted = makeService({ entitled: true, rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] } });

    expect((await denied.svc.resolveTenantCloudOverrides('tts', TENANT_A)).platformDefault).toEqual({
      entitlementSuppressed: true,
      vetoed: [],
    });
    expect((await granted.svc.resolveTenantCloudOverrides('tts', TENANT_A)).platformDefault).toBeUndefined();
  });

  it('an ABSENT entitlements service denies — a missing gate must not spend the platform’s money', async () => {
    const { svc, repo } = makeService({
      entitlements: null,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });
    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides).toEqual({});
    expect(repo.findByTenantIdAndService).toHaveBeenCalledTimes(1);
  });

  it('the gate is asked for the RESOLVING tenant and the platform-default feature, once', async () => {
    const { svc, entitlements } = makeService({ entitled: true });
    await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(entitlements.isFeatureEnabled).toHaveBeenCalledExactlyOnceWith(TENANT_A, 'platformDefaultCredential');
  });
});

describe('the opt-out veto (R4)', () => {
  it('34. a DISABLED tenant row blocks BOTH tiers for that provider only', async () => {
    const { svc } = makeService({
      entitled: true,
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' }), makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'sarvam' })],
      },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    // Fails CLOSED for azure — never the platform default, never a different provider.
    expect(resolved.overrides.azure).toBeUndefined();
    expect(resolved.overrides.sarvam).toMatchObject({ funding: 'platform' });
    expect(resolved.platformDefault).toEqual({ entitlementSuppressed: false, vetoed: ['azure'] });
  });

  it('35. the veto beats the grant — a tenant’s data-handling refusal outranks a commercial grant', async () => {
    const { svc } = makeService({
      entitled: true,
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })],
      },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides.azure).toBeUndefined();
    expect(() => assertProviderAvailable(resolved, 'tts', 'azure')).toThrow(ProviderCredentialVetoedException);
  });

  it('35b. vetoing AND ungranted still raises the VETO — the more specific, more local fact', async () => {
    const { svc } = makeService({
      entitled: false,
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })],
      },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.platformDefault).toEqual({ entitlementSuppressed: true, vetoed: ['azure'] });
    expect(() => assertProviderAvailable(resolved, 'tts', 'azure')).toThrow(ProviderCredentialVetoedException);
    // …while a provider the tenant never vetoed reports the commercial reason.
    expect(() => assertProviderAvailable(resolved, 'tts', 'sarvam')).toThrow(QuotaExceededException);
  });

  it('36. a KEYLESS but ENABLED tenant row is an incomplete setup, NOT a veto', async () => {
    const { svc } = makeService({
      entitled: true,
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', enabled: true, encryptedApiKey: null })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })],
      },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides.azure).toMatchObject({ funding: 'platform' });
    expect(resolved.platformDefault).toBeUndefined();
  });

  it('a veto also blocks resolveConnection, without fetching the platform row', async () => {
    const { svc, repo } = makeService({
      entitled: true,
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })],
      },
    });
    await expect(svc.resolveConnection('tts', 'azure', TENANT_A)).resolves.toBeNull();
    expect(repo.findByTenantServiceProvider.mock.calls.map((c) => c[2])).toEqual([TENANT_A]);
  });
});

describe('37. assertProviderAvailable — the attributable-error matrix', () => {
  it('veto → ProviderCredentialVetoedException, carrying the (service, provider)', () => {
    const resolved = { overrides: {}, platformDefault: { entitlementSuppressed: false, vetoed: ['azure'] } };
    try {
      assertProviderAvailable(resolved, 'tts', 'azure');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderCredentialVetoedException);
      expect((err as ProviderCredentialVetoedException).metadata).toMatchObject({ service: 'tts', provider: 'azure' });
    }
  });

  it('no grant → QuotaExceededException with capability featurePlatformDefaultCredential', () => {
    const resolved = { overrides: {}, platformDefault: { entitlementSuppressed: true, vetoed: [] } };
    try {
      assertProviderAvailable(resolved, 'llm', 'azure');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededException);
      expect((err as QuotaExceededException).metadata).toMatchObject({ capability: 'featurePlatformDefaultCredential' });
    }
  });

  it('neither → returns void; nothing configured stays the downstream 503', () => {
    expect(assertProviderAvailable({ overrides: {} }, 'llm', 'azure')).toBeUndefined();
    expect(assertProviderAvailable({ overrides: { azure: { api_key: 'k', funding: 'platform' } } }, 'llm', 'azure')).toBeUndefined();
  });

  it('a provider that HAS an override never throws, whatever was suppressed for others', () => {
    const resolved = {
      overrides: { sarvam: { api_key: 'k', funding: 'platform' as const } },
      platformDefault: { entitlementSuppressed: false, vetoed: ['azure'] },
    };
    expect(assertProviderAvailable(resolved, 'tts', 'sarvam')).toBeUndefined();
  });
});
