/**
 * Display metadata for the gateway model enums (frame 15): human labels for
 * sources ("providers" in the frame) and the closed option lists the
 * register/edit form and filter selects render.
 *
 * TASK-860: the registry is organised the way the Hugging Face Hub is —
 * `pipeline_tag` (task) → `library_name` → model — so the vocabularies below
 * mirror `AI_MODEL_LIBRARIES` / `AI_MODEL_SERVED_BY` / `AI_MODEL_PROVIDERS`
 * in `@arcaai/applications` (`services/ai-model/constants.ts`).
 */

import type { AiDeploymentKind, AiModelAvailability, AiModelFormat, AiModelSource, AiTaskKind, ModelCategory, ModelType } from '../api/types';

export const SOURCE_LABELS: Record<AiModelSource, string> = {
  HUGGINGFACE: 'Hugging Face',
  GITHUB: 'GitHub',
  MLFLOW: 'MLflow',
  LOCAL: 'Local',
  S3: 'S3 bucket',
};

export const SOURCE_OPTIONS: AiModelSource[] = ['HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL', 'S3'];

export const CATEGORY_OPTIONS: ModelCategory[] = ['MULTI_MODAL', 'VISION', 'NLP', 'AUDIO', 'TABULAR', 'UNKNOWN'];

export const MODEL_TYPE_OPTIONS: ModelType[] = ['BASE_MODEL', 'FINETUNED_MODEL', 'QUANTIZED_MODEL', 'UNKNOWN'];

export const FORMAT_OPTIONS: AiModelFormat[] = [
  'SAFETENSOR',
  'ONNX',
  'NEMO',
  'PYTORCH',
  'CTRANSLATE2',
  'FASTER_WHISPER',
  'MLX',
  'GGUF',
  'WHISPER_CPP',
];

/** Canonical runtime provider ids (mirrors AI_MODEL_PROVIDERS in @arcaai/applications). */
export const RUNTIME_PROVIDER_OPTIONS = ['ollama', 'lm-studio', 'azure', 'bedrock', 'built-in', 'sarvam', 'openai', 'anthropic', 'vertex', 'vllm', 'llama-cpp'] as const;

/** Serving libraries — the Hub `library_name` facet (mirrors AI_MODEL_LIBRARIES). */
export const LIBRARY_OPTIONS = [
  'faster-whisper',
  'whisper.cpp',
  'ctranslate2',
  'parakeet.cpp',
  'nemo',
  'onnxruntime',
  'pyrnnoise',
  'deepfilternet',
  'speechbrain',
  'pyannote-audio',
  'cadence-punctuation',
  'transformers',
  'gliner2',
  'llama.cpp',
  'kokoro',
  'parler-tts',
  'lm-studio',
  'ollama',
  'vllm',
  'azure-speech',
  'azure-foundry',
  'azure-openai',
  'openai',
  'sarvam',
  'bedrock',
  'anthropic',
  'vertex',
] as const;

/** Workloads that execute a row (mirrors AI_MODEL_SERVED_BY). */
export const SERVED_BY_OPTIONS = ['stt', 'stt-worker', 'nlp', 'tts', 'tts-worker', 'lmstudio', 'text', 'gateway-proxy'] as const;

export const DEPLOYMENT_KIND_OPTIONS: AiDeploymentKind[] = ['SELF_HOSTED', 'CLOUD'];
export const DEPLOYMENT_KIND_LABELS: Record<AiDeploymentKind, string> = { SELF_HOSTED: 'Self-hosted', CLOUD: 'Cloud' };

export const AVAILABILITY_OPTIONS: AiModelAvailability[] = ['AVAILABLE', 'MISSING', 'PARTIAL', 'NOT_APPLICABLE', 'UNKNOWN'];

