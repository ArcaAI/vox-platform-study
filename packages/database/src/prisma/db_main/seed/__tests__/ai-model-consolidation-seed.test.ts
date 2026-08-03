/**
 * AI Model Registry Consolidation seed invariants
 *
 * Static + mock-client assertions over the EXPORTED seed data (no live DB),
 * following the conventions of `seed.test.ts` (this dir) and
 * `src/__tests__/seed.test.ts`. Locks the 60 → 26 catalog consolidation:
 *
 *   1. The final `DEFAULT_AI_MODELS` catalog is EXACTLY the 26 expected slugs,
 *      ids/slugs unique, every `provider` canonical, all 5 TTS rows carry a
 *      non-empty `metaData.voices`, and `indic-f5` seeds DISABLED (prod
 *      NO-GO).
 *   2. `RETIRED_AI_MODEL_SLUGS` is exactly the 50 retired slugs, disjoint from
 *      the catalog, and retired ∪ keepers === the previous 60-row catalog.
 *   3. Regression lock — every slug referenced by seeded pipeline YAML
 *      (`models:` blocks) resolves to a catalog slug, and the 8
 *      pipeline-referenced slugs all survive the consolidation.
 *   4. The pipeline-reference retirement guard skips referenced slugs and
 *      retires unreferenced ones (incl. the prefix-collision case:
 *      `whisper-large-v3` must NOT be blocked by `whisper-large-v3-turbo`).
 *   5. The SYSTEM `AiTaskDefault` seed rows reference catalog slugs with the
 *      compatible `taskType`, and the seed step is CREATE-ONLY.
 *   6. Companion updates: HarnessPolicy SMR default → `gemma-4-e2b-it-qat`;
 *      the six superseded GlobalSetting keys are gone from the seeded arrays
 *      and covered by the idempotent soft-retire sweep; tenant admins hold
 *      read+manage on `AiTaskDefault`.
 */

import { describe, it, expect, vi } from 'vitest';

import * as stt from '../06-stt';
import * as globalSetting from '../11-global-setting';
import { SYSTEM_HARNESS_POLICY_SMR_DEFAULTS } from '../13-harness-policy';
import { DEFAULT_POLICIES } from '../01-policy';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

const { DEFAULT_AI_MODELS, DEFAULT_ASR_PIPELINES, CUSTOMER_TENANT_ASR_PIPELINES, GLOBAL_TENANT_ASR_PIPELINES, ModelTaskType } = stt;

// Loose views over exports that only exist after the seed consolidation
// lands (namespace access keeps this file compiling against the OLD seed so
// the TDD RED run shows real assertion failures, not transform errors).
const RETIRED_AI_MODEL_SLUGS = (stt as Record<string, unknown>).RETIRED_AI_MODEL_SLUGS as readonly string[] | undefined;
const shouldRetireAiModelSlug = (stt as Record<string, unknown>).shouldRetireAiModelSlug as
  ((slug: string, yamls: readonly string[]) => boolean) | undefined;
const retireLegacyAiModels = (stt as Record<string, unknown>).retireLegacyAiModels as
  ((client: unknown) => Promise<{ retired: number; skipped: string[] }>) | undefined;
const RETIRED_GLOBAL_SETTING_KEYS = (globalSetting as Record<string, unknown>).RETIRED_GLOBAL_SETTING_KEYS as
  ReadonlyArray<{ namespace: string; key: string }> | undefined;
const retireSupersededGlobalSettings = (globalSetting as Record<string, unknown>).retireSupersededGlobalSettings as
  ((client: unknown) => Promise<{ retired: number }>) | undefined;

// =============================================================================
// Expected catalog — the 10 keepers + 16 new rows (spec §4.1/§4.3)
// =============================================================================

