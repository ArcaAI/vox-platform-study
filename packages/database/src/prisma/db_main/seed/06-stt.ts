import type { CorePrismaClient } from '../../../client';
import { ResourceStatusType, ValueType } from '../../../generated/core-prisma-client/client.js';
import {
    SYSTEM_TENANT_ID,
    SYSTEM_USER_ID,
    SEED_TENANT_ID,
    SEED_CUSTOMER_TENANT_IDS,
} from './00-constants';
import { TEMPLATE_IDS } from './07-prompt-template';
import { AUDIO_AI_MODELS } from './ai-models/audio';
import { LLM_AI_MODELS } from './ai-models/llm';
import { NLP_AI_MODELS } from './ai-models/nlp';
import { TTS_AI_MODELS } from './ai-models/tts';
import { RETIRED_AI_MODEL_SLUGS, shouldRetireAiModelSlug } from './ai-models/retired';
import type { AiModelSeed } from './ai-models/shared';

/**
 * STT (Speech-to-Text) Seed Data
 *
 * This script creates seed data for the STT service including:
 * - AI Models (consolidated registry: ASR/VAD/noise + LLM/guardrail + NLP + TTS)
 * - ASR Pipelines
 * - Global Settings for STT configuration
 *
 * These rows are PLATFORM-WIDE system seeds: every customer tenant inherits
 * them; they are NOT customer data. Therefore they are owned by the reserved
 * system tenant (`00000000-…`), introduced by TASK-305 Phase A.
 *
 * TASK-506 — the 60-row model catalog is consolidated to 26 rows split into
 * per-domain modules under `seed/ai-models/` ({audio,llm,nlp,tts}.ts); the 50
 * retired slugs are soft-`DELETED` across all tenants by
 * `retireLegacyAiModels` (guarded against live pipeline references).
 *
 * See: docs/implementation/STT-001-STT-Service-V2-Architecture/README.md
 * See: docs/implementation/TASK-506-AI-Model-Registry-Consolidation/README.md
 */

