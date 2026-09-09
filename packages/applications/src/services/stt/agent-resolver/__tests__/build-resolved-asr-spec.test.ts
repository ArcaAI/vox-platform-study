/**
 * TASK-861 — `buildResolvedAsrSpec()` is the ONE producer of the gateway → apps/stt
 * ASR runtime contract. These tests pin it against the committed cross-language
 * fixture (`tests/contracts/resolved-asr-spec.fixture.json`) and the edge rules the
 * fixture cannot show (no primary model → fail closed; a fallback needs a distinct
 * runtime key).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedAgent, ResolvedAsrSpec } from '@arcaai/types';
import { AI_MODEL_ASR_PROFILE_DECODING_RANGES, AI_MODEL_ASR_PROFILE_WINDOW_RANGES } from '@arcaai/types';
import { AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import { describe, expect, it } from 'vitest';
import { AsrSpecBuildError, buildResolvedAsrSpec } from '../build-resolved-asr-spec';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
  expected: ResolvedAsrSpec;
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

describe('buildResolvedAsrSpec — the committed contract fixture', () => {
  it.each(cases)('%s: produces exactly the expected ResolvedAsrSpec', (_name, { input, expected }) => {
    expect(buildResolvedAsrSpec(input)).toEqual(expected);
  });

  it('never carries credential material, even when the agent resolved a provider override', () => {
    const cloud = fixture.cloudWithAgentFallback as FixtureCase;
    const json = JSON.stringify(buildResolvedAsrSpec(cloud.input));
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('REDACTED-NEVER-IN-SPEC');
  });
});

describe('buildResolvedAsrSpec — rules the fixture cannot show', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  it('fails closed when the agent resolved no primary model', () => {
    const agent: ResolvedAgent = { ...base, models: base.models.filter((m) => m.role !== 'primary') };
    expect(() => buildResolvedAsrSpec({ agent, fallbackAgent: null })).toThrow(AsrSpecBuildError);
  });

  it('a model-level fallback gets a runtime key distinct from the primary so an engine switch is observable', () => {
    const spec = buildResolvedAsrSpec({ agent: base, fallbackAgent: null });
    expect(spec.fallback.kind).toBe('model');
    expect(spec.fallback.spec?.runtimeKey).not.toBe(spec.runtimeKey);
    expect(spec.fallback.spec?.runtimeKey).toContain(spec.runtimeKey);
  });

  it('with no fallback rows and no fallback agent the spec declares kind none and no target', () => {
    const agent: ResolvedAgent = { ...base, models: base.models.filter((m) => m.role !== 'fallback') };
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.fallback).toEqual({ kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null });
  });

  it('prefers the lowest-priority enabled fallback row', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: [
        ...base.models,
        { ...base.models[1], role: 'fallback', priority: 5, slug: 'later-fallback' },
        { ...base.models[1], role: 'fallback', priority: -1, slug: 'first-fallback' },
      ],
    };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).fallback.spec?.models.asr.slug).toBe('first-fallback');
  });

  it('a fallback agent wins over the model chain (parameters.fallback.agentSlug is the explicit choice)', () => {
    const fallbackAgent = (fixture.cloudWithAgentFallback as FixtureCase).input.fallbackAgent as ResolvedAgent;
    const spec = buildResolvedAsrSpec({ agent: base, fallbackAgent });
    expect(spec.fallback.kind).toBe('agent');
    expect(spec.fallback.spec?.runtimeKey).toBe(fallbackAgent.agentVersionId);
  });
});

describe('buildResolvedAsrSpec — TASK-877 additive fields', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  /** `base` with `compiledConfig.parameters` merged — the shape TASK-876 names in the agent schema. */
  const withParameters = (parameters: Record<string, unknown>): ResolvedAgent => ({
    ...base,
    compiledConfig: { ...base.compiledConfig, parameters: { ...(base.compiledConfig.parameters as object), ...parameters } },
  });

  it('maps the per-agent batch chunking the owner asked for (decision #9)', () => {
    const spec = buildResolvedAsrSpec({ agent: withParameters({ decoding: { chunkLengthSec: 20, strideLengthSec: [5, 3] } }), fallbackAgent: null });
    expect(spec.decoding.chunkLengthSec).toBe(20);
    expect(spec.decoding.strideLengthSec).toEqual([5, 3]);
  });

  it('omits the chunking fields when the agent set none, so the batch path keeps the platform values', () => {
    const spec = buildResolvedAsrSpec({ agent: withParameters({ decoding: {} }), fallbackAgent: null });
    expect(spec.decoding).not.toHaveProperty('chunkLengthSec');
    expect(spec.decoding).not.toHaveProperty('strideLengthSec');
  });

  it('rejects a malformed stride rather than emitting half a pair', () => {
    // A one-element or non-numeric stride is no opinion — never a silently
    // half-read `[left]` the runtime would then treat as authoritative.
    for (const strideLengthSec of [[5], [5, 3, 1], ['5', '3'], 5, null]) {
      const spec = buildResolvedAsrSpec({ agent: withParameters({ decoding: { strideLengthSec } }), fallbackAgent: null });
      expect(spec.decoding).not.toHaveProperty('strideLengthSec');
    }
  });

  it('maps the semantic-endpointing block that replaces stt.semanticEndpoint.*', () => {
    const spec = buildResolvedAsrSpec({
      agent: withParameters({ streaming: { endpointing: 'semantic', semantic: { minSilenceMs: 240, maxSilenceMs: 600, confidenceThreshold: 0.9, minWords: 5 } } }),
      fallbackAgent: null,
    });
    expect(spec.streaming.endpointing).toBe('semantic');
    expect(spec.streaming.semantic).toEqual({ minSilenceMs: 240, maxSilenceMs: 600, confidenceThreshold: 0.9, minWords: 5 });
  });

  it('omits an empty semantic block so "set nothing" has exactly one encoding', () => {
    const spec = buildResolvedAsrSpec({ agent: withParameters({ streaming: { endpointing: 'semantic', semantic: {} } }), fallbackAgent: null });
    expect(spec.streaming.endpointing).toBe('semantic');
    expect(spec.streaming).not.toHaveProperty('semantic');
  });

  it('carries a partially-set semantic block, leaving the rest to the engine default', () => {
    const spec = buildResolvedAsrSpec({ agent: withParameters({ streaming: { semantic: { minWords: 5 } } }), fallbackAgent: null });
    expect(spec.streaming.semantic).toEqual({ minSilenceMs: null, maxSilenceMs: null, confidenceThreshold: null, minWords: 5 });
  });

  it('resolves the end-of-utterance model from the agent chain, not a free-string platform key', () => {
    const eou = { ...base.models[2], role: 'endpointing' as const, slug: 'smart-turn-v3' };
    const spec = buildResolvedAsrSpec({ agent: { ...base, models: [...base.models, eou] }, fallbackAgent: null });
    expect(spec.models.endpointing?.slug).toBe('smart-turn-v3');
    expect(spec.models.endpointing?.taskType).toBe('TEXT_CLASSIFICATION');
    // The fallback chain runs the same front end, so it inherits the same EOU model.
    expect(spec.fallback.spec?.models.endpointing?.slug).toBe('smart-turn-v3');
  });

  it('omits the endpointing role entirely when the agent bound no EOU model', () => {
    expect(buildResolvedAsrSpec({ agent: base, fallbackAgent: null }).models).not.toHaveProperty('endpointing');
  });
});

