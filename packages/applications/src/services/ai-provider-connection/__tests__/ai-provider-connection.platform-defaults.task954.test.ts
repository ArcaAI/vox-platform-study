/**
 * TASK-954 — `listPlatformDefaults`: the platform fallback a TENANT inherits,
 * projected READ-ONLY for the tenant's own console.
 *
 * A tenant admin may not address the SYSTEM tier (`?tenantId=SYSTEM` is a 403)
 * and `list()` under a tenant scope returns the tenant's rows only, so before
 * this read the console could not say whether "use platform default" would
 * actually serve anything. The read is built on the ONE cascade
 * (`cascadeRows`), so the veto set and the entitlement gate here are the same
 * `if`s that decide a real request — a tenant is never told it inherits a
 * credential the fold would refuse.
 *
 * Contracts locked:
 *   1. one entry per CLOUD BYO provider of the service, and NOTHING else — a
 *      built-in engine or model-registry row on the platform tier never reaches
 *      a tenant (TASK-932 R-12);
 *   2. every entry is the masked mapper projection — `hasKey` only, no
 *      ciphertext at any depth;
 *   3. `resolution` follows the cascade: overridden → vetoed → not-entitled →
 *      not-configured → off → inherited;
 *   4. the SYSTEM tier itself is refused (400): it is the top of the cascade.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { withTask958Lookups } from './task958-repo-lookups';

const TENANT_A = 'tenant-aaa';

function makeRow(overrides: { tenantId?: string; service?: string; provider?: string; enabled?: boolean; encryptedApiKey?: Uint8Array | null }) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    service: overrides.service ?? 'llm',
    provider: overrides.provider ?? 'azure',
    baseUrl: 'https://platform.openai.azure.com',
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : overrides.encryptedApiKey,
    keyVersion: overrides.encryptedApiKey === null ? null : 3,
  });
}

function makeService(opts: { rowsByTenant?: Record<string, unknown[]>; entitled?: boolean; user?: unknown; clsTenant?: string | undefined } = {}) {
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
  const user = opts.user === undefined ? { id: 'u1', roles: ['TENANT_ADMIN'], tenantId: TENANT_A } : opts.user;
  const clsTenant = 'clsTenant' in opts ? opts.clsTenant : TENANT_A;
  const cls = { get: vi.fn((k: string) => (k === 'user' ? user : k === 'tenantId' ? clsTenant : undefined)) };
  const secrets = { decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')), supportsTransit: vi.fn(() => true) };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true), assertQuantityQuota: vi.fn() };
  const svc = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    cls as any,
    secrets as any,
    entitlements as any,
  );
  return { svc, repo, secrets, entitlements };
}

/** Every string value at any depth of a JSON-serialisable structure. */
function stringsDeep(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsDeep(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsDeep(v, out));
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe('listPlatformDefaults — one entry per cloud BYO provider, masked', () => {
  it('projects the SYSTEM tier cloud rows and a placeholder for every cloud provider with no row', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [makeRow({ provider: 'azure' }), makeRow({ provider: 'openai', enabled: false })],
      },
    });

    const out = await svc.listPlatformDefaults('llm');

    expect(out.service).toBe('llm');
    expect(out.tenantId).toBe(TENANT_A);
    expect(out.entitled).toBe(true);
    // The llm cloud set, in CLOUD_BYO_PROVIDERS order — every provider present.
    expect(out.connections.map((c) => c.provider)).toEqual(['azure', 'bedrock', 'openai', 'anthropic', 'vertex']);
    const azure = out.connections.find((c) => c.provider === 'azure')!;
    expect(azure.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(azure.hasKey).toBe(true);
    expect(azure.baseUrl).toBe('https://platform.openai.azure.com');
    expect(azure.resolution).toBe('inherited');
    // A cloud provider the platform never configured is a placeholder, not an omission.
    const bedrock = out.connections.find((c) => c.provider === 'bedrock')!;
    expect(bedrock.version).toBe(0);
    expect(bedrock.hasKey).toBe(false);
    expect(bedrock.resolution).toBe('not-configured');
  });

  it('never surfaces a platform-managed engine or model-registry row to a tenant (R-12)', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [makeRow({ provider: 'lm-studio' }), makeRow({ provider: 'built-in' }), makeRow({ provider: 'azure' })],
      },
    });

    const out = await svc.listPlatformDefaults('llm');

    expect(out.connections.map((c) => c.provider)).not.toContain('lm-studio');
    expect(out.connections.map((c) => c.provider)).not.toContain('built-in');
    expect(out.connections.some((c) => c.provider === 'azure')).toBe(true);
  });

  it('carries no ciphertext at any depth — presence is `hasKey` only', async () => {
    const { svc, secrets } = makeService({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: 'azure' })] } });

    const out = await svc.listPlatformDefaults('llm');

    const json = JSON.parse(JSON.stringify(out));
    expect(JSON.stringify(json)).not.toContain('encryptedApiKey');
    expect(stringsDeep(json).some((s) => s.includes('vault:v3:cipher') || s.includes('plaintext'))).toBe(false);
    // A read-only projection never decrypts anything.
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});

