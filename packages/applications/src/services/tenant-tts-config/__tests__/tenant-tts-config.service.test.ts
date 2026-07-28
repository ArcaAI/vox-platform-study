import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SYSTEM_TENANT_ID, SysEventType, TenantTtsConfigFactory } from '@arcaai/domains';
import { TenantTtsConfigService } from '../tenant-tts-config.service';
import { PLATFORM_TTS_LIMITS } from '../platform-limits';

const TENANT = 'tenant-abc';

function makeService() {
  const repo = { findByTenantId: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
  // SYSTEM TTS registry rows (empty = pre-seed fallback).
  const modelRepo = { findByTaskType: vi.fn().mockResolvedValue([]) };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1' } : k === 'tenantId' ? TENANT : undefined)),
  };
  const svc = new TenantTtsConfigService(repo as any, modelRepo as any, emitter as any, cls as any);
  return { svc, repo, modelRepo, emitter };
}

/** Minimal SYSTEM AiModel TTS registry row shape consumed by the catalog. */
function ttsModelRow(over: { slug?: string; name?: string; provider?: string | null; metaData?: Record<string, unknown> | null } = {}) {
  return {
    slug: over.slug ?? 'azure-neural-voices',
    name: over.name ?? 'Azure Neural Voices',
    provider: over.provider === undefined ? 'azure' : over.provider,
    // Catalog voices carry PROVIDER voice identifiers (what voiceBindings bind to).
    metaData:
      over.metaData === undefined
        ? {
            voices: [
              { id: 'en-IN-NeerjaNeural', locale: 'en-IN' },
              { id: 'ml-IN-SobhanaNeural', locale: 'ml-IN' },
            ],
          }
        : over.metaData,
  };
}

const existingRow = () => TenantTtsConfigFactory.CreateTenantTtsConfig({ tenantId: TENANT, defaultSpeed: 1.0, defaultVoiceEn: 'en-female-1' });

describe('TenantTtsConfigService', () => {
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
    await expect(ctx.svc.upsertRow(TENANT, { defaultSpeed: 2.0, expectedVersion: 5 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
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

describe('TenantTtsConfigService — platform catalog from the AiModel registry', () => {
  it('maps SYSTEM ENABLED TEXT_TO_SPEECH rows into providers with metaData.voices', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow(),
      ttsModelRow({
        slug: 'kokoro',
        name: 'Kokoro',
        provider: 'built-in',
        metaData: { ttsProvider: 'kokoro', voices: [{ id: 'af_heart', locale: 'en-US' }] },
      }),
    ]);

    const catalog = await ctx.svc.getPlatformCatalog();

    expect(ctx.modelRepo.findByTaskType).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'TEXT_TO_SPEECH');
    expect(catalog.providers).toEqual([
      {
        provider: 'azure',
        slug: 'azure-neural-voices',
        name: 'Azure Neural Voices',
        voices: [
          { id: 'en-IN-NeerjaNeural', locale: 'en-IN' },
          { id: 'ml-IN-SobhanaNeural', locale: 'ml-IN' },
        ],
      },
      { provider: 'kokoro', slug: 'kokoro', name: 'Kokoro', voices: [{ id: 'af_heart', locale: 'en-US' }] },
    ]);
  });

  it('derives the provider id from metaData.ttsProvider for built-in engines, slug-underscored as last resort', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow({ slug: 'indic-f5', name: 'IndicF5', provider: 'built-in', metaData: { ttsProvider: 'indic_f5', voices: [] } }),
      ttsModelRow({ slug: 'some-engine', name: 'Engine', provider: 'built-in', metaData: null }),
    ]);

    const catalog = await ctx.svc.getPlatformCatalog();

    expect(catalog.providers.map((p) => p.provider)).toEqual(['indic_f5', 'some_engine']);
  });

  it('falls back to the code-constant provider universe when the registry catalog is empty (pre-seed)', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([]);

    const catalog = await ctx.svc.getPlatformCatalog();

    expect(catalog.providers.map((p) => p.provider)).toEqual([...PLATFORM_TTS_LIMITS.providerUniverse]);
    expect(catalog.providers.every((p) => p.voices.length === 0)).toBe(true);
  });
});