/**
 * TASK-880 — model-coupled facts ride the `AiModel` row, not a platform key.
 *
 * `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS` were platform-wide
 * numbers describing ONE engine's decode geometry. They are now
 * `AiModel._metadata.asr.{maxDecodeWindowSec,partialWindowSec}`, carried per model on the
 * spec — so the fallback chain's engine gets ITS OWN window rather than the primary's.
 */
describe('buildResolvedAsrSpec — AiModel._metadata.asr rides each model', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  const withMeta = (agent: ResolvedAgent, role: string, asr: Record<string, number>): ResolvedAgent => ({
    ...agent,
    models: agent.models.map((m) => (m.role === role ? { ...m, metaData: { asr } } : m)),
  });

  it('carries the agent-owned VAD padding onto audioFrontEnd.vad, omitted when unset', () => {
    const withPad: ResolvedAgent = {
      ...base,
      compiledConfig: { ...base.compiledConfig, parameters: { ...(base.compiledConfig.parameters as object), audioFrontEnd: { vad: { speechPadMs: 320 } } } },
    };
    expect(buildResolvedAsrSpec({ agent: withPad, fallbackAgent: null }).audioFrontEnd.vad.speechPadMs).toBe(320);
    expect(buildResolvedAsrSpec({ agent: base, fallbackAgent: null }).audioFrontEnd.vad).not.toHaveProperty('speechPadMs');
  });

  it('surfaces the primary model’s asr metadata on models.asr.metadata', () => {
    const agent = withMeta(base, 'primary', { maxDecodeWindowSec: 7, partialWindowSec: 6 });
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).models.asr.metadata).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 6 });
  });

  it('OMITS metadata when the row declares none — the wire key must never appear as null', () => {
    const agent: ResolvedAgent = { ...base, models: base.models.map(({ metaData: _drop, ...m }) => m) };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).models.asr).not.toHaveProperty('metadata');
  });

  it('the fallback chain carries the FALLBACK row’s own window, not the primary’s', () => {
    const agent = withMeta(withMeta(base, 'primary', { maxDecodeWindowSec: 7 }), 'fallback', { maxDecodeWindowSec: 30 });
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.models.asr.metadata?.maxDecodeWindowSec).toBe(7);
    expect(spec.fallback.spec?.models.asr.metadata?.maxDecodeWindowSec).toBe(30);
  });

  it('ignores non-numeric metadata rather than forwarding a shape apps/stt would reject', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: base.models.map((m) => (m.role === 'primary' ? { ...m, metaData: { asr: { maxDecodeWindowSec: 'seven' } } as never } : m)),
    };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).models.asr).not.toHaveProperty('metadata');
  });
});

