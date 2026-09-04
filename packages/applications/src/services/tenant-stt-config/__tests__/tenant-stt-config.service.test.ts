import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // The unified provider-connection plane — the ONLY credential
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
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'ghost', expectedVersion: 0 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a disabled fallback pipeline', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ resourceStatus: ResourceStatusType.DISABLED }));
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-1', expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-cloud (local GPU) fallback pipeline', async () => {
    ctx.aiModelRepo.findBySlug.mockResolvedValue({ computeType: 'gpu', format: 'FASTER_WHISPER' });
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-1', expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
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
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 5 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('accepts the cloud provider::model shorthand without an AiModel lookup', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ configYaml: 'models:\n  asr: "sarvam::saaras-v4"\n' }));
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

  it('rejects a batch-only (Azure Foundry) fallback target via the provider shorthand', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ configYaml: 'models:\n  asr: "azure-foundry::mai-transcribe-1.5"\n' }));
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ctx.configRepo.create).not.toHaveBeenCalled();
  });

  it('rejects a batch-only (Azure Foundry) fallback target resolved by AiModel format', async () => {
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ configYaml: 'models:\n  asr: "mai-transcribe-1.5"\n' }));
    ctx.aiModelRepo.findBySlug.mockResolvedValue({ computeType: 'cloud', format: 'AZURE_FOUNDRY' });
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    await expect(ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a Sarvam fallback via a BARE SLUG ref (canonical shape — like Azure) resolved to the SARVAM AiModel format', async () => {
    // The seeded Sarvam pipeline now uses `asr: "sarvam-saaras-v4"` (bare slug),
    // identical in shape to the Azure Speech pipeline. The slug resolves to the
    // AiModel whose format is the first-class SARVAM (a cloud STT format).
    ctx.pipelineService.getById.mockResolvedValue(cloudPipeline({ configYaml: 'models:\n  asr: "sarvam-saaras-v4"\n' }));
    ctx.aiModelRepo.findBySlug.mockResolvedValue({ computeType: 'cloud', format: 'SARVAM' });
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    ctx.configRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 });
    expect(res.fallbackPipelineId).toBe('pl-fallback-1');
  });

  it('accepts a Sarvam fallback defined by the INLINE engine block (no `::` shorthand, no DB slug)', async () => {
    // The seeded Sarvam pipeline binds the engine inline (`engine: "sarvam"` +
    // `hf_model_id`), not via the `sarvam::model` shorthand, and Sarvam has no
    // AiModel slug row — extractAsrRef must surface the `engine` field.
    ctx.pipelineService.getById.mockResolvedValue(
      cloudPipeline({ configYaml: 'models:\n  asr:\n    hf_model_id: "saaras:v4"\n    engine: "sarvam"\n' }),
    );
    ctx.configRepo.findByTenantId.mockResolvedValue(null);
    ctx.configRepo.create.mockImplementation(async (e: unknown) => e);
    const res = await ctx.svc.setFallbackPipeline(TENANT, { fallbackPipelineId: 'pl-fallback-1', expectedVersion: 0 });
    expect(res.fallbackPipelineId).toBe('pl-fallback-1');
    expect(ctx.aiModelRepo.findBySlug).not.toHaveBeenCalled();
  });

  it('getFallbackCandidates keeps the inline-engine Sarvam pipeline + Azure Speech, excludes batch-only Azure Foundry', async () => {
    ctx.pipelineService.getAll.mockResolvedValue([
      { id: 'pl-speech', slug: 'azure-speech-transcription', resourceStatus: ResourceStatusType.ENABLED, configYaml: 'models:\n  asr: "azure-speech-stt"\n' },
      { id: 'pl-foundry', slug: 'azure-foundry-mai-transcribe', resourceStatus: ResourceStatusType.ENABLED, configYaml: 'models:\n  asr: "azure-foundry::mai-transcribe-1.5"\n' },
      { id: 'pl-sarvam', slug: 'sarvam-transcription', resourceStatus: ResourceStatusType.ENABLED, configYaml: 'models:\n  asr:\n    hf_model_id: "saaras:v4"\n    engine: "sarvam"\n' },
    ]);
    const slugs = (await ctx.svc.getFallbackCandidates(TENANT)).map((c) => c.slug);
    expect(slugs).toContain('azure-speech-transcription');
    expect(slugs).toContain('sarvam-transcription');
    expect(slugs).not.toContain('azure-foundry-mai-transcribe');
  });
});

describe('TenantSttConfigService — resolveProviderOverrides (delegated to IProviderConnectionService, service="stt")', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });

  it('maps region/base_url/model straight off the resolved entries — no second, tenant-pinned read', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: {
        'azure-speech': { api_key: 'AZ-KEY', funding: 'tenant', region: 'eastus' },
        sarvam: { api_key: 'SV-KEY', funding: 'platform', base_url: 'https://api.sarvam.ai', model: 'saaras:v4' },
      },
    });

    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);

    expect(ctx.providerConnectionService.resolveTenantCloudOverrides).toHaveBeenCalledWith('stt', TENANT);
    expect(overrides).toEqual({
      'azure-speech': { api_key: 'AZ-KEY', funding: 'tenant', region: 'eastus' },
      sarvam: { api_key: 'SV-KEY', funding: 'platform', base_url: 'https://api.sarvam.ai', model: 'saaras:v4' },
    });
    // The `model` used to be re-read with `list()`, which is pinned
    // to the CALLER's tenant: a SYSTEM-sourced override would silently lose its
    // model id the moment the cascade started supplying one.
    expect(ctx.providerConnectionService.list).not.toHaveBeenCalled();
  });

  it('forwards the funding label — a dropped label bills a platform-funded call as tenant BYOK', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: { sarvam: { api_key: 'SV-KEY', funding: 'platform' } },
    });
    const overrides = await ctx.svc.resolveProviderOverrides(TENANT);
    expect(overrides.sarvam.funding).toBe('platform');
  });

  it('returns empty when the unified plane resolves nothing (no Vault / all disabled / all decrypt-failed / not entitled)', async () => {
    ctx.providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({ overrides: {} });
    expect(await ctx.svc.resolveProviderOverrides(TENANT)).toEqual({});
    expect(ctx.providerConnectionService.list).not.toHaveBeenCalled();
  });
});