const KEEPER_SLUGS = [
  'whisper-large-v3-turbo',
  'whisper-small',
  'faster-whisper-large-v3-turbo-int8',
  'azure-speech-stt',
  'mai-transcribe-1.5',
  'nemotron-3.5-asr-streaming-0.6b',
  // renamed from `silero-vad-v6` to match the v5 onnx-community
  // model the stt runtime actually loads.
  'silero-vad',
  'rnnoise',
  'ecapa-tdnn-voxceleb',
  'granite-guardian-4.1-8b',
] as const;

const NEW_LLM_SLUGS = [
  'ollama-gemma4-12b-mlx',
  'ollama-gemma4-e2b-it-qat',
  'ollama-qwen3.5-2b',
  'lms-gemma-4-e2b-it-qat',
  'lms-gemma-4-e4b-it-qat',
  'lms-gemma-4-medical-icd10',
  'lms-gemma-4-12b-qat',
  'lms-medgemma-1.5-4b-it',
  'azure-gpt-5.4-mini',
] as const;

const NEW_NLP_SLUGS = ['medical-ner', 'symps-disease-bert-v3-c41', 'gliner-guard-uniencoder-onnx'] as const;

const NEW_TTS_SLUGS = ['azure-neural-voices', 'kokoro', 'sarvam-bulbul', 'indic-parler-tts', 'indic-f5'] as const;

// Two rows added on top of the closed 60→26
// consolidation: a whisper.cpp GGUF ASR engine and a reinstated
// DeepFilterNet3 denoise engine (fresh slug — NOT the retired
// `deepfilternet-v3`; see EXPECTED_RETIRED_SLUGS below).
const TASK_507_NEW_SLUGS = ['whisper-large-v3-turbo-gguf', 'deepfilternet3'] as const;

// additive production
// self-host engine rows: a vLLM (SAFETENSOR/GPU) and a llama.cpp (GGUF) LLM.
const TASK_515_NEW_SLUGS = ['vllm-medgemma-1.5-27b-it', 'llama-cpp-medgemma-1.5-4b-it'] as const;

// catalog rows for engines the code supports but the seed lacked:
// a Bedrock LLM, the harness LLM-as-judge (google/gemma-4-e4b), the MiniCheck
// groundedness fact-checker, the Cadence STT punctuation model, a pyannote
// WeSpeaker diarization embedding (STT code default), and a DISABLED doc-type
// classifier placeholder that `nlp.classification` now points at.
const TASK_524_NEW_SLUGS = [
  'bedrock-claude-3.5-haiku',
  'lms-gemma-4-e4b',
  'minicheck-flan-t5-large',
  'nlp-doc-type-classifier',
  'cadence-punctuation',
  'wespeaker-voxceleb-resnet34',
] as const;

// TASK-567 — tenant BYOK STT fallback engines (cloud REST catalog metadata for
// the fallback-candidate picker; the pipeline YAML reaches them via the
// `provider :: model` shorthand, so their Prisma `format` is CLOUD_API).
const TASK_567_NEW_SLUGS = ['sarvam-saaras-v4', 'openai-gpt4o-transcribe'] as const;

// ArcaAI in-house Malayalam+English code-switch full fine-tune of
// whisper-large-v3-turbo, served via whisper.cpp GGUF (matrix #10).
const ARCAAI_ML_EN_NEW_SLUGS = [
  'arcaai-whisper-large-ml-en-gguf',
  'arcaai-whisper-large-ml-en-gguf-q8_0',
  'arcaai-whisper-large-ml-en',
] as const;

const EXPECTED_CATALOG_SLUGS = [
  ...KEEPER_SLUGS,
  ...NEW_LLM_SLUGS,
  ...NEW_NLP_SLUGS,
  ...NEW_TTS_SLUGS,
  ...TASK_507_NEW_SLUGS,
  ...TASK_515_NEW_SLUGS,
  ...TASK_524_NEW_SLUGS,
  ...TASK_567_NEW_SLUGS,
  ...ARCAAI_ML_EN_NEW_SLUGS,
] as const;

