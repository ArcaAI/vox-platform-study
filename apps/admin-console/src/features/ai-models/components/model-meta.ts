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

import { HOPE_MODELS_BUCKET, HOPE_MODELS_MOUNT } from '@arcaai/types';
import type { AiDeploymentKind, AiModelAvailability, AiModelFormat, AiModelSource, AiTaskKind } from '../api/types';

export const SOURCE_LABELS: Record<AiModelSource, string> = {
  HUGGINGFACE: 'Hugging Face',
  GITHUB: 'GitHub',
  MLFLOW: 'MLflow',
  LOCAL: 'Local',
  S3: 'S3 bucket',
};

/** The sources a model can be REGISTERED from (TASK-1023). GITHUB and S3 rows keep their display label in `SOURCE_LABELS`. */
export const SOURCE_OPTIONS: AiModelSource[] = ['HUGGINGFACE', 'MLFLOW', 'LOCAL'];

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

/**
 * Every `ModelTaskType` the gateway DTO accepts (`@IsEnum(ModelTaskType)`), in
 * the enum's order. A copy because the console cannot import `@arcaai/domains`;
 * `model-meta.test.ts` fails if it drifts from the enum.
 */
export const MODEL_TASK_TYPE_OPTIONS = [
  'IMAGE_TEXT_TO_TEXT',
  'VISUAL_QUESTION_ANSWERING',
  'DOCUMENT_QUESTION_ANSWERING',
  'VIDEO_TEXT_TO_TEXT',
  'ANY_TO_ANY',
  'DEPTH_ESTIMATION',
  'IMAGE_CLASSIFICATION',
  'OBJECT_DETECTION',
  'IMAGE_SEGMENTATION',
  'TEXT_TO_IMAGE',
  'IMAGE_TO_TEXT',
  'IMAGE_TO_IMAGE',
  'IMAGE_TO_VIDEO',
  'UNCONDITIONAL_IMAGE_GENERATION',
  'VIDEO_CLASSIFICATION',
  'TEXT_TO_VIDEO',
  'ZERO_SHOT_IMAGE_CLASSIFICATION',
  'MASK_GENERATION',
  'ZERO_SHOT_OBJECT_DETECTION',
  'TEXT_TO_3D',
  'IMAGE_TO_3D',
  'IMAGE_FEATURE_EXTRACTION',
  'KEYPOINT_DETECTION',
  'TEXT_CLASSIFICATION',
  'TOKEN_CLASSIFICATION',
  'TABLE_QUESTION_ANSWERING',
  'QUESTION_ANSWERING',
  'ZERO_SHOT_CLASSIFICATION',
  'TRANSLATION',
  'SUMMARIZATION',
  'FEATURE_EXTRACTION',
  'TEXT_GENERATION',
  'TEXT2TEXT_GENERATION',
  'FILL_MASK',
  'SENTENCE_SIMILARITY',
  'GUARDRAIL',
  'TEXT_TO_SPEECH',
  'TEXT_TO_AUDIO',
  'AUTOMATIC_SPEECH_RECOGNITION',
  'AUDIO_TO_AUDIO',
  'AUDIO_CLASSIFICATION',
  'VOICE_ACTIVITY_DETECTION',
  'SPEAKER_DIARIZATION',
  'SPEAKER_EMBEDDING',
  'TABULAR_CLASSIFICATION',
  'TABULAR_REGRESSION',
  'TIME_SERIES_FORECASTING',
  'UNKNOWN',
] as const;

/** "TEXT2TEXT_GENERATION" -> "text2text-generation" — the Hub's own spelling of the task. */
export function taskTypeToPipelineTag(taskType: string): string {
  return taskType.toLowerCase().replaceAll('_', '-');
}

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
export const SERVED_BY_OPTIONS = ['stt', 'stt-worker', 'nlp', 'tts', 'tts-worker', 'lmstudio', 'text', 'gateway-proxy', 'vllm'] as const;

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

// The mount every serving pod reads the bucket at, and the bucket itself — declared once in
// `@arcaai/types` (TASK-1023 OD-8); the gateway derives `localPath` from the same constant.
export { HOPE_MODELS_BUCKET, HOPE_MODELS_MOUNT };
