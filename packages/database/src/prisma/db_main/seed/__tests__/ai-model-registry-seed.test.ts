/**
 * AI Model Registry seed invariants (TASK-860).
 *
 * Static + mock-client assertions over the EXPORTED seed data (no live DB),
 * following the conventions of `seed.test.ts` (this dir). Locks the owner's
 * catalogue (README §3.6):
 *
 *   1. `DEFAULT_AI_MODELS` is EXACTLY the 33 catalogue slugs of the owner
 *      catalogue — ids/slugs
 *      unique, every row SYSTEM-owned, every row carrying a `libraryName` /
 *      `servedBy` / `deploymentKind` from the closed vocabularies, cloud rows
 *      NOT_APPLICABLE with a wire id, and the `metaData` payloads worth
 *      keeping carried over verbatim.
 *   2. Platform defaults: each elected task appears on exactly ONE enabled row.
 *   3. `RETIRED_AI_MODEL_SLUGS` gained the 11 TASK-860 retirements, stays
 *      disjoint from the catalogue, and the pipeline-reference guard still
 *      protects the three whisper rows seeded pipelines reference.
 *   4. The sweeps: `retireLegacyAiModels` (ledger, all tenants, guarded) and
 *      `retireCustomerTenantAiModels` (every non-SYSTEM row) are idempotent
 *      soft-deletes; `seedAiModels` re-syncs the registry columns on re-seed
 *      without touching `resourceStatus` or a measured `availability`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AI_MODEL_LIBRARIES,
  AI_MODEL_SERVED_BY,
  DEFAULT_AI_MODELS,
  RETIRED_AI_MODEL_SLUGS,
  retireCustomerTenantAiModels,
  retireLegacyAiModels,
  seedAiModels,
  shouldRetireAiModelSlug,
} from '../06-ai-models';
import { AiModelFormat, ModelTaskType } from '../ai-models/shared';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

// =============================================================================
// The owner's catalogue — README §3.6, in pipeline_tag order
// =============================================================================

const CATALOGUE_SLUGS = [
  // automatic-speech-recognition
  'faster-whisper-large-v3-turbo-int8',
  'nemotron-3.5-asr-streaming-0.6b',
  'arcaai-whisper-large-ml-en-gguf',
  'arcaai-whisper-large-ml-en-gguf-q8_0',
  'arcaai-whisper-large-ml-en',
  'arcaai-whisper-large-ml-en-ct2',
  'whisper-large-en-medical-260726-merged-gguf',
  'whisper-large-en-medical-260726-merged-gguf-q8_0',
  'whisper-large-en-medical-260726-merged-ct2',
  'azure-speech-stt',
  'mai-transcribe-1.5',
  'sarvam-saaras-v4',
  'openai-gpt4o-transcribe',
  // voice-activity-detection
  'silero-vad',
  // audio-to-audio
  'rnnoise',
  'deepfilternet3',
  // audio-classification (speaker-embedding)
  'ecapa-tdnn-voxceleb',
  'wespeaker-voxceleb-resnet34',
  // text-to-speech
  'kokoro',
  'indic-parler-tts',
  'azure-neural-voices',
  'sarvam-bulbul',
  // token-classification
  'medical-ner',
  'cadence-punctuation',
  'gliner2-privacy-filter-pii-multi',
  'gliner2-guardrails-pii-multi',
  // text-classification
  'symps-disease-bert-v3-c41',
  'gliguard-llm-guardrails-300m',
  'minicheck-flan-t5-large',
  // text-generation
  'granite-guardian-4.1-8b',
  'lms-gemma-4-e2b-it-qat',
  'lms-gemma-4-e4b',
  'azure-gpt-5.4-mini',
] as const;

/** README §2.5 — everything the previous 46-row catalogue carried beyond the 35. */
const TASK_860_RETIRED_SLUGS = [
  'whisper-small',
  'whisper-large-v3-turbo',
  'whisper-large-v3-turbo-gguf',
  'lms-gemma-4-12b-qat',
  'lms-medgemma-1.5-4b-it',
  'lms-medgemma-1.5-4b-it-vision',
  'vllm-medgemma-1.5-27b-it',
  'llama-cpp-medgemma-1.5-4b-it',
  'bedrock-claude-3.5-haiku',
  'nlp-doc-type-classifier',
  'indic-f5',
] as const;

