/**
 * TASK-1005 §13 L-RUI — wire types for the catalogue-first model-residency
 * screen.
 *
 * `ModelResidencyCatalogueResponse` mirrors
 * `tests/contracts/model-residency-catalogue.fixture.json`
 * (`GET admin/model-residency/catalogue`) — the gateway lane (L-RCAT) builds
 * that route against the SAME pinned fixture, so this file tracks it rather
 * than the other way around.
 *
 * Actions (load, unload, keep-policy create/update) still go through the
 * routes in `tests/contracts/model-residency-admin.fixture.json`. The
 * async-load request/response shapes, the LM Studio options type, the house
 * error-body decoder and the operation-poll types are declared ONCE in
 * `@/shared/residency` — `features/inference-engines`'s LM Studio drawer
 * starts a load through the SAME gateway endpoint — and consumed here
 * directly (features never import each other — rule 07).
 */

export type ModelResidencyMode = 'shadow' | 'enforce';

/** `AiModel.servedBy`, normalised. Fixed rendering order: stt, stt-worker, lm-studio, nlp. */
export type ResidencyServiceId = 'stt' | 'stt-worker' | 'lm-studio' | 'nlp';

export type ResidencyRunsOn = 'gpu' | 'cpu';

export type ResidencyModelStatus = 'loaded' | 'loading' | 'unloading' | 'not_loaded' | 'failed';

/** Why a load failed (TASK-1019) — present while `status` is `failed`. `at` is null when the source carries no time. */
export interface ResidencyLoadError {
  code: string;
  message: string;
  at: string | null;
}

/** `measured` is a live NVML/allocator or agent-reported figure; `catalogue` is the registry
 *  estimate; `unknown` means neither is available. Never present an estimate as an observation. */
export type ResidencySizeSource = 'measured' | 'catalogue' | 'unknown';

export type ResidencyUseRole = 'primary' | 'fallback' | 'routing' | 'pipeline_stage' | 'workflow_node';

/** TASK-1051 — `remote` (cloud API) and `builtin` (compiled into a library) hold no memory; render "Not applicable", never "failed". */
export type ResidencyModelKind = 'resident' | 'remote' | 'builtin';

/** TASK-1051 — a device's per-model bytes: `estimated` is the catalogue size or a split model's per-card share. */
export type ResidencyDeviceBytesSource = 'measured' | 'estimated' | 'unknown';

export type ResidencyKeepPolicyKind = 'always' | 'warm' | 'on_demand';

/** Which tier decided the keep policy — an explicit `ModelResidencyPolicy` row, the implicit
 *  "this backs the live consultation path" rule, or the service default (rule 00 §Configuration Principles). */
export type ResidencyKeepPolicySource = 'policy' | 'implicit-live-path' | 'default';

export type ResidencyAction = 'load' | 'unload' | 'reload' | 'edit_policy';

export interface ResidencyFreshness {
  /** Age of the OLDEST service report, measured from `oldestReportAt` (TASK-1051 — the agent's clock, not the fetch). */
  maxAgeSeconds: number;
  /** Services whose last agent report is older than `maxAgeSeconds`. */
  staleServices: string[];
  /** TASK-1051 — null when no service has reported yet. */
  oldestReportAt: string | null;
}

/** One model's slice of a device (the GPU summary card's "models on this card" list). */
export interface ResidencyDeviceModelRef {
  service: string;
  modelRef: string;
  name: string;
  bytes: number | null;
  bytesSource: ResidencyDeviceBytesSource;
}

