import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceStatusType, SYSTEM_TENANT_ID, SysEventType, TenantSttConfigFactory } from '@arcaai/domains';
import { TenantSttConfigService } from '../tenant-stt-config.service';
import { STT_FALLBACK_DEFAULTS } from '../platform-limits';

const TENANT = 'tenant-abc';

/** A tenant-visible, ENABLED, cloud-backed pipeline (models.asr → cloud AiModel). */
function cloudPipeline(over: Partial<{ resourceStatus: ResourceStatusType; configYaml: string; slug: string }> = {}) {
  return {
    id: 'pl-fallback-1',
    slug: over.slug ?? 'azure-speech-transcription',
    resourceStatus: over.resourceStatus ?? ResourceStatusType.ENABLED,
    configYaml: over.configYaml ?? 'models:\n  asr: "azure-speech-stt"\n',
  };
}

/** A masked `AiProviderConnectionResponse` row (`service='stt'`) — what `IProviderConnectionService` returns. */
function connectionRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: TENANT,
    service: 'stt',
    provider: 'azure-speech',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: true,
    keyVersion: 1,
    enabled: true,
    extraJson: null,
    version: 1,
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

function makeService() {
  const configRepo = { findByTenantId: vi.fn().mockResolvedValue(null), create: vi.fn(), updateWithVersion: vi.fn() };
  const aiModelRepo = { findBySlug: vi.fn().mockResolvedValue({ computeType: 'cloud', format: 'AZURE_SPEECH' }) };
  const pipelineService = { getById: vi.fn().mockResolvedValue(cloudPipeline()), getAll: vi.fn().mockResolvedValue([]) };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1' } : k === 'tenantId' ? TENANT : undefined)),
  };
  // The unified provider-connection plane (TASK-569/571) — the ONLY credential
  // store. `TenantSttConfigService` no longer touches a credential repository
  // or Vault directly; every BYO STT credential path delegates here with
  // `service='stt'`.
  const providerConnectionService = {
    list: vi.fn().mockResolvedValue([]),
    getRow: vi.fn().mockResolvedValue(connectionRow({ version: 0, hasKey: false, enabled: false })),
    upsertRow: vi.fn(),
    deleteRow: vi.fn().mockResolvedValue(undefined),
    resolveConnection: vi.fn(),
    findRow: vi.fn(),
    resolveTenantCloudOverrides: vi.fn().mockResolvedValue({}),
  };
  const svc = new TenantSttConfigService(
    configRepo as any,
    aiModelRepo as any,
    pipelineService as any,
    emitter as any,
    cls as any,
    providerConnectionService as any,
  );
  return { svc, configRepo, aiModelRepo, pipelineService, emitter, providerConnectionService };
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