/**
 * TASK-887 — diarization is a DECLARED agent option, and the AGENT names the space.
 *
 * This replaces TASK-880's `ASR_AGENT_EMBEDDING_SPACE_MISMATCH` block. That guard enforced ONE
 * platform embedding space (`stt.diarization.hfModelId` + a `vector(256)` column), so an agent
 * binding a 192-d row was refused. Under the owner's decision (target model item 8) the agent IS
 * the space: a profile records the model that embedded it (`UserVoiceProfile.modelId`), the
 * column is dimension-agnostic `vector`, and matching only ever considers profiles from the SAME
 * model. A width mismatch is impossible by construction — there is nothing left to refuse.
 *
 * What remains refusable is the fail-closed case: embedding diarization ON with no model named.
 */
describe('buildResolvedAsrSpec — the agent declares the diarization space', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;
  const baseParameters = base.compiledConfig.parameters as Record<string, unknown>;
  const baseFrontEnd = baseParameters.audioFrontEnd as Record<string, unknown>;

  /** `base` with its diarization block replaced, and optionally its model list. */
  const withDiarization = (diarization: Record<string, unknown>, models: ResolvedAgent['models'] = base.models): ResolvedAgent => ({
    ...base,
    models,
    compiledConfig: {
      ...base.compiledConfig,
      parameters: { ...baseParameters, audioFrontEnd: { ...baseFrontEnd, diarization } },
    },
  });

  const withoutEmbeddingModel = (): ResolvedAgent['models'] => base.models.filter((m) => m.role !== 'embedding');

  it('no longer refuses an embedding model whose declared width differs from the old platform space', () => {
    // The exact case TASK-880 rejected with a 409: the fixture agent binds the 192-d ECAPA row.
    // Enrolment now happens IN that row's space, so this is a legitimate agent, not a defect.
    const agent: ResolvedAgent = {
      ...base,
      models: base.models.map((m) => (m.role === 'embedding' ? { ...m, metaData: { embedding: { dimension: 192 } } } : m)),
    };
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.models.embedding?.slug).toBe('ecapa-tdnn-voxceleb');
  });

  it('refuses embedding diarization with no embedding model bound, naming the parameter to set', () => {
    let thrown: unknown;
    try {
      buildResolvedAsrSpec({ agent: withDiarization({ enabled: true, backend: 'embedding' }, withoutEmbeddingModel()), fallbackAgent: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AsrSpecBuildError);
    expect((thrown as AsrSpecBuildError).code).toBe('ASR_AGENT_DIARIZATION_MODEL_MISSING');
    expect((thrown as AsrSpecBuildError).message).toContain('audioFrontEnd.diarization.embeddingModelSlug');
  });

  it('leaves the sortformer backend alone — it carries its own weights', () => {
    expect(() =>
      buildResolvedAsrSpec({ agent: withDiarization({ enabled: true, backend: 'sortformer' }, withoutEmbeddingModel()), fallbackAgent: null }),
    ).not.toThrow();
  });

  it('says nothing about an agent with diarization off and no embedding model — the OFF default', () => {
    expect(() => buildResolvedAsrSpec({ agent: withDiarization({ enabled: false }, withoutEmbeddingModel()), fallbackAgent: null })).not.toThrow();
  });

  it('checks the FALLBACK chain too — a fallback agent may not diarize without a model either', () => {
    const fallbackAgent = withDiarization({ enabled: true, backend: 'embedding' }, withoutEmbeddingModel());
    expect(() => buildResolvedAsrSpec({ agent: base, fallbackAgent })).toThrow(AsrSpecBuildError);
  });

  it('carries matchThreshold when the agent sets it, and OMITS the key when it does not', () => {
    const set = buildResolvedAsrSpec({ agent: withDiarization({ enabled: true, backend: 'embedding', matchThreshold: 0.72 }), fallbackAgent: null });
    expect(set.audioFrontEnd.diarization.matchThreshold).toBe(0.72);

    // Omitted, never `null`: apps/stt's mirror is `extra='forbid'` and treats an absent key as
    // "no opinion, keep my own default" — `DiarizationConfig.match_threshold`.
    const unset = buildResolvedAsrSpec({ agent: withDiarization({ enabled: true, backend: 'embedding' }), fallbackAgent: null });
    expect(unset.audioFrontEnd.diarization).not.toHaveProperty('matchThreshold');
  });

  it('ignores a non-numeric matchThreshold rather than forwarding a shape apps/stt would reject', () => {
    const spec = buildResolvedAsrSpec({ agent: withDiarization({ enabled: true, backend: 'embedding', matchThreshold: 'high' }), fallbackAgent: null });
    expect(spec.audioFrontEnd.diarization).not.toHaveProperty('matchThreshold');
  });
});