/** README §3.6 — the platform-default elections. TASK-934 (OD-2) moved SPEECH_TO_TEXT
 * from the f16 row to q8_0 — the row the seeded `realtime-transcription` agent serves
 * as primary, not merely a fallback. */
const PLATFORM_DEFAULTS: Record<string, string> = {
  SPEECH_TO_TEXT: 'arcaai-whisper-large-ml-en-gguf-q8_0',
  TEXT_TO_SPEECH: 'kokoro',
  NAMED_ENTITY_RECOGNITION: 'medical-ner',
  PII_DETECTION: 'gliner2-privacy-filter-pii-multi',
  CONTENT_SAFETY: 'gliguard-llm-guardrails-300m',
  GROUNDEDNESS: 'minicheck-flan-t5-large',
  TEXT_GENERATION: 'lms-gemma-4-e2b-it-qat',
};

const catalog = DEFAULT_AI_MODELS;
const bySlug = (slug: string) => catalog.find((m) => m.slug === slug);

// =============================================================================
// 1. Catalogue shape
// =============================================================================

describe('the platform model catalogue (33 SYSTEM rows)', () => {
  it('is exactly the 33 slugs of the owner catalogue', () => {
    expect([...catalog.map((m) => m.slug)].sort()).toEqual([...CATALOGUE_SLUGS].sort());
    expect(catalog).toHaveLength(33);
  });

  it('has unique ids and unique slugs', () => {
    expect(new Set(catalog.map((m) => m.id)).size).toBe(catalog.length);
    expect(new Set(catalog.map((m) => m.slug)).size).toBe(catalog.length);
  });

  it('keeps every row on the SYSTEM tenant — the registry is SYSTEM-only', () => {
    catalog.forEach((m) => expect(m.tenantId, m.slug).toBe(SYSTEM_TENANT_ID));
  });

  it('gives every row a libraryName / servedBy / deploymentKind from the closed vocabularies', () => {
    catalog.forEach((m) => {
      expect(AI_MODEL_LIBRARIES, `${m.slug}.libraryName`).toContain(m.libraryName);
      expect(AI_MODEL_SERVED_BY, `${m.slug}.servedBy`).toContain(m.servedBy);
      expect(['SELF_HOSTED', 'CLOUD'], `${m.slug}.deploymentKind`).toContain(m.deploymentKind);
    });
  });

  it('models every CLOUD row as NOT_APPLICABLE for availability with a vendor wire id, and no self-hosted row as CLOUD', () => {
    const cloud = catalog.filter((m) => m.deploymentKind === 'CLOUD');
    expect(cloud.map((m) => m.slug).sort()).toEqual(
      [
        'azure-speech-stt',
        'mai-transcribe-1.5',
        'sarvam-saaras-v4',
        'openai-gpt4o-transcribe',
        'azure-neural-voices',
        'sarvam-bulbul',
        'azure-gpt-5.4-mini',
      ].sort(),
    );
    cloud.forEach((m) => {
      expect(m.availability, m.slug).toBe('NOT_APPLICABLE');
      expect(m.wireModelId, m.slug).toBeTruthy();
      // The STT cloud loaders still read `source_uri` as the wire id — the two
      // must agree until TASK-862 re-points them at `wireModelId`.
      expect(m.wireModelId, m.slug).toBe(m.sourceUri);
      expect(m.memorySizeMb).toBe(0);
    });
  });

  it('keeps sourceUri = the engine-host wire id on every LM Studio row and records the Hub artifact in metaData.hubArtifact', () => {
    const lmStudio = catalog.filter((m) => m.servedBy === 'lmstudio');
    expect(lmStudio).toHaveLength(3);
    lmStudio.forEach((m) => {
      expect(m.provider).toBe('lm-studio');
      expect(m.libraryName).toBe('llama.cpp');
      expect(m.wireModelId, m.slug).toBe(m.sourceUri);
      expect(m.metaData?.hubArtifact, `${m.slug} needs a Hub artifact for the publisher`).toMatch(/^[\w.-]+\/[\w.-]+$/);
    });
  });

  it('weight-less rows (package-bundled coefficients) seed NOT_APPLICABLE and never a Hub id', () => {
    expect(bySlug('rnnoise')?.availability).toBe('NOT_APPLICABLE');
    expect(bySlug('rnnoise')?.sourceUri).toBe('pypi:pyrnnoise');
    expect(bySlug('rnnoise')?.libraryName).toBe('pyrnnoise');
    expect(bySlug('deepfilternet3')?.availability).toBe('NOT_APPLICABLE');
    expect(bySlug('deepfilternet3')?.libraryName).toBe('deepfilternet');
  });

  it('serves Cadence punctuation IN-PROCESS by stt while keeping the HF token-classification task (D-4)', () => {
    const cadence = bySlug('cadence-punctuation');
    expect(cadence?.taskType).toBe('TOKEN_CLASSIFICATION');
    expect(cadence?.servedBy).toBe('stt');
    expect(cadence?.libraryName).toBe('cadence-punctuation');
    expect(cadence?.gated).toBe(true);
  });

  it('runs Nemotron on transformers (AutoModelForRNNT, D-3) — not parakeet.cpp', () => {
    const nemotron = bySlug('nemotron-3.5-asr-streaming-0.6b');
    expect(nemotron?.libraryName).toBe('transformers');
    expect(nemotron?.format).toBe('SAFETENSOR');
    expect(nemotron?.languages).not.toContain('ml');
  });

  it('records the model-card corrections of README §2.4', () => {
    expect(bySlug('silero-vad')?.baseModel).toBe('snakers4/silero-vad');
    expect(bySlug('silero-vad')?.sourceUri).toBe('onnx-community/silero-vad');
    expect(bySlug('granite-guardian-4.1-8b')?.metaData?.hubArtifact).toBe('mradermacher/granite-guardian-4.1-8b-GGUF');
    expect(bySlug('granite-guardian-4.1-8b')?.computeType).toBe('q4_k_m');
    expect(bySlug('granite-guardian-4.1-8b')?.baseModel).toBe('ibm-granite/granite-guardian-4.1-8b');
    expect(bySlug('indic-parler-tts')?.gated).toBe(true);
  });

  it('seeds every row in the default status — the ICD-10 fine-tune that was the sole DISABLED row is retired', () => {
    const nonDefault = catalog.filter((m) => m.resourceStatus !== undefined).map((m) => `${m.slug}:${m.resourceStatus}`);
    expect(nonDefault).toEqual([]);
  });

  it('never seeds the publisher-owned bucket identity (bucketPrefix / primaryObject)', () => {
    catalog.forEach((m) => {
      expect((m as { bucketPrefix?: unknown }).bucketPrefix, m.slug).toBeUndefined();
      expect(m.primaryObject, m.slug).toBeUndefined();
      // TASK-890 — `localPath` is no longer a column at all; the mount path is derived
      // from the bucket identity above at the moment a resolved spec is built.
      expect((m as { localPath?: unknown }).localPath, m.slug).toBeUndefined();
    });
  });

  it('carries the load-bearing metaData payloads over verbatim', () => {
    expect(bySlug('medical-ner')?.metaData?.clinicalTaxonomy?.linker?.vocabulary?.length).toBeGreaterThan(30);
    expect(bySlug('gliner2-privacy-filter-pii-multi')?.metaData?.labelTaxonomy?.labels).toHaveLength(42);
    expect(bySlug('gliner2-guardrails-pii-multi')?.metaData?.capabilities).toEqual(['extract_entities', 'classify_text']);
    expect(Object.keys(bySlug('gliguard-llm-guardrails-300m')?.metaData?.labelTaxonomy?.tasks ?? {})).toHaveLength(6);
    expect(bySlug('minicheck-flan-t5-large')?.metaData?.entailment?.adapter).toBe('minicheck-flan-t5');
    expect(bySlug('granite-guardian-4.1-8b')?.metaData?.policy?.medicalValidationCriteria).toMatch(/medical context validator/);
    expect(bySlug('kokoro')?.metaData?.voices?.length).toBeGreaterThan(0);
    expect(bySlug('azure-neural-voices')?.metaData?.voices?.length).toBe(4);
    expect(bySlug('sarvam-bulbul')?.metaData?.voices?.length).toBe(2);
  });

  it('gives every whisper.cpp row the decode geometry that used to be a platform key (TASK-880)', () => {
    // `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS` applied ONE
    // number to every engine on the box. They are model facts — so they ride the row and
    // travel on `ResolvedAsrSpec.models.asr.metadata`.
    //
    // TASK-891 (A5) raised `arcaai-whisper-large-ml-en-gguf` specifically from 7/6 to a
    // MATCHED 30/30 pair — `maxDecodeWindowSec === partialWindowSec` was believed required
    // ("so the last partial and the final decode the SAME audio") — because the 7s window
    // was measurably truncating long clinical utterances into blind fragments.
    //
    // TASK-934 measured that decision against live Malayalam-English CER and reverted it:
    // 30s DOUBLES this fine-tune's CER relative to 7s (0.381 -> 0.645), so 7s remains every
    // whisper.cpp row's accuracy window for the FINAL decode. The "MUST match" rule itself
    // was also wrong — lane S decoupled `partialWindowSec` from `maxDecodeWindowSec` into
    // two independent knobs, and the PARTIAL window widens to 15s because that is where
    // the real streaming damage was: a 6s partial window measured 31% garbage on English,
    // 15s measured 0%. Every WHISPER_CPP row now carries the same measured `{7, 15}` pair
    // (OD-1) — live proof on the merged build: discharge-clip WER 0.274 -> 0.081.
    const whisperCpp = catalog.filter((m) => m.format === AiModelFormat.WHISPER_CPP);
    expect(whisperCpp.length).toBeGreaterThan(0);
    whisperCpp.forEach((m) => {
      expect(m.metaData?.asr?.maxDecodeWindowSec, m.slug).toBe(7);
      expect(m.metaData?.asr?.partialWindowSec, m.slug).toBe(15);
    });
  });

  it('declares the embedding WIDTH on every speaker-embedding row (TASK-880)', () => {
    // Load-bearing, not documentation: `buildResolvedAsrSpec` refuses an agent whose
    // `models.embedding` declares a width the deployed `UserVoiceProfile.embedding`
    // column (`vector(256)`) cannot hold, rather than shipping a spec whose every
    // enrollment fails. An undeclared row cannot be judged, so every catalogue row
    // declares one.
    const embedders = catalog.filter((m) => m.taskType === ModelTaskType.SPEAKER_EMBEDDING);
    expect(embedders.map((m) => m.slug).sort()).toEqual(['ecapa-tdnn-voxceleb', 'wespeaker-voxceleb-resnet34']);
    embedders.forEach((m) => expect(typeof m.metaData?.embedding?.dimension, m.slug).toBe('number'));
    // The platform embedding space `stt.diarization.hfModelId` names, and the one the
    // enrollment seed writes with, is the 256-d wespeaker row.
    expect(bySlug('wespeaker-voxceleb-resnet34')?.metaData?.embedding?.dimension).toBe(256);
    expect(bySlug('ecapa-tdnn-voxceleb')?.metaData?.embedding?.dimension).toBe(192);
  });
});

