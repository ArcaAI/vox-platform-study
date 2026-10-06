/**
 * TASK-1048 (owner decision OD-1, 2026-10-06) — an OPTIONAL stage whose prerequisite is missing is
 * switched OFF for the session and REPORTED; it never refuses the session. CORE refusals (no primary
 * ASR model, a non-SPEECH_TO_TEXT primary) are unchanged.
 *
 * OD-2 — diarization ON + no agent-named embedding model → the platform default speaker-embedding
 * model the resolver hands in (`defaultEmbeddingModel`); none → diarization off + warning.
 *
 * The Python-facing `ResolvedAsrSpec` wire shape does not change: warnings travel through the
 * `onWarning` collector, never on the spec.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AsrSessionWarning, ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { describe, expect, it } from 'vitest';
import { AsrSpecBuildError, buildResolvedAsrSpec, needsPlatformEmbeddingDefault } from '../build-resolved-asr-spec';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureCase | string>;
const base = (FIXTURE.platformDefault as FixtureCase).input.agent;
const cloud = (FIXTURE.cloudWithAgentFallback as FixtureCase).input;

const withFrontEnd = (audioFrontEnd: Record<string, unknown>, agent: ResolvedAgent = base): ResolvedAgent => ({
  ...agent,
  compiledConfig: { ...agent.compiledConfig, parameters: { ...(agent.compiledConfig.parameters as object), audioFrontEnd } },
});
const withoutModel = (role: string, agent: ResolvedAgent = base): ResolvedAgent => ({ ...agent, models: agent.models.filter((m) => m.role !== role) });

/** The tester's agent: diarization on, NO `embeddingModelSlug`, no embedding row. */
const sarvamLike = (): ResolvedAgent => withoutModel('embedding', withFrontEnd({ diarization: { enabled: true } }));

const PLATFORM_EMBEDDING: ResolvedAgentModel = {
  role: 'embedding',
  slug: 'wespeaker-voxceleb-resnet34',
  sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
  sourceRevision: null,
  localPath: 'models/system/wespeaker-voxceleb-resnet34',
  checksum: null,
  format: 'PYTORCH',
  computeType: null,
  provider: null,
  tenantId: '00000000-0000-0000-0000-000000000000',
};

function build(input: Parameters<typeof buildResolvedAsrSpec>[0]) {
  const warnings: AsrSessionWarning[] = [];
  const spec = buildResolvedAsrSpec({ ...input, onWarning: (w) => warnings.push(w) });
  return { spec, warnings };
}

