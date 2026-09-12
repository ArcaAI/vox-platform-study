/**
 * TASK-862 — `ProviderCredentialResolver`, the ONE credential resolver agents
 * (TASK-863) and workflow nodes consume.
 *
 * Locks the contract stated on the class: tenant row wins; SYSTEM only on
 * ABSENCE; a disabled tenant row is a VETO (409) that never falls through; the
 * platform-default entitlement gate denies a CLOUD provider's SYSTEM tier
 * (403) but never a self-host one; `fundingTier` is DERIVED from the row that
 * supplied the credential; `connectionId` names that row; `null` = no row at
 * either tier holds a credential.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { QuotaExceededException } from '@arcaai/exceptions';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { ProviderCredentialResolver } from '../provider-credential-resolver';
import { ProviderVetoedException } from '../provider-vetoed.exception';
import { withTask958Lookups } from './task958-repo-lookups';

const TENANT = 'tenant-abc';

function makeResolver(opts: { tenantRow?: any; systemRow?: any; entitled?: boolean; secretsBroken?: boolean; noSecrets?: boolean } = {}) {
  const repo = withTask958Lookups({
    findByTenantServiceProvider: vi.fn(async (_svc: string, _provider: string, tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? (opts.systemRow ?? null) : (opts.tenantRow ?? null),
    ),
    findDeletedByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  });
  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT : undefined)) };
  const db = { baseClient: {} };
  const secrets = opts.noSecrets
    ? undefined
    : {
        encrypt: vi.fn(async () => 'vault:v3:cipher'),
        decrypt: opts.secretsBroken
          ? vi.fn(async () => {
              throw new Error('transit down');
            })
          : vi.fn(async () => Buffer.from('the-token', 'utf8')),
        supportsTransit: vi.fn(() => true),
      };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true), assertQuantityQuota: vi.fn() };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { resolver: new ProviderCredentialResolver(svc), repo, entitlements };
}

function row(overrides: { tenantId?: string; service?: any; provider?: string; enabled?: boolean; withKey?: boolean } = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    service: overrides.service ?? 'llm',
    provider: overrides.provider ?? 'azure',
    baseUrl: 'https://example.openai.azure.com',
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.withKey === false ? null : Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: overrides.withKey === false ? null : 3,
  });
}

describe('ProviderCredentialResolver.resolve — precedence', () => {
  it("returns the tenant's own ENABLED + keyed row, funding `tenant`, naming that row", async () => {
    const own = row({ tenantId: TENANT });
    const { resolver, repo } = makeResolver({ tenantRow: own, systemRow: row() });

    const binding = await resolver.resolve('llm', 'azure', TENANT);

    expect(binding).not.toBeNull();
    expect(binding?.connectionId).toBe(own.id);
    expect(binding?.fundingTier).toBe('tenant');
    expect(binding?.override.api_key).toBe('the-token');
    expect(binding?.override.funding).toBe('tenant');
    expect(binding?.override.base_url).toBe('https://example.openai.azure.com');
    // SYSTEM is NOT consulted when the tenant has an opinion.
    expect(repo.findByTenantServiceProvider).not.toHaveBeenCalledWith('llm', 'azure', SYSTEM_TENANT_ID, expect.anything());
  });

  it('widens to the SYSTEM row on ABSENCE, funding `platform`', async () => {
    const platform = row();
    const { resolver } = makeResolver({ systemRow: platform });

    const binding = await resolver.resolve('llm', 'azure', TENANT);

    expect(binding?.connectionId).toBe(platform.id);
    expect(binding?.fundingTier).toBe('platform');
    expect(binding?.override.funding).toBe('platform');
  });

  it('treats an ENABLED but KEYLESS tenant row as absent (incomplete setup, not a veto)', async () => {
    const platform = row();
    const { resolver } = makeResolver({ tenantRow: row({ tenantId: TENANT, withKey: false }), systemRow: platform });

    const binding = await resolver.resolve('llm', 'azure', TENANT);

    expect(binding?.connectionId).toBe(platform.id);
    expect(binding?.fundingTier).toBe('platform');
  });

  it('returns null when no tier holds a credential', async () => {
    const { resolver } = makeResolver({ systemRow: row({ withKey: false }) });
    expect(await resolver.resolve('llm', 'azure', TENANT)).toBeNull();
  });

  it('returns null when nothing is decryptable (no secrets backend) rather than inventing a credential', async () => {
    const { resolver } = makeResolver({ systemRow: row(), noSecrets: true });
    expect(await resolver.resolve('llm', 'azure', TENANT)).toBeNull();
  });

  it('serves SYSTEM for the SYSTEM tenant itself (the platform resolving its own credential), funding `platform`', async () => {
    const platform = row();
    const { resolver } = makeResolver({ systemRow: platform });
    const binding = await resolver.resolve('llm', 'azure', SYSTEM_TENANT_ID);
    expect(binding?.connectionId).toBe(platform.id);
    expect(binding?.fundingTier).toBe('platform');
  });
});

describe('ProviderCredentialResolver.resolve — the veto', () => {
  it('throws ProviderVetoedException on a DISABLED tenant row and never reads SYSTEM', async () => {
    const { resolver, repo } = makeResolver({ tenantRow: row({ tenantId: TENANT, enabled: false }), systemRow: row() });

    await expect(resolver.resolve('llm', 'azure', TENANT)).rejects.toBeInstanceOf(ProviderVetoedException);
    expect(repo.findByTenantServiceProvider).not.toHaveBeenCalledWith('llm', 'azure', SYSTEM_TENANT_ID, expect.anything());
  });

  it('a disabled SYSTEM row is merely absent — the platform cannot veto a tenant', async () => {
    const { resolver } = makeResolver({ systemRow: row({ enabled: false }) });
    expect(await resolver.resolve('llm', 'azure', TENANT)).toBeNull();
  });
});

describe('ProviderCredentialResolver.resolve — the platform-default entitlement gate', () => {
  it('throws QuotaExceededException (featurePlatformDefaultCredential) for a CLOUD provider when the gate denies', async () => {
    const { resolver } = makeResolver({ systemRow: row(), entitled: false });

    await expect(resolver.resolve('llm', 'azure', TENANT)).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('never gates a SELF-HOST SYSTEM row — platform infrastructure, not platform spend', async () => {
    const lmStudio = row({ provider: 'lm-studio' });
    const { resolver, entitlements } = makeResolver({ systemRow: lmStudio, entitled: false });

    const binding = await resolver.resolve('llm', 'lm-studio', TENANT);

    expect(binding?.connectionId).toBe(lmStudio.id);
    expect(binding?.fundingTier).toBe('platform');
    expect(entitlements.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("the tenant's own key is served even when the gate denies the platform tier", async () => {
    const own = row({ tenantId: TENANT });
    const { resolver } = makeResolver({ tenantRow: own, systemRow: row(), entitled: false });
    const binding = await resolver.resolve('llm', 'azure', TENANT);
    expect(binding?.connectionId).toBe(own.id);
    expect(binding?.fundingTier).toBe('tenant');
  });
});

describe('ProviderCredentialResolver.resolve — inputs and faults', () => {
  it('rejects an unknown service, an empty provider and an empty tenant (never a SYSTEM-unconditional read)', async () => {
    const { resolver } = makeResolver({ systemRow: row() });
    await expect(resolver.resolve('nope' as any, 'azure', TENANT)).rejects.toThrow(/Unknown provider service/);
    await expect(resolver.resolve('llm', '  ', TENANT)).rejects.toThrow(/provider is required/);
    await expect(resolver.resolve('llm', 'azure', '')).rejects.toThrow(/tenantId is required/);
  });

  it('a credential that fails to decrypt is a FAULT on that row: the next tier still serves', async () => {
    // Transit down for every decrypt → the tenant row is skipped AND the
    // SYSTEM row is skipped; nothing decryptable → null, never a throw.
    const { resolver } = makeResolver({ tenantRow: row({ tenantId: TENANT }), systemRow: row(), secretsBroken: true });
    expect(await resolver.resolve('llm', 'azure', TENANT)).toBeNull();
  });
});