/** One GPU (or CPU budget) the controller places models on. */
export interface ResidencyDevice {
  id: string;
  kind: ResidencyRunsOn;
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** TASK-1051 — null when DCGM reports nothing usable: render "n/a", never 0. */
  utilisationPercent: number | null;
  headroomPercent: number;
  /** TASK-1051 — `totalBytes × headroomPercent / 100`. */
  headroomBytes: number;
  /** TASK-1051 — `freeBytes < headroomBytes`. */
  overHeadroom: boolean;
  /** TASK-1051 — sum of `models[].bytes`. */
  attributedBytes: number;
  /** TASK-1051 — `usedBytes − attributedBytes` (CUDA contexts, other pods on the card). */
  unattributedBytes: number;
  models: ResidencyDeviceModelRef[];
}

export interface ResidencySize {
  bytes: number | null;
  source: ResidencySizeSource;
}

/** Live footprint of a LOADED model instance — null while `status !== 'loaded'`. */
export interface ResidencyLiveState {
  device: string;
  instance: string;
  bytes: number | null;
  bytesSource: ResidencySizeSource;
  inFlight: number;
  /** From Prometheus; may be null while unresolved. */
  requestsPerMin: number | null;
  p50LatencyMs: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  /** TASK-1055 — bytes per card as the service measured them (LM Studio splits a model). */
  deviceBytes?: Array<{ device: string; bytes: number }>;
  /** TASK-1055 — LM Studio only: the config the instance was actually loaded with. */
  loadConfig?: ResidencyLoadConfig | null;
}

/** TASK-1055 — LM Studio load config as reported by the engine (prefills Reload with options). */
export interface ResidencyLoadConfig {
  contextLength: number | null;
  parallel: number | null;
  flashAttention: boolean | null;
  kvCacheQuantK: string | null;
  kvCacheQuantV: string | null;
  /** `gpu<N>` when pinned to one card, `multi` when split. */
  device: string | null;
}

/**
 * One consumer of the model — an agent (primary/fallback) or an
 * `AiRoutingPolicy` candidate (role `routing`, e.g. guardrail/NLP/judge).
 * `agentSlug`/`agentName` are null for a routing-policy consumer: there is no
 * agent, only the policy's task — render the task and the role label
 * ("Routing policy"), never a blank or literal "null".
 */
export interface ResidencyUse {
  tenantId: string;
  tenantName: string;
  agentSlug: string | null;
  agentName: string | null;
  task: string;
  role: ResidencyUseRole;
  liveConsultation: boolean;
}

/** TASK-1051 — every kind of consumer, counted (the drawer's "why it is pinned" tiles). */
export interface ResidencyConsumerCounts {
  agents: number;
  fallbacks: number;
  routingPolicies: number;
  pipelineStages: number;
  workflowNodes: number;
}

export interface ResidencyUsage {
  agentCount: number;
  tenantCount: number;
  liveConsultation: boolean;
  uses: ResidencyUse[];
  consumers: ResidencyConsumerCounts;
}

/** TASK-1051 — a catalogue row an unmatched runtime instance could be. */
export interface ResidencyRuntimeKeyCandidate {
  aiModelId: string;
  name: string;
  slug: string;
  strength: 'strong' | 'weak';
  reason: string;
}

/** TASK-1051 — how the row is tied to what the service reports. */
export interface ResidencyIdentity {
  matched: boolean;
  runtimeKeys: string[];
  /** The key the service reported for the resident instance; null when not resident. */
  reportedKey: string | null;
  /** Only on an unmatched resident row, best first. */
  candidates: ResidencyRuntimeKeyCandidate[];
}

export interface ResidencyKeepPolicy {
  kind: ResidencyKeepPolicyKind;
  /** Plain-language label, e.g. "Always loaded" — render this, never `kind`. */
  label: string;
  reason: string;
  source: ResidencyKeepPolicySource;
  policyId: string | null;
  policyVersion: number | null;
  idleTtlSeconds: number | null;
}

/**
 * One row of a service section. A model that is RESIDENT but not in the
 * `AiModel` catalogue (started outside the platform's own bookkeeping, or a
 * stale pod) carries `aiModelId`/`slug`/`format: null` — it has no usage, no
 * keep policy to edit and no drawer to open; the row falls back to showing
 * `modelRef` as its name (see `service-section.tsx`).
 */