// `DEFAULT_TENANT_ID` is kept as a local re-export so existing call sites
// (e.g. internal helpers, tests) still compile, but the value now points at
// the reserved system tenant.
export const DEFAULT_TENANT_ID = SYSTEM_TENANT_ID;
export { SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// ENUM MIRRORS + MODEL CATALOG (TASK-506 — split into seed/ai-models/*)
// Re-exported here so existing imports keep working.
// =============================================================================

export {
    AiModelSource,
    AiModelFormat,
    ModelCategory,
    ModelTaskType,
    ModelType,
    AI_MODEL_PROVIDERS,
} from './ai-models/shared';
export type { AiModelSeed, TtsVoiceBinding } from './ai-models/shared';
export { AUDIO_AI_MODELS } from './ai-models/audio';
export { LLM_AI_MODELS } from './ai-models/llm';
export { NLP_AI_MODELS } from './ai-models/nlp';
export { TTS_AI_MODELS } from './ai-models/tts';
export {
    RETIRED_AI_MODEL_SLUGS,
    shouldRetireAiModelSlug,
    pipelineYamlReferencesSlug,
} from './ai-models/retired';

/**
 * The consolidated platform model catalog (26 rows): 9 audio engines +
 * 10 LLM/guardrail + 2 NLP task models + 5 TTS engines.
 */
export const DEFAULT_AI_MODELS: AiModelSeed[] = [
    ...AUDIO_AI_MODELS,
    ...LLM_AI_MODELS,
    ...NLP_AI_MODELS,
    ...TTS_AI_MODELS,
];

// =============================================================================
// ASR PIPELINE SEED DATA
// =============================================================================

/**
 * Pipeline YAML configurations
 * Models are referenced by slug (from AiModel table)
 */
const PIPELINE_CONFIGS = {
    // High-quality production pipeline (v1.1 — safetensor, MPS/CUDA/CPU auto)
    production: `version: "2.0"

# TASK-505 matrix #1 — [whisper-large-v3-turbo] Full features.
# All stages on: normalize/denoise(dual-path)/resample/VAD/diar-FE,
# ASR + 2-spk diarization + LocalAgreement-2 stabilizer, full post.

models:
  asr: "whisper-large-v3-turbo"
  vad: "silero-vad-v6"
  denoise: "rnnoise"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"   # D1 — ECAPA feature extractor
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: true
    processor: peak
  denoise:
    enabled: true
    strength: 0.7
    scope: vad_only          # D2 dual-path: denoise gates VAD; ASR gets raw audio
  resample:
    enabled: true
    target_sample_rate: 16000
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
  diar_feature_extraction:
    enabled: true
  dual_capture:
    enabled: true
    capture_raw: true

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

diarization:
  enabled: true
  backend: embedding
  max_speakers: 2

streaming:
  commit_policy: local_agreement_2

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false # clinical verbatim posture — cleanup stays opt-in
  lowercase: false
  segment_merge:
    enabled: true
  dual_capture:
    enabled: true
    capture_processed: true  # what ASR consumed (raw when scope=vad_only)
`,

    // TASK-356 Phase 2 / TASK-505 — faster-whisper whisper-large-v3-turbo,
    // CTranslate2 int8 (deepdml artifact, resolvable). Carries diarization +
    // dual_capture.
    faster_whisper_turbo_int8: `version: "2.0"

# TASK-505 matrix #7 — [faster-whisper] deepdml CT2 int8, bare.

models:
  asr: "faster-whisper-large-v3-turbo-int8"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    // Fast turbo pipeline for real-time (v1.1 — safetensor, MPS/CUDA/CPU auto)
    turbo: `version: "2.0"

# TASK-505 matrix #2 — [whisper-large-v3-turbo] Transcription only.
# No pre-processing stages, ASR + diarization + stabilizer, no post.

models:
  asr: "whisper-large-v3-turbo"
  vad: "silero-vad-v6"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

diarization:
  enabled: true
  backend: embedding
  max_speakers: 2

streaming:
  commit_policy: local_agreement_2

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    // Lightweight CPU pipeline (v1.1 — slug-based model ref)
    lightweight: `version: "1.1"

# Lightweight pipeline: Whisper Small, CPU-only, no denoise
models:
  asr: "whisper-small"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.6
    min_speech_duration_ms: 100
    min_silence_duration_ms: 1500
  denoise:
    enabled: false

inference:
  batch_size: 4
  compute_type: float32
  device: cpu
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
`,

    // Optimized pipeline (v1.1 — safetensor, MPS/CUDA/CPU auto)

    // NeMo pipeline for English (v1.1 — slug-based model ref)

    // Best Practice: High-Quality Real-time Pipeline
    // Uses Silero VAD v6 + RNNoise + Whisper Large V3 Turbo (safetensor)

    // Best Practice: High-Quality Batch Processing Pipeline
    // Uses Silero VAD v6 + DeepFilterNet + Whisper Large V3 (safetensor)

    whisper_no_postprocessing: `version: "2.0"

# TASK-505 matrix #3 — [whisper-large-v3-turbo] No postprocessing.
# Full pre-processing + ASR + diarization + stabilizer; post off.

models:
  asr: "whisper-large-v3-turbo"
  vad: "silero-vad-v6"
  denoise: "rnnoise"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"   # D1 — ECAPA feature extractor
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: true
    processor: peak
  denoise:
    enabled: true
    strength: 0.7
    scope: vad_only          # D2 dual-path: denoise gates VAD; ASR gets raw audio
  resample:
    enabled: true
    target_sample_rate: 16000
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
  diar_feature_extraction:
    enabled: true
  dual_capture:
    enabled: true
    capture_raw: true

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

diarization:
  enabled: true
  backend: embedding
  max_speakers: 2

streaming:
  commit_policy: local_agreement_2

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    whisper_no_preprocessing: `version: "2.0"

# TASK-505 matrix #4 — [whisper-large-v3-turbo] No preprocessing.
# Pre off, ASR + diarization + stabilizer, full post-processing.

models:
  asr: "whisper-large-v3-turbo"
  vad: "silero-vad-v6"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

diarization:
  enabled: true
  backend: embedding
  max_speakers: 2

streaming:
  commit_policy: local_agreement_2

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false # clinical verbatim posture — cleanup stays opt-in
  lowercase: false
  segment_merge:
    enabled: true
  dual_capture:
    enabled: true
    capture_processed: true  # what ASR consumed (raw when scope=vad_only)
`,

    azure_speech_transcription: `version: "2.0"

# TASK-505 matrix #5 — [azure] Azure Speech-to-Text, bare.
# Cloud engine; credentials via AZURE_SPEECH_KEY/AZURE_SPEECH_REGION.

models:
  asr: "azure-speech-stt"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    azure_foundry_mai: `version: "2.0"

# TASK-505 matrix #6 — [azure] MAI-Transcribe 1.5, bare.
# PREVIEW (D4): batch-only; engine disabled unless AZURE_FOUNDRY_ENABLED.

models:
  asr: "mai-transcribe-1.5"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    parakeet_nemotron_streaming: `version: "2.0"

# TASK-505 matrix #8 — [parakeet.cpp] nemotron-3.5-asr-streaming-0.6b, bare.
# ggml runtime; per-utterance integration (native stateful streaming is a
# separate ticket).

models:
  asr: "nemotron-3.5-asr-streaming-0.6b"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: VAD/ASR require the target rate
    target_sample_rate: 16000
  vad:
    enabled: false           # streaming falls back to energy framing

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

streaming:
  commit_policy: none

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: false
  punctuation:
    enabled: false
  remove_disfluencies: false
  lowercase: false
  segment_merge:
    enabled: false
`,

    // =========================================================================
    // CODE-SWITCHING & LANGUAGE-SPECIFIC PIPELINES
    // =========================================================================

    code_switching_en_vi_template: `version: "1.1"

# Code-switching EN-VI pipeline:
# Auto-detects and switches between English and Vietnamese
models:
  asr:
    hf_model_id: "openai/whisper-tiny"
    engine: "safetensor"
  vad:
    hf_model_id: "onnx-community/silero-vad"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 500
  denoise:
    enabled: true
    strength: 0.7

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null
  code_switching: true
  initial_prompt: "${TEMPLATE_IDS.WHISPER_INITIAL_PROMPT_EN_VI}"

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false

diarization:
  enabled: false
`,

    asr_en_template: `version: "1.1"
models:
  asr:
    hf_model_id: openai/whisper-tiny
    engine: safetensor
  vad:
    hf_model_id: onnx-community/silero-vad
    engine: onnx
preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.6
    min_speech_duration_ms: 100
    min_silence_duration_ms: 500
    padding_ms: 200
  denoise:
    enabled: true
    strength: 0.3
inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: en
  beam_size: 1
  temperature: 0
postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false
diarization:
  enabled: false

`,

    asr_ml_template: `version: "1.1"

# ASR Malayalam pipeline:
# Malayalam-only transcription with VAD and denoise
models:
  asr:
    hf_model_id: "openai/whisper-tiny"
    engine: "safetensor"
  vad:
    hf_model_id: "onnx-community/silero-vad"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 500
  denoise:
    enabled: true
    strength: 0.3

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: "ml"

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false

diarization:
  enabled: false
`,
};

/**
 * Shape of an ASR pipeline seed row. `isDefault` is optional so most rows can
 * omit it (DB default = false); exactly ONE row per owning tenant should set it
 * `true` (TASK-331 doc-03 Q2 — per-tenant backend default, enforced by tests).
 */
interface AsrPipelineSeed {
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    description: string;
    configYaml: string;
    isDefault?: boolean;
    tags: string[];
}

export const DEFAULT_ASR_PIPELINES: AsrPipelineSeed[] = [
    {
        id: '81000000-0000-0000-0001-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: '[whisper-large-v3-turbo] Full Features',
        slug: 'production-whisper-large-v3',
        description: 'TASK-505 matrix #1 — full pipeline: normalize + dual-path denoise + resample + VAD + diarization feature extraction, whisper-large-v3-turbo ASR, 2-speaker diarization, LocalAgreement-2 stabilizer, full post-processing. Slug kept for setting/FK continuity.',
        configYaml: PIPELINE_CONFIGS.production,
        // System default (TASK-361, kept by TASK-505). seedAsrPipelines never
        // clobbers isDefault on update, so an admin's runtime default choice
        // survives re-seeds.
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: '[whisper-large-v3-turbo] Transcription Only',
        slug: 'turbo-whisper-large-v3',
        description: 'TASK-505 matrix #2 — no pre-processing, whisper-large-v3-turbo ASR + diarization + stabilizer, no post-processing. Slug kept for tenant-clone/test continuity.',
        configYaml: PIPELINE_CONFIGS.turbo,
        tags: ['streaming', 'real-time', 'fast'],
    },
    {
        id: '81000000-0000-0000-0001-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Lightweight Pipeline (Whisper Small)',
        slug: 'lightweight-whisper-small',
        description: 'Lightweight CPU-friendly pipeline using Whisper Small. Suitable for environments without GPU.',
        configYaml: PIPELINE_CONFIGS.lightweight,
        tags: ['cpu', 'lightweight', 'low-resource'],
    },
    // =========================================================================
    // BEST PRACTICE PIPELINES (v1.1 with inline model definitions)
    // =========================================================================
    {
        // TASK-356 Phase 2 / TASK-505 — faster-whisper CT2 int8 pipeline.
        // Registered in the catalog; resolvable (deepdml) but not the default
        // until it earns it via benchmarks (Phase 6).
        id: '81000000-0000-0000-0001-000000000008',
        tenantId: DEFAULT_TENANT_ID,
        name: '[faster-whisper] deepdml CT2 int8',
        slug: 'production-faster-whisper-turbo-int8',
        description: 'TASK-505 matrix #7 — bare faster-whisper transcription (deepdml/faster-whisper-large-v3-turbo-ct2, int8). Slug kept for tenant-clone continuity.',
        configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
        // Registered + catalog-visible, not the default (TASK-505: resolvable
        // via deepdml; default flip deferred to Phase 6 benchmarks).
        isDefault: false,
        tags: ['faster-whisper', 'ctranslate2', 'int8', 'diarization'],
    },
    // =========================================================================
    // TASK-505 P5 — remaining matrix pipelines (#3-#6, #8)
    // =========================================================================
    {
        id: '81000000-0000-0000-0001-000000000009',
        tenantId: DEFAULT_TENANT_ID,
        name: '[whisper-large-v3-turbo] No Postprocessing',
        slug: 'whisper-turbo-no-postprocessing',
        description: 'TASK-505 matrix #3 — full pre-processing + ASR + diarization + stabilizer; post-processing disabled.',
        configYaml: PIPELINE_CONFIGS.whisper_no_postprocessing,
        tags: ['matrix', 'whisper-turbo'],
    },
    {
        id: '81000000-0000-0000-0001-000000000010',
        tenantId: DEFAULT_TENANT_ID,
        name: '[whisper-large-v3-turbo] No Preprocessing',
        slug: 'whisper-turbo-no-preprocessing',
        description: 'TASK-505 matrix #4 — no pre-processing; ASR + diarization + stabilizer + full post-processing.',
        configYaml: PIPELINE_CONFIGS.whisper_no_preprocessing,
        tags: ['matrix', 'whisper-turbo'],
    },
    {
        id: '81000000-0000-0000-0001-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        name: '[azure] Azure Speech-to-Text',
        slug: 'azure-speech-transcription',
        description: 'TASK-505 matrix #5 — bare Azure Cognitive Services Speech transcription (cloud).',
        configYaml: PIPELINE_CONFIGS.azure_speech_transcription,
        tags: ['matrix', 'cloud', 'azure'],
    },
    {
        id: '81000000-0000-0000-0001-000000000012',
        tenantId: DEFAULT_TENANT_ID,
        name: '[azure] MAI-Transcribe 1.5',
        slug: 'azure-foundry-mai-transcribe',
        description: 'TASK-505 matrix #6 — bare MAI-Transcribe 1.5 via Azure AI Foundry (PREVIEW, D4: batch-only, engine off by default).',
        configYaml: PIPELINE_CONFIGS.azure_foundry_mai,
        tags: ['matrix', 'cloud', 'azure-foundry', 'preview'],
    },
    {
        id: '81000000-0000-0000-0001-000000000013',
        tenantId: DEFAULT_TENANT_ID,
        name: '[parakeet.cpp] Nemotron 3.5 ASR Streaming',
        slug: 'parakeet-nemotron-streaming',
        description: 'TASK-505 matrix #8 — bare nemotron-3.5-asr-streaming-0.6b transcription via the parakeet.cpp ggml runtime.',
        configYaml: PIPELINE_CONFIGS.parakeet_nemotron_streaming,
        tags: ['matrix', 'streaming', 'parakeet.cpp'],
    },
    // =========================================================================
    // CODE-SWITCHING & LANGUAGE-SPECIFIC PIPELINES
    // =========================================================================
    {
        id: '81000000-0000-0000-0001-000000000050',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Code-Switching EN-VI Template',
        slug: 'code-switching-en-vi-template',
        description: 'Code-switching pipeline template for English-Vietnamese.',
        configYaml: PIPELINE_CONFIGS.code_switching_en_vi_template,
        tags: ['code-switching', 'en', 'vi'],
    },
    {
        id: '81000000-0000-0000-0001-000000000051',
        tenantId: DEFAULT_TENANT_ID,
        name: 'ASR English Template',
        slug: 'asr-en-template',
        description: 'English-only ASR pipeline template.',
        configYaml: PIPELINE_CONFIGS.asr_en_template,
        tags: ['asr', 'english'],
    },
    {
        id: '81000000-0000-0000-0001-000000000052',
        tenantId: DEFAULT_TENANT_ID,
        name: 'ASR Malayalam Template',
        slug: 'asr-ml-template',
        description: 'Malayalam-only ASR pipeline template.',
        configYaml: PIPELINE_CONFIGS.asr_ml_template,
        tags: ['asr', 'malayalam'],
    },
];

/**
 * TASK-505/356 policy correction (owner directive 2026-07-17): every
 * customer-facing tenant mirrors the FULL SYSTEM pipeline catalog — a new
 * tenant gets the SAME pipelines as SYSTEM, not a curated subset. The first
 * rows of each customer array below stay hand-authored because their IDs are
 * referenced by other seeds (91-user `default-stt-pipeline`, 09-consultation
 * job seeds); the REMAINING SYSTEM pipelines are derived here so the customer
 * catalogs can never drift from DEFAULT_ASR_PIPELINES.
 *
 * Derived IDs reuse the `81000000-…-0001-…` block with the tenant discriminator
 * in the hundreds slot (SYSTEM=0xx, ArcaAI=1xx, Global=4xx) and a sequence
 * starting at 10 (…110+, …410+) so they never collide with the hand-authored
 * rows (…101-103 / …401-403). Slugs/configYaml are shared with SYSTEM (upsert
 * key is `{tenantId, slug}`; safe under `@@unique([tenantId, slug])`).
 */
const deriveRemainingTenantPipelines = (
    tenantId: string,
    discriminator: '1' | '4',
    namePrefix: string,
    explicitSlugs: ReadonlySet<string>,
): AsrPipelineSeed[] =>
    DEFAULT_ASR_PIPELINES.filter((p) => !explicitSlugs.has(p.slug)).map((p, i) => ({
        ...p,
        // …0001-000000000<disc><seq>, seq = 10 + index (2 digits) → 110.. / 410..
        id: `81000000-0000-0000-0001-000000000${discriminator}${String(10 + i).padStart(2, '0')}`,
        tenantId,
        name: `${namePrefix} ${p.name}`,
        // Only the hand-authored production row is the tenant default.
        isDefault: false,
    }));

// =============================================================================
// PER-CUSTOMER-TENANT ASR PIPELINES (TASK-331 doc-03 F3 / Q2)
//
// The DEFAULT_ASR_PIPELINES above are platform-wide system seeds owned by the
// reserved system tenant. Per the TASK-505/356 full-parity policy, every
// customer tenant now carries the ENTIRE SYSTEM catalog: three hand-authored
// rows (production default + turbo + CT2, whose IDs other seeds reference) plus
// the remaining SYSTEM pipelines appended via `deriveRemainingTenantPipelines`.
// EXACTLY ONE row is `isDefault: true` (production). The runtime
// (resolveRemoteConfig) honours that per-tenant default ahead of the
// GlobalSetting slug default.
//
// ID scheme: kept inside the `81000000-…-0001-…` ASR-pipeline block; the LAST
// UUID group encodes the tenant (1xx=ArcaAI) so the IDs
// never collide with the system rows (01-07, 50-52). Slugs are reused per
// tenant — safe under the `@@unique([tenantId, slug])` constraint.
//
// Exported for testing purposes.
// =============================================================================

const EXPLICIT_TENANT_PIPELINE_SLUGS = new Set([
    'production-whisper-large-v3',
    'turbo-whisper-large-v3',
    'production-faster-whisper-turbo-int8',
]);

export const CUSTOMER_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = [
    // --- ArcaAI ---
    {
        id: '81000000-0000-0000-0001-000000000101',
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        name: 'ArcaAI Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'ArcaAI default production pipeline using Whisper Large V3 with VAD and noise reduction.',
        configYaml: PIPELINE_CONFIGS.production,
        // Tenant default (TASK-361, kept by TASK-505).
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000102',
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        name: 'ArcaAI Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: 'ArcaAI fast streaming pipeline using Whisper Large V3 Turbo for low-latency transcription.',
        configYaml: PIPELINE_CONFIGS.turbo,
        isDefault: false,
        tags: ['streaming', 'real-time', 'fast'],
    },
    {
        // TASK-356 Phase 2 / TASK-505 — ArcaAI CT2 int8 pipeline (registered, resolvable, not default).
        id: '81000000-0000-0000-0001-000000000103',
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        name: 'ArcaAI Production Pipeline (Faster-Whisper Turbo CT2 int8)',
        slug: 'production-faster-whisper-turbo-int8',
        description: 'ArcaAI default production pipeline using whisper-large-v3-turbo CTranslate2 int8 (faster-whisper) with diarization + dual capture.',
        configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
        // Registered + catalog-visible, not the default (TASK-505: resolvable
        // via deepdml; default flip deferred to Phase 6 benchmarks).
        isDefault: false,
        tags: ['faster-whisper', 'ctranslate2', 'int8', 'diarization'],
    },
    // --- ArcaAI: remaining SYSTEM pipelines (full-parity policy) ---
    ...deriveRemainingTenantPipelines(
        SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        '1',
        'ArcaAI',
        EXPLICIT_TENANT_PIPELINE_SLUGS,
    ),
];

// =============================================================================
// GLOBAL CUSTOMER-TENANT ASR PIPELINES (TASK-336 IC-03)
//
// The DEFAULT_ASR_PIPELINES above are owned by the reserved SYSTEM tenant
// (DEFAULT_TENANT_ID === SYSTEM_TENANT_ID) and are NOT shared-read into customer
// tenants, so the Global customer tenant (SEED_TENANT_ID, 50000000-…0000)
// previously had ZERO pipelines: its doctors' public pipeline list resolved to
// [] and the `default-stt-pipeline` GlobalSetting pointed at an unreachable
// SYSTEM row. Here we give the Global tenant its OWN small catalog (a production
// default + a turbo streaming option) and mark EXACTLY ONE `isDefault: true`, so
// the SYSTEM-vs-tenant story matches the customer tenants: SYSTEM owns the master
// catalog; every customer-facing tenant (incl. Global) owns its own pipelines.
//
// ID scheme: stays in the `81000000-…-0001-…` ASR-pipeline block; the trailing
// group uses the 4xx slot (Global) so IDs never collide with the system rows
// (01-07, 50-52) or the ArcaAI customer tenant (1xx). Slugs are reused
// per tenant — safe under `@@unique([tenantId, slug])`.
//
// Kept in a SEPARATE array (not CUSTOMER_TENANT_ASR_PIPELINES) because the seed
// tests require every CUSTOMER_TENANT_ASR_PIPELINES row to be the ArcaAI
// customer tenant. Exported for testing + reuse by transcription-job seeds.
// =============================================================================

export const GLOBAL_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = [
    {
        id: '81000000-0000-0000-0001-000000000401',
        tenantId: SEED_TENANT_ID,
        name: 'Global Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'Global tenant default production pipeline using Whisper Large V3 with VAD and noise reduction. Referenced by the tenant `default-stt-pipeline` setting.',
        configYaml: PIPELINE_CONFIGS.production,
        // Tenant default (TASK-361, kept by TASK-505). Referenced by the tenant
        // `default-stt-pipeline` GlobalSetting (91-user.ts).
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000402',
        tenantId: SEED_TENANT_ID,
        name: 'Global Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: 'Global tenant fast streaming pipeline using Whisper Large V3 Turbo for low-latency transcription.',
        configYaml: PIPELINE_CONFIGS.turbo,
        isDefault: false,
        tags: ['streaming', 'real-time', 'fast'],
    },
    {
        // TASK-356 Phase 2 / TASK-505 — Global tenant CT2 int8 pipeline
        // (registered, resolvable, not default). The tenant `default-stt-pipeline`
        // GlobalSetting points at the production-whisper-large-v3 pipeline (…0401).
        id: '81000000-0000-0000-0001-000000000403',
        tenantId: SEED_TENANT_ID,
        name: 'Global Production Pipeline (Faster-Whisper Turbo CT2 int8)',
        slug: 'production-faster-whisper-turbo-int8',
        description: 'Global tenant default production pipeline using whisper-large-v3-turbo CTranslate2 int8 (faster-whisper) with diarization + dual capture.',
        configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
        // Registered + catalog-visible, not the default (TASK-505: resolvable
        // via deepdml; default flip deferred to Phase 6 benchmarks).
        isDefault: false,
        tags: ['faster-whisper', 'ctranslate2', 'int8', 'diarization'],
    },
    // --- Global: remaining SYSTEM pipelines (full-parity policy) ---
    ...deriveRemainingTenantPipelines(
        SEED_TENANT_ID,
        '4',
        'Global',
        EXPLICIT_TENANT_PIPELINE_SLUGS,
    ),
];

// =============================================================================
// GLOBAL SETTINGS FOR STT SERVICE
// =============================================================================

export const DEFAULT_STT_SETTINGS = [
    // Model Cache Settings
    {
        id: '82000000-0000-0000-0001-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'max_models',
        value: '5',
        defaultValue: '5',
        dataType: ValueType.Integer,
        description: 'Maximum number of AI models to keep in memory cache',
    },
    {
        id: '82000000-0000-0000-0001-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'ttl_seconds',
        value: '3600',
        defaultValue: '3600',
        dataType: ValueType.Integer,
        description: 'Time-to-live for cached models in seconds',
    },
    {
        id: '82000000-0000-0000-0001-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'max_memory_mb',
        value: '16384',
        defaultValue: '16384',
        dataType: ValueType.Integer,
        description: 'Maximum memory for model cache in MB',
    },

    // Worker Settings
    {
        id: '82000000-0000-0000-0002-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'concurrency',
        value: '4',
        defaultValue: '4',
        dataType: ValueType.Integer,
        description: 'Number of concurrent Dramatiq workers',
    },
    {
        id: '82000000-0000-0000-0002-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'batch_queue',
        value: 'stt_batch',
        defaultValue: 'stt_batch',
        dataType: ValueType.String,
        description: 'Queue name for batch transcription jobs',
    },
    {
        id: '82000000-0000-0000-0002-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'streaming_queue',
        value: 'stt_streaming',
        defaultValue: 'stt_streaming',
        dataType: ValueType.String,
        description: 'Queue name for streaming transcription jobs',
    },

    // Storage Settings
    {
        id: '82000000-0000-0000-0003-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'storage',
        key: 'audio_bucket',
        value: 'hope-audio',
        defaultValue: 'hope-audio',
        dataType: ValueType.String,
        description: 'MinIO bucket for audio storage',
    },
    {
        id: '82000000-0000-0000-0003-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'storage',
        key: 'chunk_bucket',
        value: 'hope-audio-chunks',
        defaultValue: 'hope-audio-chunks',
        dataType: ValueType.String,
        description: 'MinIO bucket for streaming audio chunks',
    },

    // S3/MinIO Connection Settings (used by S3Service via AppSettingsService)
    {
        id: '82000000-0000-0000-0003-000000000010',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ENDPOINT',
        value: `http://localhost:${process.env.MINIO_ENDPOINT?.split(':')[1] || '9000'}`,
        defaultValue: 'http://localhost:9000',
        dataType: ValueType.String,
        description: 'S3-compatible storage endpoint (MinIO)',
    },
    {
        id: '82000000-0000-0000-0003-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ACCESS_KEY',
        value: process.env.MINIO_ACCESS_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 access key',
    },
    {
        id: '82000000-0000-0000-0003-000000000012',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_SECRET_KEY',
        value: process.env.MINIO_SECRET_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 secret key',
    },
    {
        id: '82000000-0000-0000-0003-000000000013',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_REGION',
        value: 'us-east-1',
        defaultValue: 'us-east-1',
        dataType: ValueType.String,
        description: 'S3 region',
    },
    {
        id: '82000000-0000-0000-0003-000000000014',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_PRIVATE_BUCKET',
        value: 'hope-private',
        defaultValue: 'hope-private',
        dataType: ValueType.String,
        description: 'Private bucket for voice samples and sensitive files',
    },
    {
        id: '82000000-0000-0000-0003-000000000015',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_PUBLIC_BUCKET',
        value: 'hope-public',
        defaultValue: 'hope-public',
        dataType: ValueType.String,
        description: 'Public bucket for shared assets',
    },
    {
        id: '82000000-0000-0000-0003-000000000016',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_FORCE_PATH_STYLE',
        value: 'true',
        defaultValue: 'true',
        dataType: ValueType.Boolean,
        description: 'Force path-style URLs (required for MinIO)',
    },

    // HuggingFace Settings
    {
        id: '82000000-0000-0000-0004-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'huggingface',
        key: 'cache_dir',
        value: '/models/hf-cache',
        defaultValue: '/models/hf-cache',
        dataType: ValueType.String,
        description: 'Local directory for HuggingFace model cache',
    },
    {
        id: '82000000-0000-0000-0004-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'huggingface',
        key: 'offline_mode',
        value: 'false',
        defaultValue: 'false',
        dataType: ValueType.Boolean,
        description: 'Run in offline mode (use only cached models)',
    },

    // API Gateway Settings
    {
        id: '82000000-0000-0000-0005-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'api_gateway',
        key: 'base_url',
        value: 'http://api:8868/api/v1',
        defaultValue: 'http://api:8868/api/v1',
        dataType: ValueType.String,
        description: 'Internal API Gateway base URL',
    },
    {
        id: '82000000-0000-0000-0005-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'api_gateway',
        key: 'timeout_seconds',
        value: '30',
        defaultValue: '30',
        dataType: ValueType.Integer,
        description: 'API Gateway request timeout in seconds',
    },

    // Default Pipeline Settings
    {
        id: '82000000-0000-0000-0006-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'defaults',
        key: 'batch_pipeline_slug',
        // Batch + streaming defaults point at production-whisper-large-v3
        // (TASK-361; kept by TASK-505 pending Phase 6 benchmarks).
        value: 'production-whisper-large-v3',
        defaultValue: 'production-whisper-large-v3',
        dataType: ValueType.String,
        description: 'Default pipeline slug for batch transcription',
    },
    {
        id: '82000000-0000-0000-0006-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'defaults',
        key: 'streaming_pipeline_slug',
        // See batch_pipeline_slug note above.
        value: 'production-whisper-large-v3',
        defaultValue: 'production-whisper-large-v3',
        dataType: ValueType.String,
        description: 'Default pipeline slug for streaming transcription',
    },
];

