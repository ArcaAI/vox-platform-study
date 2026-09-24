/**
 * TASK-1005 §5.4/§8.1 L-UI — wire types for the platform-admin model-residency
 * plane, `admin/model-residency/*`.
 *
 * Hand-declared mirrors of the gateway DTOs, reached through the BFF proxy
 * like every other read in this console (no server import across the BFF
 * boundary). Pinned against `tests/contracts/model-residency-admin.fixture.json`
 * — the controller lane (L-CTRL) builds the gateway routes against the SAME
 * fixture, so this file must track it rather than the other way around.
 *
 * The async-load request/response shapes, the LM Studio options type, the
 * house error-body decoder and the operation-poll types are declared ONCE in
 * `@/shared/residency` — `features/inference-engines`'s LM Studio drawer
 * starts a load through the SAME gateway endpoint (ticket §5.1) and features
 * never import each other (rule 07) — and re-exported here for this
 * feature's own call sites.
 */

export {
  asModelResidencyConflict,
  type LmStudioResidencyLoadOptions,
  type ModelResidencyConflict,
  type ModelResidencyErrorCode,
  type ModelResidencyOperation,
  type ModelResidencyOperationError,
  type ModelResidencyOperationStatus,
} from '@/shared/residency';
import type { LmStudioResidencyLoadOptions } from '@/shared/residency';

export type ModelResidencyMode = 'shadow' | 'enforce';

export type ModelResidencyDeviceKind = 'gpu' | 'cpu';

/** One GPU (or CPU budget, per D-10) the controller places models on. */
export interface ModelResidencyDevice {
  id: string;
  kind: ModelResidencyDeviceKind;
  name: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  utilisationPercent: number;
  headroomPercent: number;
}

export type ModelResidencyState = 'loading' | 'loaded' | 'unloading';

export type ModelResidencyClass = 'PINNED' | 'WARM' | 'ON_DEMAND';

/** Which tier decided the model's class — an explicit `ModelResidencyPolicy` row,
 *  the implicit "this backs the live consultation path" rule, or the service's
 *  own default when nothing else has an opinion (rule 00 §Configuration Principles). */
export type ModelResidencyClassSource = 'policy' | 'implicit-live-path' | 'default';

/** `bytesSource: 'measured'` is an NVML/allocator delta; anything else must say so
 *  rather than presenting an estimate as an observation (ticket §4 D-2). */
export type ModelResidencyBytesSource = 'measured' | 'estimated' | 'unknown';

/** One resident model instance — a row of `GET admin/model-residency`. */
export interface ModelResidencyModel {
  service: string;
  /** Pod / engine instance identifier — unique together with `service`. */
  instance: string;
  modelRef: string;
  aiModelId: string | null;
  aiModelName: string | null;
  device: string;
  state: ModelResidencyState;
  bytes: number | null;
  bytesSource: ModelResidencyBytesSource;
  inFlight: number;
  /** From Prometheus (`model_running_instances`); may be null while unresolved. */
  requestsPerMin: number | null;
  p50LatencyMs: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  loadSeconds: number | null;
  class: ModelResidencyClass;
  classSource: ModelResidencyClassSource;
  ttlSeconds: number | null;
  pinned: boolean;
  /** An operator-set pin (`PUT .../pins`), distinct from `pinned`, which also
   *  reflects the implicit live-path pin (D-4). */
  adminPinned: boolean;
  policyId: string | null;
  policyVersion: number | null;
}

export type ModelResidencyRecommendationAction = 'load' | 'unload' | 'pin' | 'unpin';

export type ModelResidencyRecommendationReason = 'idle_ttl_expired' | 'promotion_rate' | 'live_path_pin' | 'make_room' | 'admission_rejected';

/** A shadow-mode log entry — the policy engine's own "would do X" record (D-3). */
export interface ModelResidencyRecommendation {
  id: string;
  at: string;
  action: ModelResidencyRecommendationAction;
  service: string;
  modelRef: string;
  reason: ModelResidencyRecommendationReason;
  mode: ModelResidencyMode;
  applied: boolean;
}

export interface ModelResidencyFreshness {
  maxAgeSeconds: number;
  /** Services whose last agent report is older than `maxAgeSeconds` (§5.5 target: <= 15s). */
  staleServices: string[];
}

/** GET admin/model-residency */
export interface ModelResidencyResponse {
  mode: ModelResidencyMode;
  reportedAt: string;
  freshness: ModelResidencyFreshness;
  devices: ModelResidencyDevice[];
  models: ModelResidencyModel[];
  recommendations: ModelResidencyRecommendation[];
}

/** POST admin/model-residency/load */
export interface LoadModelRequest {
  service: string;
  modelRef: string;
  pin?: boolean;
  /** Sends the load past the admission/budget check. Requires `reason` (OD-3). Never set implicitly. */
  force?: boolean;
  reason?: string | null;
  /** "Apply & reload": unload the resident instance(s) of this `modelRef` first, then load. */
  replace?: boolean;
  options?: LmStudioResidencyLoadOptions;
}

export type ModelResidencyLoadOutcome = 'accepted' | 'already_loaded';

/** 202 (accepted, async — poll `operationId`) or 200 (already_loaded, synchronous). */
export interface LoadModelResponse {
  outcome: ModelResidencyLoadOutcome;
  operationId?: string;
  model: ModelResidencyModel;
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

/** PUT admin/model-residency/pins — the ONE endpoint behind both "Pin/Unpin" and "Set TTL". */
export interface SetPinRequest {
  service: string;
  modelRef: string;
  pinned: boolean;
  ttlSeconds?: number | null;
}

export interface SetPinResponse {
  model: ModelResidencyModel;
}

/** `ModelResidencyPolicy` row (`GET/POST/PATCH/DELETE admin/model-residency/policies`). */
export interface ModelResidencyPolicy {
  id: string;
  aiModelId: string;
  service: string;
  class: ModelResidencyClass;
  idleTtlSeconds: number | null;
  priority: number;
  maxInstances: number;
  preferredDevice: string | null;
  _version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface CreatePolicyRequest {
  aiModelId: string;
  service: string;
  class: ModelResidencyClass;
  idleTtlSeconds?: number | null;
  priority?: number;
  maxInstances?: number;
  preferredDevice?: string | null;
}

export type UpdatePolicyRequest = Partial<Omit<CreatePolicyRequest, 'aiModelId' | 'service'>>;
