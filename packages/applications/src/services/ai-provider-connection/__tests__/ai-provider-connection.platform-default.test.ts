/**
 * The platform-default (SYSTEM-tenant) credential cascade.
 *
 * `ai-provider-connection.tenant-lane.test.ts` locks the TENANT tier of
 * `resolveTenantCloudOverrides`. THIS file locks the second tier and the
 * precedence between them (option C):
 *
 *   1. tenant row (ENABLED + keyed) → 2. SYSTEM row (ENABLED + keyed) → absent.
 *
 * The load-bearing contract here is NOT "a SYSTEM key is reachable" — it is
 * that every entry says WHO PAID for it. R3 (already merged) reads
 * `provider_overrides[p].funding` on the wire to decide `deployment`/`costBasis`,
 * and an unlabelled platform entry defaults to `tenant`, producing a perfectly
 * CONSISTENT `BYOK` + `BYOK_NOTIONAL` pair that no ledger guard, and no shadow-
 * metering reconciliation, can detect. So `funding` is DERIVED from the row that
 * supplied the credential (`row.tenantId === SYSTEM_TENANT_ID`) inside the ONE
 * private factory that constructs entries — never stamped by a call site.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT_A = 'tenant-aaa';

function makeRow(overrides: {
  tenantId?: string;
  service?: string;
  provider?: string;
  enabled?: boolean;
  baseUrl?: string | null;
  region?: string | null;
  encryptedApiKey?: Uint8Array | null;
  keyVersion?: number | null;
  extraJson?: Record<string, unknown> | null;
}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? TENANT_A,
    service: overrides.service ?? 'llm',
    provider: overrides.provider ?? 'azure',
    baseUrl: overrides.baseUrl ?? null,
    region: overrides.region ?? null,
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : overrides.encryptedApiKey,
    keyVersion: overrides.keyVersion === undefined ? 3 : overrides.keyVersion,
    extraJson: overrides.extraJson ?? null,
  });
}

/**
 * Rows are served BY TENANT, exactly as the repository does, so a test can
 * never accidentally hand the resolver a row it did not ask for — the whole
 * point of assertion 9 below.
 */