export interface ResidencyCatalogueModel {
  aiModelId: string | null;
  name: string;
  /** TASK-1051 */
  kind: ResidencyModelKind;
  slug: string | null;
  modelRef: string;
  format: string | null;
  status: ResidencyModelStatus;
  /** Set only while `status` is `failed`; absent from a gateway that predates TASK-1019. */
  error?: ResidencyLoadError | null;
  size: ResidencySize;
  /** TASK-1051 — what a load reserves (measured, else catalogue × 1.2); null = no size, a load needs force. */
  budgetBytes: number | null;
  /** TASK-1051 */
  identity: ResidencyIdentity;
  /** Estimated (or measured) seconds to load, when known. */
  loadSeconds: number | null;
  residency: ResidencyLiveState | null;
  usage: ResidencyUsage;
  keepPolicy: ResidencyKeepPolicy;
  /** What the UI may offer for this row right now (empty while loading/unloading). */
  actions: ResidencyAction[];
}

export interface ResidencyServiceGroup {
  service: string;
  /** Plain-language section title, e.g. "Speech-to-text — live sessions" — render this, never `service`. */
  label: string;
  runsOn: ResidencyRunsOn;
  /** False for a service with no control API (e.g. `stt-worker`, which only exposes Prometheus
   *  metrics) — its rows carry no `load`/`unload`/`reload` in `actions`; hide the action buttons
   *  rather than rendering ones that would 404. */
  controllable: boolean;
  /** Whether the LAST probe of this service succeeded — for `stt-worker` that means Prometheus
   *  answered, since it has no control API of its own to probe. */
  reachable: boolean;
  loadedCount: number;
  models: ResidencyCatalogueModel[];
}

/** A shadow-mode suggestion, already rewritten server-side as one plain sentence. */
export interface ResidencySuggestion {
  /** Stable for the standing recommendation — what dismiss takes. */
  id: string;
  /** Last confirmed. */
  at: string;
  /** TASK-1051 */
  firstSeenAt: string;
  /** TASK-1051 — ticks that re-confirmed it. */
  repeats: number;
  /** TASK-1051 — `idle_ttl_expired | promotion_rate | live_path_pin | make_room | admission_rejected`. */
  reason: string;
  text: string;
  action: string;
  service: string;
  modelRef: string;
  applied: boolean;
}

/** GET admin/model-residency/catalogue */
export interface ModelResidencyCatalogueResponse {
  mode: ModelResidencyMode;
  reportedAt: string;
  freshness: ResidencyFreshness;
  devices: ResidencyDevice[];
  services: ResidencyServiceGroup[];
  suggestions: ResidencySuggestion[];
}

/** TASK-1051 — POST admin/model-residency/load/preview (body = the load request): a dry run, changes nothing. */
export interface ResidencyPreviewModel {
  service: string;
  modelRef: string;
  name: string;
  bytes: number | null;
  reason: string;
}

export interface ModelResidencyLoadPreview {
  service: string;
  modelRef: string;
  device: string | null;
  needBytes: number | null;
  needSource: ResidencySizeSource;
  freeBytes: number | null;
  headroomBytes: number | null;
  unattributedBytes: number | null;
  shortfallBytes: number;
  fits: boolean;
  refusal: 'NO_SIZE' | 'OVER_BUDGET' | 'ALREADY_LOADED' | 'LOAD_IN_PROGRESS' | 'IN_FLIGHT' | null;
  /** ON_DEMAND resident models on the same device, largest first. */
  evictable: ResidencyPreviewModel[];
  /** Pinned resident models on the same device — shown, never offered. */
  pinned: ResidencyPreviewModel[];
  /** TASK-1055 — every device the model could go to, best first (empty for a single-device service). */
  candidates: ResidencyPlacementCandidate[];
  /** TASK-1055 — the most suitable device (fits with most room; else smallest shortfall). */
  suggestedDevice: string | null;
  suggestionReason: string | null;
}