// =============================================================================
// SEED FUNCTIONS
// =============================================================================

export const seedAiModels = async (client: CorePrismaClient) => {
    console.log('Seeding AI Models...');

    for (const modelData of DEFAULT_AI_MODELS) {
        const existing = await client.aiModel.findFirst({
            where: {
                tenantId: modelData.tenantId,
                slug: modelData.slug,
            },
        });

        if (existing) {
            console.log(`  AI Model "${modelData.slug}" already exists, updating...`);
            await client.aiModel.update({
                where: { id: existing.id },
                data: {
                    name: modelData.name,
                    description: modelData.description,
                    category: modelData.category,
                    taskType: modelData.taskType,
                    modelType: modelData.modelType,
                    source: modelData.source,
                    sourceUri: modelData.sourceUri,
                    sourceRevision: modelData.sourceRevision,
                    format: modelData.format,
                    memorySizeMb: modelData.memorySizeMb,
                    computeType: modelData.computeType,
                    tags: modelData.tags,
                    // TASK-506 — keep provider/architecture and per-model
                    // extras (TTS voice catalogs, Azure deployment placeholder)
                    // in sync on re-seed. `metaData` is only written when the
                    // seed row defines one (absent → field skipped).
                    provider: modelData.provider,
                    architecture: modelData.architecture,
                    ...(modelData.metaData !== undefined ? { metaData: modelData.metaData } : {}),
                },
            });
        } else {
            console.log(`  Creating AI Model "${modelData.slug}"...`);
            await client.aiModel.create({
                data: modelData,
            });
        }
    }

    console.log(`Seeded ${DEFAULT_AI_MODELS.length} AI Models`);
    return { success: true, count: DEFAULT_AI_MODELS.length };
};