function makeService(opts: {
  rowsByTenant?: Record<string, unknown[]>;
  withVault?: boolean;
  entitled?: boolean;
  decrypt?: (cipher: unknown) => Promise<Buffer>;
} = {}) {
  const rowsByTenant = opts.rowsByTenant ?? {};
  const repo = {
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      const rows = (rowsByTenant[tenantId] ?? []) as any[];
      return rows.find((r) => r.service === service && r.provider === provider) ?? null;
    }),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service),
    ),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets =
    opts.withVault === false
      ? undefined
      : {
          encrypt: vi.fn(async () => 'vault:v3:cipher'),
          decrypt: vi.fn(opts.decrypt ?? (async () => Buffer.from('plaintext-key', 'utf8'))),
          supportsTransit: vi.fn(() => true),
        };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  const warn = vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo, warn, entitlements };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveTenantCloudOverrides — SYSTEM-tenant cascade (R1)', () => {
  it('1. serves the SYSTEM row when the tenant has none, labelled funding=platform', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })] },
    });

    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides.azure).toMatchObject({ api_key: 'plaintext-key', funding: 'platform' });
  });

  it('2. the tenant row beats the SYSTEM row, and the SYSTEM value is absent from the result', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', baseUrl: 'https://tenant.example' })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure', baseUrl: 'https://platform.example' })],
      },
    });

    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides.azure).toMatchObject({ base_url: 'https://tenant.example', funding: 'tenant' });
    expect(JSON.stringify(overrides)).not.toContain('platform.example');
  });

  it('3. merges PER PROVIDER — a tenant azure key does not suppress the platform sarvam key', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ service: 'tts', provider: 'azure' })],
        [SYSTEM_TENANT_ID]: [
          makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'tts', provider: 'azure' }),
          makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'tts', provider: 'sarvam' }),
        ],
      },
    });

    const { overrides } = await svc.resolveTenantCloudOverrides('tts', TENANT_A);
    // The funding label has the same granularity as the merge — asserted here
    // rather than in a hand-built map, because deriving it per ROW is the only
    // thing that makes a mixed call bill correctly.
    expect(overrides.azure.funding).toBe('tenant');
    expect(overrides.sarvam.funding).toBe('platform');
  });

  it('4. a DISABLED SYSTEM row is absent — the shipped all-disabled seed stays behaviour-neutral', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: false })] },
    });
    await expect(svc.resolveTenantCloudOverrides('llm', TENANT_A)).resolves.toEqual({ overrides: {} });
  });

  it('5. a keyless ENABLED SYSTEM row produces no entry', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, encryptedApiKey: null, keyVersion: null })] },
    });
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides).toEqual({});
  });

  it('6. a SYSTEM row for a non-cloud-BYO provider is never injected (self-host base_url is not a credential)', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'ollama', baseUrl: 'http://localhost:11434' })] },
    });
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides).toEqual({});
  });

  it('7. a SYSTEM credential that will not decrypt is skipped per-credential; the tenant tier still resolves', async () => {
    const { svc, warn } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'bedrock', region: 'eu-west-1' })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure', keyVersion: 9 })],
      },
      decrypt: async (cipher: unknown) => {
        // The SYSTEM row is the one that fails; the tenant row decrypts.
        if (String(cipher).includes('cipher')) {
          throw new Error('vault transit: key version 9 not found');
        }
        return Buffer.from('good-key', 'utf8');
      },
    });

    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides.azure).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const arg = warn.mock.calls[0][0] as Record<string, unknown>;
    // A decrypt fault is NOT a veto and must never be reported as one; the log
    // stays non-secret and identifies the tier that failed.
    expect(Object.keys(arg).sort()).toEqual(['keyVersion', 'message', 'provider', 'service', 'tenantId']);
    expect(arg.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('8. no Vault secrets provider → {} and no read at all (unchanged short-circuit)', async () => {
    const { svc, repo } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] },
      withVault: false,
    });
    await expect(svc.resolveTenantCloudOverrides('llm', TENANT_A)).resolves.toEqual({ overrides: {} });
    expect(repo.findByTenantIdAndService).not.toHaveBeenCalled();
  });

  it('9. reads exactly two tenantIds — the caller and SYSTEM — and nothing else', async () => {
    const { svc, repo } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure' })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'sarvam', service: 'tts' })],
      },
    });

    await svc.resolveTenantCloudOverrides('llm', TENANT_A);

    const readTenantIds = repo.findByTenantIdAndService.mock.calls.map((c) => c[1]);
    expect(readTenantIds).toEqual([TENANT_A, SYSTEM_TENANT_ID]);
  });

  it('9b. resolving FOR the SYSTEM tenant reads once — there is no second tier above the platform', async () => {
    const { svc, repo } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure' })] },
    });

    const { overrides } = await svc.resolveTenantCloudOverrides('llm', SYSTEM_TENANT_ID);
    expect(repo.findByTenantIdAndService).toHaveBeenCalledTimes(1);
    // The row IS the platform's own, so it is still platform-funded — the label
    // follows the row, not the caller.
    expect(overrides.azure.funding).toBe('platform');
  });
});

describe('resolveConnection — the by-provider counterpart shares the same cascade (OD-5)', () => {
  it('10a. prefers an ENABLED tenant row', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ provider: 'azure', baseUrl: 'https://tenant.example' })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure', baseUrl: 'https://platform.example' })],
      },
    });
    const resolved = await svc.resolveConnection('llm', 'azure', TENANT_A);
    expect(resolved).toMatchObject({ baseUrl: 'https://tenant.example', source: 'tenant' });
  });

  it('10b. falls through an ABSENT tenant row to the SYSTEM row', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure', baseUrl: 'https://platform.example' })] },
    });
    const resolved = await svc.resolveConnection('llm', 'azure', TENANT_A);
    expect(resolved).toMatchObject({ baseUrl: 'https://platform.example', source: 'system' });
  });

  it('10c. a DISABLED SYSTEM row resolves to null (the env-fallback signal)', async () => {
    const { svc } = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'azure', enabled: false })] },
    });
    await expect(svc.resolveConnection('llm', 'azure', TENANT_A)).resolves.toBeNull();
  });

  it('10d. a SELF-HOST provider is NOT entitlement-gated — platform infrastructure is not platform SPEND', async () => {
    const { svc, entitlements } = makeService({
      entitled: false,
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'ollama', baseUrl: 'http://vllm.internal:8000' })],
      },
    });
    const resolved = await svc.resolveConnection('llm', 'ollama', TENANT_A);
    expect(resolved).toMatchObject({ baseUrl: 'http://vllm.internal:8000', source: 'system' });
    expect(entitlements.isFeatureEnabled).not.toHaveBeenCalled();
  });
});
