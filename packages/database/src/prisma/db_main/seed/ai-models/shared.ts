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

// TASK-860 registry mirrors — again only the members a seed row uses.
export const AiDeploymentKind = {
  SELF_HOSTED: 'SELF_HOSTED',
  CLOUD: 'CLOUD',
} as const;

export const AiModelAvailability = {
  UNKNOWN: 'UNKNOWN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;

export const AiTaskKind = {
  TEXT_GENERATION: 'TEXT_GENERATION',
  SPEECH_TO_TEXT: 'SPEECH_TO_TEXT',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  NAMED_ENTITY_RECOGNITION: 'NAMED_ENTITY_RECOGNITION',
  CONTENT_SAFETY: 'CONTENT_SAFETY',
  GROUNDEDNESS: 'GROUNDEDNESS',
  PII_DETECTION: 'PII_DETECTION',
} as const;

/**
 * The serving-library vocabulary (`AiModel.libraryName`) — the Hugging Face
 * Hub's `library_name` facet, restricted to what this platform can actually
 * load. A string column (not a Prisma enum) so a tenant BYO engine never needs
 * a migration; the DTO validates with `@IsIn(AI_MODEL_LIBRARIES)`.
 *
 * MUST stay identical to `AI_MODEL_LIBRARIES` in
 * `packages/applications/src/services/ai-model/constants.ts` — this package is
 * a dependency leaf, so the two copies are pinned by
 * `tests/contracts/ai-model-providers.contract.test.ts` rather than imported.
 */
export const AI_MODEL_LIBRARIES = [
  // Self-hosted — apps/stt
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
  // Self-hosted — apps/nlp / apps/tts / shared
  'transformers',
  'gliner2',
  'llama.cpp',
  'kokoro',
  'parler-tts',
  // Engine hosts (OpenAI-compatible `/v1`)
  'lm-studio',
  'ollama',
  'vllm',
  // Cloud vendors
  'azure-speech',
  'azure-foundry',
  'azure-openai',
  'openai',
  'sarvam',
  'bedrock',
  'anthropic',
  'vertex',
] as const;

export type AiModelLibrary = (typeof AI_MODEL_LIBRARIES)[number];

/**
 * The workload that executes a registry row (`AiModel.servedBy`). Cloud rows
 * are GOVERNED by the gateway (credentials, cascade — TASK-862) and EXECUTED by
 * the owning service, so they name that service, not the gateway.
 *
 * Mirrored in `packages/applications/.../ai-model/constants.ts`; same parity pin.
 */
export const AI_MODEL_SERVED_BY = ['stt', 'stt-worker', 'nlp', 'tts', 'tts-worker', 'lmstudio', 'text', 'gateway-proxy'] as const;

export type AiModelServedBy = (typeof AI_MODEL_SERVED_BY)[number];

/**
 * Canonical serving-provider identifiers. String column (not a
 * Prisma enum) to match `HarnessPolicy.textProvider` / the guardrail provider
 * switch; the DTO layer validates with `@IsIn(AI_MODEL_PROVIDERS)`.
 *
 * `ollama` is a SELECTABLE provider with NO platform-seeded catalog rows, and
 * that pairing is deliberate (owner decision 2026-08-17: "ollama
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
 * . `apps/nlp` used to carry all four of these as Python
 * literals or `TOKEN_CLASSIFIER_*` / `NLP_LINKER_*` env fields; rule 00
 * Principles names a threshold, taxonomy or label set as neither.
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
 * The MiniCheck calibration gate's ground truth , for an NLI
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
 * proved this is load-bearing: every checkpoint ANSWERS every verb,
 * so a wrong selection mis-answers confidently instead of failing.
 */
export type AiModelCapability = 'extract_entities' | 'classify_text';

/** Historical alias — same closed set. */
export type NlpModelCapability = AiModelCapability;

/**
 * finding F-32 — which GENERATION hyper-parameters a catalogue row, as served by its
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
   * DELIBERATELY NOT HAND-SET on any seed row. The path segment
   * under the slug is CONTENT-DERIVED — `<quant>-<first 12 of
   * sha256(SHA256SUMS)>`, produced by the `hope-models-publish` Job — so it
   * cannot be known, let alone typed here, before a model is actually
   * published to the `hope-models` bucket. The download
   * action writes this field back automatically once a model is fetched,
   * alongside `downloadStatus`/`checksum` — do NOT hand-author a value here;
   * an absent value simply falls through to `sourceUri` scheme dispatch with
   * a structlog warning, so it is always safe to omit.
 */
  localPath?: string | null;
  format: (typeof AiModelFormat)[keyof typeof AiModelFormat];
  // ── TASK-860 registry identity ───────────────────────────────────────────
  /** Serving library — the Hub's `library_name` facet; loader selection. */
  libraryName: AiModelLibrary;
  /** Workload that executes the row. */
  servedBy: AiModelServedBy;
  deploymentKind: (typeof AiDeploymentKind)[keyof typeof AiDeploymentKind];
  /**
   * Vendor wire id for CLOUD rows and the engine-host id for LM Studio rows.
   * Today it EQUALS `sourceUri` on those rows: the Python cloud loaders and
   * the TEXT router still read `source_uri` as the wire id, and re-pointing
   * them is TASK-862's routing work. Once that lands, `sourceUri` becomes the
   * Hub artifact (`metaData.hubArtifact` below) and this column is the only
   * wire id.
   */
  wireModelId?: string;
  /** Model-card licence identifier (Hub spelling: `apache-2.0`, `mit`, `gemma`, …). */
  license?: string;
  /** Hub gated / click-through repo — the publisher needs the SYSTEM token. */
  gated?: boolean;
  /** Upstream base checkpoint (`snakers4/silero-vad` for a mirror, the un-quantised repo for a GGUF). */
  baseModel?: string;
  /** ISO 639-1 codes, model-card order. */
  languages?: string[];
  /**
   * Single file a single-file loader opens inside the published prefix
   * (whisper.cpp `ggml-*.bin`, llama.cpp `*.gguf`). DELIBERATELY unset in the
   * seed for the same reason `localPath` is: the publisher discovers the real
   * filename from the repo listing and writes it back; a hand-typed name that
   * drifts from the repo is worse than none.
   */
  primaryObject?: string;
  /** Rows with nothing in the bucket (cloud, package-bundled weights) seed NOT_APPLICABLE. */
  availability?: (typeof AiModelAvailability)[keyof typeof AiModelAvailability];
  /** Platform-default election per task (README §3.6). At most one enabled row per task. */
  isPlatformDefaultFor?: (typeof AiTaskKind)[keyof typeof AiTaskKind][];
  /** Canonical serving provider. */
  provider: AiModelProvider;
  /** Model architecture family (nullable — engines without one use null). */
  architecture: string | null;
  memorySizeMb: number;
  computeType: string;
  tags: string[];
  /**
   * Per-model extras: TTS `{voices}`, Azure LLM `{azureDeployment}`, guardrail
   * `{policy}` — `apps/guardrail/src/guardrail/core/policy.py`'s
   * governed key table, resolved through the same tenant → SYSTEM cascade as
   * model selection; a key declared `failMode: closed` there — e.g.
   * `medicalValidationCriteria` — is NOT a code default and MUST be seeded here
   * or the resolving endpoint fails closed with 503), and — for the NLP safety
   * plane — the capability envelope, languages and label taxonomy
   * that keep model ids and label sets out of Python.
 */
  metaData?: {
    /**
     * The Hub repo the PUBLISHER fetches for an LM Studio row, where
     * `sourceUri` is still the engine-host wire id (see `wireModelId`).
     */
    hubArtifact?: string;
    /**
     * TASK-880 — ASR decode geometry, carried to `apps/stt` on
     * `ResolvedAsrSpec.models.asr.metadata`. It replaces the platform keys
     * `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS`, which
     * applied ONE number to every engine on the box; these describe a MODEL, so a
     * fallback chain now decodes on its own window instead of the primary's.
     */
    asr?: {
      /** Longest audio fed to the engine in ONE decode, seconds. Absent ⇒ no split guard. */
      maxDecodeWindowSec?: number;
      /** Tail of the live utterance decoded for PARTIALs, seconds. Absent ⇒ the preprocessor default. */
      partialWindowSec?: number;
    };
    /**
     * TASK-880 — speaker-embedding geometry. `dimension` is the vector width the row
     * emits, and it is LOAD-BEARING: `buildResolvedAsrSpec` REFUSES an agent whose
     * `models.embedding` declares a width the deployed `UserVoiceProfile.embedding`
     * column cannot hold, rather than shipping a spec whose every enrollment fails.
     */
    embedding?: { dimension?: number };
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