// The 50 slugs that must be RETIRED (previous 60 minus the 10 keepers).
const EXPECTED_RETIRED_SLUGS = [
  // ASR
  'whisper-large-v3',
  'whisper-medium',
  'faster-whisper-large-v3',
  'parakeet-ctc-1.1b',
  // VAD
  'silero-vad-v4',
  'silero-vad-v5',
  'pyannote-vad',
  // Noise
  'deepfilternet-v3',
  'nvidia-cleanunet',
  // Server-side ONNX whisper
  'whisper-large-v3-turbo-onnx',
  'whisper-large-v3-onnx',
  'whisper-medium-onnx',
  'whisper-small-onnx',
  // Ollama LLMs
  'ollama-qwen3.5-27b',
  'ollama-qwen3.5-latest',
  'ollama-translategemma-12b',
  'ollama-translategemma-latest',
  'ollama-medgemma-27b-text-q4km',
  'ollama-gemma3-latest',
  'ollama-gemma3n-e2b',
  'ollama-gpt-oss-latest',
  'ollama-gemma3n-latest',
  'ollama-granite4-tiny-h',
  'ollama-granite4-latest',
  // Azure OpenAI
  'gpt-4',
  'gpt-4o',
  'gpt-4o-mini',
  // Bedrock
  'claude-3-haiku',
  'claude-3.5-sonnet',
  // OpenAI-compatible
  'local-model-openai-compat',
  // LM Studio
  'lms-qwen3.5-4b',
  'lms-qwen3.5-0.8b',
  'lms-qwen3.5-9b',
  'lms-qwen3.5-35b-a3b',
  'lms-lfm2-24b-a2b',
  'lms-glm-4.6v-flash',
  'lms-lfm2.5-1.2b-instruct',
  'lms-lfm2.5-1.2b-thinking',
  'lms-lfm2.5-vl-1.6b',
  'lms-translategemma-27b-it',
  'lms-gemma-4-e2b-it-sft-rlvr-medical',
  'lms-medgemma-1.5-4b-unsloth',
  'lms-gpt-oss-20b',
  // Browser-local whisper
  'whisper-tiny',
  'whisper-base',
  'whisper-small-local',
  'whisper-medium-local',
  'whisper-tiny-en',
  'whisper-base-en',
  'whisper-small-en',
] as const;

const ALLOWED_PROVIDERS = ['ollama', 'lm-studio', 'azure', 'bedrock', 'built-in', 'sarvam', 'openai', 'vllm', 'llama-cpp'];

// The 8 slugs referenced by seeded pipeline `models:` blocks (regression lock).
const PIPELINE_REFERENCED_SLUGS = [
  'whisper-large-v3-turbo',
  'silero-vad',
  'rnnoise',
  'faster-whisper-large-v3-turbo-int8',
  'whisper-small',
  'azure-speech-stt',
  'mai-transcribe-1.5',
  'nemotron-3.5-asr-streaming-0.6b',
  'arcaai-whisper-large-ml-en-gguf',
  'arcaai-whisper-large-ml-en-gguf-q8_0',
  'arcaai-whisper-large-ml-en',
] as const;

type SeedModel = (typeof DEFAULT_AI_MODELS)[number] & {
  provider?: string | null;
  architecture?: string | null;
  metaData?: { voices?: Array<{ id: string; locale: string }>; azureDeployment?: string };
  resourceStatus?: string;
};

const catalog = DEFAULT_AI_MODELS as readonly SeedModel[];
const bySlug = (slug: string) => catalog.find((m) => m.slug === slug);

// =============================================================================
// 1. Final catalog shape
// =============================================================================