/**
 * Customer tenants that receive a clone of the SYSTEM AI model catalog. Mirrors
 * the customer-tenant set used by the per-tenant ASR pipeline / settings seeds.
 */
export const CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL = [
    SEED_TENANT_ID,
    SEED_CUSTOMER_TENANT_IDS.ARCAAI,
];

/**
 * TASK-356 Phase 1 (D-5 backfill) — clones the SYSTEM AI model catalog into
 * every seeded customer tenant so EXISTING tenants are made whole (the runtime
 * `TenantService.provisionTenantModelCatalog` handles NEW tenants).
 *
 * Idempotent: a clone is created only when the tenant does not already own the
 * slug, so re-running `db:seed` fills only the gaps and never duplicates. The
 * SYSTEM rows are never touched (they are the master template); each clone omits
 * the SYSTEM row `id` so Prisma assigns a fresh `uuid(7)`, and download state is
 * intentionally not copied (the column defaults to `NOT_DOWNLOADED`).
 */
export const backfillCustomerTenantAiModels = async (client: CorePrismaClient) => {
    console.log('Backfilling customer-tenant AI model catalog...');

    let cloned = 0;
    let synced = 0;
    for (const tenantId of CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL) {
        for (const src of DEFAULT_AI_MODELS) {
            const existing = await client.aiModel.findFirst({
                where: { tenantId, slug: src.slug },
            });
            if (existing) {
                // TASK-506 — pre-506 clones lack the machine-actionable
                // provider/architecture/metaData columns the guardrail/NLP/TTS
                // resolvers read (the resolver prefers the same-tenant model
                // row, so a NULL-provider clone shadows the SYSTEM row's
                // value). Fill them ONLY while provider is still NULL —
                // create-only semantics otherwise, so tenant customizations
                // are never trampled on re-seed.
                if (existing.provider == null && src.provider != null) {
                    await client.aiModel.update({
                        where: { id: existing.id },
                        data: {
                            provider: src.provider,
                            architecture: src.architecture ?? null,
                            ...(src.metaData !== undefined ? { metaData: src.metaData } : {}),
                            version: { increment: 1 },
                        },
                    });
                    synced += 1;
                }
                continue;
            }

            // Strip the SYSTEM-owned id + tenantId; the clone gets a fresh id
            // (uuid(7) default) and the customer tenant id.
            const { id: _systemId, tenantId: _systemTenantId, ...rest } = src;
            await client.aiModel.create({
                data: { ...rest, tenantId },
            });
            cloned += 1;
        }
    }

    console.log(`Backfilled ${cloned} customer-tenant AI models (${synced} pre-506 clones column-synced)`);
    return { success: true, count: cloned, synced };
};