describe('TASK-1048 — diarization with no embedding model DEGRADES', () => {
  it('no agent model and no platform default → diarization off, no embedding shipped, one DIARIZATION_MODEL_MISSING warning', () => {
    const { spec, warnings } = build({ agent: sarvamLike(), fallbackAgent: null });
    expect(spec.audioFrontEnd.diarization.enabled).toBe(false);
    expect(spec.models).not.toHaveProperty('embedding');
    expect(warnings).toEqual([
      {
        code: 'DIARIZATION_MODEL_MISSING',
        stage: 'diarization',
        severity: 'WARNING',
        message: expect.stringMatching(/^Speaker diarization is off for this session/),
        agentSlug: base.slug,
        agentVersionNumber: base.versionNumber,
      },
    ]);
  });

  it('OD-2 — the platform default embedding model is used when the agent names none, and nothing is reported', () => {
    const { spec, warnings } = build({ agent: sarvamLike(), fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.audioFrontEnd.diarization.enabled).toBe(true);
    expect(spec.models.embedding).toMatchObject({ role: 'embedding', slug: 'wespeaker-voxceleb-resnet34', taskType: 'SPEAKER_EMBEDDING' });
    expect(warnings).toEqual([]);
  });

  it('an agent-bound embedding model always wins over the platform default', () => {
    const { spec } = build({ agent: base, fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.models.embedding?.slug).toBe('ecapa-tdnn-voxceleb');
  });

  it('an agent that NAMED a slug which did not materialise never borrows the platform default (a different vector space)', () => {
    const agent = withoutModel('embedding', withFrontEnd({ diarization: { enabled: true, embeddingModelSlug: 'ecapa-tdnn-voxceleb' } }));
    const { spec, warnings } = build({ agent, fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.audioFrontEnd.diarization.enabled).toBe(false);
    expect(spec.models).not.toHaveProperty('embedding');
    expect(warnings.map((w) => w.code)).toEqual(['DIARIZATION_MODEL_MISSING']);
  });

  it('a disabled stage never consults the default and ships no embedding model', () => {
    const agent = withoutModel('embedding', withFrontEnd({ diarization: { enabled: false } }));
    const { spec, warnings } = build({ agent, fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.audioFrontEnd.diarization.enabled).toBe(false);
    expect(spec.models).not.toHaveProperty('embedding');
    expect(warnings).toEqual([]);
  });

  it('keeps the other diarization tuning the agent said, with the stage switched off', () => {
    const agent = withoutModel('embedding', withFrontEnd({ diarization: { enabled: true, maxSpeakers: 3, matchThreshold: 0.7 } }));
    const { spec } = build({ agent, fallbackAgent: null });
    expect(spec.audioFrontEnd.diarization).toEqual({ enabled: false, backend: 'embedding', maxSpeakers: 3, matchThreshold: 0.7 });
  });
});

describe('TASK-1048 — a retired diarization backend DEGRADES', () => {
  it('an enabled sortformer stage → diarization off + DIARIZATION_BACKEND_UNSUPPORTED, never coerced into running embedding', () => {
    const { spec, warnings } = build({ agent: withFrontEnd({ diarization: { enabled: true, backend: 'sortformer' } }), fallbackAgent: null });
    expect(spec.audioFrontEnd.diarization).toMatchObject({ enabled: false, backend: 'embedding' });
    expect(spec.models).not.toHaveProperty('embedding');
    expect(warnings.map((w) => [w.code, w.stage])).toEqual([['DIARIZATION_BACKEND_UNSUPPORTED', 'diarization']]);
  });

  it('reports the backend, not a missing model, when both are wrong — and uses no platform default', () => {
    const agent = withoutModel('embedding', withFrontEnd({ diarization: { enabled: true, backend: 'pyannote' } }));
    const { spec, warnings } = build({ agent, fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.models).not.toHaveProperty('embedding');
    expect(warnings.map((w) => w.code)).toEqual(['DIARIZATION_BACKEND_UNSUPPORTED']);
  });
});

describe('TASK-1048 — VAD enabled with no VAD model DEGRADES', () => {
  it('vad off, no vad model shipped, one VAD_MODEL_MISSING warning (the runtime segments on energy)', () => {
    const agent = withoutModel('vad', withFrontEnd({ vad: { enabled: true, threshold: 0.4 } }));
    const { spec, warnings } = build({ agent, fallbackAgent: null });
    expect(spec.audioFrontEnd.vad.enabled).toBe(false);
    expect(spec.audioFrontEnd.vad.threshold).toBe(0.4);
    expect(spec.models).not.toHaveProperty('vad');
    expect(warnings.map((w) => [w.code, w.stage, w.severity])).toEqual([['VAD_MODEL_MISSING', 'vad', 'WARNING']]);
    expect(warnings[0].message).toMatch(/^Voice-activity detection is off for this session/);
  });
});

describe('TASK-1048 — warnings are de-duplicated across the chains of one agent', () => {
  it('the model-level fallback chain is built from the SAME agent parameters, so its identical degradation is reported once', () => {
    // `base` carries a model-level fallback row, so its chain re-builds the same front end.
    const { spec, warnings } = build({ agent: sarvamLike(), fallbackAgent: null });
    expect(spec.fallback.kind).toBe('model');
    expect(spec.fallback.spec?.audioFrontEnd.diarization.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('the platform default reaches the model-level fallback chain too', () => {
    const { spec } = build({ agent: sarvamLike(), fallbackAgent: null, defaultEmbeddingModel: PLATFORM_EMBEDDING });
    expect(spec.fallback.spec?.models.embedding?.slug).toBe('wespeaker-voxceleb-resnet34');
  });
});

describe('TASK-1048 — fallbacks', () => {
  it('a fallback AGENT whose optional stage is unrunnable degrades in place and is reported under ITS slug', () => {
    const fallbackAgent = withoutModel('vad', withFrontEnd({ vad: { enabled: true } }, cloud.fallbackAgent as ResolvedAgent));
    const { spec, warnings } = build({ agent: base, fallbackAgent });
    expect(spec.fallback.kind).toBe('agent');
    expect(spec.fallback.spec?.audioFrontEnd.vad.enabled).toBe(false);
    expect(warnings).toEqual([expect.objectContaining({ code: 'VAD_MODEL_MISSING', agentSlug: fallbackAgent.slug })]);
  });

  it('a fallback AGENT of the wrong task is SKIPPED with FALLBACK_UNRUNNABLE — the primary session still builds', () => {
    const fallbackAgent: ResolvedAgent = { ...(cloud.fallbackAgent as ResolvedAgent), slug: 'a-text-agent', task: 'SUMMARIZATION' as never };
    const { spec, warnings } = build({ agent: cloud.agent, fallbackAgent });
    expect(spec.agent.slug).toBe(cloud.agent.slug);
    expect(spec.fallback.kind).toBe('none');
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'FALLBACK_UNRUNNABLE', stage: 'fallback', severity: 'WARNING', agentSlug: 'a-text-agent' }),
    ]);
  });

  it('a skipped fallback AGENT never lends its credential binding to the model chain that replaces it', () => {
    const fallbackAgent: ResolvedAgent = { ...(cloud.fallbackAgent as ResolvedAgent), models: [] };
    const { spec, warnings } = build({
      agent: base,
      fallbackAgent,
      connections: { fallback: { connectionId: 'conn-fb', connectionSlug: 'fb', connectionKey: 'azure-speech:fb' } },
    });
    expect(warnings.map((w) => w.code)).toEqual(['FALLBACK_UNRUNNABLE']);
    expect(spec.fallback.kind).toBe('model');
    expect(spec.fallback.spec).not.toHaveProperty('connectionId');
    expect(spec.fallback.spec).not.toHaveProperty('connectionKey');
  });
});

describe('TASK-1048 — CORE refusals are unchanged', () => {
  it('no primary ASR model still fails closed', () => {
    expect(() => build({ agent: withoutModel('primary'), fallbackAgent: null })).toThrow(AsrSpecBuildError);
  });

  it('a non-SPEECH_TO_TEXT primary still fails closed', () => {
    expect(() => build({ agent: { ...base, task: 'SUMMARIZATION' as never }, fallbackAgent: null })).toThrow(AsrSpecBuildError);
  });
});

describe('TASK-1048 — the wire shape is unchanged', () => {
  it('the spec never carries a warnings key', () => {
    const { spec } = build({ agent: sarvamLike(), fallbackAgent: null });
    expect(spec).not.toHaveProperty('warnings');
    expect(JSON.stringify(spec)).not.toContain('DIARIZATION_MODEL_MISSING');
  });

  it('building without a collector still works (a degradation is never a throw)', () => {
    expect(() => buildResolvedAsrSpec({ agent: sarvamLike(), fallbackAgent: null })).not.toThrow();
  });
});

describe('needsPlatformEmbeddingDefault — when the resolver must read OD-2 at all', () => {
  it('true only for an enabled, supported stage with no agent-named slug and no embedding row', () => {
    expect(needsPlatformEmbeddingDefault(sarvamLike())).toBe(true);
    expect(needsPlatformEmbeddingDefault(base)).toBe(false);
    expect(needsPlatformEmbeddingDefault(withoutModel('embedding', withFrontEnd({ diarization: { enabled: false } })))).toBe(false);
    expect(needsPlatformEmbeddingDefault(withoutModel('embedding', withFrontEnd({ diarization: { enabled: true, backend: 'sortformer' } })))).toBe(false);
    expect(
      needsPlatformEmbeddingDefault(withoutModel('embedding', withFrontEnd({ diarization: { enabled: true, embeddingModelSlug: 'named-one' } }))),
    ).toBe(false);
  });
});