describe('consolidated AI model catalog (26 rows) + extensions', () => {
  it('is exactly the 42 expected slugs (26 + 2 + 9 extensions + 3 ArcaAI ML-EN)', () => {
    const slugs = catalog.map((m) => m.slug).sort();
    expect(slugs).toEqual([...EXPECTED_CATALOG_SLUGS].sort());
    expect(catalog.length).toBe(42);
  });

  it('has unique ids and unique slugs', () => {
    const ids = catalog.map((m) => m.id);
    const slugs = catalog.map((m) => m.slug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps every row on the SYSTEM tenant', () => {
    catalog.forEach((m) => expect(m.tenantId).toBe(SYSTEM_TENANT_ID));
  });

  it('sets a canonical provider on every row', () => {
    catalog.forEach((m) => {
      expect(ALLOWED_PROVIDERS, `model ${m.slug} has provider ${String(m.provider)}`).toContain(m.provider);
    });
  });

  it('gives all 5 TTS rows a non-empty metaData.voices catalog ({id, locale} entries)', () => {
    const ttsRows = catalog.filter((m) => m.taskType === 'TEXT_TO_SPEECH');
    expect(ttsRows.map((m) => m.slug).sort()).toEqual([...NEW_TTS_SLUGS].sort());
    ttsRows.forEach((m) => {
      const voices = m.metaData?.voices;
      expect(Array.isArray(voices), `TTS model ${m.slug} missing metaData.voices`).toBe(true);
      expect(voices!.length).toBeGreaterThan(0);
      voices!.forEach((v) => {
        expect(typeof v.id).toBe('string');
        expect(v.id.length).toBeGreaterThan(0);
        expect(typeof v.locale).toBe('string');
        expect(v.locale.length).toBeGreaterThan(0);
      });
    });
  });

  it('seeds indic-f5 + the doc-type placeholder DISABLED and no other row with a non-default status', () => {
    // indic-f5 — prod NO-GO; nlp-doc-type-classifier —
    // explicit fail-closed placeholder (no doc-type model deployed yet).
    const disabledSlugs = ['indic-f5', 'nlp-doc-type-classifier'];
    disabledSlugs.forEach((slug) => expect(bySlug(slug)?.resourceStatus).toBe('DISABLED'));
    catalog.filter((m) => !disabledSlugs.includes(m.slug)).forEach((m) => expect(m.resourceStatus).toBeUndefined());
  });

  it('backfills provider/architecture on the keepers per spec', () => {
    const expectations: Array<[string, string, string | null]> = [
      ['whisper-large-v3-turbo', 'built-in', 'whisper'],
      ['whisper-small', 'built-in', 'whisper'],
      ['faster-whisper-large-v3-turbo-int8', 'built-in', 'whisper'],
      ['azure-speech-stt', 'azure', null],
      ['mai-transcribe-1.5', 'azure', null],
      ['nemotron-3.5-asr-streaming-0.6b', 'built-in', null],
      ['silero-vad', 'built-in', 'silero'],
      ['rnnoise', 'built-in', null],
      ['ecapa-tdnn-voxceleb', 'built-in', 'ecapa-tdnn'],
      ['granite-guardian-4.1-8b', 'lm-studio', 'granite'],
    ];
    expectations.forEach(([slug, provider, architecture]) => {
      const m = bySlug(slug);
      expect(m, `missing keeper ${slug}`).toBeDefined();
      expect(m?.provider, `${slug} provider`).toBe(provider);
      expect(m?.architecture ?? null, `${slug} architecture`).toBe(architecture);
    });
  });

  it('keeps granite-guardian-4.1-8b a GUARDRAIL/GGUF NLP row with the lm-studio sourceUri', () => {
    const granite = bySlug('granite-guardian-4.1-8b');
    expect(granite?.taskType).toBe('GUARDRAIL');
    expect(granite?.format).toBe('GGUF');
    expect(granite?.sourceUri).toBe('granite-guardian-4.1-8b');
    expect(granite?.category).toBe('NLP');
  });

  it('marks lms-gemma-4-e2b-it-qat as the platform text/summarization default (tags)', () => {
    const row = bySlug('lms-gemma-4-e2b-it-qat');
    expect(row).toBeDefined();
    expect(row?.tags).toContain('default');
    expect(row?.tags).toContain('summarization');
    expect(row?.provider).toBe('lm-studio');
    expect(row?.sourceUri).toBe('gemma-4-e2b-it-qat');
  });

  it('seeds azure-gpt-5.4-mini as a CLOUD_API row with an empty azureDeployment placeholder', () => {
    const row = bySlug('azure-gpt-5.4-mini');
    expect(row?.format).toBe('CLOUD_API');
    expect(row?.provider).toBe('azure');
    expect(row?.sourceUri).toBe('gpt-5.4-mini');
    expect(row?.memorySizeMb).toBe(0);
    expect(row?.metaData?.azureDeployment).toBe('');
  });

  it('seeds the two NLP task models from HuggingFace with the right taskTypes', () => {
    const ner = bySlug('medical-ner');
    expect(ner?.taskType).toBe('TOKEN_CLASSIFICATION');
    expect(ner?.sourceUri).toBe('blaze999/Medical-NER');
    expect(ner?.source).toBe('HUGGINGFACE');
    const cls = bySlug('symps-disease-bert-v3-c41');
    expect(cls?.taskType).toBe('TEXT_CLASSIFICATION');
    expect(cls?.sourceUri).toBe('shanover/symps_disease_bert_v3_c41');
    expect(cls?.source).toBe('HUGGINGFACE');
    expect(cls?.architecture).toBe('bert');
  });
});

// =============================================================================
// 2. Retired-slug ledger
// =============================================================================

describe('RETIRED_AI_MODEL_SLUGS ledger', () => {
  it('is exactly the 50 expected retired slugs', () => {
    expect(RETIRED_AI_MODEL_SLUGS).toBeDefined();
    expect([...(RETIRED_AI_MODEL_SLUGS ?? [])].sort()).toEqual([...EXPECTED_RETIRED_SLUGS].sort());
    expect(RETIRED_AI_MODEL_SLUGS?.length).toBe(50);
  });

  it('is disjoint from the live catalog slugs', () => {
    const catalogSlugs = new Set(catalog.map((m) => m.slug));
    (RETIRED_AI_MODEL_SLUGS ?? []).forEach((slug) => {
      expect(catalogSlugs.has(slug), `${slug} is both retired and in the catalog`).toBe(false);
    });
  });

  it('together with the 10 keepers reconstructs the previous 60-row catalog', () => {
    const union = new Set([...(RETIRED_AI_MODEL_SLUGS ?? []), ...KEEPER_SLUGS]);
    expect(union.size).toBe(60);
  });
});

// =============================================================================
// 3. Pipeline regression lock
// =============================================================================

describe('pipeline-reference regression lock', () => {
  const allPipelines = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];

  it('keeps all 8 pipeline-referenced slugs in the catalog', () => {
    const catalogSlugs = new Set(catalog.map((m) => m.slug));
    PIPELINE_REFERENCED_SLUGS.forEach((slug) => {
      expect(catalogSlugs.has(slug), `pipeline-referenced slug ${slug} missing`).toBe(true);
    });
  });

  it('resolves every models: slug reference in PIPELINE_CONFIGS YAML to a catalog slug', () => {
    const catalogSlugs = new Set(catalog.map((m) => m.slug));
    let referenced = 0;
    allPipelines.forEach((pipeline) => {
      for (const key of ['asr', 'vad', 'denoise'] as const) {
        const match = pipeline.configYaml.match(new RegExp(`${key}:\\s*"([^"]+)"`));
        const slugRef = match?.[1];
        if (slugRef !== undefined) {
          referenced += 1;
          expect(catalogSlugs.has(slugRef), `pipeline ${pipeline.slug} references unknown model slug ${slugRef}`).toBe(true);
        }
      }
    });
    // Sanity: the regex actually found slug references.
    expect(referenced).toBeGreaterThanOrEqual(10);
  });
});

