/**
 * (entitlement gate) × R4 (opt-out veto).
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
import { withTask958Lookups } from './task958-repo-lookups';

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
  const repo = withTask958Lookups({
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      const rows = (rowsByTenant[tenantId] ?? []) as any[];
      return rows.find((r) => r.service === service && r.provider === provider) ?? null;
    }),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service),
    ),
  });
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)) };
  const secrets = {
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements =
    opts.entitlements === undefined
      ? { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true), assertQuantityQuota: vi.fn() }
      : opts.entitlements;
  const svc = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    cls as any,
    secrets as any,
    entitlements as any,
  );
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo, secrets, entitlements: entitlements as { isFeatureEnabled: ReturnType<typeof vi.fn> } };
}

beforeEach(() => vi.clearAllMocks());

describe('the entitlement gate (R6)', () => {
  it('30. an UNGRANTED tenant gets no platform VENDOR credential, and it is never decrypted', async () => {
    const { svc, repo, secrets } = makeService({
      entitled: false,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });

    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides).toEqual({});

    // C — the whole-service read no longer skips the SYSTEM tier
    // wholesale. It cannot: the denial is PER PROVIDER (it governs platform
    // SPEND on a vendor account, never platform INFRASTRUCTURE), and only the
    // rows themselves say which providers it covers. Skipping the read also
    // withheld the platform's self-host rows, which is what made `rerank:tei`
    // and `vector:qdrant` storable but undeliverable.
    //
    // The property that actually mattered is preserved exactly: a suppressed
    // row is never DECRYPTED, so no plaintext key material is produced for a
    // caller that may not use it. The ciphertext read is inert.
    expect(secrets.decrypt).not.toHaveBeenCalled();
    expect(repo.findByTenantIdAndService.mock.calls.map((c: any[]) => c[1])).toEqual([TENANT_A, SYSTEM_TENANT_ID]);
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
    const { svc, secrets } = makeService({
      entitlements: null,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
    });
    const resolved = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    expect(resolved.overrides).toEqual({});
    expect(resolved.platformDefault?.entitlementSuppressed).toBe(true);
    // As in test 30: the vendor row is read but never decrypted.
    expect(secrets.decrypt).not.toHaveBeenCalled();
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

  // ── model-registry — outside the gate by construction (owner ruling 2026-08-24)
  //
  // `gateApplies` keys off `isCloudByoProvider`, so making `model-registry`
  // platform-managed did not merely close tenant WRITES — it also moved the
  // plane out of the entitlement gate on the READ side. That is the consumption
  // half of "SYSTEM default, used as default/fallback for ALL other tenants",
  // and it is a behavioural consequence of a one-line map edit, so it is pinned
  // here rather than left to be rediscovered.
  describe('model-registry — the platform weight-fetch plane serves every tenant', () => {
    it('resolves the SYSTEM row for an UNENTITLED tenant — the gate no longer reaches this plane', async () => {
      const isFeatureEnabled = vi.fn(async () => false); // no platform-default grant
      const { svc } = makeService({
        rowsByTenant: {
          [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'model-registry', provider: 'huggingface' })],
        },
        entitlements: { isFeatureEnabled },
      });

      const res = await svc.resolveCredential('model-registry', 'huggingface', TENANT_A);

      // The gate is still ASKED (resolveCredential uses the whole-service shape,
      // which always evaluates it once), but suppression is applied PER ROW at
      // `ai-provider-connection.service.ts:707`, behind the same
      // `isCloudByoProvider` predicate the write guard uses. So the answer no
      // longer reaches this plane, and the platform row serves regardless.
      expect(res.outcome).toBe('resolved');
      expect(res.funding).toBe('platform');
      expect(isFeatureEnabled).toHaveBeenCalled();
    });

    it('still applies the gate to a genuinely cloud-BYO service, so this is a scoped exemption not a hole', async () => {
      const isFeatureEnabled = vi.fn(async () => false);
      const { svc } = makeService({
        rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'tts', provider: 'azure' })] },
        entitlements: { isFeatureEnabled },
      });

      const res = await svc.resolveCredential('tts', 'azure', TENANT_A);

      expect(res.outcome).not.toBe('resolved');
      expect(isFeatureEnabled).toHaveBeenCalled();
    });
  });
});