/**
 * TASK-506 — soft-retire the 50 legacy catalog slugs (RETIRED_AI_MODEL_SLUGS)
 * across EVERY tenant's copy (SYSTEM master + Global/customer clones + rows
 * provisioned at tenant creation). Runs inside `seedStt` AFTER the upserts.
 *
 * Idempotent: rows already `DELETED` are excluded by the filter, so re-running
 * `db:seed` writes nothing. Soft-delete only — rows stay recoverable.
 *
 * Safety guard: a slug still referenced by ANY non-deleted
 * `AsrPipeline.configYaml` (a tenant may have built a custom pipeline on it)
 * is SKIPPED with a loud warning instead of breaking stt-v2's
 * `config_reader._to_model_config` slug resolution. The decision itself is the
 * pure helper `shouldRetireAiModelSlug` (seed/ai-models/retired.ts).
 */
export const retireLegacyAiModels = async (
    client: CorePrismaClient,
): Promise<{ retired: number; skipped: string[] }> => {
    console.log('Retiring legacy AI models (TASK-506 consolidation)...');

    // Guard input: every non-deleted pipeline's YAML, ANY tenant.
    const activePipelines = await client.asrPipeline.findMany({
        where: { resourceStatus: { not: ResourceStatusType.DELETED } },
        select: { configYaml: true },
    });
    const activeYamls = activePipelines.map((p) => p.configYaml);

    let retired = 0;
    const skipped: string[] = [];
    for (const slug of RETIRED_AI_MODEL_SLUGS) {
        if (!shouldRetireAiModelSlug(slug, activeYamls)) {
            console.warn(
                `  ⚠️  RETIREMENT SKIPPED: AiModel "${slug}" is still referenced by a ` +
                'non-deleted AsrPipeline configYaml — leaving it active. Migrate the ' +
                'pipeline off this model, then re-run db:seed.',
            );
            skipped.push(slug);
            continue;
        }

        // Sweep ALL tenants' copies of the slug in one statement.
        const result = await client.aiModel.updateMany({
            where: { slug, resourceStatus: { not: ResourceStatusType.DELETED } },
            data: {
                resourceStatus: ResourceStatusType.DELETED,
                resourceStatusUpdatedAt: new Date(),
                resourceStatusUpdatedBy: SYSTEM_USER_ID,
                version: { increment: 1 },
            },
        });
        retired += result.count;
    }

    console.log(
        `Retired ${retired} legacy AI model rows across all tenants` +
        (skipped.length > 0 ? ` (${skipped.length} slugs skipped: ${skipped.join(', ')})` : ''),
    );
    return { retired, skipped };
};

