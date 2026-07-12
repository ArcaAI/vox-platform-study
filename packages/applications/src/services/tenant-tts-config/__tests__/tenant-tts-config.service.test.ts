import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantTtsConfigFactory,
  TenantTtsProviderCredentialFactory,
} from '@arcaai/domains';
import { TenantTtsConfigService } from '../tenant-tts-config.service';

const TENANT = 'tenant-abc';

// Fake Vault Transit: ciphertext is `vault:v1:<base64(plaintext)>`, reversible.
const fakeSecrets = () => ({
  encrypt: vi.fn(async (buf: Buffer) => `vault:v1:${buf.toString('base64')}`),
  decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':')[2], 'base64')),
});

function makeService(opts: { withVault?: boolean } = {}) {
  const repo = { findByTenantId: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
  const credRepo = {
    findByTenantId: vi.fn().mockResolvedValue([]),
    findByTenantAndProvider: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1' } : k === 'tenantId' ? TENANT : undefined)),
  };
  const secrets = opts.withVault ? fakeSecrets() : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new TenantTtsConfigService(repo as any, credRepo as any, emitter as any, cls as any, secrets as any);
  return { svc, repo, credRepo, emitter, secrets };
}

const existingRow = () =>
  TenantTtsConfigFactory.CreateTenantTtsConfig({ tenantId: TENANT, defaultSpeed: 1.0, defaultVoiceEn: 'en-female-1' });

describe('TenantTtsConfigService (TASK-496)', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });

  it('getRow returns a version:0 placeholder when the tenant has no row', async () => {
    ctx.repo.findByTenantId.mockResolvedValue(null);
    const res = await ctx.svc.getRow(TENANT);
    expect(res.version).toBe(0);
    expect(res.tenantId).toBe(TENANT);
  });

  it('getEffective merges the tenant row over the SYSTEM default', async () => {
    ctx.repo.findByTenantId.mockImplementation(async (id: string) =>
      id === SYSTEM_TENANT_ID
        ? TenantTtsConfigFactory.CreateTenantTtsConfig({ tenantId: SYSTEM_TENANT_ID, defaultVoiceEn: 'en-male-1' })
        : TenantTtsConfigFactory.CreateTenantTtsConfig({ tenantId: TENANT, defaultSpeed: 1.5 }),
    );
    const eff = await ctx.svc.getEffective(TENANT);
    expect(eff.defaultVoiceEn).toBe('en-male-1'); // from SYSTEM default (tenant unset)
    expect(eff.defaultSpeed).toBe(1.5); // tenant override
  });

  it('upsert creates the row + broadcasts ResourceCreated when none exists (expectedVersion 0)', async () => {
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.upsertRow(TENANT, { defaultSpeed: 2.0, expectedVersion: 0 });
    expect(ctx.repo.create).toHaveBeenCalledTimes(1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
    expect(res.defaultSpeed).toBe(2.0);
  });

  it('upsert create with a non-zero expectedVersion is a concurrency conflict', async () => {
    ctx.repo.findByTenantId.mockResolvedValue(null);
    await expect(ctx.svc.upsertRow(TENANT, { defaultSpeed: 2.0, expectedVersion: 5 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('upsert updates via compare-and-set + broadcasts ResourceUpdated when a row exists', async () => {
    const row = existingRow();
    ctx.repo.findByTenantId.mockResolvedValue(row);
    ctx.repo.updateWithVersion.mockImplementation(async () => row);
    await ctx.svc.upsertRow(TENANT, { defaultSpeed: 2.5, expectedVersion: 1 });
    expect(ctx.repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
  });

  it('upsert throws when there are no changes to write', async () => {
    // Same editor + no spec fields → even the updatedBy stamp is a no-op, so the
    // entity is genuinely unchanged and the guard fires.
    const row = TenantTtsConfigFactory.CreateTenantTtsConfig({ tenantId: TENANT, updatedBy: 'u1' });
    ctx.repo.findByTenantId.mockResolvedValue(row);
    await expect(ctx.svc.upsertRow(TENANT, { expectedVersion: 1 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('TenantTtsConfigService — BYO credentials (Phase 6)', () => {
  it('setCredential encrypts the key, stores ciphertext, and returns a masked view', async () => {
    const ctx = makeService({ withVault: true });
    ctx.credRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setCredential(TENANT, 'azure', { apiKey: 'super-secret', endpoint: 'eastus' });
    // encrypted (not plaintext) + never returns the key
    expect(ctx.secrets!.encrypt).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain('super-secret');
    expect(res).toMatchObject({ provider: 'azure', endpoint: 'eastus', hasKey: true, keyVersion: 1 });
    // persisted ciphertext, not the plaintext
    const created = ctx.credRepo.create.mock.calls[0][0];
    expect(Buffer.from(created.encryptedApiKey).toString('utf8')).toMatch(/^vault:v1:/);
  });

  it('setCredential rotates an existing credential via update(id, entity)', async () => {
    const ctx = makeService({ withVault: true });
    const existing = TenantTtsProviderCredentialFactory.CreateTenantTtsProviderCredential({
      tenantId: TENANT,
      provider: 'sarvam',
      enabled: true,
    });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(existing);
    ctx.credRepo.update.mockImplementation(async (_id: string, e: unknown) => e);
    const res = await ctx.svc.setCredential(TENANT, 'sarvam', { apiKey: 'rotated', endpoint: 'https://vpc.sarvam' });
    expect(ctx.credRepo.update).toHaveBeenCalledWith(existing.id, existing);
    expect(res).toMatchObject({ provider: 'sarvam', hasKey: true });
  });

  it('setCredential rejects without a Vault secrets provider (no plaintext-at-rest)', async () => {
    const ctx = makeService({ withVault: false });
    await expect(ctx.svc.setCredential(TENANT, 'azure', { apiKey: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setCredential rejects an unsupported provider', async () => {
    const ctx = makeService({ withVault: true });
    await expect(ctx.svc.setCredential(TENANT, 'kokoro', { apiKey: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolveProviderOverrides decrypts enabled credentials into the injectable map', async () => {
    const ctx = makeService({ withVault: true });
    const row = TenantTtsProviderCredentialFactory.CreateTenantTtsProviderCredential({
      tenantId: TENANT,
      provider: 'azure',
      endpoint: 'eastus',
      enabled: true,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('THE-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 1,
    });
    ctx.credRepo.findByTenantId.mockResolvedValue([row]);
    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);
    expect(overrides).toEqual({ azure: { api_key: 'THE-KEY', region: 'eastus' } });
  });

  it('resolveProviderOverrides returns empty without a Vault provider', async () => {
    const ctx = makeService({ withVault: false });
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
  });

  it('removeCredential 404s when the provider has no credential', async () => {
    const ctx = makeService({ withVault: true });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(null);
    await expect(ctx.svc.removeCredential(TENANT, 'azure')).rejects.toBeInstanceOf(NotFoundException);
  });
});
