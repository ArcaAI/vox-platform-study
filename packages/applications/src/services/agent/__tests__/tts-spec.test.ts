/**
 * TASK-879 — the PURE half of TTS agent resolution.
 *
 * `tts-spec.ts` decides what a candidate IS: which engine serves it, which voice binding the
 * agent's `parameters.voice` selects on the bound model, which deployment artifacts the loader
 * needs, and whether the fallback chain may be walked at all. No I/O, no DI — everything a
 * repository has to fetch lives in `TtsAgentResolverService`, so the committed contract fixture
 * can pin this file's output exactly.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import {
  TtsSpecBuildError,
  buildResolvedTtsSpec,
  fallbackTtsModelsOf,
  primaryTtsModelOf,
  sameTtsCandidate,
  selectTtsVoice,
  toTtsCandidate,
  ttsArtifactsOf,
  ttsEngineProvider,
  ttsParametersOf,
  ttsVoiceBindingsOf,
} from '../tts-spec';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';

const model = (over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel => ({
  role: 'primary',
  slug: 'kokoro',
  sourceUri: 'hexgrad/Kokoro-82M',
  sourceRevision: 'main',
  localPath: null,
  checksum: null,
  format: 'PYTORCH',
  computeType: 'float32',
  provider: 'built-in',
  tenantId: SYSTEM_TENANT_ID,
  ...over,
});

const agent = (over: Partial<ResolvedAgent> & { parameters?: Record<string, unknown> } = {}): ResolvedAgent => {
  const { parameters, ...rest } = over;
  const models = rest.models ?? [model()];
  const primary = models[0]!;
  return {
    agentId: 'agent-tts-1',
    agentVersionId: 'agent-tts-1',
    slug: 'platform-tts',
    versionNumber: 1,
    task: 'TEXT_TO_SPEECH',
    tenantId: SYSTEM_TENANT_ID,
    source: 'platform-default',
    compiledConfig: {
      task: 'TEXT_TO_SPEECH',
      service: 'tts',
      model: { id: 'm1', slug: primary.slug, provider: primary.provider, taskType: 'TEXT_TO_SPEECH' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: parameters ?? { voice: 'af_heart', language: 'en', speed: 1, format: 'wav', sampleRate: 24000 },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
      protocols: ['http'],
    },
    models,
    ...rest,
  };
};

const KOKORO_META = { ttsProvider: 'kokoro', voices: [{ id: 'af_heart', locale: 'en-US' }, { id: 'am_adam', locale: 'en-US' }] };

describe('ttsEngineProvider — the documented catalogue cascade', () => {
  it('prefers `_metadata.ttsProvider` for a built-in engine', () => {
    expect(ttsEngineProvider(model(), KOKORO_META)).toBe('kokoro');
  });

  it('falls back to the `provider` column when it is not `built-in`', () => {
    expect(ttsEngineProvider(model({ slug: 'sarvam-bulbul', provider: 'sarvam' }), { voices: [] })).toBe('sarvam');
  });

  it('falls back to the slug with `-` → `_` as the last resort', () => {
    expect(ttsEngineProvider(model({ slug: 'indic-f5', provider: 'built-in' }), null)).toBe('indic_f5');
  });
});

describe('ttsVoiceBindingsOf / selectTtsVoice', () => {
  it('normalises `_metadata.voices`, dropping malformed entries', () => {
    const bindings = ttsVoiceBindingsOf({
      voices: [
        { id: 'af_heart', locale: 'en-US' },
        { id: 'ml-ref-1', locale: 'ml-IN', providerVoice: 'Anjali', refAudioPath: '/models/ref.wav', refText: 'namaskaaram' },
        { locale: 'en-GB' },
        'nonsense',
      ],
    });
    expect(bindings).toEqual([
      { id: 'af_heart', locale: 'en-US', providerVoice: null, refAudioPath: null, refText: null },
      { id: 'ml-ref-1', locale: 'ml-IN', providerVoice: 'Anjali', refAudioPath: '/models/ref.wav', refText: 'namaskaaram' },
    ]);
  });

  it('returns [] when there is no voice list at all', () => {
    expect(ttsVoiceBindingsOf(null)).toEqual([]);
    expect(ttsVoiceBindingsOf({ voices: 'not-an-array' })).toEqual([]);
  });

  it('selects the binding the agent named, and null when it names none or an unknown one', () => {
    const bindings = ttsVoiceBindingsOf(KOKORO_META);
    expect(selectTtsVoice(bindings, 'am_adam')?.id).toBe('am_adam');
    expect(selectTtsVoice(bindings, 'nobody')).toBeNull();
    expect(selectTtsVoice(bindings, null)).toBeNull();
  });
});

describe('ttsArtifactsOf', () => {
  it('keeps only string-valued artifact paths', () => {
    expect(ttsArtifactsOf({ artifacts: { descEncoderPath: '/models/flan-t5', bogus: 3 } })).toEqual({ descEncoderPath: '/models/flan-t5' });
  });

  it('is {} when the row declares none', () => {
    expect(ttsArtifactsOf({ voices: [] })).toEqual({});
  });
});

describe('ttsParametersOf', () => {
  it('normalises the agent block, leaving an unset field null', () => {
    expect(ttsParametersOf({ voice: 'af_heart', speed: 1.25 })).toEqual({
      voice: 'af_heart',
      language: null,
      speed: 1.25,
      format: null,
      sampleRate: null,
      ssml: false,
    });
  });
});

describe('primaryTtsModelOf / fallbackTtsModelsOf', () => {
  it('orders the model chain by priority', () => {
    const a = agent({
      models: [model(), model({ role: 'fallback', slug: 'azure-neural-voices', priority: 1 }), model({ role: 'fallback', slug: 'sarvam-bulbul', priority: 0 })],
    });
    expect(primaryTtsModelOf(a)?.slug).toBe('kokoro');
    expect(fallbackTtsModelsOf(a).map((m) => m.slug)).toEqual(['sarvam-bulbul', 'azure-neural-voices']);
  });
});

describe('toTtsCandidate', () => {
  it('resolves engine, voice, artifacts and the runtime key', () => {
    const candidate = toTtsCandidate({
      agent: agent(),
      model: model(),
      kind: 'primary',
      metaData: KOKORO_META,
      connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' },
      fundingTier: 'platform',
    });
    expect(candidate.runtimeKey).toBe('agent-tts-1');
    expect(candidate.model.provider).toBe('kokoro');
    expect(candidate.model.taskType).toBe('TEXT_TO_SPEECH');
    expect(candidate.model.voices).toHaveLength(2);
    expect(candidate.voice?.id).toBe('af_heart');
    expect(candidate.parameters.sampleRate).toBe(24000);
    expect(candidate.connection?.funding).toBe('platform');
  });

  it('derives a distinct runtime key for a model-level fallback so a switch is observable', () => {
    const candidate = toTtsCandidate({
      agent: agent(),
      model: model({ role: 'fallback', slug: 'sarvam-bulbul', provider: 'sarvam', sourceUri: 'bulbul:v3', priority: 0 }),
      kind: 'fallback-model',
      metaData: { voices: [] },
      connection: null,
      fundingTier: 'platform',
    });
    expect(candidate.runtimeKey).toBe('agent-tts-1:fallback:sarvam-bulbul');
    expect(candidate.model.role).toBe('fallback');
    expect(candidate.model.provider).toBe('sarvam');
    expect(candidate.voice).toBeNull();
  });
});

describe('sameTtsCandidate', () => {
  const base = () =>
    toTtsCandidate({
      agent: agent(),
      model: model(),
      kind: 'primary',
      metaData: KOKORO_META,
      connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' },
      fundingTier: 'platform',
    });

  it('treats two candidates that dispatch to the same engine + model + funding as one', () => {
    const other = toTtsCandidate({
      agent: agent({ agentId: 'other', agentVersionId: 'other', slug: 'tenant-tts', tenantId: TENANT, source: 'tenant' }),
      model: model(),
      kind: 'platform-default',
      metaData: KOKORO_META,
      connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' },
      fundingTier: 'platform',
    });
    expect(sameTtsCandidate(base(), other)).toBe(true);
  });

  it('keeps the tenant`s own credentialled endpoint distinct from the platform`s', () => {
    const byo = toTtsCandidate({
      agent: agent({ tenantId: TENANT, source: 'tenant' }),
      model: model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' }),
      kind: 'primary',
      metaData: { voices: [] },
      connection: { provider: 'azure', baseUrl: null, region: 'westeurope', timeoutS: null, funding: 'tenant' },
      fundingTier: 'tenant',
    });
    const platform = toTtsCandidate({
      agent: agent(),
      model: model({ slug: 'azure-neural-voices', provider: 'azure', sourceUri: 'azure://neural-voices' }),
      kind: 'platform-default',
      metaData: { voices: [] },
      connection: { provider: 'azure', baseUrl: null, region: 'eastus', timeoutS: null, funding: 'platform' },
      fundingTier: 'platform',
    });
    expect(sameTtsCandidate(byo, platform)).toBe(false);
  });
});

describe('buildResolvedTtsSpec', () => {
  const source = (over: Partial<Parameters<typeof toTtsCandidate>[0]> = {}) => ({
    agent: agent(),
    model: model(),
    kind: 'primary' as const,
    metaData: KOKORO_META,
    connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' as const },
    fundingTier: 'platform' as const,
    ...over,
  });

  it('refuses an agent of the wrong task — fail closed, never a guessed engine', () => {
    const wrong = agent({ task: 'TEXT_GENERATION' });
    expect(() => buildResolvedTtsSpec({ primary: source({ agent: wrong }), chain: [], autoSwitch: true })).toThrow(TtsSpecBuildError);
  });

  it('carries the schema version, the primary and an empty chain', () => {
    const spec = buildResolvedTtsSpec({ primary: source(), chain: [], autoSwitch: true });
    expect(spec.schemaVersion).toBe(1);
    expect(spec.agent.slug).toBe('platform-tts');
    expect(spec.primary.kind).toBe('primary');
    expect(spec.fallback).toEqual({ autoSwitch: true, chain: [] });
  });

  it('drops a chain entry that duplicates the primary endpoint, and de-dupes within the chain', () => {
    const dup = source({ kind: 'platform-default' });
    const spec = buildResolvedTtsSpec({ primary: source(), chain: [dup, dup], autoSwitch: true });
    expect(spec.fallback.chain).toHaveLength(0);
  });

  it('honours a tenant`s autoSwitch:false only on a primary the TENANT funds', () => {
    const byoPrimary = source({
      agent: agent({ tenantId: TENANT, source: 'tenant' }),
      model: model({ slug: 'azure-neural-voices', provider: 'azure' }),
      metaData: { voices: [] },
      connection: { provider: 'azure', baseUrl: null, region: 'westeurope', timeoutS: null, funding: 'tenant' as const },
      fundingTier: 'tenant' as const,
    });
    expect(buildResolvedTtsSpec({ primary: byoPrimary, chain: [], autoSwitch: false }).fallback.autoSwitch).toBe(false);
    // …and ignores it on a platform-funded primary: the tenant is not the party paying for
    // — or bearing the availability of — that synthesis (owner decision TASK-870 #4).
    expect(buildResolvedTtsSpec({ primary: source(), chain: [], autoSwitch: false }).fallback.autoSwitch).toBe(true);
  });
});
