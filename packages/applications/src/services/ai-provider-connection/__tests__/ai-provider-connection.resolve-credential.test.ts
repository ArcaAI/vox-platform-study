/**
 * TASK-799 — `resolveCredential`, the four-outcome projection of the cascade.
 *
 * The model-registry credentials (`HUGGINGFACE_TOKEN`, `STT_MODEL_S3_*`) are
 * consumed by a Python process that holds no DB handle, so they can only arrive
 * over the gateway. This method is what a `/internal/*` route projects: it does
 * NOT reimplement the cascade — `resolveTenantCloudOverrides` stays the one
 * place tenant-vs-SYSTEM precedence, the veto set, the entitlement gate and
 * derived funding live — it only maps that result onto the four outcomes a
 * fail-closed consumer needs.
 *
 * The `absent` / `unavailable` split is the load-bearing part. `absent` means
 * no tier has an opinion, which for a PUBLIC HuggingFace repo is the correct
 * resolved state (pull anonymously). `unavailable` means the gateway could not
 * answer. Collapsing them would turn a Vault outage into a silent downgrade
 * from an entitled pull to an anonymous one — which on a GATED repo fails, and
 * on a public one quietly fetches something nobody authorised.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { CLOUD_BYO_PROVIDERS } from '../constants';

const TENANT = 'tenant-abc';

function makeService(opts: { tenantRows?: any[]; systemRows?: any[]; entitled?: boolean; secretsBroken?: boolean } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findDeletedByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn(async (_svc: string, tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? (opts.systemRows ?? []) : (opts.tenantRows ?? []),
    ),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT : undefined)) };
  const db = { baseClient: {} };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: opts.secretsBroken
      ? vi.fn(async () => {
          throw new Error('transit down');
        })
      : vi.fn(async () => Buffer.from('the-token', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo };
}

function row(overrides: { tenantId?: string; provider?: string; enabled?: boolean; withKey?: boolean; extraJson?: any } = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    service: 'vector',
    provider: overrides.provider ?? 'qdrant',
    baseUrl: null,
    enabled: overrides.enabled ?? true,
    extraJson: overrides.extraJson ?? null,
    encryptedApiKey: overrides.withKey === false ? null : Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: overrides.withKey === false ? null : 3,
  });
}

describe('resolveCredential — outcomes', () => {
  it('resolves the SYSTEM row when the tenant has no opinion, funding platform', async () => {
    const { svc } = makeService({ systemRows: [row()] });
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('resolved');
    expect(res.apiKey).toBe('the-token');
    expect(res.funding).toBe('platform');
  });

  it("prefers the TENANT's own row, funding tenant — SYSTEM is consulted only on ABSENCE", async () => {
    const { svc } = makeService({ tenantRows: [row({ tenantId: TENANT })], systemRows: [row()] });
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('resolved');
    expect(res.funding).toBe('tenant');
  });

  it('funding is DERIVED from the row, never stamped by the caller', async () => {
    const { svc } = makeService({ systemRows: [row()] });
    const res = await svc.resolveCredential('vector', 'qdrant', SYSTEM_TENANT_ID);
    expect(res.funding).toBe('platform');
  });

  it('reports ABSENT when no tier has a row — a public repo pulls anonymously', async () => {
    const { svc } = makeService();
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('absent');
    expect(res.apiKey).toBeUndefined();
  });

  it('reports ABSENT for a KEYLESS row — a row without key material injects on NEITHER tier', async () => {
    const { svc } = makeService({ systemRows: [row({ withKey: false })] });
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('absent');
  });

  it("reports DENIED when the tenant DISABLED the row — a veto blocks BOTH tiers, it never falls through", async () => {
    const { svc } = makeService({ tenantRows: [row({ tenantId: TENANT, enabled: false })], systemRows: [row()] });
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('denied');
    expect(res.reason).toMatch(/veto|disabled/i);
  });

  it('reports UNAVAILABLE when the cascade throws — a fault is never "no opinion"', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantIdAndService.mockRejectedValue(new Error('db down'));
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(res.outcome).toBe('unavailable');
  });

  it('never echoes the underlying error text — a secrets error can quote the payload it choked on', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantIdAndService.mockRejectedValue(new Error('transit: failed on ciphertext vault:v3:SUPERSECRET'));
    const res = await svc.resolveCredential('vector', 'qdrant', TENANT);
    expect(JSON.stringify(res)).not.toContain('SUPERSECRET');
  });
});

describe('resolveCredential — the s3 shape', () => {
  it('carries the non-secret accessKeyId from extraJson alongside the secret key', async () => {
    const { svc } = makeService({
      systemRows: [row({ provider: 's3', extraJson: { accessKeyId: 'hope-models' } })],
    });
    const res = await svc.resolveCredential('model-registry', 's3', TENANT);
    expect(res.outcome).toBe('resolved');
    expect(res.extras?.accessKeyId).toBe('hope-models');
    expect(res.apiKey).toBe('the-token');
  });

  it('never puts the credential into extras — the reserved-key rule holds on the read path too', async () => {
    const { svc } = makeService({
      systemRows: [row({ provider: 's3', extraJson: { accessKeyId: 'hope-models' } })],
    });
    const res = await svc.resolveCredential('model-registry', 's3', TENANT);
    expect(res.extras).not.toHaveProperty('api_key');
    expect(res.extras).not.toHaveProperty('funding');
  });
});

describe('resolveCredential — input validation', () => {
  it('rejects an unknown service rather than guessing one', async () => {
    const { svc } = makeService();
    await expect(svc.resolveCredential('not-a-service' as any, 'huggingface', TENANT)).rejects.toThrow(/service/i);
  });

  it('REQUIRES a tenant — a tenant-less resolve could only mean "read SYSTEM unconditionally"', async () => {
    const { svc } = makeService();
    await expect(svc.resolveCredential('vector', 'qdrant', '')).rejects.toThrow(/tenant/i);
  });

  // ── Owner ruling 2026-08-24 — model-registry is PLATFORM-MANAGED ──────────
  //
  // The four-outcome contract above is exercised on `vector:qdrant`, a genuinely
  // tenant-eligible service, because a platform-only one cannot reach the
  // tenant-tier outcomes at all. That inability IS the ruling, so it is pinned
  // here rather than left as an absence.
  describe('model-registry — platform-managed, tenant tier never consulted', () => {
    it('serves the SYSTEM row even when a tenant row exists and is keyed', async () => {
      const tenantRow = row({ tenantId: TENANT, provider: 'huggingface' });
      const systemRow = row({ provider: 'huggingface' });
      const { svc } = makeService({ tenantRows: [tenantRow], systemRows: [systemRow] });

      const res = await svc.resolveCredential('model-registry', 'huggingface', TENANT);

      // `funding` is DERIVED from the row that served, so 'platform' is the
      // assertion that the SYSTEM row won — not merely that a key came back.
      expect(res.outcome).toBe('resolved');
      expect(res.funding).toBe('platform');
    });

    it('is absent from the tenant-writable map, so a tenant row is a 403 at the write guard', () => {
      expect(CLOUD_BYO_PROVIDERS['model-registry']).toEqual([]);
    });

    // TASK-855 L8 — the AiModel platform catalogue is SYSTEM-owned
    // (`06-stt.ts`'s `DEFAULT_TENANT_ID === SYSTEM_TENANT_ID`), so a
    // gateway-internal resolve for one of those rows' HuggingFace token
    // passes SYSTEM_TENANT_ID itself as the resolving tenant — there is no
    // "asking tenant" once the resource being resolved for is SYSTEM's own.
    // Regression coverage for the cascadeRows fix: SYSTEM's own row for a
    // non-cloud, platform-managed service used to be mislabelled as the
    // 'tenant' tier and silently dropped by the `isCloudByoProvider` filter
    // meant to enforce "a tenant may only own a cloud row" — a rule that
    // cannot even apply to SYSTEM resolving itself.
    it('resolves SYSTEM´s own row when the resolving tenantId IS SYSTEM_TENANT_ID', async () => {
      const systemRow = row({ provider: 'huggingface' });
      const { svc } = makeService({ systemRows: [systemRow] });

      const res = await svc.resolveCredential('model-registry', 'huggingface', SYSTEM_TENANT_ID);

      expect(res.outcome).toBe('resolved');
      expect(res.funding).toBe('platform');
      expect(res.apiKey).toBe('the-token');
    });
  });
});
