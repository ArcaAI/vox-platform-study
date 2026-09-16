/**
 * TASK-977 — the resolver half of "an ASR front-end stage runs only because an admin
 * said so".
 *
 * Before this ticket `vad.enabled` was the literal `true` (the agent had no way to say
 * otherwise) and `denoise.enabled` was DERIVED from model binding, so attaching a
 * denoise row to browse it switched the stage on. Both are now read from the agent, both
 * default `false`, and a stage the spec ships as OFF ships no model with it (D-4) — a
 * disabled stage must cost zero model loads in `apps/stt`.
 *
 * `resample` / `normalize` keep defaulting `true`: they are not stages, they are what
 * makes the audio meet the model's input contract (owner directive).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedAgent } from '@arcaai/types';
import { describe, expect, it } from 'vitest';
import { AsrSpecBuildError, buildResolvedAsrSpec } from '../build-resolved-asr-spec';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureCase | string>;

const base = (FIXTURE.platformDefault as FixtureCase).input.agent;

/** `base` with `parameters.audioFrontEnd` REPLACED (not merged) — each case states the whole block. */
const withFrontEnd = (audioFrontEnd: Record<string, unknown>, agent: ResolvedAgent = base): ResolvedAgent => ({
  ...agent,
  compiledConfig: { ...agent.compiledConfig, parameters: { ...(agent.compiledConfig.parameters as object), audioFrontEnd } },
});

const withoutModel = (role: string, agent: ResolvedAgent = base): ResolvedAgent => ({
  ...agent,
  models: agent.models.filter((m) => m.role !== role),
});

const specOf = (agent: ResolvedAgent) => buildResolvedAsrSpec({ agent, fallbackAgent: null });

describe('TASK-977 D-1 — VAD is off until the agent enables it', () => {
  it('an agent silent about VAD yields vad.enabled false', () => {
    expect(specOf(withFrontEnd({})).audioFrontEnd.vad.enabled).toBe(false);
  });

  it('an agent that only TUNES VAD has still not enabled it', () => {
    // Tuning is not consent: a threshold left over from an earlier config must not
    // switch the stage back on.
    const spec = specOf(withFrontEnd({ vad: { modelSlug: 'silero-vad', threshold: 0.5, speechPadMs: 320 } }));
    expect(spec.audioFrontEnd.vad.enabled).toBe(false);
    expect(spec.audioFrontEnd.vad.threshold).toBe(0.5);
    expect(spec.audioFrontEnd.vad.speechPadMs).toBe(320);
  });

  it('an explicit true enables it', () => {
    expect(specOf(withFrontEnd({ vad: { enabled: true } })).audioFrontEnd.vad.enabled).toBe(true);
  });
});

describe('TASK-977 D-2 — denoise enablement is declared, never inferred from a bound model', () => {
  it('a bound denoise model does NOT enable the stage', () => {
    const agent = withFrontEnd({ denoise: { modelSlug: 'rnnoise' } }, (FIXTURE.cloudWithAgentFallback as FixtureCase).input.agent);
    expect(specOf(agent).audioFrontEnd.denoise).toEqual({ enabled: false, level: 'off' });
  });

  it('enabled with no level falls back to medium', () => {
    expect(specOf(withFrontEnd({ denoise: { enabled: true } })).audioFrontEnd.denoise).toEqual({ enabled: true, level: 'medium' });
  });

  it('enabled honours the level the agent chose', () => {
    expect(specOf(withFrontEnd({ denoise: { enabled: true, level: 'high' } })).audioFrontEnd.denoise).toEqual({ enabled: true, level: 'high' });
  });

  it('the two fields can never disagree: disabled forces level off whatever the agent wrote', () => {
    expect(specOf(withFrontEnd({ denoise: { enabled: false, level: 'high' } })).audioFrontEnd.denoise).toEqual({ enabled: false, level: 'off' });
  });

  it('level: off forces enabled false, so the old `level` spelling still turns the stage off', () => {
    expect(specOf(withFrontEnd({ denoise: { enabled: true, level: 'off' } })).audioFrontEnd.denoise).toEqual({ enabled: false, level: 'off' });
  });
});