/** The platform-default election vocabulary, in product order. */
export const TASK_KIND_OPTIONS: AiTaskKind[] = [
  'SPEECH_TO_TEXT',
  'TEXT_GENERATION',
  'TEXT_TO_SPEECH',
  'NAMED_ENTITY_RECOGNITION',
  'TEXT_CLASSIFICATION',
  'CONTENT_SAFETY',
  'GROUNDEDNESS',
  'PII_DETECTION',
  'TRANSLATION',
  'VISION_EXTRACTION',
  'EMBEDDING',
];

export const TASK_KIND_LABELS: Record<AiTaskKind, string> = {
  SPEECH_TO_TEXT: 'Speech to text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text to speech',
  NAMED_ENTITY_RECOGNITION: 'Named-entity recognition',
  TEXT_CLASSIFICATION: 'Text classification',
  CONTENT_SAFETY: 'Content safety',
  GROUNDEDNESS: 'Groundedness',
  PII_DETECTION: 'PII detection',
  TRANSLATION: 'Translation',
  VISION_EXTRACTION: 'Vision extraction',
  EMBEDDING: 'Embedding',
};

/**
 * Hugging Face task order for the grouped grid (README §3.7): audio first (the
 * platform's realtime path), then speech synthesis, then the text tasks.
 */
export const PIPELINE_TAG_ORDER = [
  'automatic-speech-recognition',
  'voice-activity-detection',
  'audio-to-audio',
  'audio-classification',
  'text-to-speech',
  'token-classification',
  'text-classification',
  'text-generation',
] as const;

/** Sort key for a pipeline tag: known tags in HF order, everything else after, alphabetically. */
export function pipelineTagRank(tag: string): number {
  const index = (PIPELINE_TAG_ORDER as readonly string[]).indexOf(tag);
  return index === -1 ? PIPELINE_TAG_ORDER.length : index;
}

/** "AUTOMATIC_SPEECH_RECOGNITION" -> "automatic speech recognition". */
export function humanizeEnum(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase();
}

/** The mount every serving pod reads the bucket at — the gateway derives `localPath` from it the same way. */
export const HOPE_MODELS_MOUNT = '/mnt/models-bucket';

/** Mirror of the gateway's `deriveLocalPath`, for the read-only preview in the drawer. */
export function deriveLocalPath(bucketPrefix: string, primaryObject?: string | null): string {
  const prefix = bucketPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const base = `${HOPE_MODELS_MOUNT}/${prefix}/`;
  return primaryObject ? `${base}${primaryObject.replace(/^\/+/, '')}` : base;
}

/** The bucket `HOPE_MODELS_MOUNT` is mounted from — used to derive a LOCAL row's `sourceUri` from its `bucketPrefix` (TASK-960). */
export const HOPE_MODELS_BUCKET = 'hope-models';

/**
 * `s3://hope-models/<bucketPrefix>` for a LOCAL row — DERIVED, never typed by
 * hand, so `sourceUri` and `bucketPrefix` can never disagree (TASK-960 D3c).
 * The Python resolver falls back to `sourceUri` scheme dispatch when
 * `local_path` is absent, so keeping this honest keeps that fallback honest
 * too. Empty until a bucket prefix is entered.
 */
export function deriveLocalSourceUri(bucketPrefix: string): string {
  const prefix = bucketPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return prefix ? `s3://${HOPE_MODELS_BUCKET}/${prefix}` : '';
}

/**
 * `true` when a bucket prefix redundantly repeats the bucket itself
 * (`hope-models/…` or `s3://hope-models/…`). `HOPE_MODELS_MOUNT` already IS
 * that bucket, so the segment would double into a path that does not exist.
 * Mirrors the gateway's server-side DTO validation (TASK-960 Lane B) so an
 * admin is corrected here rather than by a 400.
 */
export function isBucketPrefixRedundant(bucketPrefix: string): boolean {
  const trimmed = bucketPrefix.trim().replace(/^\/+/, '');
  const lower = trimmed.toLowerCase();
  return lower === HOPE_MODELS_BUCKET || lower.startsWith(`${HOPE_MODELS_BUCKET}/`) || lower === `s3://${HOPE_MODELS_BUCKET}` || lower.startsWith(`s3://${HOPE_MODELS_BUCKET}/`);
}