// =============================================================================
// 2. Platform-default elections
// =============================================================================

describe('platform defaults per task (isPlatformDefaultFor)', () => {
  it('elects exactly the README §3.6 rows, one enabled row per task', () => {
    const elected = new Map<string, string[]>();
    catalog.forEach((m) => {
      (m.isPlatformDefaultFor ?? []).forEach((task) => {
        elected.set(task, [...(elected.get(task) ?? []), m.slug]);
      });
    });
    expect(Object.fromEntries([...elected.entries()].map(([k, v]) => [k, v.sort()]))).toEqual(
      Object.fromEntries(Object.entries(PLATFORM_DEFAULTS).map(([k, v]) => [k, [v]])),
    );
    Object.values(PLATFORM_DEFAULTS).forEach((slug) => expect(bySlug(slug)?.resourceStatus).toBeUndefined());
  });
});

// =============================================================================
// 3. Retirement ledger + pipeline-reference guard
// =============================================================================

/** The owner's 33-row catalogue revision — retired on top of the TASK-860 ledger. */
const CATALOGUE_33_RETIRED_SLUGS = ['whisper-large-v3-turbo-q8_0', 'lms-gemma-4-e4b-it-qat', 'lms-gemma-4-medical-icd10'] as const;

describe('RETIRED_AI_MODEL_SLUGS ledger (TASK-860 extension)', () => {
  it('contains the 11 TASK-860 retirements on top of the 53 earlier entries (64)', () => {
    TASK_860_RETIRED_SLUGS.forEach((slug) => expect(RETIRED_AI_MODEL_SLUGS, slug).toContain(slug));
    CATALOGUE_33_RETIRED_SLUGS.forEach((slug) => expect(RETIRED_AI_MODEL_SLUGS, slug).toContain(slug));
    expect(RETIRED_AI_MODEL_SLUGS).toHaveLength(67);
    expect(new Set(RETIRED_AI_MODEL_SLUGS).size).toBe(67);
  });

  it('is disjoint from the live catalogue', () => {
    const live = new Set(catalog.map((m) => m.slug));
    expect(RETIRED_AI_MODEL_SLUGS.filter((slug) => live.has(slug))).toEqual([]);
  });

  it('no seeded YAML shields the legacy whisper rows any more (TASK-861 retired the pipeline seed) — only a live tenant-built row can', () => {
    // `retireLegacyAiModels` feeds the guard every non-deleted `AsrPipeline.configYaml`
    // it reads from the DB at seed time. `06-stt.ts` seeds none since TASK-861, so on a
    // fresh DB the two whisper rows the old pipelines referenced retire with the ledger.
    expect(shouldRetireAiModelSlug('whisper-large-v3-turbo-gguf', [])).toBe(true);
    expect(shouldRetireAiModelSlug('whisper-large-v3-turbo', [])).toBe(true);
    // A tenant-built pipeline that still references a slug keeps it alive — and the
    // match is boundary-aware (`…-turbo-gguf` is not a reference to `…-turbo`).
    const tenantBuilt = 'models:\n  asr: "whisper-large-v3-turbo-gguf"\n';
    expect(shouldRetireAiModelSlug('whisper-large-v3-turbo-gguf', [tenantBuilt])).toBe(false);
    expect(shouldRetireAiModelSlug('whisper-large-v3-turbo', [tenantBuilt])).toBe(true);
    // Nothing references these → retired on the next seed.
    expect(shouldRetireAiModelSlug('bedrock-claude-3.5-haiku', [tenantBuilt])).toBe(true);
    expect(shouldRetireAiModelSlug('nlp-doc-type-classifier', [tenantBuilt])).toBe(true);
    expect(shouldRetireAiModelSlug('indic-f5', [tenantBuilt])).toBe(true);
  });
});