/** TASK-1055 — one device judged with the same admission arithmetic as the chosen one. */
export interface ResidencyPlacementCandidate {
  device: string;
  label: string;
  totalBytes: number | null;
  freeBytes: number | null;
  headroomBytes: number | null;
  /** Free minus headroom minus the need; negative = short. */
  remainingBytes: number | null;
  shortfallBytes: number;
  fits: boolean;
  /** Need > free memory: refused even with force (OD-5). */
  exceedsDevice: boolean;
  livePathModels: number;
  evictable: ResidencyPreviewModel[];
}

/** TASK-1051 — POST admin/model-residency/links */
export interface LinkRuntimeKeyRequest {
  service: string;
  runtimeKey: string;
  aiModelId: string;
}

export interface LinkRuntimeKeyResponse {
  aiModelId: string;
  service: string;
  runtimeKeys: string[];
}

/** TASK-1051 — POST admin/model-residency/suggestions/:id/dismiss */
export interface DismissSuggestionResponse {
  id: string;
  dismissed: boolean;
}

/** PUT admin/model-residency/pins (TASK-1005; first console caller TASK-1051) */
export interface PinModelRequest {
  service: string;
  modelRef: string;
  pinned: boolean;
  ttlSeconds?: number | null;
}

/** TASK-1051 — GET admin/model-residency/readiness */
export type ReadinessCheckId =
  | 'shadow_review_recorded'
  | 'instances_matched'
  | 'gpus_inside_headroom'
  | 'shared_decision_state'
  | 'shadow_days'
  | 'usage_complete'
  | 'unmeasured_budgeted'
  | 'actions_audited';

export interface ModelResidencyReadiness {
  mode: ModelResidencyMode;
  passed: number;
  total: number;
  checks: Array<{ id: ReadinessCheckId; title: string; passed: boolean; detail: string }>;
  shadow: { since: string; loads: number; unloads: number; refusedOverBudget: number; duplicateLoads: number };
}

/** POST admin/model-residency/unload */
export interface UnloadModelRequest {
  service: string;
  modelRef: string;
  force?: boolean;
  /** TASK-1055 (OD-2) — required for a live-path model. */
  reason?: string | null;
  /** TASK-1055 — unload only the copy on this device. */
  device?: string | null;
}

export interface UnloadModelResponse {
  outcome: 'unloaded';
  service: string;
  modelRef: string;
}

/** Keep-policy write plane (`ModelResidencyPolicy` row). Scoped to what the drawer's plain-radio
 *  editor edits — class + idle TTL; priority/maxInstances/preferredDevice keep their server defaults. */
export type ResidencyPolicyClass = 'PINNED' | 'WARM' | 'ON_DEMAND';

export interface CreatePolicyRequest {
  aiModelId: string;
  service: string;
  class: ResidencyPolicyClass;
  idleTtlSeconds?: number | null;
}

export type UpdatePolicyRequest = Partial<Pick<CreatePolicyRequest, 'class' | 'idleTtlSeconds'>>;

/** `ModelResidencyPolicy` row (`POST/PATCH admin/model-residency/policies`). */
export interface ResidencyPolicy {
  id: string;
  aiModelId: string;
  service: string;
  class: ResidencyPolicyClass;
  idleTtlSeconds: number | null;
  priority: number;
  maxInstances: number;
  preferredDevice: string | null;
  _version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export {
  asModelResidencyConflict,
  type LmStudioResidencyLoadOptions,
  type LoadModelResidencyRequest,
  type LoadModelResidencyResponse,
  type ModelResidencyConflict,
  type ModelResidencyErrorCode,
  type ModelResidencyOperation,
  type ModelResidencyOperationError,
  type ModelResidencyOperationStatus,
} from '@/shared/residency';
