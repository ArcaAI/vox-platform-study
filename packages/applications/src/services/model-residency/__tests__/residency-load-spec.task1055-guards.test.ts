import { describe, expect, it } from 'vitest';
import { AUDIO_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/audio';
import { NLP_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/nlp';
import { SYSTEM_TASK_DEFAULT_ROUTING } from '../../../../../database/src/prisma/db_main/seed/16-ai-routing-policy';
import { derivedLocalPath } from '../../ai-model/constants';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError, loadBlockedReasonFor } from '../residency-load-spec.builder';

/**
 * TASK-1055 follow-up (owner: "the platform admin must manage ALL model load/unload/lifecycle with
 * configuration, including Prompt Guard 2 and the judge models"). nlp serves two more caches —
 * `nlp_seq_cls_guard` (the transformers sequence-classification guard behind `/guard/classify`, e.g.
 * Prompt Guard 2) and `nlp_judge_guard` (the generative `qwen3guard_native` judge behind `/guard/judge`)
 * — and the builder used to send Prompt Guard 2 to `nlp_text_classifier` and could not name either
 * cache at all. Rows below are the SEED rows.
 */

const SYSTEM = '00000000-0000-0000-0000-000000000000';
type Row = Record<string, unknown> & { id: string; slug: string; sourceUri: string; servedBy: string };

const seed = (slug: string, overrides: Record<string, unknown> = {}): Row => {
  const row = [...NLP_AI_MODELS, ...AUDIO_AI_MODELS].find((m) => m.slug === slug);
  if (!row) throw new Error(`seed row ${slug} missing`);
  return { resourceStatus: 'ENABLED', ...(row as unknown as Row), ...overrides };
};
const ALL_NLP = (): Row[] => NLP_AI_MODELS.map((m) => ({ resourceStatus: 'ENABLED', ...(m as unknown as Row) }));

function policies(rows: Row[]) {
  return SYSTEM_TASK_DEFAULT_ROUTING.flatMap((p) => {
    const model = rows.find((m) => m.slug === p.modelSlug);
    return model ? [{ tenantId: SYSTEM, taskKey: p.taskKey, modelId: model.id, isDefault: true }] : [];
  });
}

/** The repositories the builder reads, honouring every filter it sends (servedBy included: an LM Studio row is not nlp's). */
function build(rows: Row[]) {
  const matches = (m: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, want]) => {
      if (want && typeof want === 'object' && 'in' in (want as object)) return ((want as { in: unknown[] }).in ?? []).includes(m[key]);
      if (want && typeof want === 'object' && 'not' in (want as object)) return m[key] !== (want as { not: unknown }).not;
      return m[key] === want;
    });
  const aiModels = {
    findAll: async ({ filters }: { filters: Record<string, unknown> }) => rows.filter((m) => matches(m, filters)),
    findBySlug: async (tenantId: string, slug: string) => rows.find((m) => m.tenantId === tenantId && m.slug === slug) ?? null,
  };
  const routing = { findCandidates: async (_t: string[], taskKey: string) => policies(rows).filter((p) => p.taskKey === taskKey) };
  const agentModels = new AgentResolverService({} as never, {} as never, aiModels as never, {} as never);
  return new ResidencyLoadSpecBuilder(aiModels as never, routing as never, agentModels);
}

const refusal = async (promise: Promise<unknown>): Promise<ResidencyLoadSpecError> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ResidencyLoadSpecError);
  return error as ResidencyLoadSpecError;
};

describe('Prompt Guard 2 → nlp_seq_cls_guard (a guard-taxonomy row on the transformers runtime)', () => {
  it('derives nlp_seq_cls_guard, not nlp_text_classifier, after an nlp restart (nothing reported)', async () => {
    await expect(build(ALL_NLP()).build('nlp', 'meta-llama/Llama-Prompt-Guard-2-86M')).resolves.toEqual({
      cache: 'nlp_seq_cls_guard',
      model_path: null,
    });
  });

  it('carries the derived local path once the row is published', async () => {
    const pg2 = seed('llama-prompt-guard-2-86m', { bucketPrefix: 'nlp/llama-prompt-guard-2-86m' });
    const rows = [...ALL_NLP().filter((m) => m.slug !== pg2.slug), pg2];
    const spec = await build(rows).build('nlp', 'meta-llama/Llama-Prompt-Guard-2-86M');
    expect(spec).toEqual({ cache: 'nlp_seq_cls_guard', model_path: derivedLocalPath(pg2 as never) });
    expect(spec.model_path).toMatch(/llama-prompt-guard-2-86m\/$/);
  });

  it('a reported nlp_seq_cls_guard slot is accepted as-is', async () => {
    await expect(build(ALL_NLP()).build('nlp', 'meta-llama/Llama-Prompt-Guard-2-86M', 'nlp_seq_cls_guard')).resolves.toEqual({
      cache: 'nlp_seq_cls_guard',
      model_path: null,
    });
  });

  it('a guard-taxonomy row on a runtime /guard/classify does not have is refused by name', async () => {
    const odd = seed('llama-prompt-guard-2-86m', { libraryName: 'onnxruntime' });
    const error = await refusal(build([odd]).build('nlp', odd.sourceUri));
    expect(error.code).toBe('LOAD_FAILED');
    expect(error.message).toMatch(/labelTaxonomy/);
    expect(error.message).toMatch(/onnxruntime/);
  });
});