describe('TenantSttConfigService — BYO credentials (delegated to IProviderConnectionService, service="stt")', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
    ctx.providerConnectionService.getRow.mockResolvedValue(connectionRow({ version: 0, hasKey: false, enabled: false }));
  });

  it('setCredential creates via upsertRow(service="stt", ...), defaulting enabled=true on create, returns a masked view', async () => {
    ctx.providerConnectionService.upsertRow.mockResolvedValue(connectionRow({ region: 'eastus', version: 1 }));

    const res = await ctx.svc.setCredential(TENANT, 'azure-speech', { apiKey: 'super-secret', region: 'eastus', expectedVersion: 0 });

    expect(ctx.providerConnectionService.getRow).toHaveBeenCalledWith('stt', 'azure-speech', TENANT);
    expect(ctx.providerConnectionService.upsertRow).toHaveBeenCalledWith(
      'stt',
      'azure-speech',
      expect.objectContaining({ region: 'eastus', apiKey: 'super-secret', enabled: true }),
      TENANT,
      0,
    );
    expect(JSON.stringify(res)).not.toContain('super-secret');
    expect(res).toMatchObject({ provider: 'azure-speech', region: 'eastus', hasKey: true, keyVersion: 1 });
  });

  it('setCredential rotate: an omitted `enabled` is passed through as undefined (unified plane leaves the flag untouched)', async () => {
    ctx.providerConnectionService.getRow.mockResolvedValue(connectionRow({ provider: 'sarvam', enabled: false, version: 3 }));
    ctx.providerConnectionService.upsertRow.mockResolvedValue(connectionRow({ provider: 'sarvam', enabled: false, version: 4 }));

    const res = await ctx.svc.setCredential(TENANT, 'sarvam', {
      apiKey: 'rotated',
      endpoint: 'https://api.sarvam.ai',
      expectedVersion: 3,
    });

    expect(ctx.providerConnectionService.upsertRow).toHaveBeenCalledWith(
      'stt',
      'sarvam',
      expect.objectContaining({ baseUrl: 'https://api.sarvam.ai', enabled: undefined }),
      TENANT,
      3,
    );
    expect(res).toMatchObject({ provider: 'sarvam', hasKey: true });
  });

  it('setCredential on an existing row with a stale expectedVersion propagates the unified plane OCC conflict', async () => {
    ctx.providerConnectionService.getRow.mockResolvedValue(connectionRow({ provider: 'openai', version: 2 }));
    ctx.providerConnectionService.upsertRow.mockRejectedValue(
      new OptimisticConcurrencyException('AiProviderConnection', 'x', { expectedVersion: 11, currentVersion: 2 }),
    );
    await expect(ctx.svc.setCredential(TENANT, 'openai', { apiKey: 'x', expectedVersion: 11 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('setCredential create with a non-zero expectedVersion propagates the unified plane OCC conflict', async () => {
    ctx.providerConnectionService.upsertRow.mockRejectedValue(
      new OptimisticConcurrencyException('AiProviderConnection', 'x', { expectedVersion: 3, currentVersion: 0 }),
    );
    await expect(ctx.svc.setCredential(TENANT, 'openai', { apiKey: 'x', expectedVersion: 3 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('setCredential propagates a rejection (e.g. no Vault secrets provider) from the unified plane unchanged', async () => {
    ctx.providerConnectionService.upsertRow.mockRejectedValue(
      new BadRequestException('Provider API keys require the Vault secrets provider (SECRETS_PROVIDER=vault).'),
    );
    await expect(ctx.svc.setCredential(TENANT, 'azure-speech', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('setCredential rejects an unsupported provider WITHOUT calling the unified plane', async () => {
    await expect(ctx.svc.setCredential(TENANT, 'whisper', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ctx.providerConnectionService.getRow).not.toHaveBeenCalled();
    expect(ctx.providerConnectionService.upsertRow).not.toHaveBeenCalled();
  });

  it('getCredentials lists via service="stt" and never echoes key material (deep snapshot); maps extraJson.model', async () => {
    ctx.providerConnectionService.list.mockResolvedValue([
      connectionRow({ provider: 'azure-speech', extraJson: { model: 'whisper-large' }, keyVersion: 1 }),
    ]);
    const list = await ctx.svc.getCredentials(TENANT);
    expect(ctx.providerConnectionService.list).toHaveBeenCalledWith('stt', TENANT);
    const snapshot = JSON.stringify(list);
    expect(snapshot).not.toContain('THE-KEY');
    expect(snapshot).not.toContain('vault:');
    expect(list[0]).toMatchObject({ provider: 'azure-speech', hasKey: true, keyVersion: 1, model: 'whisper-large' });
  });

  it('removeCredential 404s when the unified plane has no row for the provider', async () => {
    ctx.providerConnectionService.deleteRow.mockRejectedValue(new NotFoundException("No connection row for provider 'azure-speech'"));
    await expect(ctx.svc.removeCredential(TENANT, 'azure-speech')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removeCredential delegates the soft delete to the unified plane (service="stt")', async () => {
    await ctx.svc.removeCredential(TENANT, 'sarvam');
    expect(ctx.providerConnectionService.deleteRow).toHaveBeenCalledWith('stt', 'sarvam', TENANT);
  });
});

describe('TenantSttConfigService — resolveProviderOverrides (delegated to IProviderConnectionService, service="stt")', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });

  it('folds extraJson.model in on top of the decrypted overrides (region/base_url/model mapped)', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      'azure-speech': { api_key: 'AZ-KEY', region: 'eastus' },
      sarvam: { api_key: 'SV-KEY', base_url: 'https://api.sarvam.ai' },
    });
    ctx.providerConnectionService.list.mockResolvedValue([
      connectionRow({ provider: 'azure-speech', region: 'eastus' }),
      connectionRow({ provider: 'sarvam', baseUrl: 'https://api.sarvam.ai', extraJson: { model: 'saaras:v3' } }),
    ]);

    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);

    expect(ctx.providerConnectionService.resolveTenantCloudOverrides).toHaveBeenCalledWith('stt', TENANT);
    expect(overrides).toEqual({
      'azure-speech': { api_key: 'AZ-KEY', region: 'eastus' },
      sarvam: { api_key: 'SV-KEY', base_url: 'https://api.sarvam.ai', model: 'saaras:v3' },
    });
  });

  it('short-circuits to {} without a second call when the unified plane has no overrides', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({});
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
    expect(ctx.providerConnectionService.list).not.toHaveBeenCalled();
  });

  it('returns empty when the unified plane resolves nothing (no Vault / all disabled / all decrypt-failed)', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({});
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
  });
});