describe('TenantTtsConfigService — provider-universe validation on upsert', () => {
  it('rejects routing/allowedProviders entries outside the catalog-derived universe', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([ttsModelRow()]); // universe = ['azure']
    ctx.repo.findByTenantId.mockResolvedValue(null);

    await expect(ctx.svc.upsertRow(TENANT, { routingEn: ['azure', 'kokoro'], expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(ctx.svc.upsertRow(TENANT, { allowedProviders: ['polly'], expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('accepts entries inside the catalog-derived universe', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow(),
      ttsModelRow({ slug: 'kokoro', name: 'Kokoro', provider: 'built-in', metaData: { ttsProvider: 'kokoro', voices: [] } }),
    ]);
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow(TENANT, { routingEn: ['azure', 'kokoro'], expectedVersion: 0 });
    expect(res.routingEn).toEqual(['azure', 'kokoro']);
  });

  it('validates against PLATFORM_TTS_LIMITS.providerUniverse when the catalog is empty', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([]);
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    // indic_parler is in the code universe → accepted pre-seed.
    const res = await ctx.svc.upsertRow(TENANT, { routingMl: ['indic_parler'], expectedVersion: 0 });
    expect(res.routingMl).toEqual(['indic_parler']);

    await expect(ctx.svc.upsertRow(TENANT, { routingMl: ['polly'], expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('TenantTtsConfigService — voice bindings', () => {
  it('persists voiceBindings under configJson on create', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([ttsModelRow()]);
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    await ctx.svc.upsertRow(TENANT, {
      voiceBindings: { 'en-female-1': { azure: 'en-IN-NeerjaNeural' } },
      expectedVersion: 0,
    });

    const created = ctx.repo.create.mock.calls[0][0];
    expect(created.configJson).toEqual({ voiceBindings: { 'en-female-1': { azure: 'en-IN-NeerjaNeural' } } });
  });

  it('rejects a binding for a provider outside the universe', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([ttsModelRow()]); // universe = ['azure']
    ctx.repo.findByTenantId.mockResolvedValue(null);

    await expect(ctx.svc.upsertRow(TENANT, { voiceBindings: { 'en-female-1': { polly: 'Joanna' } }, expectedVersion: 0 })).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );
  });

  it('rejects a bound voice name missing from the provider catalog voices', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow({ metaData: { voices: [{ id: 'en-female-1', locale: 'en-IN', name: 'en-IN-NeerjaNeural' }] } }),
    ]);
    ctx.repo.findByTenantId.mockResolvedValue(null);

    await expect(ctx.svc.upsertRow(TENANT, { voiceBindings: { 'en-female-1': { azure: 'nope-voice' } }, expectedVersion: 0 })).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );
  });

  it('accepts a bound voice name declared in the provider catalog (by name or id)', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([ttsModelRow({ metaData: { voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] } })]);
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow(TENANT, {
      voiceBindings: { 'en-female-1': { azure: 'en-IN-NeerjaNeural' } },
      expectedVersion: 0,
    });
    expect(res.configJson).toEqual({ voiceBindings: { 'en-female-1': { azure: 'en-IN-NeerjaNeural' } } });
  });

  it('skips voice-name validation when the registry catalog is empty (pre-seed)', async () => {
    const ctx = makeService();
    ctx.modelRepo.findByTaskType.mockResolvedValue([]);
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow(TENANT, {
      voiceBindings: { 'en-female-1': { azure: 'any-voice-name' } },
      expectedVersion: 0,
    });
    expect(res.configJson).toEqual({ voiceBindings: { 'en-female-1': { azure: 'any-voice-name' } } });
  });

  it('getEffective merges SYSTEM voiceBindings under tenant bindings (per-voice-id shallow merge, tenant wins)', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantId.mockImplementation(async (id: string) =>
      id === SYSTEM_TENANT_ID
        ? TenantTtsConfigFactory.CreateTenantTtsConfig({
            tenantId: SYSTEM_TENANT_ID,
            configJson: {
              voiceBindings: {
                'en-female-1': { azure: 'en-IN-NeerjaNeural', kokoro: 'af_heart' },
                'ml-female-1': { azure: 'ml-IN-SobhanaNeural' },
              },
            },
          })
        : TenantTtsConfigFactory.CreateTenantTtsConfig({
            tenantId: TENANT,
            configJson: { voiceBindings: { 'en-female-1': { azure: 'en-IN-PrabhatNeural' } } },
          }),
    );

    const eff = await ctx.svc.getEffective(TENANT);

    expect(eff.voiceBindings).toEqual({
      // tenant wins per provider; SYSTEM's kokoro binding survives the shallow merge
      'en-female-1': { azure: 'en-IN-PrabhatNeural', kokoro: 'af_heart' },
      // SYSTEM-only voice id inherited untouched
      'ml-female-1': { azure: 'ml-IN-SobhanaNeural' },
    });
  });
});

