import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  ResourceStatusType,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantSttConfigFactory,
  TenantSttProviderCredentialFactory,
} from '@arcaai/domains';
import { TenantSttConfigService } from '../tenant-stt-config.service';
import { STT_FALLBACK_DEFAULTS } from '../platform-limits';

const TENANT = 'tenant-abc';

// Fake Vault Transit: ciphertext is `vault:v1:<base64(plaintext)>`, reversible.
const fakeSecrets = () => ({
  encrypt: vi.fn(async (buf: Buffer) => `vault:v1:${buf.toString('base64')}`),
  decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':')[2], 'base64')),
});

/** A tenant-visible, ENABLED, cloud-backed pipeline (models.asr → cloud AiModel). */
function cloudPipeline(over: Partial<{ resourceStatus: ResourceStatusType; configYaml: string; slug: string }> = {}) {
  return {
    id: 'pl-fallback-1',
    slug: over.slug ?? 'azure-speech-transcription',
    resourceStatus: over.resourceStatus ?? ResourceStatusType.ENABLED,
    configYaml: over.configYaml ?? 'models:\n  asr: "azure-speech-stt"\n',
  };
}

function makeService(opts: { withVault?: boolean } = {}) {
  const configRepo = { findByTenantId: vi.fn().mockResolvedValue(null), create: vi.fn(), updateWithVersion: vi.fn() };
  const credRepo = {
    findByTenantId: vi.fn().mockResolvedValue([]),
    findByTenantAndProvider: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
  };
  const aiModelRepo = { findBySlug: vi.fn().mockResolvedValue({ computeType: 'cloud', format: 'AZURE_SPEECH' }) };
  const pipelineService = { getById: vi.fn().mockResolvedValue(cloudPipeline()) };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1' } : k === 'tenantId' ? TENANT : undefined)),
  };
  const secrets = opts.withVault ? fakeSecrets() : undefined;
  const svc = new TenantSttConfigService(
    configRepo as any,
    credRepo as any,
    aiModelRepo as any,
    pipelineService as any,
    emitter as any,
    cls as any,
    secrets as any,
  );
  return { svc, configRepo, credRepo, aiModelRepo, pipelineService, emitter, secrets };
}

describe('TenantSttConfigService — config row + effective', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });

  it('getRow returns a version:0 placeholder (no fallback) when the tenant has no row', async () => {
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    const res = await ctx.svc.getRow(TENANT);
    expect(res.version).toBe(0);
    expect(res.tenantId).toBe(TENANT);
    expect(res.fallbackPipelineId).toBeNull();
    expect(res.autoSwitchEnabled).toBe(true);
  });

  it('getEffective merges the tenant row over the SYSTEM default; no-fallback default', async () => {
    ctx.configRepo.findByTenantId.mockImplementation(async (id: string) =>
      id === SYSTEM_TENANT_ID
        ? TenantSttConfigFactory.CreateTenantSttConfig({ tenantId: SYSTEM_TENANT_ID, autoSwitchEnabled: true })
        : TenantSttConfigFactory.CreateTenantSttConfig({ tenantId: TENANT, fallbackPipelineId: 'pl-x', autoSwitchEnabled: false }),
    );
    const eff = await ctx.svc.getEffective(TENANT);
    expect(eff.fallbackPipelineId).toBe('pl-x'); // tenant override
    expect(eff.autoSwitchEnabled).toBe(false); // tenant override
    expect(eff.consecutiveFailureThreshold).toBe(STT_FALLBACK_DEFAULTS.consecutiveFailureThreshold);
  });

  it('getEffective returns null fallback + defaults when neither tier has a row', async () => {
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    const eff = await ctx.svc.getEffective(TENANT);
    expect(eff.fallbackPipelineId).toBeNull();
    expect(eff.autoSwitchEnabled).toBe(STT_FALLBACK_DEFAULTS.autoSwitchEnabled);
  });
});

