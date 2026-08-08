import type { CorePrismaClient } from '../../../client';
import { ResourceStatusType, ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID, SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS } from './00-constants';
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
 * system tenant (`00000000-…`).
 *
 * The model catalog is consolidated to 26 rows split into
 * per-domain modules under `seed/ai-models/` ({audio,llm,nlp,tts}.ts); the
 * retired slugs are soft-`DELETED` across all tenants by
 * `retireLegacyAiModels` (guarded against live pipeline references).
 */

// `DEFAULT_TENANT_ID` is kept as a local re-export so existing call sites
// (e.g. internal helpers, tests) still compile, but the value now points at
// the reserved system tenant.
export const DEFAULT_TENANT_ID = SYSTEM_TENANT_ID;
export { SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// ENUM MIRRORS + MODEL CATALOG (split into seed/ai-models/*)
// Re-exported here so existing imports keep working.
// =============================================================================

export { AiModelSource, AiModelFormat, ModelCategory, ModelTaskType, ModelType, AI_MODEL_PROVIDERS } from './ai-models/shared';
export type { AiModelSeed, TtsVoiceBinding } from './ai-models/shared';
export { AUDIO_AI_MODELS } from './ai-models/audio';
export { LLM_AI_MODELS } from './ai-models/llm';
export { NLP_AI_MODELS } from './ai-models/nlp';
export { TTS_AI_MODELS } from './ai-models/tts';
export { RETIRED_AI_MODEL_SLUGS, shouldRetireAiModelSlug, pipelineYamlReferencesSlug } from './ai-models/retired';

/**
 * The consolidated platform model catalog (26 rows): 9 audio engines +
 * 10 LLM/guardrail + 2 NLP task models + 5 TTS engines.
 */
export const DEFAULT_AI_MODELS: AiModelSeed[] = [...AUDIO_AI_MODELS, ...LLM_AI_MODELS, ...NLP_AI_MODELS, ...TTS_AI_MODELS];

// =============================================================================
// ASR PIPELINE SEED DATA
// =============================================================================

/**
 * Pipeline YAML configurations
 * Models are referenced by slug (from AiModel table)
 */
const PIPELINE_CONFIGS = {
  // High-quality production pipeline (v2.0 — whisper.cpp GGUF)
  production: `version: "2.0"

# TASK-507 matrix #1 — [whisper-large-v3-turbo gguf] Full features.
# All stages on: normalize/denoise(dual-path, DeepFilterNet3)/resample/VAD/diar-FE,
# whisper.cpp GGUF ASR + 2-spk diarization + LocalAgreement-2 stabilizer, full post.
# No longer the tenant default (TASK-507) — see PIPELINE_CONFIGS.whisper_turbo_gguf_default.

models:
  asr: "whisper-large-v3-turbo-gguf"
  vad: "silero-vad"
  denoise: "deepfilternet3"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"   # D1 — ECAPA feature extractor (kept, TASK-507)
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: true
    processor: peak
  denoise:
    enabled: true
    strength: 0.7
    scope: vad_only          # D2 dual-path: denoise gates VAD; ASR gets raw audio
    engine: deepfilternet3   # TASK-507
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

  // faster-whisper whisper-large-v3-turbo, CTranslate2 int8 (deepdml
  // artifact, resolvable). Carries diarization + dual_capture.
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
  // This is matrix #9 (safetensor "Transcription only"), kept unchanged;
  // matrix #2's GGUF equivalent is PIPELINE_CONFIGS.whisper_turbo_gguf_default
  // below (the new default).
  turbo: `version: "2.0"

# TASK-505 matrix #9 (was #2) — [whisper-large-v3-turbo] Transcription only.
# No pre-processing stages, ASR + diarization + stabilizer, no post.

models:
  asr: "whisper-large-v3-turbo"
  vad: "silero-vad"
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

  // Matrix #2 — [whisper-large-v3-turbo gguf] Transcription only.
  // Same shape as `turbo` above but whisper.cpp GGUF ASR — this is the NEW
  // platform default (isDefault flip in DEFAULT_ASR_PIPELINES etc.).
  whisper_turbo_gguf_default: `version: "2.0"

# TASK-507 matrix #2 — [whisper-large-v3-turbo gguf] Transcription only.
# VAD pre-processing enabled (Silero); whisper.cpp GGUF ASR + diarization + stabilizer, no post.

models:
  asr: "whisper-large-v3-turbo-gguf"
  vad: "silero-vad"
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
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
    force_emit_after_ms: 20000   # force-emit continuous (pause-free) speech at ~12s. Natural pauses finalize sooner via VAD; 6s cut mid-phrase and failed (measured), 25s is the max — 12s balances latency vs quality

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null          # Auto-detect. Language is a runtime choice (end-user/dev languageMode, TASK-587); an unset pipeline lets whisper.cpp detect and code-switch natively.
  prev_text_context_words: 0   # NO carry-forward prompt — priming whisper.cpp with prior text propagates/compounds errors over a long session

diarization:
  enabled: false               # speaker labels not needed; also removes the per-utterance ECAPA embedding latency from finals
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

  // ArcaAI Malayalam+English code-switch full fine-tune, whisper.cpp GGUF
  // (f16). Same shape as `whisper_turbo_gguf_default` (matrix #2 —
  // Transcription only: no pre-processing, ASR + diarization + stabilizer, no
  // post) but bound to the in-house arcaai-whisper-large-ml-en-gguf engine.
  arcaai_ml_en_gguf: `version: "2.0"

# Matrix #10 — [arcaai-whisper-large-ml-en gguf] Transcription only.
# VAD pre-processing enabled (Silero); whisper.cpp GGUF ASR (ArcaAI ML-EN
# code-switch full fine-tune) + diarization + stabilizer, no post.

models:
  asr: "arcaai-whisper-large-ml-en-gguf"
  vad: "silero-vad"
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
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
    force_emit_after_ms: 20000   # force-emit continuous (pause-free) speech at ~12s. Natural pauses finalize sooner via VAD; 6s cut mid-phrase and failed (measured), 25s is the max — 12s balances latency vs quality

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null          # Auto-detect. Language is a runtime choice (languageMode, TASK-587); an unset pipeline lets the ml-en fine-tune code-switch natively — pinning a language over-biases the script.
  prev_text_context_words: 0   # NO carry-forward prompt — priming this fine-tune with prior text propagates/compounds errors over a long session (measured)

diarization:
  enabled: false               # speaker labels not needed; also removes the per-utterance ECAPA embedding latency from finals
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

  // Same as arcaai_ml_en_gguf but the q8_0 quantization
  // (arcaai-whisper-large-ml-en-gguf-q8_0 engine) — smaller/faster weight.
  arcaai_ml_en_gguf_q8_0: `version: "2.0"

# Matrix #10 (q8_0) — [arcaai-whisper-large-ml-en gguf q8_0] Transcription only.
# VAD pre-processing enabled (Silero); whisper.cpp GGUF ASR (ArcaAI ML-EN
# code-switch full fine-tune, q8_0) + diarization + stabilizer, no post.

models:
  asr: "arcaai-whisper-large-ml-en-gguf-q8_0"
  vad: "silero-vad"
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
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
    force_emit_after_ms: 20000   # force-emit continuous (pause-free) speech at ~12s. Natural pauses finalize sooner via VAD; 6s cut mid-phrase and failed (measured), 25s is the max — 12s balances latency vs quality

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null          # Auto-detect. Language is a runtime choice (languageMode, TASK-587); an unset pipeline lets the ml-en fine-tune code-switch natively — pinning a language over-biases the script.
  prev_text_context_words: 0   # NO carry-forward prompt — priming this fine-tune with prior text propagates/compounds errors over a long session (measured)

diarization:
  enabled: false               # speaker labels not needed; also removes the per-utterance ECAPA embedding latency from finals
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

  // ArcaAI ML-EN code-switch fine-tune served via the transformers runtime
  // (fp16 safetensor). Same transcription-only shape as the GGUF variants but
  // bound to the arcaai-whisper-large-ml-en engine (matrix #9 / turbo shape).
  arcaai_ml_en_transformer: `version: "2.0"

# Matrix #9 shape — [arcaai-whisper-large-ml-en] Transcription only.
# VAD pre-processing enabled (Silero); transformers-runtime ASR (ArcaAI ML-EN
# code-switch fp16 safetensor) + diarization + stabilizer, no post.

models:
  asr: "arcaai-whisper-large-ml-en"
  vad: "silero-vad"
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
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 100
    min_silence_duration_ms: 700
    padding_ms: 200
    force_emit_after_ms: 20000   # force-emit continuous (pause-free) speech at ~12s. Natural pauses finalize sooner via VAD; 6s cut mid-phrase and failed (measured), 25s is the max — 12s balances latency vs quality

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null          # Auto-detect. Language is a runtime choice (languageMode, TASK-587); an unset pipeline lets the ml-en fine-tune code-switch natively — pinning a language over-biases the script.
  prev_text_context_words: 0   # NO carry-forward prompt — priming this fine-tune with prior text propagates/compounds errors over a long session (measured)

diarization:
  enabled: false               # speaker labels not needed; also removes the per-utterance ECAPA embedding latency from finals
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

# TASK-507 matrix #3 — [whisper-large-v3-turbo gguf] No postprocessing.
# Full pre-processing (DeepFilterNet3 denoise) + whisper.cpp GGUF ASR +
# diarization + stabilizer; post off.

models:
  asr: "whisper-large-v3-turbo-gguf"
  vad: "silero-vad"
  denoise: "deepfilternet3"
  embedding:
    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"   # D1 — ECAPA feature extractor (kept, TASK-507)
    engine: "pytorch"

preprocessing:
  normalize:
    enabled: true
    processor: peak
  denoise:
    enabled: true
    strength: 0.7
    scope: vad_only          # D2 dual-path: denoise gates VAD; ASR gets raw audio
    engine: deepfilternet3   # TASK-507
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

# TASK-507 matrix #4 — [whisper-large-v3-turbo gguf] No preprocessing.
# Pre off, whisper.cpp GGUF ASR + diarization + stabilizer, full post-processing.

models:
  asr: "whisper-large-v3-turbo-gguf"
  vad: "silero-vad"
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

  sarvam_transcription: `version: "2.0"

# TASK-567 — [sarvam] Sarvam AI speech-to-text (saaras:v4), cloud REST.
# BYOK: per-tenant SARVAM credential (TASK-567) or SARVAM_API_KEY env. TASK-586:
# SARVAM is now a first-class AiModelFormat, so the ASR is a BARE SLUG ref to the
# "sarvam-saaras-v4" catalog row — identical in shape to the Azure Speech pipeline
# (no inline engine block or provider shorthand needed).

models:
  asr: "sarvam-saaras-v4"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: cloud REST expects 16k mono PCM
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

  openai_transcription: `version: "2.0"

# TASK-567 — [openai] OpenAI speech-to-text (gpt-4o-transcribe), cloud REST.
# BYOK: per-tenant OPENAI credential (TASK-567) or OPENAI_API_KEY env. The ASR
# ref is an INLINE definition binding the OPENAI engine (equivalent to the
# "openai :: gpt-4o-transcribe" shorthand).

models:
  asr:
    hf_model_id: "gpt-4o-transcribe"
    engine: "openai"

preprocessing:
  normalize:
    enabled: false
  denoise:
    enabled: false
  resample:
    enabled: true            # runtime floor: cloud REST expects 16k mono PCM
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
  language: null           # Auto-detect. Language is a runtime choice (languageMode, TASK-587); not pinned in the pipeline definition.
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
  language: null           # Auto-detect. Language is a runtime choice (languageMode, TASK-587); not pinned in the pipeline definition.

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
 * `true` (per-tenant backend default, enforced by tests).
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
  // Template lineage. Omitted on the SYSTEM rows (they ARE the
  // templates); stamped on every tenant copy by `asTemplateCopies` below.
  sourceTemplateSlug?: string | null;
  templateLocked?: boolean;
}

export const DEFAULT_ASR_PIPELINES: AsrPipelineSeed[] = [
  {
    id: '81000000-0000-0000-0001-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    name: '[whisper-large-v3-turbo gguf] Full Features',
    slug: 'production-whisper-large-v3',
    description:
      'TASK-507 matrix #1 — full pipeline: normalize + dual-path denoise (DeepFilterNet3) + resample + VAD + diarization feature extraction, whisper.cpp GGUF ASR, 2-speaker diarization, LocalAgreement-2 stabilizer, full post-processing. Slug kept for setting/FK continuity.',
    configYaml: PIPELINE_CONFIGS.production,
    // No longer the tenant default (flipped to
    // production-whisper-large-v3-turbo-gguf below). seedAsrPipelines
    // never clobbers isDefault on update, so the one-time flip for
    // already-seeded environments is a separate explicit step —
    // see flipDefaultAsrPipelineToGgufTurbo().
    isDefault: false,
    tags: ['high-quality'],
  },
  {
    id: '81000000-0000-0000-0001-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    name: '[whisper-large-v3-turbo] Transcription Only',
    slug: 'turbo-whisper-large-v3',
    description:
      'TASK-505 matrix #9 (was #2) — no pre-processing, whisper-large-v3-turbo (safetensor) ASR + diarization + stabilizer, no post-processing. Slug kept for tenant-clone/test continuity.',
    configYaml: PIPELINE_CONFIGS.turbo,
    tags: ['streaming', 'real-time', 'fast'],
  },
  {
    // Matrix #2 — new platform default.
    id: '81000000-0000-0000-0001-000000000014',
    tenantId: DEFAULT_TENANT_ID,
    name: '[whisper-large-v3-turbo gguf] Transcription Only',
    slug: 'production-whisper-large-v3-turbo-gguf',
    description:
      'TASK-507 matrix #2 — no pre-processing, whisper.cpp GGUF ASR + diarization + stabilizer, no post-processing. Registered but NO LONGER the platform default: the generic whisper-turbo GGUF pinned to ml produces garbage Malayalam, so the ArcaAI ml-en GGUF fine-tune (arcaai-whisper-large-ml-en-gguf) is the default.',
    configYaml: PIPELINE_CONFIGS.whisper_turbo_gguf_default,
    isDefault: false,
    tags: ['production', 'streaming', 'real-time', 'fast'],
  },
  // Retired from the product matrix of 9 base pipelines:
  // lightweight-whisper-small (soft-disabled by retireRetiredAsrPipelines).
  // =========================================================================
  // BEST PRACTICE PIPELINES (v1.1 with inline model definitions)
  // =========================================================================
  {
    // faster-whisper CT2 int8 pipeline.
    // Registered in the catalog; resolvable (deepdml) but not the default
    // until it earns it via benchmarks.
    id: '81000000-0000-0000-0001-000000000008',
    tenantId: DEFAULT_TENANT_ID,
    name: '[faster-whisper] deepdml CT2 int8',
    slug: 'production-faster-whisper-turbo-int8',
    description:
      'TASK-505 matrix #7 — bare faster-whisper transcription (deepdml/faster-whisper-large-v3-turbo-ct2, int8). Slug kept for tenant-clone continuity.',
    configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
    // Registered + catalog-visible, not the default (resolvable
    // via deepdml; default flip deferred to future benchmarks).
    isDefault: false,
    tags: ['faster-whisper', 'ctranslate2', 'int8', 'diarization'],
  },
  // =========================================================================
  // Remaining matrix pipelines (#3-#6, #8)
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
  {
    // TASK-567 — cloud BYOK fallback pipeline (Sarvam). A tenant points
    // TenantSttConfig.fallbackPipelineId at a clone of this to fail over off a
    // local/GPU primary onto a cloud provider. Reaches the SARVAM engine via the
    // `provider :: model` shorthand (no DB slug for the superset engine).
    id: '81000000-0000-0000-0001-000000000016',
    tenantId: DEFAULT_TENANT_ID,
    name: '[sarvam] Sarvam Speech-to-Text',
    slug: 'sarvam-transcription',
    description: 'TASK-567 — bare Sarvam AI speech-to-text (saaras:v4, cloud REST). Tenant BYOK fallback candidate.',
    configYaml: PIPELINE_CONFIGS.sarvam_transcription,
    tags: ['cloud', 'sarvam', 'byok', 'fallback'],
  },
  {
    // TASK-567 — cloud BYOK fallback pipeline (OpenAI). See the sarvam row.
    id: '81000000-0000-0000-0001-000000000017',
    tenantId: DEFAULT_TENANT_ID,
    name: '[openai] OpenAI Speech-to-Text',
    slug: 'openai-transcription',
    description: 'TASK-567 — bare OpenAI speech-to-text (gpt-4o-transcribe, cloud REST). Tenant BYOK fallback candidate.',
    configYaml: PIPELINE_CONFIGS.openai_transcription,
    tags: ['cloud', 'openai', 'byok', 'fallback'],
  },
  {
    // Matrix #10 — ArcaAI in-house Malayalam+English code-switch full
    // fine-tune, whisper.cpp GGUF (f16). Transcription-only shape.
    // PLATFORM DEFAULT: the generic whisper-turbo GGUF pinned to ml
    // hallucinates on Malayalam; this in-house ml-en fine-tune transcribes
    // Malayalam + English code-switch cleanly, so it is the default.
    id: '81000000-0000-0000-0001-000000000018',
    tenantId: DEFAULT_TENANT_ID,
    name: '[arcaai-whisper-large-ml-en gguf] Transcription Only',
    slug: 'arcaai-whisper-large-ml-en-gguf',
    description:
      'Matrix #10 — no pre-processing, ArcaAI ML-EN code-switch whisper.cpp GGUF ASR + diarization + stabilizer, no post-processing. Platform default.',
    configYaml: PIPELINE_CONFIGS.arcaai_ml_en_gguf,
    isDefault: true,
    tags: ['production', 'streaming', 'real-time', 'malayalam', 'english', 'code-switch', 'whisper.cpp', 'recommended'],
  },
  {
    // Matrix #10 (q8_0) — same as the row above but the q8_0 quantization.
    id: '81000000-0000-0000-0001-000000000019',
    tenantId: DEFAULT_TENANT_ID,
    name: '[arcaai-whisper-large-ml-en gguf q8_0] Transcription Only',
    slug: 'arcaai-whisper-large-ml-en-gguf-q8_0',
    description:
      'Matrix #10 (q8_0) — no pre-processing, ArcaAI ML-EN code-switch whisper.cpp GGUF ASR (q8_0) + diarization + stabilizer, no post-processing.',
    configYaml: PIPELINE_CONFIGS.arcaai_ml_en_gguf_q8_0,
    tags: ['streaming', 'real-time', 'malayalam', 'english', 'code-switch', 'whisper.cpp', 'q8_0'],
  },
  {
    // ArcaAI ML-EN code-switch, transformers runtime (fp16 safetensor).
    id: '81000000-0000-0000-0001-000000000020',
    tenantId: DEFAULT_TENANT_ID,
    name: '[arcaai-whisper-large-ml-en] Transcription Only',
    slug: 'arcaai-whisper-large-ml-en',
    description:
      'Matrix #9 shape — no pre-processing, ArcaAI ML-EN code-switch transformers-runtime ASR (fp16 safetensor) + diarization + stabilizer, no post-processing.',
    configYaml: PIPELINE_CONFIGS.arcaai_ml_en_transformer,
    tags: ['streaming', 'real-time', 'malayalam', 'english', 'code-switch', 'transformer'],
  },
  // Code-switching / language templates retired from the product
  // matrix of 9 (soft-disabled by retireRetiredAsrPipelines).
];

/**
 * The slugs of the 9 SYSTEM template pipelines, derived so the list
 * can never drift from the catalog above.
 *
 * A tenant row carrying one of these slugs is a copy of that template. The
 * lineage backfill migration inlines the same set as a SQL literal (migrations
 * cannot import TypeScript); `pipeline-template-lineage-migration.test.ts`
 * asserts the two stay set-equal.
 */
export const ASR_TEMPLATE_SLUGS: readonly string[] = DEFAULT_ASR_PIPELINES.map((p) => p.slug);

/**
 * Stamp template lineage onto a tenant's catalog rows.
 *
 * Every seeded tenant pipeline is provisioned FROM the SYSTEM template of the
 * same slug, so its provenance is that slug and it starts locked: tenant admins
 * clone a copy to customize it rather than editing it in place. SYSTEM rows
 * never pass through here — they are the templates, and stay unlocked with
 * null provenance.
 */
const asTemplateCopies = (rows: AsrPipelineSeed[]): AsrPipelineSeed[] =>
  rows.map((row) => ({ ...row, sourceTemplateSlug: row.slug, templateLocked: true }));

/** Slugs removed from the product matrix; soft-disable on re-seed. */
export const RETIRED_ASR_PIPELINE_SLUGS = [
  'lightweight-whisper-small',
  'code-switching-en-vi-template',
  'asr-en-template',
  'asr-ml-template',
] as const;

/**
 * Policy: every customer-facing tenant mirrors the FULL SYSTEM pipeline
 * catalog — a new tenant gets the SAME pipelines as SYSTEM, not a curated
 * subset. The first rows of each customer array below stay hand-authored
 * because their IDs are referenced by other seeds (91-user
 * `default-stt-pipeline`, 09-consultation job seeds); the REMAINING SYSTEM
 * pipelines are derived here so the customer catalogs can never drift from
 * DEFAULT_ASR_PIPELINES.
 *
 * Lineage: because every customer row mirrors a SYSTEM template, all of
 * them (hand-authored and derived alike) are stamped `sourceTemplateSlug = slug`
 * + `templateLocked = true` by `asTemplateCopies`. Tenant admins therefore get
 * the full catalog as READ-ONLY copies and clone one to customize; the SYSTEM
 * rows themselves stay unlocked — they are the templates the copies descend
 * from.
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
    // The ArcaAI ml-en GGUF fine-tune is the tenant default (derived here);
    // every other derived pipeline is non-default. (The hand-authored
    // production-gguf rows above are now isDefault:false.)
    isDefault: p.slug === 'arcaai-whisper-large-ml-en-gguf',
  }));

// =============================================================================
// PER-CUSTOMER-TENANT ASR PIPELINES
//
// The DEFAULT_ASR_PIPELINES above are platform-wide system seeds owned by the
// reserved system tenant. Per the full-parity policy, every
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
  // Kept hand-authored (stable ids …104/…404) for id continuity. No longer
  // the tenant default — the ArcaAI ml-en GGUF fine-tune
  // (arcaai-whisper-large-ml-en-gguf) is, and it is referenced by the tenant
  // `default-stt-pipeline` GlobalSetting via its DERIVED Global id (…417).
  'production-whisper-large-v3-turbo-gguf',
]);

export const CUSTOMER_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = asTemplateCopies([
  // --- ArcaAI ---
  {
    id: '81000000-0000-0000-0001-000000000101',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI Production Pipeline (Whisper Large V3 GGUF)',
    slug: 'production-whisper-large-v3',
    description: 'ArcaAI full-features pipeline using whisper.cpp GGUF ASR with VAD and DeepFilterNet3 noise reduction.',
    configYaml: PIPELINE_CONFIGS.production,
    // No longer the tenant default; see …-000000000104 below.
    isDefault: false,
    tags: ['high-quality'],
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
    // ArcaAI CT2 pipeline (registered, resolvable, not default).
    id: '81000000-0000-0000-0001-000000000103',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI Production Pipeline (Faster-Whisper Turbo CT2 f16)',
    slug: 'production-faster-whisper-turbo-int8',
    description: 'ArcaAI default production pipeline using whisper-large-v3-turbo CTranslate2 f16 (faster-whisper) with diarization + dual capture.',
    configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
    // Registered + catalog-visible, not the default (resolvable
    // via deepdml; default flip deferred to future benchmarks).
    isDefault: false,
    tags: ['faster-whisper', 'ctranslate2', 'diarization'],
  },
  {
    // New tenant default (matrix #2, whisper.cpp GGUF).
    id: '81000000-0000-0000-0001-000000000104',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI Production Pipeline (Whisper Large V3 Turbo GGUF)',
    slug: 'production-whisper-large-v3-turbo-gguf',
    description: 'ArcaAI whisper.cpp GGUF pipeline (generic whisper-turbo), no pre/post-processing, low-latency streaming. No longer the tenant default (ArcaAI ml-en GGUF fine-tune is default).',
    configYaml: PIPELINE_CONFIGS.whisper_turbo_gguf_default,
    isDefault: false,
    tags: ['production', 'streaming', 'real-time', 'fast'],
  },
  // --- ArcaAI: remaining SYSTEM pipelines (full-parity policy) ---
  ...deriveRemainingTenantPipelines(SEED_CUSTOMER_TENANT_IDS.ARCAAI, '1', 'ArcaAI', EXPLICIT_TENANT_PIPELINE_SLUGS),
]);

// =============================================================================
// GLOBAL CUSTOMER-TENANT ASR PIPELINES
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

export const GLOBAL_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = asTemplateCopies([
  {
    id: '81000000-0000-0000-0001-000000000401',
    tenantId: SEED_TENANT_ID,
    name: 'Global Production Pipeline (Whisper Large V3 GGUF)',
    slug: 'production-whisper-large-v3',
    description: 'Global tenant full-features pipeline using whisper.cpp GGUF ASR with VAD and DeepFilterNet3 noise reduction.',
    configYaml: PIPELINE_CONFIGS.production,
    // No longer the tenant default; see …-000000000404 below.
    isDefault: false,
    tags: ['high-quality'],
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
    // Global tenant CT2 pipeline
    // (registered, resolvable, not default).
    id: '81000000-0000-0000-0001-000000000403',
    tenantId: SEED_TENANT_ID,
    name: 'Global Production Pipeline (Faster-Whisper Turbo CT2 f16)',
    slug: 'production-faster-whisper-turbo-int8',
    description:
      'Global tenant default production pipeline using whisper-large-v3-turbo CTranslate2 f16 (faster-whisper) with diarization + dual capture.',
    configYaml: PIPELINE_CONFIGS.faster_whisper_turbo_int8,
    // Registered + catalog-visible, not the default (resolvable
    // via deepdml; default flip deferred to future benchmarks).
    isDefault: false,
    tags: ['faster-whisper', 'ctranslate2', 'diarization'],
  },
  {
    // New tenant default (matrix #2, whisper.cpp GGUF).
    // Referenced by the tenant `default-stt-pipeline` GlobalSetting (91-user.ts).
    id: '81000000-0000-0000-0001-000000000404',
    tenantId: SEED_TENANT_ID,
    name: 'Global Production Pipeline (Whisper Large V3 Turbo GGUF)',
    slug: 'production-whisper-large-v3-turbo-gguf',
    description:
      'Global tenant whisper.cpp GGUF pipeline (generic whisper-turbo), no pre/post-processing, low-latency streaming. No longer the tenant default (the ArcaAI ml-en GGUF fine-tune is default and is what `default-stt-pipeline` now points at).',
    configYaml: PIPELINE_CONFIGS.whisper_turbo_gguf_default,
    isDefault: false,
    tags: ['production', 'streaming', 'real-time', 'fast'],
  },
  // --- Global: remaining SYSTEM pipelines (full-parity policy) ---
  ...deriveRemainingTenantPipelines(SEED_TENANT_ID, '4', 'Global', EXPLICIT_TENANT_PIPELINE_SLUGS),
]);

// =============================================================================
// GLOBAL SETTINGS FOR STT SERVICE
// =============================================================================

export const DEFAULT_STT_SETTINGS = [
  // The `model_cache` (max_models / ttl_seconds / max_memory_mb) and
  // `workers` (concurrency / batch_queue / streaming_queue) rows were REMOVED here.
  //
  // They were never read by anything: stt's only GlobalSetting reader was the
  // `GlobalSettingRead` SQLAlchemy mapping, which had zero callers and is now
  // deleted. Their replacements are registered settings keys served over
  // `GET /api/v1/internal/effective-config?service=stt`:
  //     stt.modelCache.{maxModels,ttlSeconds,maxMemoryMb}
  //     stt.workers.concurrency
  // (packages/applications/src/services/settings-registry/descriptors/service-runtime.descriptors.ts)
  //
  // `workers.batch_queue` / `workers.streaming_queue` have NO replacement because
  // they had no consumer either: the queue names are hardcoded (`stt_batch`,
  // `default`) in worker.py and the actor's `queue_name`.
  //
  // NOTE the descriptor for maxMemoryMb defaults to 10000, NOT the 16384 this
  // seed carried: 16384 was never in force (no reader), while the running code
  // has always used the 10000 ctor fallback in models/cache.py. Preserving 16384
  // would have silently raised the cache ceiling 64% on first deploy.

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
  // TASK-558 §9.3 M10 (lane G, G4) — `S3_ACCESS_KEY` and `S3_SECRET_KEY` were
  // seeded here as PLAINTEXT `GlobalSetting` rows (ids …0011 / …0012). A
  // credential never belongs in a DB column in the clear; these now live in
  // Vault kv-v2 under the `s3.accessKey` / `s3.secretKey` descriptors
  // (`platform-secrets.descriptors.ts`), seeded by
  // `scripts/vault-seed-secrets.sh` and, for the dev container, by
  // `infrastructure/docker/configs/vault/dev-init.sh`. Under
  // `SECRETS_PROVIDER=env` they resolve from the process environment instead.
  //
  // The credential VALUES were already read via `SecretsService.getSecretSync()`
  // — these rows only still gated `S3Service.hasRequiredConfiguration()`, which
  // now asks SecretsService directly.
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
    // Batch + streaming defaults point at the ArcaAI ml-en GGUF fine-tune
    // (arcaai-whisper-large-ml-en-gguf) — the generic whisper-turbo GGUF
    // pinned to ml produced garbage Malayalam, so the in-house code-switch
    // fine-tune is the default.
    value: 'arcaai-whisper-large-ml-en-gguf',
    defaultValue: 'arcaai-whisper-large-ml-en-gguf',
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
    value: 'arcaai-whisper-large-ml-en-gguf',
    defaultValue: 'arcaai-whisper-large-ml-en-gguf',
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
          // Keep provider/architecture and per-model
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
export const CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL = [SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS.ARCAAI];

/**
 * Clones the SYSTEM AI model catalog into
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
        // Older clones lack the machine-actionable
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
 * Soft-retire the legacy catalog slugs (RETIRED_AI_MODEL_SLUGS)
 * across EVERY tenant's copy (SYSTEM master + Global/customer clones + rows
 * provisioned at tenant creation). Runs inside `seedStt` AFTER the upserts.
 *
 * Idempotent: rows already `DELETED` are excluded by the filter, so re-running
 * `db:seed` writes nothing. Soft-delete only — rows stay recoverable.
 *
 * Safety guard: a slug still referenced by ANY non-deleted
 * `AsrPipeline.configYaml` (a tenant may have built a custom pipeline on it)
 * is SKIPPED with a loud warning instead of breaking stt's
 * `config_reader._to_model_config` slug resolution. The decision itself is the
 * pure helper `shouldRetireAiModelSlug` (seed/ai-models/retired.ts).
 */
export const retireLegacyAiModels = async (client: CorePrismaClient): Promise<{ retired: number; skipped: string[] }> => {
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

/**
 * Soft-disable pipelines retired from the product matrix of 9.
 * Idempotent; uses DISABLED (not DELETE) so historical FKs remain intact.
 */
export const retireRetiredAsrPipelines = async (client: CorePrismaClient) => {
  console.log('Retiring ASR pipelines outside the product matrix of 9...');
  const result = await client.asrPipeline.updateMany({
    where: {
      slug: { in: [...RETIRED_ASR_PIPELINE_SLUGS] },
      resourceStatus: { not: ResourceStatusType.DISABLED },
    },
    data: {
      resourceStatus: ResourceStatusType.DISABLED,
      resourceStatusUpdatedAt: new Date(),
      resourceStatusUpdatedBy: SYSTEM_USER_ID,
      isDefault: false,
    },
  });
  console.log(`  Soft-disabled ${result.count} retired ASR pipeline row(s)`);
  return { success: true, count: result.count };
};

export const seedAsrPipelines = async (client: CorePrismaClient) => {
  console.log('Seeding ASR Pipelines...');

  // System (platform-wide) pipelines + Global-tenant pipelines
  // IC-03) + per-customer-tenant pipelines.
  const allPipelines = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];

  for (const pipelineData of allPipelines) {
    const existing = await client.asrPipeline.findFirst({
      where: {
        tenantId: pipelineData.tenantId,
        slug: pipelineData.slug,
      },
    });

    if (existing) {
      // Idempotent re-seed: refresh content but DO NOT clobber `isDefault`.
      // The default flag is admin-controlled at runtime (per the
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
          // Lineage is a property of the seed declaration,
          // not admin state, so (unlike `isDefault`) it IS refreshed
          // on re-seed. This branch already restores `configYaml` to
          // the seed value, so the row is pristine by definition.
          sourceTemplateSlug: pipelineData.sourceTemplateSlug ?? null,
          templateLocked: pipelineData.templateLocked ?? false,
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

// The ArcaAI ml-en GGUF fine-tune is the platform default, replacing the
// generic whisper-turbo GGUF (`production-whisper-large-v3-turbo-gguf`), which
// hallucinated on Malayalam when pinned to ml. The reconciler below promotes
// the fine-tune and demotes the generic GGUF (now the "old" default slug),
// while still respecting an admin who picked some OTHER default.
const STT_OLD_DEFAULT_PIPELINE_SLUG = 'production-whisper-large-v3-turbo-gguf';
const STT_NEW_DEFAULT_PIPELINE_SLUG = 'arcaai-whisper-large-ml-en-gguf';

/** Tenants that carry a full ASR pipeline catalog (mirrors seedAsrPipelines). */
const STT_DEFAULT_PIPELINE_BACKFILL_TENANTS = [
  DEFAULT_TENANT_ID, // SYSTEM master catalog (=== SYSTEM_TENANT_ID)
  SEED_TENANT_ID, // Global customer tenant
  SEED_CUSTOMER_TENANT_IDS.ARCAAI,
];

/**
 * Migrate EXISTING databases to the new whisper.cpp GGUF default
 * without creating a second default (mirrors the
 * `switchDefaultSttPipeline`, removed once its own reconciliation completed).
 *
 * `seedAsrPipelines` deliberately never clobbers `isDefault` on update, so on
 * an existing DB the freshly-created GGUF row arrives as `isDefault: true`
 * while the prior default (production-whisper-large-v3) is still
 * `isDefault: true` — two defaults for one tenant. This backfill reconciles
 * each tenant to EXACTLY ONE default, while respecting an admin who already
 * moved the default elsewhere:
 *
 *   - prior default is still the untouched OLD production slug → demote it
 *     and promote the new GGUF pipeline;
 *   - admin already picked a different default (e.g. turbo) → keep their
 *     choice and demote the freshly-seeded GGUF pipeline instead;
 *   - the GGUF pipeline is already the sole default (fresh seed) → no-op.
 *
 * Idempotent: re-running converges to the same single-default state and
 * performs no writes once converged.
 */
export const switchDefaultSttPipelineToGgufTurbo = async (client: CorePrismaClient) => {
  console.log('Reconciling default ASR pipeline (TASK-507)...');
  let switched = 0;
  let skipped = 0;

  for (const tenantId of STT_DEFAULT_PIPELINE_BACKFILL_TENANTS) {
    const ggufDefault = await client.asrPipeline.findFirst({
      where: { tenantId, slug: STT_NEW_DEFAULT_PIPELINE_SLUG },
    });
    // New pipeline not seeded for this tenant — nothing to reconcile.
    if (!ggufDefault) {
      continue;
    }

    const currentDefaults = await client.asrPipeline.findMany({
      where: { tenantId, isDefault: true },
    });
    const otherDefaults = currentDefaults.filter((p) => p.id !== ggufDefault.id);
    const adminPicked = otherDefaults.find((p) => p.slug !== STT_OLD_DEFAULT_PIPELINE_SLUG);

    let touched = false;
    if (adminPicked) {
      // Respect the admin's explicit default; ensure the GGUF pipeline
      // is not a second default and demote any stale OLD-slug default.
      if (ggufDefault.isDefault) {
        await client.asrPipeline.update({ where: { id: ggufDefault.id }, data: { isDefault: false } });
        touched = true;
      }
      for (const stale of otherDefaults) {
        if (stale.slug === STT_OLD_DEFAULT_PIPELINE_SLUG && stale.isDefault) {
          await client.asrPipeline.update({ where: { id: stale.id }, data: { isDefault: false } });
          touched = true;
        }
      }
    } else {
      // No admin override → the GGUF pipeline is the intended sole
      // default. Demote any OLD-slug defaults and promote it if needed.
      for (const stale of otherDefaults) {
        await client.asrPipeline.update({ where: { id: stale.id }, data: { isDefault: false } });
        touched = true;
      }
      if (!ggufDefault.isDefault) {
        await client.asrPipeline.update({ where: { id: ggufDefault.id }, data: { isDefault: true } });
        touched = true;
      }
    }

    if (touched) {
      switched += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`  Reconciled default ASR pipeline: ${switched} switched, ${skipped} unchanged`);
  return { success: true, switched, skipped };
};

/**
 * Keys whose plaintext `GlobalSetting` rows are superseded by Vault kv-v2
 * (TASK-558 §9.3 M10, lane G G4). Removing them from `DEFAULT_STT_SETTINGS`
 * stops NEW databases getting them, but existing databases still hold the
 * credential in the clear — so sweep them here.
 */
export const PURGED_PLAINTEXT_SECRET_KEYS: readonly string[] = ['S3_ACCESS_KEY', 'S3_SECRET_KEY'];

/**
 * Idempotently scrub the superseded plaintext credential rows across ALL
 * tenants.
 *
 * The value is OVERWRITTEN before the row is retired: a soft delete alone
 * would leave the secret readable in the `value` column, which is precisely
 * the posture M10 forbids. This is an UPDATE, never a hard delete — no row is
 * destroyed, so the house rule against destructive seed operations holds.
 *
 * Rows already scrubbed are excluded, so a re-run writes nothing.
 */
export const purgePlaintextSecretSettings = async (client: CorePrismaClient): Promise<{ purged: number }> => {
  console.log('Purging superseded plaintext secret Global Settings (TASK-558 M10)...');

  const SCRUBBED = '__MOVED_TO_VAULT__';
  let purged = 0;

  for (const key of PURGED_PLAINTEXT_SECRET_KEYS) {
    const result = await client.globalSetting.updateMany({
      where: { key, value: { not: SCRUBBED } },
      data: {
        value: SCRUBBED,
        defaultValue: SCRUBBED,
        description: 'Superseded by Vault kv-v2 (TASK-558). Resolved via SecretsService, never from this row.',
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    if (result.count > 0) {
      console.log(`  Purged ${key} (${result.count} row(s) across all tenants)`);
    }
    purged += result.count;
  }

  console.log(`Purged ${purged} plaintext secret Global Setting row(s)`);
  return { purged };
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
 * Seed the SYSTEM-tenant TenantSttConfig row (TASK-567) — the PLATFORM-DEFAULT
 * STT config every tenant merges under its own row (TenantSttConfigService
 * .getEffective, Phase C). No fallback by default: `fallbackPipelineId` stays
 * NULL because the fallback is an explicit per-tenant choice, and auto-switch is
 * ON by default. Idempotent (find-by-tenant then create). Mirrors the TTS SYSTEM
 * platform-default posture; unscoped seed client so the SYSTEM row is written
 * directly.
 */
export const SYSTEM_TENANT_STT_CONFIG = {
  tenantId: SYSTEM_TENANT_ID,
  // No platform-default fallback — fallback is an explicit tenant choice.
  //
  // This NULL is load-bearing for unit economics (TASK-638 §6.1): pointing it at
  // a CLOUD pipeline would route every tenant's fallback traffic to a managed
  // ASR vendor on PLATFORM credentials, and managed ASR costs ~13× self-hosted
  // per audio-second — enough to take PRO from ~93% gross margin to ~7%. Managed
  // ASR is an ADD-ON: reached via tenant BYOK (tenant funds it) or an explicit
  // tenant-scoped arrangement, never as a silent platform-funded default.
  fallbackPipelineId: null,
  autoSwitchEnabled: true,
} as const;

export const seedTenantSttConfig = async (client: CorePrismaClient) => {
  console.log('Seeding SYSTEM TenantSttConfig (platform default)...');

  const existing = await client.tenantSttConfig.findFirst({
    where: { tenantId: SYSTEM_TENANT_ID },
  });

  if (existing) {
    console.log('  SYSTEM TenantSttConfig already exists, leaving as-is.');
    return { success: true, created: false };
  }

  await client.tenantSttConfig.create({
    data: { ...SYSTEM_TENANT_STT_CONFIG },
  });
  console.log('  Created SYSTEM TenantSttConfig platform-default row.');
  return { success: true, created: true };
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

    // Clone the SYSTEM catalog into existing customer
    // tenants (idempotent; mirrors the runtime clone-per-tenant).
    await backfillCustomerTenantAiModels(client);
    console.log('');

    await seedAsrPipelines(client);
    console.log('');

    // The switchDefaultSttPipeline reconciliation was
    // removed: the CT2 artifact now resolves (deepdml, decision D3), so
    // there is no placeholder default to demote, and re-running it would
    // silently override an admin's legitimate CT2 default choice.
    // seedAsrPipelines never clobbers isDefault on update.

    // Reconcile the default pipeline to the new whisper.cpp
    // GGUF pipeline on existing DBs (seedAsrPipelines won't clobber
    // isDefault on update, so without this an existing DB would have two
    // defaults per tenant).
    await switchDefaultSttPipelineToGgufTurbo(client);
    console.log('');

    // Soft-disable pipelines retired from the product matrix of 9.
    await retireRetiredAsrPipelines(client);
    console.log('');

    // Soft-retire the legacy catalog rows across all tenants
    // AFTER the upserts (idempotent; the pipeline-reference guard skips
    // any slug a live pipeline still points at). Runs after
    // seedAsrPipelines so the guard sees the freshly seeded pipelines.
    await retireLegacyAiModels(client);
    console.log('');

    await seedSttSettings(client);
    console.log('');

    // SYSTEM TenantSttConfig platform-default row (TASK-567).
    await seedTenantSttConfig(client);
    console.log('');

    // Scrub credential rows this seed used to plant in plaintext. Runs AFTER
    // seedSttSettings so a re-seed can never leave a freshly written value behind.
    await purgePlaintextSecretSettings(client);
    console.log('');

    console.log('STT domain seeding completed successfully!');
    return { success: true };
  } catch (error) {
    console.error('Error during STT domain seeding:', error);
    throw error;
  }
};
