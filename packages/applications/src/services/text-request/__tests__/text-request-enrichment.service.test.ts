/**
 * C.1 — the DELIVERY half of the P1-C fix, on the TEXT path.
 *
 * Phase 1 (P1-C) fixed the RESOLVER so a keyed SYSTEM row for a SELF-HOSTED
 * provider is delivered: "a TENANT may not own this" is not "the PLATFORM may
 * not serve it". But `TextRequestEnrichmentService` short-circuited on
 * `isCloudByoProvider('llm', provider)` and returned BEFORE the resolver was
 * ever called, so on the TEXT path a super-admin-configured self-host engine
 * still could not reach any tenant — `TEXT_OPENAI_COMPAT_API_KEY` /
 * `TEXT_VLLM_API_KEY` were listed as migratable but were not, end to end.
 *
 * These tests drive the enrichment service against the REAL
 * `AiProviderConnectionService` (only the repository, Vault and entitlements
 * are doubles), because the gap was precisely that the two were never wired
 * together. Mocking the resolver here would re-create the blind spot.
 *
 * Every property the resolver already guarantees is re-asserted THROUGH the
 * text path, so this file also pins that the fix did not weaken any of them:
 * keyless rows inject on neither tier; the tenant tier still refuses non-cloud
 * rows; cloud SYSTEM rows stay entitlement-gated while self-host SYSTEM rows do
 * not; funding stays DERIVED from the row that supplied the credential.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ProviderCredentialVetoedException, QuotaExceededException } from '@arcaai/exceptions';
import { AiProviderConnectionService } from '../../ai-provider-connection/ai-provider-connection.service';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

const TENANT_A = 'tenant-aaa';

/** A self-host LLM engine: platform INFRASTRUCTURE, never a tenant-owned credential. */
const SELF_HOST = 'vllm';
/** A cloud BYO LLM provider: platform SPEND when the SYSTEM tier supplies it. */
const CLOUD = 'azure';

function makeRow(o: {
  tenantId?: string;
  provider?: string;
  enabled?: boolean;
  baseUrl?: string | null;
  encryptedApiKey?: Uint8Array | null;
}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: o.tenantId ?? SYSTEM_TENANT_ID,
    service: 'llm',
    provider: o.provider ?? SELF_HOST,
    baseUrl: o.baseUrl ?? null,
    enabled: o.enabled ?? true,
    encryptedApiKey: o.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : o.encryptedApiKey,
    keyVersion: 3,
    extraJson: null,
  });
}

/**
 * The enrichment service wired to a REAL resolver. `rowsByTenant` is the whole
 * database; `entitled` is the `featurePlatformDefaultCredential` grant.
 */
function makeEnrichment(opts: { rowsByTenant?: Record<string, unknown[]>; entitled?: boolean } = {}) {
  const rowsByTenant = opts.rowsByTenant ?? {};
  const repo = {
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      const rows = (rowsByTenant[tenantId] ?? []) as any[];
      return rows.find((r) => r.service === service && r.provider === provider) ?? null;
    }),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service),
    ),
    findDeletedByTenantServiceProvider: vi.fn(async () => null),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)),
  };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) };

  const connections = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    cls as any,
    secrets as any,
    entitlements as any,
  );
  vi.spyOn((connections as any).logger, 'warn').mockImplementation(() => undefined);

  const enrichment = new TextRequestEnrichmentService(cls as any, connections);
  vi.spyOn((enrichment as any).logger, 'warn').mockImplementation(() => undefined);

  return { enrichment, connections, repo, secrets, entitlements };
}

beforeEach(() => vi.clearAllMocks());

// ──────────────── the gap this lane closes ────────────────

describe('R2-C.1 — a keyed SYSTEM self-host row reaches the TEXT path', () => {
  it('injects the platform credential for a self-hosted engine', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST, baseUrl: 'http://vllm:8000/v1' })] },
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    // THE regression: this was `undefined` because the short-circuit returned
    // before the resolver was ever consulted.
    expect((body as any).provider_overrides).toBeDefined();
    expect((body as any).provider_overrides[SELF_HOST].api_key).toBe('plaintext-key');
    expect((body as any).provider_overrides[SELF_HOST].base_url).toBe('http://vllm:8000/v1');
  });

  it('actually consults the resolver for a self-host provider', async () => {
    const { enrichment, connections } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST })] },
    });
    const spy = vi.spyOn(connections, 'resolveTenantCloudOverrides');

    await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect(spy).toHaveBeenCalledWith('llm', TENANT_A);
  });

  it('still injects for a cloud provider (the pre-existing path is unchanged)', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: CLOUD })] },
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: CLOUD });

    expect((body as any).provider_overrides[CLOUD].api_key).toBe('plaintext-key');
  });
});

// ──────────────── the guarantees that must NOT weaken ────────────────