export const seedAsrPipelines = async (client: CorePrismaClient) => {
    console.log('Seeding ASR Pipelines...');

    // System (platform-wide) pipelines + Global-tenant pipelines (TASK-336
    // IC-03) + per-customer-tenant pipelines.
    const allPipelines = [
        ...DEFAULT_ASR_PIPELINES,
        ...GLOBAL_TENANT_ASR_PIPELINES,
        ...CUSTOMER_TENANT_ASR_PIPELINES,
    ];

    for (const pipelineData of allPipelines) {
        const existing = await client.asrPipeline.findFirst({
            where: {
                tenantId: pipelineData.tenantId,
                slug: pipelineData.slug,
            },
        });

        if (existing) {
            // Idempotent re-seed: refresh content but DO NOT clobber `isDefault`.
            // The default flag is admin-controlled at runtime (per TASK-331
            // doc-03 Q2); leaving it untouched on update both respects admin
            // changes and keeps the "exactly one default per tenant" invariant
            // intact (no new rows are created, so no second default can appear).
            console.log(`  ASR Pipeline "${pipelineData.slug}" already exists for tenant ${pipelineData.tenantId}, updating...`);
            await client.asrPipeline.update({
                where: { id: existing.id },
                data: {
                    name: pipelineData.name,
                    description: pipelineData.description,
                    configYaml: pipelineData.configYaml,
                    tags: pipelineData.tags,
                },
            });
        } else {
            console.log(`  Creating ASR Pipeline "${pipelineData.slug}" for tenant ${pipelineData.tenantId}...`);
            await client.asrPipeline.create({
                data: pipelineData,
            });
        }
    }

    console.log(`Seeded ${allPipelines.length} ASR Pipelines`);
    return { success: true, count: allPipelines.length };
};