/**
 * TASK-934 (OD-3, OD-4, OD-11) — the per-model ASR decode profile.
 *
 * `AiModel._metadata.asr` grew from two window numbers into a full decode profile, so a
 * registered fine-tune carries the parameters it was MEASURED with. Precedence is one rule,
 * stated once: the AGENT wins where it spoke, the model profile FILLS what it left unsaid, and
 * what neither declares is omitted so `apps/stt`'s dataclass stays the one engine default.
 *
 * That order is deliberate (OD-3): the tenant-authored agent stays sovereign (rule 2), and the
 * profile is a per-model DEFAULT, never a per-model override.
 */
describe('buildResolvedAsrSpec — AiModelAsrProfile precedence (OD-3)', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  /** `base` with the PRIMARY row's `_metadata.asr` replaced and the agent parameters merged. */
  const withProfile = (asr: Record<string, unknown>, parameters: Record<string, unknown> = {}): ResolvedAgent => ({
    ...base,
    models: base.models.map((m) => (m.role === 'primary' ? { ...m, metaData: { asr } as never } : m)),
    compiledConfig: { ...base.compiledConfig, parameters: { ...(base.compiledConfig.parameters as object), ...parameters } },
  });

  it('the agent wins, the profile fills, and what neither declares is absent', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile(
        { decoding: { beamSize: 1, noSpeechThreshold: 0.4 } },
        { decoding: { languageMode: 'ml-en', beamSize: 5 } },
      ),
      fallbackAgent: null,
    });
    expect(spec.decoding.beamSize).toBe(5); // the agent said 5 over the row's 1
    expect(spec.decoding.noSpeechThreshold).toBe(0.4); // the row filled what the agent left unsaid
    expect(spec.decoding).not.toHaveProperty('compressionRatioThreshold'); // neither spoke ⇒ the engine default
  });

  it('names the tier that supplied each contested knob, so a live session can be explained', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile(
        { decoding: { beamSize: 1, noSpeechThreshold: 0.4 } },
        { decoding: { languageMode: 'ml-en', beamSize: 5 } },
      ),
      fallbackAgent: null,
    });
    expect(spec.decoding.sources).toEqual({ beamSize: 'agent', noSpeechThreshold: 'model', initialPrompt: 'agent', hotwords: 'agent' });
  });

  it('omits the sources map entirely when neither tier decided anything', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: base.models.map(({ metaData: _drop, ...m }) => m),
      compiledConfig: { ...base.compiledConfig, parameters: {}, instruction: null },
    };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).decoding).not.toHaveProperty('sources');
  });

  it('carries every new decode knob from the profile alone', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile({
        decoding: {
          noSpeechThreshold: 0.4,
          compressionRatioThreshold: 2.2,
          logprobThreshold: -0.8,
          conditionOnPrevTokens: true,
          noRepeatNgramSize: 4,
          prevTextContextWords: 20,
        },
      }),
      fallbackAgent: null,
    });
    expect(spec.decoding).toMatchObject({
      noSpeechThreshold: 0.4,
      compressionRatioThreshold: 2.2,
      logprobThreshold: -0.8,
      conditionOnPrevTokens: true,
      noRepeatNgramSize: 4,
      prevTextContextWords: 20,
    });
  });

  it('carries every new decode knob from the agent alone', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile(
        {},
        {
          decoding: {
            noSpeechThreshold: 0.3,
            compressionRatioThreshold: 3,
            logprobThreshold: -1.2,
            conditionOnPrevTokens: false,
            noRepeatNgramSize: 0,
            prevTextContextWords: 0,
          },
        },
      ),
      fallbackAgent: null,
    });
    expect(spec.decoding).toMatchObject({
      noSpeechThreshold: 0.3,
      compressionRatioThreshold: 3,
      logprobThreshold: -1.2,
      conditionOnPrevTokens: false,
      noRepeatNgramSize: 0,
      prevTextContextWords: 0,
    });
    expect(spec.decoding.sources).toMatchObject({ noSpeechThreshold: 'agent', prevTextContextWords: 'agent', conditionOnPrevTokens: 'agent' });
  });

  it('drops an out-of-range or unknown profile member and reports it, rather than failing the session', () => {
    const rejections: Array<{ modelSlug: string; rejected: string[] }> = [];
    const spec = buildResolvedAsrSpec({
      // The agent leaves beamSize unsaid, so only the row's (rejected) 99 could have supplied it.
      agent: withProfile({ decoding: { beamSize: 99, noSpeechThreshold: 0.4 }, bestOf: 5 }, { decoding: { languageMode: 'ml-en' } }),
      fallbackAgent: null,
      onProfileRejection: (event) => rejections.push(event),
    });
    expect(spec.decoding.beamSize).toBeNull(); // 99 is outside 1–10 ⇒ no opinion, engine default
    expect(spec.decoding.noSpeechThreshold).toBe(0.4);
    expect(rejections).toEqual([{ modelSlug: 'arcaai-whisper-large-ml-en-gguf', rejected: ['decoding.beamSize', 'bestOf'] }]);
  });

  it('OD-11 — the prompt is per fine-tune: the agent wins, the profile fills, absence is null', () => {
    const noInstruction = { ...base.compiledConfig, instruction: null };
    const rowPrompt = { ...base, compiledConfig: noInstruction, models: base.models.map((m) => (m.role === 'primary' ? { ...m, metaData: { asr: { initialPrompt: 'Malayalam-English clinical consultation.' } } as never } : m)) };
    expect(buildResolvedAsrSpec({ agent: rowPrompt, fallbackAgent: null }).instruction.initialPrompt).toBe('Malayalam-English clinical consultation.');
    expect(buildResolvedAsrSpec({ agent: rowPrompt, fallbackAgent: null }).decoding.sources).toMatchObject({ initialPrompt: 'model' });

    // The agent's own prompt is sovereign.
    const agentPrompt = withProfile({ initialPrompt: 'from the row' });
    expect(buildResolvedAsrSpec({ agent: agentPrompt, fallbackAgent: null }).instruction.initialPrompt).toBe('Clinical consultation. Medical terminology.');

    const neither: ResolvedAgent = { ...base, compiledConfig: noInstruction, models: base.models.map(({ metaData: _drop, ...m }) => m) };
    expect(buildResolvedAsrSpec({ agent: neither, fallbackAgent: null }).instruction.initialPrompt).toBeNull();
  });

  it('folds profile hotwords into instruction.hotwords — one wire path, never two', () => {
    const noInstruction = { ...base.compiledConfig, instruction: null };
    const agent: ResolvedAgent = {
      ...base,
      compiledConfig: noInstruction,
      models: base.models.map((m) => (m.role === 'primary' ? { ...m, metaData: { asr: { decoding: { hotwords: ['sephotrioxone'] } } } as never } : m)),
    };
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.instruction.hotwords).toEqual(['sephotrioxone']);
    expect(spec.decoding.sources).toMatchObject({ hotwords: 'model' });
    // The agent's own list wins whole — hotwords are a set the author curated, not a merge.
    expect(buildResolvedAsrSpec({ agent: withProfile({ decoding: { hotwords: ['sephotrioxone'] } }), fallbackAgent: null }).instruction.hotwords).toEqual([
      'paracetamol',
      'metformin',
    ]);
  });

  it('carries the ROW’s raw recommendation on models.asr.metadata even when the agent overrode it', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile({ maxDecodeWindowSec: 7, partialWindowSec: 15, initialPrompt: 'from the row', decoding: { beamSize: 1 } }, { decoding: { beamSize: 5 } }),
      fallbackAgent: null,
    });
    expect(spec.models.asr.metadata).toEqual({
      maxDecodeWindowSec: 7,
      partialWindowSec: 15,
      initialPrompt: 'from the row',
      decoding: { beamSize: 1 },
    });
  });

  it('OD-4 — an agent-level streaming.partialWindowSec overrides the row’s partial tail', () => {
    const spec = buildResolvedAsrSpec({
      agent: withProfile({ maxDecodeWindowSec: 7, partialWindowSec: 6 }, { streaming: { partialWindowSec: 15 } }),
      fallbackAgent: null,
    });
    // The EFFECTIVE geometry rides where apps/stt already reads it, so no runtime change is needed.
    expect(spec.models.asr.metadata?.partialWindowSec).toBe(15);
    expect(spec.models.asr.metadata?.maxDecodeWindowSec).toBe(7); // geometry: the row alone (OD-3)
    expect(spec.decoding.sources).toMatchObject({ partialWindowSec: 'agent' });
  });

  it('the agent override reaches a row that declares no geometry at all', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: base.models.map(({ metaData: _drop, ...m }) => m),
      compiledConfig: { ...base.compiledConfig, parameters: { ...(base.compiledConfig.parameters as object), streaming: { partialWindowSec: 15 } } },
    };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).models.asr.metadata).toEqual({ partialWindowSec: 15 });
  });

  it('resolves the FALLBACK chain against the fallback row’s own profile', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: base.models.map((m) =>
        m.role === 'primary'
          ? { ...m, metaData: { asr: { decoding: { noSpeechThreshold: 0.4 } } } as never }
          : m.role === 'fallback'
            ? { ...m, metaData: { asr: { decoding: { noSpeechThreshold: 0.7 } } } as never }
            : m,
      ),
    };
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.decoding.noSpeechThreshold).toBe(0.4);
    expect(spec.fallback.spec?.decoding.noSpeechThreshold).toBe(0.7);
  });
});

