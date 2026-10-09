import { describe, expect, it } from 'vitest';
import { AUDIO_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/audio';
import { LLM_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/llm';
import { NLP_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/nlp';
import { TTS_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/tts';
import { SYSTEM_TASK_DEFAULT_ROUTING } from '../../../../../database/src/prisma/db_main/seed/16-ai-routing-policy';
import { LM_STUDIO_SERVING_DEFAULTS } from '../../settings-registry/descriptors/lmstudio-serving.descriptors';
import { lmStudioPreloadEntryFor, lmStudioServingContextFrom } from '../../effective-config/effective-config.service';
import { residencyServiceOf } from '../model-residency.types';
import { lmStudioLoadSpec } from '../residency-placement';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError, loadBlockedReasonFor } from '../residency-load-spec.builder';

/**
 * TASK-1055 follow-up — completeness audit over the SEED catalogue. For EVERY enabled, self-hosted
 * SYSTEM model a residency-controlled service runs (stt, nlp, LM Studio), the gateway either builds the
 * load_spec its agent accepts or refuses with a NAMED reason. Each row's outcome is pinned in a table,
 * so a new seed row (or a derivation change) cannot silently land in a wrong cache: an unlisted row
 * fails this test.
 */

const SYSTEM = '00000000-0000-0000-0000-000000000000';
type Row = Record<string, unknown> & { id: string; slug: string; sourceUri: string; servedBy: string; wireModelId?: string | null };

const CATALOGUE: Row[] = [...AUDIO_AI_MODELS, ...LLM_AI_MODELS, ...NLP_AI_MODELS, ...TTS_AI_MODELS]
  .map((m) => ({ resourceStatus: 'ENABLED', ...(m as unknown as Row) }))
  .filter((m) => m.tenantId === SYSTEM && m.deploymentKind === 'SELF_HOSTED' && m.resourceStatus === 'ENABLED');
const controlled = (service: string) => CATALOGUE.filter((m) => residencyServiceOf(m as never) === service);

/** The one speech-to-text agent the seed publishes (`25-agents.ts` `realtime-transcription`) names this primary. */
const SEEDED_ASR_PRIMARY = 'arcaai-whisper-large-ml-en-gguf';

type Outcome = { cache: string } | { resolvedSpec: true } | { refused: 'LOAD_FAILED' | 'MODEL_UNKNOWN'; match: RegExp };
const NO_AGENT: Outcome = { refused: 'MODEL_UNKNOWN', match: /No active published speech-to-text agent names/ };
const STAGE: Outcome = { refused: 'LOAD_FAILED', match: /stage, not a speech recognition model/ };

const EXPECTED: Record<'nlp' | 'stt', Record<string, Outcome>> = {
  nlp: {
    'medical-ner': { cache: 'nlp_token_classifier' },
    'symps-disease-bert-v3-c41': { cache: 'nlp_medical_suggester' },
    'gliner2-privacy-filter-pii-multi': { cache: 'nlp_gliner2_guard' },
    'gliner2-guardrails-pii-multi': { cache: 'nlp_gliner2_guard' },
    'gliguard-llm-guardrails-300m': { cache: 'nlp_gliner2_guard' },
    'llama-prompt-guard-2-86m': { cache: 'nlp_seq_cls_guard' },
    // The seed row is not yet published to the models bucket; the scorer never auto-downloads.
    'minicheck-flan-t5-large': { refused: 'LOAD_FAILED', match: /not published to the models bucket/ },
  },
  stt: {
    'faster-whisper-large-v3-turbo-int8': NO_AGENT,
    'nemotron-3.5-asr-streaming-0.6b': NO_AGENT,
    [SEEDED_ASR_PRIMARY]: { resolvedSpec: true },
    'arcaai-whisper-large-ml-en-gguf-q8_0': NO_AGENT,
    'arcaai-whisper-large-ml-en': NO_AGENT,
    'arcaai-whisper-large-ml-en-ct2': NO_AGENT,
    'whisper-large-en-medical-260726-merged-gguf': NO_AGENT,
    'whisper-large-en-medical-260726-merged-gguf-q8_0': NO_AGENT,
    'whisper-large-en-medical-260726-merged-ct2': NO_AGENT,
    'silero-vad': STAGE,
    rnnoise: STAGE,
    deepfilternet3: STAGE,
    'ecapa-tdnn-voxceleb': STAGE,
    'wespeaker-voxceleb-resnet34': STAGE,
    'cadence-fast': STAGE,
  },
};

function builder() {
  const matches = (m: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, want]) =>
      want && typeof want === 'object' && 'in' in (want as object) ? (want as { in: unknown[] }).in.includes(m[key]) : m[key] === want,
    );
  const aiModels = { findAll: async ({ filters }: { filters: Record<string, unknown> }) => CATALOGUE.filter((m) => matches(m, filters)) };
  const asrRow = CATALOGUE.find((m) => m.slug === SEEDED_ASR_PRIMARY)!;
  const agents = [{ tenantId: SYSTEM, slug: 'realtime-transcription', modelId: asrRow.id }];
  const agentRepo = {
    findAll: async ({ filters }: { filters: Record<string, unknown> }) => agents.filter((a) => (filters.modelId as { in: string[] }).in.includes(a.modelId)),
  };
  const asr = { resolve: async () => ({ spec: { models: { asr: { slug: SEEDED_ASR_PRIMARY } } } }) };
  const policies = SYSTEM_TASK_DEFAULT_ROUTING.flatMap((p) => {
    const model = CATALOGUE.find((m) => m.slug === p.modelSlug);
    return model ? [{ tenantId: SYSTEM, taskKey: p.taskKey, modelId: model.id, isDefault: true }] : [];
  });
  const routing = { findCandidates: async (_t: string[], taskKey: string) => policies.filter((p) => p.taskKey === taskKey) };
  return new ResidencyLoadSpecBuilder({ read: async () => [] } as never, agentRepo as never, aiModels as never, asr as never, routing as never);
}

describe.each(['nlp', 'stt'] as const)('every seeded %s model: a load_spec or a named refusal', (service) => {
  const rows = controlled(service);

  it('the expectation table lists exactly the seeded rows (a new row must be classified here)', () => {
    expect(rows.map((m) => m.slug).sort()).toEqual(Object.keys(EXPECTED[service]).sort());
  });

  it.each(rows.map((m) => [m.slug, m] as const))('%s', async (_slug, row) => {
    const expected = EXPECTED[service][row.slug]!;
    const ref = service === 'nlp' ? row.sourceUri : row.slug;
    const outcome = await builder()
      .build(service, ref)
      .then((spec) => ({ spec }))
      .catch((error: unknown) => ({ error }));
    const blocked = loadBlockedReasonFor(service, row as never);

    if ('cache' in expected || 'resolvedSpec' in expected) {
      expect('spec' in outcome ? outcome.spec : outcome).toMatchObject('cache' in expected ? { cache: expected.cache } : { resolved_spec: expect.anything() });
      expect(blocked).toBeNull();
      return;
    }
    expect('error' in outcome).toBe(true);
    const error = (outcome as { error: unknown }).error as ResidencyLoadSpecError;
    expect(error).toBeInstanceOf(ResidencyLoadSpecError);
    expect(error.code).toBe(expected.refused);
    expect(error.message).toMatch(expected.match);
    // A refusal the row alone decides is shown by the catalogue, in the builder's own words; a run-time one is not.
    expect(blocked).toBe(expected.refused === 'LOAD_FAILED' ? error.message : null);
  });
});

describe('every seeded LM Studio model (judges included): the boot-plan load_spec', () => {
  const rows = controlled('lm-studio');
  const context = lmStudioServingContextFrom({ ...LM_STUDIO_SERVING_DEFAULTS });

  it('covers both generative judges and the two Gemma models', () => {
    expect(rows.map((m) => m.slug).sort()).toEqual(['granite-guardian-4.1-8b', 'lms-gemma-4-e2b-it-qat', 'lms-gemma-4-e4b', 'qwen3guard-gen-0.6b']);
  });

  it.each(rows.map((m) => [m.slug, m] as const))('%s', (_slug, row) => {
    expect(row.wireModelId).toEqual(expect.any(String));
    const { entry } = lmStudioPreloadEntryFor(row as never, context);
    const spec = lmStudioLoadSpec(entry, row.wireModelId!, 2);
    expect(spec).toMatchObject({ identifier: row.wireModelId, context_length: expect.any(Number), parallel: expect.any(Number) });
    expect(loadBlockedReasonFor('lm-studio', row as never)).toBeNull();
  });
});