describe('TenantSttConfigService — setFallbackPipeline validation', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });

  it('rejects a non-existent / cross-tenant fallback target with 404 (never 403)', async () => {
    ctx.pipelineService.getById.mockResolvedValue(null);
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'ghost', expectedVersion: 0 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a disabled fallback pipeline', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ resourceStatus: ResourceStatusType.DISABLED }));
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-1', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-cloud (local GPU) fallback pipeline', async () => {
    ctx.aiModelRepo.findBySlug.mockResolvedValue({ computeType: 'gpu', format: 'FASTER_WHISPER' });
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-1', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a valid cloud-backed fallback and creates the row + broadcasts ResourceCreated', async () => {
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    ctx.configRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 });
    expect(ctx.configRepo.create).toHaveBeenCalledTimes(1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
    expect(res.fallbackPipelineId).toBe('pl-fallback-1');
  });

  it('create with a non-zero expectedVersion is a concurrency conflict', async () => {
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    await expect(
      ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 5 }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('accepts the cloud provider::model shorthand without an AiModel lookup', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ configYaml: 'models:\n  asr: "sarvam::saaras-v3"\n' }));
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    ctx.configRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 });
    expect(res.fallbackPipelineId).toBe('pl-fallback-1');
    expect(ctx.aiModelRepo.findBySlug).not.toHaveBeenCalled();
  });

  it('updates via compare-and-set + broadcasts ResourceUpdated when a row exists', async () => {
    const row = TenantSttConfigFactory.CreateTenantSttConfig({ tenantId: TENANT });
    ctx.configRepo.findByTenantId.mockResolvedValue(row);
    ctx.configRepo.updateWithVersion.mockImplementation(async () => row);
    await ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 1 });
    expect(ctx.configRepo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
  });
});