// =============================================================================
// 4. Retirement pipeline-reference guard (pure helper)
// =============================================================================

describe('shouldRetireAiModelSlug guard', () => {
  it('skips (returns false for) a slug referenced by a non-deleted pipeline YAML', () => {
    expect(shouldRetireAiModelSlug).toBeTypeOf('function');
    const yamls = ['models:\n  asr: "whisper-large-v3"\n'];
    expect(shouldRetireAiModelSlug!('whisper-large-v3', yamls)).toBe(false);
  });

  it('retires (returns true for) an unreferenced slug', () => {
    const yamls = ['models:\n  asr: "whisper-large-v3-turbo"\n  vad: "silero-vad"\n'];
    expect(shouldRetireAiModelSlug!('deepfilternet-v3', yamls)).toBe(true);
  });

  it('does NOT let a longer keeper slug block a retired prefix slug (whisper-large-v3 vs -turbo)', () => {
    const yamls = ['models:\n  asr: "whisper-large-v3-turbo"\n'];
    expect(shouldRetireAiModelSlug!('whisper-large-v3', yamls)).toBe(true);
  });

  it('does NOT treat an inline hf_model_id path segment as a slug reference (openai/whisper-tiny)', () => {
    const yamls = ['models:\n  asr:\n    hf_model_id: "openai/whisper-tiny"\n    engine: "safetensor"\n'];
    expect(shouldRetireAiModelSlug!('whisper-tiny', yamls)).toBe(true);
  });

  it('retires every one of the 50 retired slugs against the SEEDED pipeline set (no accidental blocks)', () => {
    const seededYamls = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES].map((p) => p.configYaml);
    (RETIRED_AI_MODEL_SLUGS ?? []).forEach((slug) => {
      expect(shouldRetireAiModelSlug!(slug, seededYamls), `seeded pipelines unexpectedly block retirement of ${slug}`).toBe(true);
    });
  });
});