describe('listPlatformDefaults — resolution follows the cascade', () => {
  const system = [
    makeRow({ provider: 'azure' }),
    makeRow({ provider: 'openai', enabled: false }),
    makeRow({ provider: 'anthropic', encryptedApiKey: null }),
  ];

  it('reports `inherited` for an enabled, keyed platform row the tenant has no opinion on', async () => {
    const { svc } = makeService({ rowsByTenant: { [SYSTEM_TENANT_ID]: system } });
    const out = await svc.listPlatformDefaults('llm');
    expect(out.connections.find((c) => c.provider === 'azure')?.resolution).toBe('inherited');
  });

  it('reports `off` for a disabled platform row and `not-configured` for a keyless one', async () => {
    const { svc } = makeService({ rowsByTenant: { [SYSTEM_TENANT_ID]: system } });
    const out = await svc.listPlatformDefaults('llm');
    expect(out.connections.find((c) => c.provider === 'openai')?.resolution).toBe('off');
    expect(out.connections.find((c) => c.provider === 'anthropic')?.resolution).toBe('not-configured');
  });

  it('reports `overridden` when the tenant brings its own enabled key, and `vetoed` when its row is disabled', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: system,
        [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: 'azure' }), makeRow({ tenantId: TENANT_A, provider: 'openai', enabled: false })],
      },
    });

    const out = await svc.listPlatformDefaults('llm');

    expect(out.connections.find((c) => c.provider === 'azure')?.resolution).toBe('overridden');
    // The veto wins over the platform row's own state (it was `off` above).
    expect(out.connections.find((c) => c.provider === 'openai')?.resolution).toBe('vetoed');
  });

  it('reports `not-entitled` for every non-overridden, non-vetoed provider when the platform-default grant is absent', async () => {
    const { svc, entitlements } = makeService({
      entitled: false,
      rowsByTenant: { [SYSTEM_TENANT_ID]: system, [TENANT_A]: [makeRow({ tenantId: TENANT_A, provider: 'openai', enabled: false })] },
    });

    const out = await svc.listPlatformDefaults('llm');

    expect(out.entitled).toBe(false);
    expect(entitlements.isFeatureEnabled).toHaveBeenCalledWith(TENANT_A, 'platformDefaultCredential');
    expect(out.connections.find((c) => c.provider === 'azure')?.resolution).toBe('not-entitled');
    expect(out.connections.find((c) => c.provider === 'bedrock')?.resolution).toBe('not-entitled');
    // The tenant's own veto is the more local fact and is reported first.
    expect(out.connections.find((c) => c.provider === 'openai')?.resolution).toBe('vetoed');
  });
});

describe('listPlatformDefaults — scope', () => {
  it('refuses the SYSTEM tier itself with 400: the platform row is the top of the cascade', async () => {
    const { svc, repo } = makeService({ user: { id: 'root', roles: ['SUPER_ADMIN'] }, clsTenant: undefined });
    await expect(svc.listPlatformDefaults('llm', SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findByTenantIdAndService).not.toHaveBeenCalled();
  });

  it('lets a super admin read what a working tenant inherits via an explicit tenantId', async () => {
    const { svc } = makeService({
      user: { id: 'root', roles: ['SUPER_ADMIN'] },
      clsTenant: undefined,
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ provider: 'azure' })] },
    });
    const out = await svc.listPlatformDefaults('llm', TENANT_A);
    expect(out.tenantId).toBe(TENANT_A);
    expect(out.connections.find((c) => c.provider === 'azure')?.resolution).toBe('inherited');
  });
});