// =============================================================================
// 4. Seed mechanics (mock client)
// =============================================================================

describe('seedAiModels upsert', () => {
  type UpdateCall = { where: { id: string }; data: Record<string, unknown> };

  const existingRowClient = () => {
    const updates: UpdateCall[] = [];
    const creates: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        findFirst: vi.fn(async (args: { where: { slug: string } }) => ({ id: `existing-${args.where.slug}` })),
        update: vi.fn(async (args: UpdateCall) => {
          updates.push(args);
          return {};
        }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          creates.push(args);
          return {};
        }),
      },
    };
    return { client, updates, creates };
  };

  it('re-syncs the registry columns on an existing row and never touches resourceStatus or the bucket identity', async () => {
    const { client, updates, creates } = existingRowClient();
    await seedAiModels(client as never);

    expect(creates).toHaveLength(0);
    expect(updates).toHaveLength(33);
    const kokoro = updates.find((u) => u.where.id === 'existing-kokoro')!;
    expect(kokoro.data.libraryName).toBe('kokoro');
    expect(kokoro.data.servedBy).toBe('tts');
    expect(kokoro.data.deploymentKind).toBe('SELF_HOSTED');
    expect(kokoro.data.isPlatformDefaultFor).toEqual(['TEXT_TO_SPEECH']);
    expect(kokoro.data.languages).toEqual(['en']);
    expect(kokoro.data.gated).toBe(false);
    expect(kokoro.data).not.toHaveProperty('resourceStatus');
    expect(kokoro.data).not.toHaveProperty('bucketPrefix');
    expect(kokoro.data).not.toHaveProperty('primaryObject');
    expect(kokoro.data).not.toHaveProperty('localPath');
    // A measured availability is never reset by a seed — only a pinned
    // NOT_APPLICABLE travels.
    expect(kokoro.data).not.toHaveProperty('availability');
    const azure = updates.find((u) => u.where.id === 'existing-azure-speech-stt')!;
    expect(azure.data.availability).toBe('NOT_APPLICABLE');
    expect(azure.data.wireModelId).toBe('azure://speech-to-text');
  });

  it('creates every row verbatim on a cold seed', async () => {
    const creates: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          creates.push(args);
          return {};
        }),
        update: vi.fn(),
      },
    };
    await seedAiModels(client as never);
    expect(creates).toHaveLength(33);
    expect(client.aiModel.update).not.toHaveBeenCalled();
    creates.forEach(({ data }) => expect(data.tenantId).toBe(SYSTEM_TENANT_ID));
  });
});