describe('TASK-977 D-3 — an enabled stage with no model bound is refused, not silently emitted', () => {
  it('VAD enabled with no VOICE_ACTIVITY_DETECTION model fails closed', () => {
    let thrown: unknown;
    try {
      specOf(withFrontEnd({ vad: { enabled: true } }, withoutModel('vad')));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AsrSpecBuildError);
    expect((thrown as AsrSpecBuildError).code).toBe('ASR_AGENT_VAD_MODEL_MISSING');
  });

  it('VAD enabled WITH a model is runnable', () => {
    expect(() => specOf(withFrontEnd({ vad: { enabled: true } }))).not.toThrow();
  });

  it('VAD disabled with no model is runnable — off is not a configuration error', () => {
    expect(() => specOf(withFrontEnd({}, withoutModel('vad')))).not.toThrow();
  });

  it('denoise enabled with NO model is runnable — the denoise engines are runtime-owned', () => {
    // `StreamingDenoiser` loads pyrnnoise's own weights and `DeepFilterNet3StreamingDenoiser`
    // calls `init_df(default_model='DeepFilterNet3')`; the engine is chosen by NAME
    // (`DenoiseConfig.engine`), never from `models.denoise`. Refusing here would refuse the
    // default, legitimate configuration — so denoise gets NO model guard.
    expect(() => specOf(withFrontEnd({ denoise: { enabled: true } }, withoutModel('denoise')))).not.toThrow();
  });

  it('the guard reaches the fallback chain too', () => {
    const fallbackAgent = withFrontEnd(
      { vad: { enabled: true } },
      withoutModel('vad', (FIXTURE.cloudWithAgentFallback as FixtureCase).input.fallbackAgent as ResolvedAgent),
    );
    expect(() => buildResolvedAsrSpec({ agent: base, fallbackAgent })).toThrow(AsrSpecBuildError);
  });
});

describe('TASK-977 D-4 — a disabled stage ships no model', () => {
  it('omits models.vad when VAD is off, even though the agent bound one', () => {
    const spec = specOf(withFrontEnd({ vad: { modelSlug: 'silero-vad' } }));
    expect(spec.audioFrontEnd.vad.enabled).toBe(false);
    expect(spec.models).not.toHaveProperty('vad');
  });

  it('ships models.vad when VAD is on', () => {
    expect(specOf(withFrontEnd({ vad: { enabled: true } })).models.vad?.role).toBe('vad');
  });

  it('omits models.denoise when denoise is off', () => {
    const agent = withFrontEnd({ denoise: { modelSlug: 'rnnoise' } }, (FIXTURE.cloudWithAgentFallback as FixtureCase).input.agent);
    expect(specOf(agent).models).not.toHaveProperty('denoise');
  });

  it('ships models.denoise when denoise is on', () => {
    const agent = withFrontEnd({ denoise: { enabled: true, level: 'high' } }, (FIXTURE.cloudWithAgentFallback as FixtureCase).input.agent);
    expect(specOf(agent).models.denoise?.role).toBe('denoise');
  });

  it('omits models.embedding when diarization is off', () => {
    const spec = specOf(withFrontEnd({ diarization: { enabled: false } }));
    expect(spec.models).not.toHaveProperty('embedding');
  });

  it('ships models.embedding when diarization is on', () => {
    const spec = specOf(withFrontEnd({ diarization: { enabled: true, backend: 'embedding' } }));
    expect(spec.models.embedding?.role).toBe('embedding');
  });

  it('leaves punctuation and endpointing alone — they are not audio front-end stages', () => {
    const endpointing = { ...base.models[0], role: 'endpointing' as const, slug: 'smart-turn-v3' };
    const punctuation = { ...base.models[0], role: 'punctuation' as const, slug: 'punct-en' };
    const agent = withFrontEnd({}, { ...base, models: [...base.models, endpointing, punctuation] });
    const spec = specOf(agent);
    expect(spec.models.endpointing?.slug).toBe('smart-turn-v3');
    expect(spec.models.punctuation?.slug).toBe('punct-en');
  });
});

describe('TASK-977 D-5 — resampling stays ON by default', () => {
  it('an agent silent about resample/normalize still gets them', () => {
    const afe = specOf(withFrontEnd({})).audioFrontEnd;
    expect(afe.resample).toBe(true);
    expect(afe.normalize).toBe(true);
  });

  it('an explicit false is still honoured', () => {
    expect(specOf(withFrontEnd({ resample: false })).audioFrontEnd.resample).toBe(false);
  });
});
