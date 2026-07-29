import type { ResourceStatus } from '@/shared/api';

export type ModelCategory = 'MULTI_MODAL' | 'VISION' | 'NLP' | 'AUDIO' | 'TABULAR' | 'UNKNOWN';
export type ModelType = 'BASE_MODEL' | 'FINETUNED_MODEL' | 'QUANTIZED_MODEL' | 'UNKNOWN';
export type AiModelSource = 'HUGGINGFACE' | 'GITHUB' | 'MLFLOW' | 'LOCAL';
export type AiModelFormat = 'SAFETENSOR' | 'ONNX' | 'NEMO' | 'PYTORCH' | 'CTRANSLATE2' | 'FASTER_WHISPER' | 'MLX' | 'GGUF' | 'WHISPER_CPP';
export type AiModelDownloadStatus = 'NOT_DOWNLOADED' | 'DOWNLOADING' | 'DOWNLOADED' | 'DOWNLOAD_FAILED';
/** Large gateway enum (46 values) — keep open for forward compatibility. */
export type ModelTaskType = string;

/** GET /admin/ai-models rows (ModelResponse; ISO timestamps on the wire). */
export interface AiModel {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  category: ModelCategory;
  taskType: ModelTaskType;
  modelType: ModelType;
  source: AiModelSource;
  sourceUri: string;
  sourceRevision?: string | null;
  format: AiModelFormat;
  /** Canonical runtime provider id: ollama | lm-studio | azure | bedrock | built-in | sarvam. */
  provider?: string | null;
  /** Model architecture family: gemma4, granite, whisper, ... */
  architecture?: string | null;
  memorySizeMb?: number | null;
  computeType?: string | null;
  downloadStatus: AiModelDownloadStatus;
  localPath?: string | null;
  downloadedAt?: string | null;
  fileSizeMb?: number | null;
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

export interface CreateModelRequest {
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
}

/** PATCH /admin/ai-models/:id body (expectedVersion added by the client). */
export interface UpdateModelRequest {
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
}

// =============================================================================
// Discovery (GET admin/ai-models/discovery)
// =============================================================================

/** How an entry relates to the two sides of the merge (§3.1). */
export type DiscoveryEntryStatus = 'registered' | 'discovered' | 'registered-missing-on-server';
/** Engine-reported load state; `unknown` whenever the engine does not say. */
export type DiscoveryLoadState = 'loaded' | 'not-loaded' | 'unknown';
export type DiscoveryProbeStatus = 'ok' | 'timeout' | 'error' | 'skipped';

export interface DiscoveryEntry {
  /** SMR provider registry key, rendered verbatim (`lm-studio`, not `lmstudio`). */
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

/** POST admin/ai-models/discovery/register body. */
export interface RegisterDiscoveredModelRequest {
  provider: string;
  modelName: string;
  slug?: string;
  name?: string;
  description?: string;
}
