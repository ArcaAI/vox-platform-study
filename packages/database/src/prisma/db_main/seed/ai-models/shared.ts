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
  // `CLOUD_BYO_PROVIDERS.llm` (@arcaai/applications); their TEXT adapters are
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
 *
 * One classification task, e.g. the six GLiGuard moderation tasks. A type alias
 * (like `TtsVoiceBinding`) so it keeps an implicit index signature and stays
 * assignable to `InputJsonValue`.
 */
/**
 * The CLINICAL TAXONOMY a token-classification (NER) checkpoint executes against
 * (TASK-799 lane G). `apps/nlp` used to carry all four of these as Python
 * literals or `TOKEN_CLASSIFIER_*` / `NLP_LINKER_*` env fields; rule 00
 * §Configuration Principles names a threshold, taxonomy or label set as neither.
 *
 * It rides on the MODEL ROW rather than in a settings key because most of it IS
 * a property of the checkpoint — which labels it emits meaning "nothing", how
 * its subword pieces aggregate, which surface forms its NER can be expected to
 * produce. Re-pointing `nlp.ner` at a different checkpoint therefore swaps the
 * taxonomy with it, instead of leaving a service-keyed knob pointed at the old
 * model's conventions.
 *
 * The gateway resolves it (`resolveNerModelInjection`, SYSTEM-pinned per
 * decision D-4: nlp models are PLATFORM-SHARED) and injects it verbatim as
 * `clinical_taxonomy`. An absent SECTION disables the pass it governs in the
 * executor — it is never backfilled with a literal.
 */
export type OntologyVocabularyEntry = {
  /** Surface forms, matched after normalization (case/punctuation/subword markers). */
  aliases: string[];
  umls_cui?: string;
  snomed_code?: string;
  rxnorm_code?: string;
  icd_code?: string;
  loinc_code?: string;
};

export type VitalsRange = { min: number; max: number };

export type ClinicalTaxonomy = {
  /** The checkpoint's own NER contract. */
  tokenClassifier?: {
    /** HF pipeline aggregation: simple | first | max | average. */
    aggregationStrategy?: string;
    /** Labels this checkpoint emits that mean "nothing" (e.g. the BIO `O` tag). */
    ignoreLabels?: string[];
    /** Whether the ConText/NegEx assertion pass runs over recognized spans. */
    assertionEnabled?: boolean;
  };
  /** Deterministic ontology linker: gate, floor, and the crosswalk itself. */
  linker?: {
    enabled?: boolean;
    confidenceFloor?: number;
    vocabulary?: OntologyVocabularyEntry[];
  };
  /**
   * Physiologic plausibility bands. A parsed vital outside its band is DISCARDED
   * (never clamped); a vital with no band configured is never emitted at all, so
   * a paediatric or neonatal deployment retunes these rather than shipping a
   * fork of the extractor.
   */
  vitals?: {
    systolic?: VitalsRange;
    diastolic?: VitalsRange;
    heartRate?: VitalsRange;
    spo2?: VitalsRange;
    temperatureC?: VitalsRange;
    weightKg?: VitalsRange;
  };
  /** ConText/NegEx pre-trigger lexicon, keyed by the AssertionStatus it implies. */
  assertion?: {
    triggers?: Record<string, string[]>;
  };
};

/**
 * The MiniCheck calibration gate's ground truth (TASK-799 lane G), for an NLI
 * entailment checkpoint. `apps/nlp` keeps the ADAPTER (the `'predict: '`
 * template and the 3/209 label-token read) in code — no other value of those
 * makes it work — but refuses to load a row whose declared `adapter` is
 * something else, or which declares no calibration at all. The bounds and the
 * reference pair are configuration because they depend on the specific build
 * AND its quantisation: tolerances measured on a Q6 GGUF are meaningless for a
 * Q4 one, and a re-published model card changes the reference probabilities.
 */
export type EntailmentCalibration = {
  adapter: string;
  labelTokenNo: number;
  labelTokenYes: number;
  supportedMin: number;
  unsupportedMax: number;
  document: string;
  supportedClaim: string;
  unsupportedClaim: string;
};

export type LabelTaxonomyTask = {
  labels: string[];
  multi_label?: boolean;
  cls_threshold?: number;
};

/**
 * Extraction rows use `labels`; classification rows use `tasks` (+
 * `benignLabels`); the joint checkpoint carries both, which is exactly what
 * makes it the joint checkpoint. Fields are optional so both shapes are
 * expressible on one type.
 */
export type LabelTaxonomy = {
  threshold?: number;
  labels?: string[];
  benignLabels?: string[];
  tasks?: Record<string, LabelTaxonomyTask>;
};

/**
 * What `apps/nlp` may ask a checkpoint to DO. Declared here, on the row, so the
 * service never branches on a model id — the capability envelope is
 * configuration, and a selection pointing a `classify_text` task at an
 * extraction-only row is wrong at the catalog, not at inference time.
 * TASK-778 proved this is load-bearing: every checkpoint ANSWERS every verb,
 * so a wrong selection mis-answers confidently instead of failing.
 */