describe('TenantSttConfigService — BYO credentials', () => {
  it('setCredential encrypts the key, stores ciphertext, returns a masked view, broadcasts ResourceCreated', async () => {
    const ctx = makeService({ withVault: true });
    ctx.credRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setCredential(TENANT, 'azure-speech', { apiKey: 'super-secret', region: 'eastus', expectedVersion: 0 });
    expect(ctx.secrets!.encrypt).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain('super-secret');
    expect(res).toMatchObject({ provider: 'azure-speech', region: 'eastus', hasKey: true, keyVersion: 1 });
    const created = ctx.credRepo.create.mock.calls[0][0];
    expect(Buffer.from(created.encryptedApiKey).toString('utf8')).toMatch(/^vault:v1:/);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
  });

  it('setCredential rotates an existing credential via updateWithVersion (OCC)', async () => {
    const ctx = makeService({ withVault: true });
    const existing = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'sarvam',
      enabled: true,
    });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(existing);
    ctx.credRepo.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
    const res = await ctx.svc.setCredential(TENANT, 'sarvam', { apiKey: 'rotated', endpoint: 'https://api.sarvam.ai', expectedVersion: existing.version });
    expect(ctx.credRepo.updateWithVersion).toHaveBeenCalledWith(existing.id, existing, existing.version);
    expect(res).toMatchObject({ provider: 'sarvam', hasKey: true });
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
  });

  it('setCredential on an existing row with a stale expectedVersion is a concurrency conflict (before any Vault call)', async () => {
    const ctx = makeService({ withVault: true });
    const existing = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({ tenantId: TENANT, provider: 'openai', enabled: true });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(existing);
    await expect(ctx.svc.setCredential(TENANT, 'openai', { apiKey: 'x', expectedVersion: existing.version + 9 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(ctx.secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('setCredential create with a non-zero expectedVersion is a concurrency conflict', async () => {
    const ctx = makeService({ withVault: true });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(null);
    await expect(ctx.svc.setCredential(TENANT, 'openai', { apiKey: 'x', expectedVersion: 3 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('setCredential rejects without a Vault secrets provider (no plaintext-at-rest)', async () => {
    const ctx = makeService({ withVault: false });
    await expect(ctx.svc.setCredential(TENANT, 'azure-speech', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('setCredential rejects an unsupported provider', async () => {
    const ctx = makeService({ withVault: true });
    await expect(ctx.svc.setCredential(TENANT, 'whisper', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getCredentials + set never echo the key material (deep snapshot)', async () => {
    const ctx = makeService({ withVault: true });
    const row = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'azure-speech',
      enabled: true,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('THE-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 1,
    });
    ctx.credRepo.findByTenantId.mockResolvedValue([row]);
    const list = await ctx.svc.getCredentials(TENANT);
    const snapshot = JSON.stringify(list);
    expect(snapshot).not.toContain('THE-KEY');
    expect(snapshot).not.toContain('vault:');
    expect(list[0]).toMatchObject({ provider: 'azure-speech', hasKey: true, keyVersion: 1 });
  });

  it('removeCredential 404s when the provider has no credential', async () => {
    const ctx = makeService({ withVault: true });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(null);
    await expect(ctx.svc.removeCredential(TENANT, 'azure-speech')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removeCredential soft-deletes + broadcasts ResourceDeleted', async () => {
    const ctx = makeService({ withVault: true });
    const existing = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({ tenantId: TENANT, provider: 'sarvam', enabled: true });
    ctx.credRepo.findByTenantAndProvider.mockResolvedValue(existing);
    await ctx.svc.removeCredential(TENANT, 'sarvam');
    expect(ctx.credRepo.softDelete).toHaveBeenCalledWith(existing.id);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.any(Object));
  });
});

describe('TenantSttConfigService — resolveProviderOverrides', () => {
  it('decrypts enabled credentials into the injectable map (region/base_url/model mapped)', async () => {
    const ctx = makeService({ withVault: true });
    const azure = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'azure-speech',
      region: 'eastus',
      enabled: true,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('AZ-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 1,
    });
    const sarvam = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'sarvam',
      endpoint: 'https://api.sarvam.ai',
      enabled: true,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('SV-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 1,
      extraJson: { model: 'saaras:v3' },
    });
    ctx.credRepo.findByTenantId.mockResolvedValue([azure, sarvam]);
    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);
    expect(overrides).toEqual({
      'azure-speech': { api_key: 'AZ-KEY', region: 'eastus' },
      sarvam: { api_key: 'SV-KEY', base_url: 'https://api.sarvam.ai', model: 'saaras:v3' },
    });
  });

  it('skips a disabled credential row', async () => {
    const ctx = makeService({ withVault: true });
    const disabled = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'azure-speech',
      enabled: false,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('AZ-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 1,
    });
    ctx.credRepo.findByTenantId.mockResolvedValue([disabled]);
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
  });

  it('fails OPEN per credential on decrypt error: skips it + warns with ONLY {tenantId, provider, keyVersion}', async () => {
    const ctx = makeService({ withVault: true });
    // decrypt throws for this row
    (ctx.secrets!.decrypt as any).mockRejectedValueOnce(new Error('transit boom'));
    const row = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: TENANT,
      provider: 'openai',
      enabled: true,
      encryptedApiKey: Buffer.from(`vault:v1:${Buffer.from('OA-KEY').toString('base64')}`, 'utf8'),
      keyVersion: 4,
    });
    ctx.credRepo.findByTenantId.mockResolvedValue([row]);

    const { Logger } = await import('@nestjs/common');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);

    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);
    expect(overrides).toEqual({}); // failed credential skipped

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    // No secret material anywhere in the log payload.
    const loggedStr = JSON.stringify(logged);
    expect(loggedStr).not.toContain('OA-KEY');
    expect(loggedStr).not.toContain('vault:');
    expect(logged).toMatchObject({ tenantId: TENANT, provider: 'openai', keyVersion: 4 });
    warnSpy.mockRestore();
  });

  it('returns empty without a Vault provider', async () => {
    const ctx = makeService({ withVault: false });
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
  });
});
