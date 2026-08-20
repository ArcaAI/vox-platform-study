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
  // First-class cloud STT engines — a bare-slug pipeline ref binds
  // them like AZURE_SPEECH (no inline engine / provider-shorthand override).
  SARVAM: 'SARVAM',
  OPENAI: 'OPENAI',
} as const;

export const ModelCategory = {
  AUDIO: 'AUDIO',
  NLP: 'NLP',
  // Vision-language models.
  VISION: 'VISION',
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
  // Multimodal image+text → text (vision extraction).
  IMAGE_TEXT_TO_TEXT: 'IMAGE_TEXT_TO_TEXT',
} as const;

export const ModelType = {
  BASE_MODEL: 'BASE_MODEL',
  FINETUNED_MODEL: 'FINETUNED_MODEL',
  QUANTIZED_MODEL: 'QUANTIZED_MODEL',
} as const;

/**
 * Canonical serving-provider identifiers. String column (not a
 * Prisma enum) to match `HarnessPolicy.textProvider` / the guardrail provider
 * switch; the DTO layer validates with `@IsIn(AI_MODEL_PROVIDERS)`.
 *
 * `ollama` is a SELECTABLE provider with NO platform-seeded catalog rows, and
 * that pairing is deliberate (TASK-736, owner decision 2026-08-17: "ollama
 * provider logic must be available, however, model catalog related to ollama
 * must be removed"). It reverses the 2026-08-16 directive that removed the
 * provider outright. The platform ships no Ollama model because it standardises
 * on one LM Studio model; a tenant that brings its own Ollama endpoint supplies
 * its own `AiModel` row and `AiTaskDefault`. Pinned by
 * `seed/__tests__/ollama-provider-retained.test.ts`.
 */
export const AI_MODEL_PROVIDERS = [
  'ollama',
  'lm-studio',
  'azure',
  'bedrock',
  'built-in',
  'sarvam',
  'openai',
  // Cloud tenant-BYO LLM providers. `openai` above already served
  // the STT OpenAI ASR engine; these two are net-new. Governance lives in
  // `CLOUD_BYO_PROVIDERS.llm` (@arcaai/applications); their SMR adapters are
  // `apps/text/src/text/providers/{anthropic,vertex}.py`.
  'anthropic',
  'vertex',
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

/**
 * `metaData.labelTaxonomy` shapes used by the guardrail-plane NLP rows
 * (GLiNER2 PII span detector, GLiNER2 safety moderator). Guardrail reads this
 * through the tenant → SYSTEM cascade (`core/tenant_config.py`), so the shape
 * is load-bearing configuration, not documentation.
 */
export type NlpModelCapability = 'extract_entities' | 'classify_text';

export type LabelTaxonomyTask = {
  labels: string[];
  multi_label: boolean;
  cls_threshold?: number;
};

export type LabelTaxonomy =
  | { threshold: number; labels: string[] }
  | { threshold: number; benignLabels: string[]; tasks: Record<string, LabelTaxonomyTask> };

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
  /**
   * Per-model extras: TTS `{voices}`, Azure LLM `{azureDeployment}`, and the
   * guardrail-plane NLP rows' `{languages, labelTaxonomy}`.
   */
  metaData?: {
    voices?: TtsVoiceBinding[];
    azureDeployment?: string;
    ttsProvider?: string;
    languages?: string[];
    labelTaxonomy?: LabelTaxonomy;
    /**
     * What `apps/nlp` may ask this checkpoint to do. Declared as configuration
     * rather than inferred from the model id in Python, so a `guardrail.safety`
     * selection pointing at an extraction-only row fails at selection time
     * instead of mis-answering at inference. Closed set: a row without a
     * classification head must not claim `classify_text`.
     */
    capabilities?: NlpModelCapability[];
  };
  /** Only set when a row must seed in a non-default status (indic-f5). */
  resourceStatus?: ResourceStatusType;
}