// =============================================================================
// 5. retireLegacyAiModels sweep (mock client)
// =============================================================================

describe('retireLegacyAiModels sweep', () => {
  const makeClient = (pipelines: Array<{ configYaml: string }>) => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      asrPipeline: {
        findMany: vi.fn(async () => pipelines),
      },
      aiModel: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
    };
    return { client, updates };
  };

  it('soft-deletes every retired slug across all tenants with stamps + version increment', async () => {
    expect(retireLegacyAiModels).toBeTypeOf('function');
    const { client, updates } = makeClient([]);
    const result = await retireLegacyAiModels!(client as never);

    expect(client.aiModel.updateMany).toHaveBeenCalledTimes(50);
    expect(result.retired).toBe(50);
    expect(result.skipped).toEqual([]);

    updates.forEach(({ where, data }) => {
      // All tenants' copies: the filter is slug-wide, NOT tenant-pinned,
      // and idempotent (already-DELETED rows are excluded).
      expect(where.tenantId).toBeUndefined();
      expect(where.resourceStatus).toEqual({ not: 'DELETED' });
      expect(RETIRED_AI_MODEL_SLUGS).toContain(where.slug);
      expect(data.resourceStatus).toBe('DELETED');
      expect(data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(data.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);
      expect(data.version).toEqual({ increment: 1 });
    });
  });

  it('skips a slug referenced by a live custom pipeline and reports it', async () => {
    const { client, updates } = makeClient([{ configYaml: 'version: "2.0"\nmodels:\n  asr: "whisper-large-v3"\n' }]);
    const result = await retireLegacyAiModels!(client as never);

    expect(result.skipped).toEqual(['whisper-large-v3']);
    expect(result.retired).toBe(49);
    expect(updates.some((u) => u.where.slug === 'whisper-large-v3')).toBe(false);
  });

  it('only consults non-deleted pipelines for the reference guard', async () => {
    const { client } = makeClient([]);
    await retireLegacyAiModels!(client as never);
    expect(client.asrPipeline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ resourceStatus: { not: 'DELETED' } }),
      }),
    );
  });
});

// =============================================================================
// 6. AiTaskDefault SYSTEM seed (create-only)
// =============================================================================