/**
 * TASK-934 — the two tiers must accept the SAME values.
 *
 * The agent's decode block is range-gated by `SPEECH_TO_TEXT_PARAMETERS` at publish
 * (`@arcaai/workflow-contract`); the model row's profile is range-gated by
 * `parseAiModelAsrProfile` at resolve (`@arcaai/types`). They feed ONE engine field, so a
 * value one tier accepts and the other refuses would make the effective value depend on
 * which tier happened to supply it — and the difference would only ever show up as a
 * quality regression on somebody's consultation.
 *
 * `@arcaai/workflow-contract` has zero dependencies by design, so its own suite pins the
 * ranges as literals. THIS is where the two tables are compared, because this package is
 * the only one that imports both.
 */
describe('TASK-934 — the agent schema and the model profile agree on every range', () => {
  it.each(Object.keys(AI_MODEL_ASR_PROFILE_DECODING_RANGES))('decoding.%s', (key) => {
    const range = AI_MODEL_ASR_PROFILE_DECODING_RANGES[key];
    const schema = ((AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT.properties as Record<string, { properties: Record<string, Record<string, unknown>> }>).decoding.properties ?? {})[key];
    expect(schema, `SPEECH_TO_TEXT_PARAMETERS.decoding.${key} is missing`).toBeDefined();
    expect(schema).toMatchObject({ type: range.integer ? 'integer' : 'number', minimum: range.min, maximum: range.max });
  });

  it('streaming.partialWindowSec matches the profile’s window range', () => {
    const schema = (AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT.properties as Record<string, { properties: Record<string, Record<string, unknown>> }>).streaming.properties
      .partialWindowSec;
    expect(schema).toMatchObject({
      type: 'number',
      minimum: AI_MODEL_ASR_PROFILE_WINDOW_RANGES.partialWindowSec.min,
      maximum: AI_MODEL_ASR_PROFILE_WINDOW_RANGES.partialWindowSec.max,
    });
  });

  it('conditionOnPrevTokens is a boolean at BOTH tiers (it is a switch, not a threshold)', () => {
    expect(AI_MODEL_ASR_PROFILE_DECODING_RANGES).not.toHaveProperty('conditionOnPrevTokens');
    const schema = (AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT.properties as Record<string, { properties: Record<string, Record<string, unknown>> }>).decoding.properties
      .conditionOnPrevTokens;
    expect(schema).toMatchObject({ type: 'boolean' });
  });
});