export type AiModelCapability = 'extract_entities' | 'classify_text';

/** Historical alias — same closed set. */
export type NlpModelCapability = AiModelCapability;

/**
 * TASK-847 finding F-32 — which GENERATION hyper-parameters a catalogue row, as served by its
 * provider, actually accepts.
 *
 * The vocabulary is `GENERATION_HYPERPARAMETERS` from `@arcaai/workflow-contract`, restated here
 * for the same reason `AiModelCapability` is a literal union rather than an import: this seed
 * module is a database-package leaf and must not depend on the workflow contract. Parity is
 * asserted by test rather than trusted to this comment.
 *
 * ## Why this is a ROW and not a table in TypeScript
 *
 * Provider capabilities are CONFIG. A per-provider `switch` in application code would be exactly
 * the hardcoded configuration `00-project-context.md` §Configuration Principles rule 1 forbids,
 * and it could never express a tenant's own endpoint — a tenant running vLLM behind
 * `AiProviderConnection` may well accept parameters the platform's managed default does not. It
 * lives on `_metadata` alongside `labelTaxonomy` (guardrail), `clinicalTaxonomy` (nlp) and
 * `entailment`, all of which are model-declared descriptors resolved through the SAME tenant →
 * SYSTEM cascade that chose the model. `_metadata` is a `Json?` column, so carrying one more
 * descriptor needs no migration.
 *
 * ## ABSENT is "unknown", not "unsupported"
 *
 * Omitting the key means nobody has profiled this row. `hyperparameterCapabilityProblems` then
 * emits a WARNING, never an ERROR — refusing every graph bound to an unprofiled configuration
 * would block the platform on data entry rather than on a real conflict. Declaring the key is
 * what makes the gate bite.
 *
 * ## What the platform can actually serve today
 *
 * `apps/text`'s generation plane forwards exactly three parameters to every adapter —
 * `temperature`, `max_tokens`, `top_p` (`apps/text/src/text/core/defaults.py:41-43,69-71`), and
 * `AiRuntimeProfile` carries those same three columns and no others. No adapter in
 * `apps/text/src/text/providers/` references a penalty parameter at all. So a row declaring the
 * three is stating a verified fact about this platform, not a vendor's brochure.
 */
export type GenerationParamName = 'temperature' | 'maxTokens' | 'topP' | 'frequencyPenalty' | 'presencePenalty' | 'stopSequences' | 'seed';

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
  /**
   * Operator/admin override — HIGHEST precedence in every service's
   * `resolve_model_dir` (stt, guardrail, nlp, harness; `stt.prisma:178-182`),
   * ahead of `sourceUri` scheme dispatch. Weights are read IN PLACE from this
   * path, never copied.
   *
   * DELIBERATELY NOT HAND-SET on any seed row (TASK-855). The path segment
   * under the slug is CONTENT-DERIVED — `<quant>-<first 12 of
   * sha256(SHA256SUMS)>`, produced by the `hope-models-publish` Job — so it
   * cannot be known, let alone typed here, before a model is actually
   * published to the `hope-models` bucket. The TASK-855 Phase 2 download
   * action writes this field back automatically once a model is fetched,
   * alongside `downloadStatus`/`checksum` — do NOT hand-author a value here;
   * an absent value simply falls through to `sourceUri` scheme dispatch with
   * a structlog warning, so it is always safe to omit.
   */
  localPath?: string | null;
  format: (typeof AiModelFormat)[keyof typeof AiModelFormat];
  /** Canonical serving provider. */
  provider: AiModelProvider;
  /** Model architecture family (nullable — engines without one use null). */
  architecture: string | null;
  memorySizeMb: number;
  computeType: string;
  tags: string[];
  /**
   * Per-model extras: TTS `{voices}`, Azure LLM `{azureDeployment}`, guardrail
   * `{policy}` (TASK-777 — `apps/guardrail/src/guardrail/core/policy.py`'s
   * governed key table, resolved through the same tenant → SYSTEM cascade as
   * model selection; a key declared `failMode: closed` there — e.g.
   * `medicalValidationCriteria` — is NOT a code default and MUST be seeded here
   * or the resolving endpoint fails closed with 503), and — for the NLP safety
   * plane (TASK-778) — the capability envelope, languages and label taxonomy
   * that keep model ids and label sets out of Python.
   */
  metaData?: {
    voices?: TtsVoiceBinding[];
    azureDeployment?: string;
    ttsProvider?: string;
    policy?: Record<string, string | number>;
    languages?: string[];
    capabilities?: AiModelCapability[];
    labelTaxonomy?: LabelTaxonomy;
    clinicalTaxonomy?: ClinicalTaxonomy;
    entailment?: EntailmentCalibration;
    supportedGenerationParams?: GenerationParamName[];
  };
  /** Only set when a row must seed in a non-default status (indic-f5). */
  resourceStatus?: ResourceStatusType;
}
