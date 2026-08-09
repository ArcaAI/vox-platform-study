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

  it('accepts a Sarvam fallback via a BARE SLUG ref (TASK-586 canonical shape — like Azure) resolved to the SARVAM AiModel format', async () => {
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
    await expect(ctx.svc.setCredential(TENANT, 'openai', { apiKey: 'x', expectedVersion: 3 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('setCredential propagates a rejection (e.g. no Vault secrets provider) from the unified plane unchanged', async () => {
    ctx.providerConnectionService.upsertRow.mockRejectedValue(
      new BadRequestException('Provider API keys require the Vault secrets provider (SECRETS_PROVIDER=vault).'),
    );
    await expect(ctx.svc.setCredential(TENANT, 'azure-speech', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setCredential rejects an unsupported provider WITHOUT calling the unified plane', async () => {
    await expect(ctx.svc.setCredential(TENANT, 'whisper', { apiKey: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
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
    // TASK-643 — the `model` used to be re-read with `list()`, which is pinned
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

describe('TenantSttConfigService — testCredential (ephemeral probe, never persisted)', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an unsupported provider without making any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ctx.svc.testCredential(TENANT, 'whisper', { apiKey: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('openai: ok on a 2xx GET /models with the bearer key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'sk-test' });
    expect(res).toEqual({ ok: true, message: expect.stringContaining('accepted') });
    const [target, init] = fetchSpy.mock.calls[0];
    expect(String(target)).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('openai: rejects a 401 as an invalid key, not a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const res = await ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'bad-key' });
    expect(res).toEqual({ ok: false, message: expect.stringContaining('invalid') });
  });

  it('openai: probes a custom OpenAI-compatible endpoint at {endpoint}/models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'k', endpoint: 'https://gateway.example.com/v1' });
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://gateway.example.com/v1/models');
  });

  it('openai: rejects a non-https endpoint before ever calling fetch (SSRF guard)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'k', endpoint: 'http://example.com' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('openai: rejects a private-network endpoint before ever calling fetch (SSRF guard)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'k', endpoint: 'https://169.254.169.254/v1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('openai: a network failure surfaces as ok:false, not a thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await ctx.svc.testCredential(TENANT, 'openai', { apiKey: 'k' });
    expect(res).toEqual({ ok: false, message: expect.stringContaining('Could not reach provider') });
  });

  it('azure-speech: with a region, probes the STS token-issuance endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ctx.svc.testCredential(TENANT, 'azure-speech', { apiKey: 'az-key', region: 'eastus' });
    expect(res.ok).toBe(true);
    const [target, init] = fetchSpy.mock.calls[0];
    expect(target).toBe('https://eastus.api.cognitive.microsoft.com/sts/v1.0/issuetoken');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('az-key');
  });

  it('azure-speech: rejects a region with path/host injection characters', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(ctx.svc.testCredential(TENANT, 'azure-speech', { apiKey: 'k', region: 'eastus/../evil' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('azure-speech: no region, Foundry endpoint present — reachability-only smoke test', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ctx.svc.testCredential(TENANT, 'azure-speech', { apiKey: 'k', endpoint: 'https://my-resource.cognitiveservices.azure.com' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('no auth-only probe');
    expect(fetchSpy.mock.calls[0][1].method).toBe('HEAD');
  });

  it('azure-speech: neither region nor endpoint is a bad request', async () => {
    await expect(ctx.svc.testCredential(TENANT, 'azure-speech', { apiKey: 'k' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sarvam: defaults to api.sarvam.ai and reports reachability (no auth-only route)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ctx.svc.testCredential(TENANT, 'sarvam', { apiKey: 'sv-key' });
    expect(res.ok).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.sarvam.ai/');
    expect((fetchSpy.mock.calls[0][1].headers as Record<string, string>)['api-subscription-key']).toBe('sv-key');
  });

  it('sarvam: a 5xx from the provider is reported as ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const res = await ctx.svc.testCredential(TENANT, 'sarvam', { apiKey: 'sv-key' });
    expect(res).toEqual({ ok: false, message: expect.stringContaining('503') });
  });
});