describe('TASK-935 — postProcessing.lexicon rides the wire, its terms do not (OD-5 a)', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  /** `base` with `parameters.postProcessing` merged. */
  const withLexicon = (lexicon: Record<string, unknown> | undefined): ResolvedAgent => {
    const parameters = base.compiledConfig.parameters as Record<string, unknown>;
    const postProcessing = { ...(parameters.postProcessing as object), ...(lexicon === undefined ? {} : { lexicon }) };
    return { ...base, compiledConfig: { ...base.compiledConfig, parameters: { ...parameters, postProcessing } } };
  };

  it('carries the block when the agent declared it, beside the hotwords that feed it', () => {
    const spec = buildResolvedAsrSpec({ agent: withLexicon({ enabled: true }), fallbackAgent: null });
    expect(spec.postProcessing.lexicon).toEqual({ enabled: true });
    // The stage's vocabulary is `instruction.hotwords` — already resolved agent →
    // model profile by TASK-934 — and is NEVER copied into the lexicon block.
    expect(spec.instruction.hotwords).toEqual(['paracetamol', 'metformin']);
    expect(spec.postProcessing.lexicon).not.toHaveProperty('terms');
  });

  it('omits the block entirely when the agent said nothing about it', () => {
    const spec = buildResolvedAsrSpec({ agent: withLexicon(undefined), fallbackAgent: null });
    // `apps/stt`'s mirror is `extra='forbid'`, so an unset optional is OMITTED rather
    // than written as null — the same rule the TASK-877/934 additive fields follow.
    expect(spec.postProcessing).not.toHaveProperty('lexicon');
    expect(Object.keys(spec.postProcessing).sort()).toEqual(['disfluency', 'merge', 'punctuation', 'stabilizer']);
  });

  it('carries an explicit OFF — a veto is an opinion, not an absence', () => {
    const spec = buildResolvedAsrSpec({ agent: withLexicon({ enabled: false }), fallbackAgent: null });
    expect(spec.postProcessing.lexicon).toEqual({ enabled: false });
  });

  it('carries maxDistance only when the agent tuned it', () => {
    expect(buildResolvedAsrSpec({ agent: withLexicon({ enabled: true, maxDistance: 0.25 }), fallbackAgent: null }).postProcessing.lexicon).toEqual({
      enabled: true,
      maxDistance: 0.25,
    });
    expect(buildResolvedAsrSpec({ agent: withLexicon({ enabled: true }), fallbackAgent: null }).postProcessing.lexicon).not.toHaveProperty('maxDistance');
  });

  it('reads a bare maxDistance as switching the stage on', () => {
    // Tuning a stage you have not enabled is not a state worth encoding; the author
    // who set a distance meant the stage to run at it.
    expect(buildResolvedAsrSpec({ agent: withLexicon({ maxDistance: 0.4 }), fallbackAgent: null }).postProcessing.lexicon).toEqual({
      enabled: true,
      maxDistance: 0.4,
    });
  });

  it('bounds maxDistance to the published agent schema, never to a call-site literal', () => {
    const schema = AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT as { properties: Record<string, { properties: Record<string, { properties: Record<string, { minimum: number; maximum: number }> }> }> };
    const declared = schema.properties.postProcessing.properties.lexicon.properties.maxDistance;
    expect([declared.minimum, declared.maximum]).toEqual([0.1, 0.5]);
  });
});
