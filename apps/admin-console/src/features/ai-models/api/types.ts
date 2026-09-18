import type { ResourceStatus } from '@/shared/api';

export type ModelCategory = 'MULTI_MODAL' | 'VISION' | 'NLP' | 'AUDIO' | 'TABULAR' | 'UNKNOWN';
export type ModelType = 'BASE_MODEL' | 'FINETUNED_MODEL' | 'QUANTIZED_MODEL' | 'UNKNOWN';
export type AiModelSource = 'HUGGINGFACE' | 'GITHUB' | 'MLFLOW' | 'LOCAL' | 'S3';
export type AiModelFormat = 'SAFETENSOR' | 'ONNX' | 'NEMO' | 'PYTORCH' | 'CTRANSLATE2' | 'FASTER_WHISPER' | 'MLX' | 'GGUF' | 'WHISPER_CPP';
/** @deprecated TASK-860 — removed in R3; read `availability` instead. */
/**
 * The publish JOB's status vocabulary. TASK-890 §3.11 dropped the `AiModel`
 * COLUMN of this name; the job endpoint's frozen contract still reports it, so
 * the type stays for `ModelDownloadState` / `StartModelDownloadResponse` only.
 */
export type AiModelDownloadStatus = 'NOT_DOWNLOADED' | 'DOWNLOADING' | 'DOWNLOADED' | 'DOWNLOAD_FAILED';
/** Large gateway enum (46 values) — keep open for forward compatibility. */
export type ModelTaskType = string;
/** The one `ModelTaskType` value the ASR decode profile (below) applies to. */
export const ASR_TASK_TYPE = 'AUTOMATIC_SPEECH_RECOGNITION';

// =============================================================================
// ASR decode profile (`AiModel._metadata.asr`, TASK-934) — mirrors
// `AiModelAsrProfile` / `AiModelAsrProfileDecoding` (`@arcaai/types`) and the
// range tables the gateway DTO (`AsrProfileRequest`) validates against. The
// console has no dependency on `@arcaai/types` (every wire type in this file
// is a hand-mirrored copy, per the existing convention — see `TextProviderModel`
// in `@/shared/catalog`), so the ranges are copied here rather than imported.
// =============================================================================

/**
 * TASK-985 (QW-8) — the subset a row may narrow PER DECODE PASS. `partial` is the
 * in-flight re-decode, `final` the committing one; a gate that is right on one is
 * wrong on the other, so they are separable. Precedence is pass → flat → default.
 */
export interface AiModelAsrProfileDecodingPass {
  beamSize?: number;
  temperature?: number;
  logprobThreshold?: number;
  entropyThreshold?: number;
  noSpeechThreshold?: number;
  singleSegment?: boolean;
  suppressBlank?: boolean;
  suppressNonSpeechTokens?: boolean;
  maxTokens?: number;
  audioCtx?: number;
}

/**
 * MUST TRACK `AiModelAsrProfileDecoding` in `@arcaai/types` FIELD FOR FIELD.
 *
 * This is a hand-mirrored copy by the convention stated above, which makes it a
 * drift generator with nothing behind it: nothing fails when the canonical type
 * gains a field, until someone USES that field here — and then it fails in the
 * image build rather than at the boundary, which is where TASK-985 found it.
 * `hotwordsInPrompt` was the field in use; eight others had drifted silently and
 * are added here too, so the console can express the decode surface the gateway
 * DTO already validates.
 *
 * `tests/contracts/admin-console-asr-profile-mirror.contract.test.ts` now asserts
 * this parity, so the next divergence fails at the contract instead of the build.
 */
export interface AiModelAsrProfileDecoding {
  beamSize?: number;
  temperature?: number;
  noSpeechThreshold?: number;
  compressionRatioThreshold?: number;
  entropyThreshold?: number;
  logprobThreshold?: number;
  conditionOnPrevTokens?: boolean;
  noRepeatNgramSize?: number;
  prevTextContextWords?: number;
  singleSegment?: boolean;
  suppressBlank?: boolean;
  suppressNonSpeechTokens?: boolean;
  maxTokens?: number;
  audioCtx?: number;
  hotwords?: string[];
  hotwordsInPrompt?: boolean;
  partial?: AiModelAsrProfileDecodingPass;
  final?: AiModelAsrProfileDecodingPass;
}