describe('generative judges → nlp_judge_guard (an nlp-served row declaring `_metadata.judge`)', () => {
  it('the seed Qwen3Guard row is LM Studio-served: nlp has no row for it (LM Studio loads it with the boot-plan spec)', async () => {
    const error = await refusal(build([...ALL_NLP()]).build('nlp', 'qwen3guard-gen-0.6b'));
    expect(error.code).toBe('MODEL_UNKNOWN');
    expect(loadBlockedReasonFor('lm-studio', seed('qwen3guard-gen-0.6b'))).toBeNull();
  });

  it('an nlp-served qwen3guard_native judge loads into nlp_judge_guard with its derived path', async () => {
    const judge = seed('qwen3guard-gen-0.6b', {
      servedBy: 'nlp',
      provider: 'built-in',
      sourceUri: 'Qwen/Qwen3Guard-Gen-0.6B',
      libraryName: 'transformers',
      bucketPrefix: 'nlp/qwen3guard-gen-0.6b',
    });
    const spec = await build([...ALL_NLP(), judge]).build('nlp', 'Qwen/Qwen3Guard-Gen-0.6B');
    expect(spec).toEqual({ cache: 'nlp_judge_guard', model_path: derivedLocalPath(judge as never) });
  });

  it('a reported nlp_judge_guard slot is accepted as-is', async () => {
    const judge = seed('qwen3guard-gen-0.6b', { servedBy: 'nlp', sourceUri: 'Qwen/Qwen3Guard-Gen-0.6B' });
    await expect(build([judge]).build('nlp', 'Qwen/Qwen3Guard-Gen-0.6B', 'nlp_judge_guard')).resolves.toEqual({
      cache: 'nlp_judge_guard',
      model_path: null,
    });
  });

  it('an nlp-served judge on a protocol nlp has no runtime for (criteria_json) is refused by name', async () => {
    const judge = seed('qwen3guard-gen-0.6b', {
      servedBy: 'nlp',
      sourceUri: 'some/criteria-judge',
      metaData: { judge: { protocol: 'criteria_json', lanes: ['medical_validation'] } },
    });
    const error = await refusal(build([judge]).build('nlp', 'some/criteria-judge'));
    expect(error.code).toBe('LOAD_FAILED');
    expect(error.message).toMatch(/qwen3guard_native/);
    expect(error.message).toMatch(/criteria_json/);
  });
});

describe('stt stage models load on their own — the model-only spec (TASK-1055 wave 3, W3-2)', () => {
  it('Silero VAD builds {model} in the vad role, no agent consulted', async () => {
    const spec = (await build([seed('silero-vad')]).build('stt', 'silero-vad')) as { model: Record<string, unknown> };
    expect(spec.model).toMatchObject({ role: 'vad', slug: 'silero-vad', taskType: 'VOICE_ACTIVITY_DETECTION' });
  });

  it('an ASR row builds {model} in the asr role, whether or not a published agent names it', async () => {
    const asr = seed('arcaai-whisper-large-ml-en-gguf');
    const spec = (await build([asr]).build('stt', asr.slug)) as { model: Record<string, unknown> };
    expect(spec.model).toMatchObject({ role: 'asr', slug: asr.slug, localPath: derivedLocalPath(asr as never) });
  });
});

describe('loadBlockedReasonFor — the reasons the catalogue can state before a Load is attempted', () => {
  it('is null for every model the console can load (Prompt Guard 2, GLiGuard, Medical NER, the suggester, ASR models, LM Studio judges)', () => {
    expect(loadBlockedReasonFor('nlp', seed('llama-prompt-guard-2-86m'))).toBeNull();
    expect(loadBlockedReasonFor('nlp', seed('gliguard-llm-guardrails-300m'))).toBeNull();
    expect(loadBlockedReasonFor('nlp', seed('medical-ner'))).toBeNull();
    expect(loadBlockedReasonFor('nlp', seed('symps-disease-bert-v3-c41'))).toBeNull();
    expect(loadBlockedReasonFor('stt', seed('arcaai-whisper-large-ml-en-gguf'))).toBeNull();
    expect(loadBlockedReasonFor('lm-studio', seed('qwen3guard-gen-0.6b'))).toBeNull();
  });

  it('names the missing published path for MiniCheck (the scorer never auto-downloads)', () => {
    expect(loadBlockedReasonFor('nlp', seed('minicheck-flan-t5-large'))).toMatch(/models bucket/);
    expect(loadBlockedReasonFor('nlp', seed('minicheck-flan-t5-large', { bucketPrefix: 'nlp/m', primaryObject: 'm.gguf' }))).toBeNull();
  });

  it('stt stage rows are no longer refused (they load on their own)', () => {
    expect(loadBlockedReasonFor('stt', seed('silero-vad'))).toBeNull();
    expect(loadBlockedReasonFor('stt', seed('ecapa-tdnn-voxceleb'))).toBeNull();
  });

  it('names the missing calibration and the unsupported judge protocol', () => {
    expect(loadBlockedReasonFor('nlp', seed('minicheck-flan-t5-large', { bucketPrefix: 'nlp/m', metaData: { entailment: 'x' } }))).toMatch(
      /_metadata\.entailment/,
    );
    expect(loadBlockedReasonFor('nlp', seed('qwen3guard-gen-0.6b', { servedBy: 'nlp', metaData: { judge: { protocol: 'criteria_json' } } }))).toMatch(
      /qwen3guard_native/,
    );
  });
});
