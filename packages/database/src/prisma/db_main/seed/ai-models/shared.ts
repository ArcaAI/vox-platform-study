import type { ResourceStatusType } from '../../../../generated/core-prisma-client/client.js';

/**
 * Shared enum mirrors + row shape for the AI-model seed catalog.
 *
 * The enum consts mirror the Prisma enums in `enums.prisma`; only the values
 * actually used by a seed row are mirrored here (house convention carried over
 * from the pre-split `06-stt.ts`). `06-stt.ts` re-exports them so existing
 * imports keep working.
 */

export const AiModelSource = {
  HUGGINGFACE: 'HUGGINGFACE',
  GITHUB: 'GITHUB',
  MLFLOW: 'MLFLOW',
  LOCAL: 'LOCAL',
} as const;

export const AiModelFormat = {
  SAFETENSOR: 'SAFETENSOR',
  ONNX: 'ONNX',
  NEMO: 'NEMO',
  PYTORCH: 'PYTORCH',
  // Additive formats (foundation migration).
  MLX: 'MLX',
  GGUF: 'GGUF',
  // CTranslate2 (faster-whisper) artifacts.
  CTRANSLATE2: 'CTRANSLATE2',
  // Prisma↔Python enum sync (see migration task_505_stt_engine_enums).
  FASTER_WHISPER: 'FASTER_WHISPER',
  ONNX_OPTIMUM: 'ONNX_OPTIMUM',
  AZURE_SPEECH: 'AZURE_SPEECH',
  AZURE_FOUNDRY: 'AZURE_FOUNDRY',
  PARAKEET_CPP: 'PARAKEET_CPP',
  // Generic cloud-API engine (Sarvam TTS, Azure OpenAI catalog rows).
  CLOUD_API: 'CLOUD_API',
  // whisper.cpp ggml runtime (whisper-large-v3-turbo GGUF).
  WHISPER_CPP: 'WHISPER_CPP',
} as const;

export const ModelCategory = {
  AUDIO: 'AUDIO',
  NLP: 'NLP',
} as const;

export const ModelTaskType = {
  AUTOMATIC_SPEECH_RECOGNITION: 'AUTOMATIC_SPEECH_RECOGNITION',
  VOICE_ACTIVITY_DETECTION: 'VOICE_ACTIVITY_DETECTION',
  AUDIO_TO_AUDIO: 'AUDIO_TO_AUDIO',
  SUMMARIZATION: 'SUMMARIZATION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  // Guardrail/safety models (foundation migration).
  GUARDRAIL: 'GUARDRAIL',
  // Diarization stack task types.
  SPEAKER_EMBEDDING: 'SPEAKER_EMBEDDING',
  // NLP task models + TTS engines join the registry.
  TOKEN_CLASSIFICATION: 'TOKEN_CLASSIFICATION',
  TEXT_CLASSIFICATION: 'TEXT_CLASSIFICATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
} as const;

export const ModelType = {
  BASE_MODEL: 'BASE_MODEL',
  FINETUNED_MODEL: 'FINETUNED_MODEL',
  QUANTIZED_MODEL: 'QUANTIZED_MODEL',
} as const;

/**
 * Canonical serving-provider identifiers. String column (not a
 * Prisma enum) to match `HarnessPolicy.smrProvider` / the guardrail provider
 * switch; the DTO layer validates with `@IsIn(AI_MODEL_PROVIDERS)`.
 */
export const AI_MODEL_PROVIDERS = [
  'ollama',
  'lm-studio',
  'azure',
  'bedrock',
  'built-in',
  'sarvam',
  // production self-host
  // engines. OpenAI-compatible `/v1` wire; free-string
  // provider values, no Prisma enum migration (the column is a plain string).
  'vllm',
  'llama-cpp',
] as const;

export type AiModelProvider = (typeof AI_MODEL_PROVIDERS)[number];

/**
 * TTS voice binding stored in `metaData.voices` (admin-selectable catalog).
 * A type alias (not an interface) so it gets an implicit index signature and
 * stays assignable to Prisma's `InputJsonValue`.
 */
export type TtsVoiceBinding = { id: string; locale: string };

/** Shape of one `DEFAULT_AI_MODELS` seed row. */
export interface AiModelSeed {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string;
  category: (typeof ModelCategory)[keyof typeof ModelCategory];
  taskType: (typeof ModelTaskType)[keyof typeof ModelTaskType];
  modelType: (typeof ModelType)[keyof typeof ModelType];
  source: (typeof AiModelSource)[keyof typeof AiModelSource];
  sourceUri: string;
  sourceRevision: string;
  format: (typeof AiModelFormat)[keyof typeof AiModelFormat];
  /** Canonical serving provider. */
  provider: AiModelProvider;
  /** Model architecture family (nullable — engines without one use null). */
  architecture: string | null;
  memorySizeMb: number;
  computeType: string;
  tags: string[];
  /** Per-model extras: TTS `{voices}`, Azure LLM `{azureDeployment}`. */
  metaData?: { voices?: TtsVoiceBinding[]; azureDeployment?: string; ttsProvider?: string };
  /** Only set when a row must seed in a non-default status (indic-f5). */
  resourceStatus?: ResourceStatusType;
}
