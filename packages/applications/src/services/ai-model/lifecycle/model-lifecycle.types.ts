/**
 * One lifecycle status per registered model — the word the `/ai-models` grid
 * shows. First match wins, in this order (TASK-1019 D-9):
 *
 *   UNREGISTERING → DOWNLOADING → DOWNLOAD_FAILED → NOT_DOWNLOADED (availability ≠ AVAILABLE)
 *   → LOAD_FAILED → LOADING → SERVING (loaded on ≥ 1 observed service) → DOWNLOADED (idle, loadable)
 *   → NOT_OBSERVED (served by a service outside the residency ledger) → NOT_APPLICABLE (cloud rows)
 */
export const MODEL_LIFECYCLE_STATUSES = [
  'UNREGISTERING',
  'DOWNLOADING',
  'DOWNLOAD_FAILED',
  'NOT_DOWNLOADED',
  'LOAD_FAILED',
  'LOADING',
  'SERVING',
  'DOWNLOADED',
  'NOT_OBSERVED',
  'NOT_APPLICABLE',
] as const;
export type ModelLifecycleStatus = (typeof MODEL_LIFECYCLE_STATUSES)[number];

/** Residency states a service reports for one model (TASK-1005 + TASK-1019 `failed`). */
export type ModelServiceState = 'loaded' | 'loading' | 'unloading' | 'not_loaded' | 'failed';

export interface ModelServiceStatus {
  /** `stt` | `stt-worker` | `nlp` | `lm-studio` */
  service: string;
  state: ModelServiceState;
  device: string | null;
  bytes: number | null;
  inFlight: number | null;
  requestsPerMin: number | null;
  error: { code: string; message: string; at: string | null } | null;
}

export interface ModelLifecycle {
  status: ModelLifecycleStatus;
  services: ModelServiceStatus[];
  download: { bytesDone: number | null; bytesTotal: number | null; error: string | null } | null;
  unregister: { weights: string; error: string | null } | null;
  /** When the residency view this was derived from was observed (ISO), null when none. */
  observedAt: string | null;
}

/**
 * What kind of row still points at a model — the list `MODEL_IN_USE` carries and
 * `GET admin/ai-models/:id/usage` returns. Every kind is read across ALL tenants.
 *
 *  - `agent`              `Agent.modelId` (the version's primary model)
 *  - `agent-fallback`     `AgentModelFallback.modelId` (`id` is the AGENT's id)
 *  - `agent-asr-submodel` an ASR agent's VAD / denoise / embedding / punctuation / endpointing slug
 *  - `routing-policy`     `AiRoutingPolicy.modelId`
 *  - `residency-policy`   `ModelResidencyPolicy.aiModelId`
 *  - `voice-profile`      `UserVoiceProfile.modelId` (which holds the model SLUG)
 */
export const MODEL_REFERRER_KINDS = ['agent', 'agent-fallback', 'agent-asr-submodel', 'routing-policy', 'residency-policy', 'voice-profile'] as const;
export type ModelReferrerKind = (typeof MODEL_REFERRER_KINDS)[number];

export interface ModelReferrer {
  kind: ModelReferrerKind;
  tenantId: string;
  id: string;
  name: string;
}