describe('AiTaskDefault SYSTEM seed', () => {
  const TASK_KEY_TO_TASK_TYPE: Record<string, string> = {
    'guardrail.validate': ModelTaskType.GUARDRAIL,
    'nlp.ner': 'TOKEN_CLASSIFICATION',
    'nlp.classification': 'TEXT_CLASSIFICATION',
    // SMR generation routing keys.
    'smr.live': 'TEXT_GENERATION',
    'smr.finalize': 'TEXT_GENERATION',
    // guardrail safety/groundedness, harness judge, diagnosis.
    'guardrail.safety': 'TOKEN_CLASSIFICATION',
    'guardrail.groundedness': 'TEXT_CLASSIFICATION',
    'harness.judge': 'TEXT_GENERATION',
    'nlp.diagnosis': 'TEXT_CLASSIFICATION',
  };

  const loadModule = async () =>
    import('../16-ai-task-default') as Promise<{
      SYSTEM_AI_TASK_DEFAULTS: Array<{
        id: string;
        tenantId: string;
        taskKey: string;
        modelSlug: string;
      }>;
      seedAiTaskDefault: (client: unknown) => Promise<{ created: number; skipped: number }>;
    }>;

  it('seeds exactly the nine SYSTEM task defaults with deterministic ids', async () => {
    const { SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    const byKey = new Map(SYSTEM_AI_TASK_DEFAULTS.map((r) => [r.taskKey, r]));
    expect(SYSTEM_AI_TASK_DEFAULTS.length).toBe(9);
    expect(byKey.get('guardrail.validate')?.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(byKey.get('nlp.ner')?.modelSlug).toBe('medical-ner');
    // nlp.classification is the doc-type classifier (fail-closed
    // placeholder); the diagnosis suggester moved to nlp.diagnosis.
    expect(byKey.get('nlp.classification')?.modelSlug).toBe('nlp-doc-type-classifier');
    expect(byKey.get('nlp.diagnosis')?.modelSlug).toBe('symps-disease-bert-v3-c41');
    // SMR live/finalize routing, both mapped to the
    // current SYSTEM SMR default registry slug.
    expect(byKey.get('smr.live')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    expect(byKey.get('smr.finalize')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    // guardrail safety/groundedness + harness judge selection.
    expect(byKey.get('guardrail.safety')?.modelSlug).toBe('gliner-guard-uniencoder-onnx');
    expect(byKey.get('guardrail.groundedness')?.modelSlug).toBe('minicheck-flan-t5-large');
    expect(byKey.get('harness.judge')?.modelSlug).toBe('lms-gemma-4-e4b');
    SYSTEM_AI_TASK_DEFAULTS.forEach((row) => {
      expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
    expect(new Set(SYSTEM_AI_TASK_DEFAULTS.map((r) => r.id)).size).toBe(9);
  });

  it('references catalog slugs whose taskType matches the task key', async () => {
    const { SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    SYSTEM_AI_TASK_DEFAULTS.forEach((row) => {
      const model = bySlug(row.modelSlug);
      expect(model, `AiTaskDefault ${row.taskKey} references unknown slug ${row.modelSlug}`).toBeDefined();
      expect(model?.taskType).toBe(TASK_KEY_TO_TASK_TYPE[row.taskKey]);
    });
  });

  it('is CREATE-ONLY: never overwrites an existing (tenant, taskKey) row', async () => {
    const { seedAiTaskDefault } = await loadModule();
    const client = {
      aiTaskDefault: {
        findFirst: vi.fn(async () => ({ id: 'existing', modelSlug: 'admin-chosen' })),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const result = await seedAiTaskDefault(client as never);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(9);
    expect(client.aiTaskDefault.create).not.toHaveBeenCalled();
    expect(client.aiTaskDefault.update).not.toHaveBeenCalled();
  });

  it('creates the missing rows on a cold seed (system user as creator)', async () => {
    const { seedAiTaskDefault } = await loadModule();
    const created: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiTaskDefault: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return args.data;
        }),
      },
    };
    const result = await seedAiTaskDefault(client as never);
    expect(result.created).toBe(9);
    created.forEach(({ data }) => {
      expect(data.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(data.createdBy).toBe(SYSTEM_USER_ID);
    });
  });
});

// =============================================================================
// 7. Companion seeds — HarnessPolicy default + GlobalSetting retirement + RBAC
// =============================================================================

describe('companion seed updates', () => {
  it('moves the SYSTEM HarnessPolicy SMR default to gemma-4-e2b-it-qat (provider lm-studio)', () => {
    expect(SYSTEM_HARNESS_POLICY_SMR_DEFAULTS.smrProvider).toBe('lm-studio');
    expect(SYSTEM_HARNESS_POLICY_SMR_DEFAULTS.smrModel).toBe('gemma-4-e2b-it-qat');
  });

  it('keeps the new SMR default resolvable against the registry (lm-studio row, matching sourceUri)', () => {
    const row = catalog.find((m) => m.provider === 'lm-studio' && m.sourceUri === SYSTEM_HARNESS_POLICY_SMR_DEFAULTS.smrModel);
    expect(row).toBeDefined();
    expect(row?.slug).toBe('lms-gemma-4-e2b-it-qat');
  });

  it('removes the six superseded GlobalSetting keys from the seeded arrays', () => {
    const retiredKeys = [
      'default-smr-provider',
      'default-smr-model',
      'smr-provider-models',
      'default-guardrail-provider',
      'default-guardrail-model',
      'guardrail-azure-deployment',
    ];
    const seededKeys = new Set(globalSetting.ALL_SETTINGS.map((s) => s.key));
    retiredKeys.forEach((key) => {
      expect(seededKeys.has(key), `GlobalSetting key ${key} is still seeded`).toBe(false);
    });
    // The survivors stay untouched.
    expect(seededKeys.has('smr-azure-deployment')).toBe(true);
    expect(seededKeys.has('guardrail-provider-models')).toBe(true);
    expect(seededKeys.has('default-stt-model')).toBe(true);
  });

  it('declares exactly the six superseded keys in RETIRED_GLOBAL_SETTING_KEYS', () => {
    expect(RETIRED_GLOBAL_SETTING_KEYS).toBeDefined();
    const asStrings = (RETIRED_GLOBAL_SETTING_KEYS ?? []).map((k) => `${k.namespace}/${k.key}`).sort();
    expect(asStrings).toEqual(
      [
        'guardrail/default-guardrail-provider',
        'guardrail/default-guardrail-model',
        'guardrail/guardrail-azure-deployment',
        'smr/default-smr-provider',
        'smr/default-smr-model',
        'ux-constants/smr-provider-models',
      ].sort(),
    );
  });

  it('soft-retires the superseded GlobalSetting rows idempotently (DELETED + stamps + version bump)', async () => {
    expect(retireSupersededGlobalSettings).toBeTypeOf('function');
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      globalSetting: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 2 };
        }),
      },
    };
    const result = await retireSupersededGlobalSettings!(client as never);

    expect(client.globalSetting.updateMany).toHaveBeenCalledTimes(6);
    expect(result.retired).toBe(12);
    updates.forEach(({ where, data }) => {
      expect(where.resourceStatus).toEqual({ not: 'DELETED' });
      expect(where.namespace).toBeTypeOf('string');
      expect(where.key).toBeTypeOf('string');
      // Sweeps EVERY tenant's copy — no tenant pin.
      expect(where.tenantId).toBeUndefined();
      expect(data.resourceStatus).toBe('DELETED');
      expect(data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(data.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);
      expect(data.version).toEqual({ increment: 1 });
    });
  });

  it('grants tenant admins read+manage on AiTaskDefault (tenant-scoped, TenantTtsConfig pattern)', () => {
    const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
    const rule = tenantFullAccess?.rules.find((r) => (r as { subject?: string }).subject === 'AiTaskDefault');
    expect(rule).toBeDefined();
    const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
    expect(actions).toContain('read');
    expect(actions).toContain('manage');
    const conditions = (rule as { conditions?: unknown } | undefined)?.conditions;
    expect(JSON.stringify(conditions)).toContain('${context.tenantId}');
  });
});