export interface AiModelAsrProfile {
  maxDecodeWindowSec?: number;
  partialWindowSec?: number;
  decoding?: AiModelAsrProfileDecoding;
  initialPrompt?: string;
}

interface AsrProfileRange {
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

/** Mirrors `AI_MODEL_ASR_PROFILE_WINDOW_RANGES` (`@arcaai/types`). */
export const AI_MODEL_ASR_PROFILE_WINDOW_RANGES: Readonly<Record<'maxDecodeWindowSec' | 'partialWindowSec', AsrProfileRange>> = {
  maxDecodeWindowSec: { min: 1, max: 30 },
  partialWindowSec: { min: 1, max: 30 },
};

/** Mirrors `AI_MODEL_ASR_PROFILE_DECODING_RANGES` (`@arcaai/types`). */
export const AI_MODEL_ASR_PROFILE_DECODING_RANGES: Readonly<
  Record<
    keyof Omit<
      AiModelAsrProfileDecoding,
      // Non-numeric members have no range: booleans and the two per-pass blocks.
      // The `Omit` is what keeps this table honest — a new NUMERIC field fails to
      // compile until it is given bounds, which is the intended pressure.
      | 'conditionOnPrevTokens'
      | 'hotwords'
      | 'hotwordsInPrompt'
      | 'singleSegment'
      | 'suppressBlank'
      | 'suppressNonSpeechTokens'
      | 'partial'
      | 'final'
    >,
    AsrProfileRange
  >
> = {
  beamSize: { min: 1, max: 10, integer: true },
  temperature: { min: 0, max: 1 },
  noSpeechThreshold: { min: 0, max: 1 },
  compressionRatioThreshold: { min: 1, max: 10 },
  logprobThreshold: { min: -10, max: 0 },
  noRepeatNgramSize: { min: 0, max: 10, integer: true },
  prevTextContextWords: { min: 0, max: 200, integer: true },
  // TASK-985 (QW-8/QW-9) — bounds copied from the canonical table, not invented.
  entropyThreshold: { min: 0, max: 10 },
  maxTokens: { min: 0, max: 224, integer: true },
  audioCtx: { min: 0, max: 1500, integer: true },
};

export const AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS = 64;
export const AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH = 1000;
/** MEASURED presence of a row's weights in `s3://hope-models` (TASK-860 R-2). */
export type AiModelAvailability = 'UNKNOWN' | 'AVAILABLE' | 'MISSING' | 'PARTIAL' | 'NOT_APPLICABLE';
export type AiDeploymentKind = 'SELF_HOSTED' | 'CLOUD';
/** The platform task taxonomy a row can be the platform default for. */
export type AiTaskKind =
  | 'TEXT_GENERATION'
  | 'TRANSLATION'
  | 'SPEECH_TO_TEXT'
  | 'TEXT_TO_SPEECH'
  | 'VISION_EXTRACTION'
  | 'EMBEDDING'
  | 'NAMED_ENTITY_RECOGNITION'
  | 'TEXT_CLASSIFICATION'
  | 'CONTENT_SAFETY'
  | 'GROUNDEDNESS'
  | 'PII_DETECTION';

/** GET /admin/ai-models rows (ModelResponse; ISO timestamps on the wire). */
export interface AiModel {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  category: ModelCategory;
  taskType: ModelTaskType;
  /** The Hugging Face `pipeline_tag` (kebab-case), derived from `taskType`. */
  pipelineTag: string;
  modelType: ModelType;
  source: AiModelSource;
  sourceUri: string;
  sourceRevision?: string | null;
  format: AiModelFormat;
  // ── Hugging Face taxonomy + serving identity (TASK-860) ──────────────────
  /** Serving library — the Hub `library_name` facet (`whisper.cpp`, `transformers`, `gliner2`, …). */
  libraryName: string;
  /** Workload that executes the model (`stt`, `nlp`, `tts`, `lmstudio`, `text`, …). */
  servedBy: string;
  deploymentKind: AiDeploymentKind;
  /** Vendor wire id for a CLOUD row. */
  wireModelId?: string | null;
  license?: string | null;
  gated: boolean;
  baseModel?: string | null;
  languages: string[];
  hfRevision?: string | null;
  // ── Bucket identity + measured availability ──────────────────────────────
  bucketPrefix?: string | null;
  primaryObject?: string | null;
  manifestDigest?: string | null;
  availability: AiModelAvailability;
  availabilityCheckedAt?: string | null;
  availabilityDetail?: unknown;
  isPlatformDefaultFor: AiTaskKind[];
  /** Canonical runtime provider id: ollama | lm-studio | azure | bedrock | built-in | sarvam | … */
  provider?: string | null;
  /** Model architecture family: gemma4, granite, whisper, ... */
  architecture?: string | null;
  memorySizeMb?: number | null;
  computeType?: string | null;
  /**
   * Parsed `AUTOMATIC_SPEECH_RECOGNITION` decode profile (`_metadata.asr`, TASK-934) — the
   * SAME validated shape the gateway resolver reads with, never the raw stored JSON. `null`
   * off an ASR row, or when the row carries none.
   */
  asrProfile?: AiModelAsrProfile | null;
  /**
   * DERIVED by the gateway from `bucketPrefix` (+ `primaryObject`); never typed
   * and never sent on a write.
   *
   * TASK-890 §3.11 — `downloadStatus`, `downloadedAt` and `fileSizeMb` are GONE
   * from the schema and from `ModelResponse`. They are not deprecated here, they
   * are absent: a reader would get `undefined` and quietly decide "not
   * downloading". The publish JOB's own status endpoint (`ModelDownloadState`
   * below) is the only remaining source for those facts, and `availability` is
   * the measured answer to "are the weights there".
   */
  localPath?: string | null;
  checksum?: string | null;
  resourceStatus: ResourceStatus;
  version: number;
  tags: string[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

/** GET /admin/ai-models/list envelope — CUSTOM (not the platform standard). */
export interface PaginatedModels {
  data: AiModel[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** The registry fields shared by create + update (TASK-860). `localPath` is NEVER sent — the gateway derives it. */
export interface ModelRegistryFields {
  libraryName: string;
  servedBy: string;
  deploymentKind: AiDeploymentKind;
  wireModelId?: string;
  license?: string;
  gated?: boolean;
  baseModel?: string;
  languages?: string[];
  hfRevision?: string;
  /** Register weights ALREADY in the bucket ("In bucket, not registered → Register"). */
  bucketPrefix?: string;
  primaryObject?: string;
}

export interface CreateModelRequest extends ModelRegistryFields {
  name: string;
  slug: string;
  description?: string;
  category: ModelCategory;
  taskType: ModelTaskType;
  modelType: ModelType;
  source: AiModelSource;
  sourceUri: string;
  sourceRevision?: string;
  format: AiModelFormat;
  provider?: string;
  architecture?: string;
  memorySizeMb?: number;
  computeType?: string;
  tags?: string[];
  isPlatformDefaultFor?: AiTaskKind[];
  /** ASR-only (`taskType: 'AUTOMATIC_SPEECH_RECOGNITION'`); a 400 on any other row. */
  asrProfile?: AiModelAsrProfile;
}

/** PATCH /admin/ai-models/:id body (expectedVersion added by the client). Empty strings clear the nullable fields. */
export interface UpdateModelRequest extends Partial<ModelRegistryFields> {
  name?: string;
  slug?: string;
  description?: string;
  category?: ModelCategory;
  taskType?: ModelTaskType;
  modelType?: ModelType;
  source?: AiModelSource;
  sourceUri?: string;
  sourceRevision?: string;
  format?: AiModelFormat;
  provider?: string;
  architecture?: string;
  memorySizeMb?: number;
  computeType?: string;
  tags?: string[];
  /** ASR-only; `null` clears the stored profile. Omit to leave it untouched. */
  asrProfile?: AiModelAsrProfile | null;
}

/** PATCH /admin/ai-models/:id/platform-default body. */
export interface SetPlatformDefaultRequest {
  tasks: AiTaskKind[];
}

// =============================================================================
// Inventory (POST admin/ai-models/inventory) — measured availability
// =============================================================================

export interface ModelInventoryRow {
  id: string;
  slug: string;
  availability: AiModelAvailability;
  detail: Record<string, unknown>;
}

/** A weight-bearing prefix in the bucket that no catalogue row references — manifest-bearing or a manifest-less admin upload (`layout: 'staged'`). */
export interface UnregisteredBucketPrefix {
  bucketPrefix: string;
  /** `staged` = an admin upload carrying weights but no `manifest.json` (TASK-960 Lane C). */
  layout: 'flat' | 'hf-cache' | 'staged';
  slug: string | null;
  version: string | null;
  objectCount: number;
  totalBytes: number | null;
}

export interface ModelInventoryReport {
  checkedAt: string;
  counts: { available: number; missing: number; partial: number; notApplicable: number };
  rows: ModelInventoryRow[];
  unregistered: UnregisteredBucketPrefix[];
}

// =============================================================================
// Download (POST/GET admin/ai-models/:id/download) — FROZEN contract
// =============================================================================

/** POST /admin/ai-models/:id/download — 202 body. 409 = a download is already in flight. */
export interface StartModelDownloadResponse {
  jobId: string;
  status: Extract<AiModelDownloadStatus, 'DOWNLOADING'>;
}

/** GET /admin/ai-models/:id/download — polled while `status` is `DOWNLOADING`. */
export interface ModelDownloadState {
  status: AiModelDownloadStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  fileSizeMb?: number | null;
  sha256?: string | null;
  localPath?: string | null;
  error?: string | null;
}

// =============================================================================
// Model-registry provider connection (read-only here — @arcaai/ai-providers owns writes)
// =============================================================================

/**
 * Minimal read of `GET admin/providers/model-registry/s3` (the SYSTEM row).
 * Mode U (`s3://` sourceUri) fails closed unless this connection is enabled
 * and keyed. `features/ai-providers` owns the editor (rule 13); this is the
 * same minimal-copy read-only shape `features/ai-platform`'s CatalogueTab uses
 * in reverse for `features/ai-models`.
 */
export interface ModelRegistryConnectionStatus {
  enabled: boolean;
  hasKey: boolean;
}

// =============================================================================
// Discovery (GET admin/ai-models/discovery)
// =============================================================================

/** How an entry relates to the two sides of the merge. */
export type DiscoveryEntryStatus = 'registered' | 'discovered' | 'registered-missing-on-server';
/** Engine-reported load state; `unknown` whenever the engine does not say. */
export type DiscoveryLoadState = 'loaded' | 'not-loaded' | 'unknown';
export type DiscoveryProbeStatus = 'ok' | 'timeout' | 'error' | 'skipped';

export interface DiscoveryEntry {
  /** Provider registry key, rendered verbatim (`lm-studio`, not `lmstudio`). */
  provider: string;
  modelName: string;
  status: DiscoveryEntryStatus;
  loadState: DiscoveryLoadState;
  registeredModel?: { id: string; slug: string; resourceStatus: string };
  engineMeta?: Record<string, unknown>;
}

export interface DiscoveryProbe {
  provider: string;
  probeStatus: DiscoveryProbeStatus;
  latencyMs?: number;
  error?: string;
}

export interface DiscoveryResponse {
  entries: DiscoveryEntry[];
  probes: DiscoveryProbe[];
  /** ISO timestamp the probe completed — feeds the staleness indicator. */
  probedAt: string;
}

// `POST admin/ai-models/discovery/register` is deprecated (TASK-860, 410 Gone):
// discovery is READ-ONLY; registration is `createModel` (optionally from an
// inventory-reported bucket prefix).
