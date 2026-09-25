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

export type ResidencyModelStatus = 'loaded' | 'loading' | 'unloading' | 'not_loaded';

/** `measured` is a live NVML/allocator or agent-reported figure; `catalogue` is the registry
 *  estimate; `unknown` means neither is available. Never present an estimate as an observation. */
export type ResidencySizeSource = 'measured' | 'catalogue' | 'unknown';

export type ResidencyUseRole = 'primary' | 'fallback' | 'routing';

export type ResidencyKeepPolicyKind = 'always' | 'warm' | 'on_demand';

/** Which tier decided the keep policy — an explicit `ModelResidencyPolicy` row, the implicit
 *  "this backs the live consultation path" rule, or the service default (rule 00 §Configuration Principles). */
export type ResidencyKeepPolicySource = 'policy' | 'implicit-live-path' | 'default';

export type ResidencyAction = 'load' | 'unload' | 'reload' | 'edit_policy';

export interface ResidencyFreshness {
  maxAgeSeconds: number;
  /** Services whose last agent report is older than `maxAgeSeconds`. */
  staleServices: string[];
}

/** One model's slice of a device (the GPU summary card's "models on this card" list). */
export interface ResidencyDeviceModelRef {
  service: string;
  modelRef: string;
  name: string;
  bytes: number | null;
}

/** One GPU (or CPU budget) the controller places models on. */
export interface ResidencyDevice {
  id: string;
  kind: ResidencyRunsOn;
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  utilisationPercent: number;
  headroomPercent: number;
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

export interface ResidencyUsage {
  agentCount: number;
  tenantCount: number;
  liveConsultation: boolean;
  uses: ResidencyUse[];
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
  slug: string | null;
  modelRef: string;
  format: string | null;
  status: ResidencyModelStatus;
  size: ResidencySize;
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
  id: string;
  at: string;
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

/** POST admin/model-residency/unload */
export interface UnloadModelRequest {
  service: string;
  modelRef: string;
  force?: boolean;
  reason?: string | null;
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