describe('R2-C.1 — every resolver guarantee survives the wider path', () => {
  it('a KEYLESS SYSTEM row injects nothing — a base_url never becomes a credential', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST, baseUrl: 'http://vllm:8000/v1', encryptedApiKey: null })],
      },
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect((body as any).provider_overrides).toBeUndefined();
  });

  it('a KEYLESS TENANT cloud row injects nothing either', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: CLOUD, encryptedApiKey: null })] },
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: CLOUD });

    expect((body as any).provider_overrides).toBeUndefined();
  });

  it('the TENANT tier still refuses a non-cloud row (a tenant may not own platform infrastructure)', async () => {
    const { enrichment } = makeEnrichment({
      // A row that predates the write guard: tenant-owned, self-host provider.
      rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: SELF_HOST })] },
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect((body as any).provider_overrides).toBeUndefined();
  });

  it('a CLOUD SYSTEM row stays entitlement-gated (platform SPEND) and raises an attributable 403', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: CLOUD })] },
      entitled: false,
    });

    await expect(enrichment.applyTenantProviderOverrides({ provider: CLOUD })).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('a SELF-HOST SYSTEM row is NOT entitlement-gated (platform INFRASTRUCTURE)', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST })] },
      entitled: false,
    });

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect((body as any).provider_overrides[SELF_HOST].api_key).toBe('plaintext-key');
  });

  it('an unentitled tenant on an UNCONFIGURED self-host provider proceeds on env, never a 403', async () => {
    // The entitlement gate governs platform SPEND on a vendor account. A
    // self-host engine is not spend, so "nothing configured" must stay the
    // pre-existing downstream fallback — not a policy refusal.
    const { enrichment } = makeEnrichment({ rowsByTenant: {}, entitled: false });

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect((body as any).provider_overrides).toBeUndefined();
  });

  it('a suppressed row is never DECRYPTED', async () => {
    const { enrichment, secrets } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: CLOUD })] },
      entitled: false,
    });

    await expect(enrichment.applyTenantProviderOverrides({ provider: CLOUD })).rejects.toBeInstanceOf(QuotaExceededException);
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('derives funding from the tier that supplied the credential', async () => {
    const platform = makeEnrichment({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST })] } });
    const platformBody = await platform.enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });
    expect((platformBody as any).provider_overrides[SELF_HOST].funding).toBe('platform');

    const tenant = makeEnrichment({ rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: CLOUD })] } });
    const tenantBody = await tenant.enrichment.applyTenantProviderOverrides({ provider: CLOUD });
    expect((tenantBody as any).provider_overrides[CLOUD].funding).toBe('tenant');
  });

  it('a tenant VETO on a cloud provider still raises 409, not a silent fall-through', async () => {
    const { enrichment } = makeEnrichment({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: CLOUD, enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ provider: CLOUD })],
      },
    });

    await expect(enrichment.applyTenantProviderOverrides({ provider: CLOUD })).rejects.toBeInstanceOf(
      ProviderCredentialVetoedException,
    );
  });

  it('a resolver ERROR still fails OPEN with no injection (a fault is not a policy decision)', async () => {
    const { enrichment, connections } = makeEnrichment({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST })] },
    });
    vi.spyOn(connections, 'resolveTenantCloudOverrides').mockRejectedValue(new Error('vault unreachable'));

    const body = await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect((body as any).provider_overrides).toBeUndefined();
  });
});

// ──────────────── the cheap exits stay cheap ────────────────

describe('R2-C.1 — reads are still skipped when they cannot matter', () => {
  // TASK-876 — a caller that already carries `provider_overrides` resolved the credential FOR
  // THE ROW IT IS ABOUT TO RUN (a `core.agent` candidate: the tenant's own agent, or the SYSTEM
  // platform default it fell back to). Recomputing from the CLS tenant would re-fund a
  // platform-served call as that tenant's BYOK — the `funding` label is what TEXT meters.
  it('leaves a caller-supplied provider_overrides untouched and performs NO read', async () => {
    const { enrichment, repo } = makeEnrichment();
    const target = { provider: SELF_HOST, provider_overrides: { [SELF_HOST]: { api_key: 'platform-key', funding: 'platform' } } };

    const result = await enrichment.applyTenantProviderOverrides(target);

    expect(result.provider_overrides).toEqual({ [SELF_HOST]: { api_key: 'platform-key', funding: 'platform' } });
    expect(repo.findByTenantIdAndService).not.toHaveBeenCalled();
    expect(repo.findByTenantServiceProvider).not.toHaveBeenCalled();
  });

  it('performs NO database read when the request names no provider', async () => {
    const { enrichment, repo } = makeEnrichment();

    await enrichment.applyTenantProviderOverrides({});

    expect(repo.findByTenantIdAndService).not.toHaveBeenCalled();
    expect(repo.findByTenantServiceProvider).not.toHaveBeenCalled();
  });

  it('performs NO database read when there is no tenant context', async () => {
    const { enrichment, repo } = makeEnrichment();
    (enrichment as any).clsService.get = vi.fn(() => undefined);

    await enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    expect(repo.findByTenantIdAndService).not.toHaveBeenCalled();
  });

  /**
   * The read pattern a self-host request now pays, pinned so a regression is
   * visible rather than inferred.
   *
   * Before this lane a self-host provider cost ZERO reads (the short-circuit);
   * it now costs exactly what a CLOUD provider has always cost on this path —
   * the whole-service cascade: one tenant-tier read, one entitlement lookup,
   * one SYSTEM-tier read. It is bounded and constant, not per-provider, and it
   * is the same two-query shape the resolver was already performing for every
   * azure/bedrock request in production.
   */
  it('costs the same bounded cascade a cloud provider already cost — no per-provider fan-out', async () => {
    const selfHost = makeEnrichment({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: SELF_HOST })] } });
    await selfHost.enrichment.applyTenantProviderOverrides({ provider: SELF_HOST });

    // Whole-service shape: both tiers read once each, by (service, tenant).
    expect(selfHost.repo.findByTenantIdAndService).toHaveBeenCalledTimes(2);
    expect(selfHost.repo.findByTenantIdAndService.mock.calls.map((c: any[]) => c[1])).toEqual([TENANT_A, SYSTEM_TENANT_ID]);
    expect(selfHost.entitlements.isFeatureEnabled).toHaveBeenCalledTimes(1);

    const cloud = makeEnrichment({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: CLOUD })] } });
    await cloud.enrichment.applyTenantProviderOverrides({ provider: CLOUD });

    expect(cloud.repo.findByTenantIdAndService).toHaveBeenCalledTimes(2);
  });
});