// BYO credential behavior (set/rotate/remove/resolve) moved to the unified
// `IProviderConnectionService` (TASK-570) — see
// `TenantTtsConfigAdminController`'s credential-route tests and
// `SpeechProxyController`/`TtsWsGateway` injection tests, which now exercise
// that delegation directly. `TenantTtsConfigService` no longer has a
// credential surface to test.

/**
 * `getEffective` must consult the TTS registry catalog so a
 * disabled/absent SYSTEM registry row disables the provider platform-wide.
 * Empty catalog (pre-seed) → code-constant universe, today's
 * behaviour byte-for-byte. The catalog read is TTL-cached because getEffective
 * sits on the speech-proxy/WS hot path.
 */
describe('TenantTtsConfigService — registry-driven provider universe in getEffective', () => {
  it('a provider with no ENABLED registry row is stripped from effective routing + allowedProviders', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantId.mockResolvedValue(null); // no SYSTEM row, no tenant row
    // Registry catalog WITHOUT azure (row disabled/absent) — kokoro + indic_parler only.
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow({ slug: 'kokoro-82m', name: 'Kokoro 82M', provider: 'built-in', metaData: { ttsProvider: 'kokoro', voices: [] } }),
      ttsModelRow({ slug: 'indic-parler-tts', name: 'Indic Parler', provider: 'built-in', metaData: { ttsProvider: 'indic_parler', voices: [] } }),
    ]);

    const eff = await ctx.svc.getEffective(TENANT);

    expect(eff.routingEn).toEqual(['kokoro']); // code default ['azure','kokoro'] clamped
    expect(eff.routingMl).toEqual(['indic_parler']); // azure stripped, sarvam PHI-stripped
    expect(eff.allowedProviders).not.toContain('azure');
  });

  it('a registry-only provider survives in the effective config', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantId.mockImplementation(async (id: string) =>
      id === TENANT
        ? TenantTtsConfigFactory.CreateTenantTtsConfig({
            tenantId: TENANT,
            routingEn: ['elevenlabs', 'kokoro'],
            allowedProviders: ['elevenlabs', 'kokoro'],
          })
        : null,
    );
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow({ slug: 'elevenlabs-flash', name: 'ElevenLabs Flash', provider: 'elevenlabs', metaData: { voices: [] } }),
      ttsModelRow({ slug: 'kokoro-82m', name: 'Kokoro 82M', provider: 'built-in', metaData: { ttsProvider: 'kokoro', voices: [] } }),
    ]);

    const eff = await ctx.svc.getEffective(TENANT);

    expect(eff.routingEn).toEqual(['elevenlabs', 'kokoro']);
    expect(eff.allowedProviders).toEqual(['elevenlabs', 'kokoro']);
  });

  it("EMPTY registry catalog → code-constant universe (today's behaviour byte-for-byte)", async () => {
    const ctx = makeService();
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.modelRepo.findByTaskType.mockResolvedValue([]); // pre-seed

    const eff = await ctx.svc.getEffective(TENANT);

    expect(eff.routingEn).toEqual([...PLATFORM_TTS_LIMITS.codeDefaults.routingEn]);
    expect(eff.routingMl).toEqual(['azure', 'indic_parler']); // sarvam PHI-stripped
    expect(eff.allowedProviders).toEqual(PLATFORM_TTS_LIMITS.providerUniverse.filter((p) => p !== 'sarvam'));
  });

  it('caches the catalog read across getEffective calls (hot-path TTL cache)', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantId.mockResolvedValue(null);
    ctx.modelRepo.findByTaskType.mockResolvedValue([
      ttsModelRow({ slug: 'kokoro-82m', name: 'Kokoro 82M', provider: 'built-in', metaData: { ttsProvider: 'kokoro', voices: [] } }),
    ]);

    await ctx.svc.getEffective(TENANT);
    await ctx.svc.getEffective(TENANT);
    await ctx.svc.getEffective('tenant-two');

    expect(ctx.modelRepo.findByTaskType).toHaveBeenCalledTimes(1);
  });
});