describe('retireLegacyAiModels sweep', () => {
  const makeClient = (activeYamls: string[]) => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      asrPipeline: { findMany: vi.fn(async () => activeYamls.map((configYaml) => ({ configYaml }))) },
      aiModel: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
    };
    return { client, updates };
  };

  it('soft-deletes every unreferenced ledger slug across ALL tenants with stamps + version increment', async () => {
    const { client, updates } = makeClient([]);
    const result = await retireLegacyAiModels(client as never);

    expect(result.retired).toBe(RETIRED_AI_MODEL_SLUGS.length);
    expect(result.skipped).toEqual([]);
    updates.forEach(({ where, data }) => {
      expect(where.tenantId).toBeUndefined();
      expect(where.resourceStatus).toEqual({ not: 'DELETED' });
      expect(data.resourceStatus).toBe('DELETED');
      expect(data.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);
      expect(data.version).toEqual({ increment: 1 });
    });
  });

  it('skips a slug a live pipeline still references and reports it', async () => {
    const { client, updates } = makeClient(['models:\n  asr: "whisper-large-v3-turbo-gguf"\n']);
    const result = await retireLegacyAiModels(client as never);

    expect(result.skipped).toEqual(['whisper-large-v3-turbo-gguf']);
    expect(updates.map((u) => u.where.slug)).not.toContain('whisper-large-v3-turbo-gguf');
  });
});

describe('retireCustomerTenantAiModels sweep', () => {
  it('soft-deletes every non-SYSTEM row in one idempotent statement', async () => {
    const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          calls.push(args);
          return { count: 70 };
        }),
      },
    };
    const result = await retireCustomerTenantAiModels(client as never);

    expect(result.retired).toBe(70);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.where).toEqual({ tenantId: { not: SYSTEM_TENANT_ID }, resourceStatus: { not: 'DELETED' } });
    expect(calls[0]!.data.resourceStatus).toBe('DELETED');
    expect(calls[0]!.data.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);
    expect(calls[0]!.data.version).toEqual({ increment: 1 });
  });
});