export const seedSttSettings = async (client: CorePrismaClient) => {
    console.log('Seeding STT Global Settings...');

    for (const settingData of DEFAULT_STT_SETTINGS) {
        const existing = await client.globalSetting.findFirst({
            where: {
                tenantId: settingData.tenantId,
                name: settingData.name,
                key: settingData.key,
            },
        });

        if (existing) {
            console.log(`  Setting "${settingData.namespace}.${settingData.name}.${settingData.key}" already exists, updating...`);
            await client.globalSetting.update({
                where: { id: existing.id },
                data: {
                    value: settingData.value,
                    defaultValue: settingData.defaultValue,
                    description: settingData.description,
                },
            });
        } else {
            console.log(`  Creating setting "${settingData.namespace}.${settingData.name}.${settingData.key}"...`);
            await client.globalSetting.create({
                data: settingData,
            });
        }
    }

    console.log(`Seeded ${DEFAULT_STT_SETTINGS.length} STT Settings`);
    return { success: true, count: DEFAULT_STT_SETTINGS.length };
};

/**
 * Main seed function for STT domain
 * Seeds: AI Models → ASR Pipelines → Global Settings
 */
export const seedStt = async (client: CorePrismaClient) => {
    console.log('Starting STT domain seeding...\n');

    try {
        // Seed AI Models first (pipelines reference them by slug)
        await seedAiModels(client);
        console.log('');

        // TASK-356 Phase 1 — clone the SYSTEM catalog into existing customer
        // tenants (idempotent; mirrors the runtime clone-per-tenant).
        await backfillCustomerTenantAiModels(client);
        console.log('');

        // Seed ASR Pipelines
        await seedAsrPipelines(client);
        console.log('');

        // TASK-505 — the TASK-361 switchDefaultSttPipeline reconciliation was
        // removed: the CT2 artifact now resolves (deepdml, decision D3), so
        // there is no placeholder default to demote, and re-running it would
        // silently override an admin's legitimate CT2 default choice.
        // seedAsrPipelines never clobbers isDefault on update.

        // TASK-506 — soft-retire the legacy catalog rows across all tenants
        // AFTER the upserts (idempotent; the pipeline-reference guard skips
        // any slug a live pipeline still points at). Runs after
        // seedAsrPipelines so the guard sees the freshly seeded pipelines.
        await retireLegacyAiModels(client);
        console.log('');

        // Seed Global Settings
        await seedSttSettings(client);
        console.log('');

        console.log('STT domain seeding completed successfully!');
        return { success: true };
    } catch (error) {
        console.error('Error during STT domain seeding:', error);
        throw error;
    }
};
