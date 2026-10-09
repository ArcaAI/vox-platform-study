/**
 * TASK-1005 §8.1 L-UI — the pieces of the `admin/model-residency/*` plane
 * TWO features need: `features/model-residency` (the console screen) and
 * `features/inference-engines` (the LM Studio "Apply & reload" flow, which
 * starts an async load through the SAME gateway endpoint — ticket §5.1).
 * Features never import each other (rule 07), so the shared surface — the
 * async-load request/response shapes, the house error-body decoder, and the
 * operation poll — lives here; `features/model-residency` owns and re-exports
 * the rest of the plane (the GET, unload, pins, policies).
 */

import { getJson, postJson } from '@/shared/api';

export type ModelResidencyOperationStatus = 'running' | 'succeeded' | 'failed';

export interface ModelResidencyOperationError {
  code: string;
  message: string;
}

export interface ModelResidencyOperation {
  id: string;
  action: 'load' | 'unload';
  service: string;
  modelRef: string;
  status: ModelResidencyOperationStatus;
  error: ModelResidencyOperationError | null;
  startedAt: string;
  finishedAt: string | null;
}

export function getModelResidencyOperation(operationId: string): Promise<ModelResidencyOperation> {
  return getJson(`admin/model-residency/operations/${encodeURIComponent(operationId)}`);
}

/** The five LM Studio REST v1 load keys the load route accepts for `service: 'lm-studio'`
 *  (400 `OPTIONS_UNSUPPORTED` for any other service — ticket §5.1/§10.1 D-5). */
export interface LmStudioResidencyLoadOptions {
  contextLength?: number;
  evalBatchSize?: number;
  flashAttention?: boolean;
  numExperts?: number;
  offloadKvCacheToGpu?: boolean;
}

export interface ModelResidencyModelSummary {
  service: string;
  instance: string;
  modelRef: string;
  state: 'loading' | 'loaded' | 'unloading';
  [key: string]: unknown;
}

export interface LoadModelResidencyRequest {
  service: string;
  modelRef: string;
  pin?: boolean;
  force?: boolean;
  reason?: string | null;
  /** "Apply & reload": unload the resident instance(s) of this `modelRef` first, then load. */
  replace?: boolean;
  options?: LmStudioResidencyLoadOptions;
  /** TASK-1055 — `gpu<N>`, `multi` (LM Studio split) or `cpu`; absent = the model's default placement. */
  device?: string | null;
  /** TASK-1055 (OD-4) — also make `device` this model's default placement. */
  makeDefault?: boolean;
}

export interface LoadModelResidencyResponse {
  outcome: 'accepted' | 'already_loaded';
  operationId?: string;
  model: ModelResidencyModelSummary;
}

/** Async — 202 with `operationId` on a real load, or 200 `already_loaded` (§10.1). */
export function loadModelResidency(body: LoadModelResidencyRequest): Promise<LoadModelResidencyResponse> {
  return postJson('admin/model-residency/load', body);
}

export type ModelResidencyErrorCode =
  | 'DEVICE_UNAVAILABLE'
  | 'EXCEEDS_DEVICE'
  | 'IN_FLIGHT'
  | 'LIVE_PATH_REASON_REQUIRED'
  | 'LOAD_FAILED'
  | 'LOAD_IN_PROGRESS'
  | 'MODEL_UNKNOWN'
  | 'NO_SIZE'
  | 'OPTIONS_UNSUPPORTED'
  | 'OVER_BUDGET'
  | 'SERVICE_UNREACHABLE';

/** The gateway house error form: `ConflictException`'s object body — `{ code, message, ...details }`. */
export interface ModelResidencyConflict {
  code: ModelResidencyErrorCode;
  message: string;
  inFlight?: number;
  /** TASK-1055 — OVER_BUDGET / EXCEEDS_DEVICE: the device asked for and the best one instead. */
  device?: string;
  suggestedDevice?: string | null;
  /** TASK-1055 — OVER_BUDGET: how far the chosen device is short. */
  shortfallBytes?: number;
  /** TASK-1055 — OVER_BUDGET / EXCEEDS_DEVICE: every device judged, best first (same shape as the preview's). */
  candidates?: ResidencyConflictCandidate[];
  /** TASK-1055 — LIVE_PATH_REASON_REQUIRED: who uses the model, in plain words. */
  consumers?: string[];
}

/** A resident model a refusal names as unloadable on a device (same shape as the preview's `evictable[]`). */
export interface ResidencyConflictEvictable {
  service: string;
  modelRef: string;
  name: string;
  bytes: number | null;
  reason: string;
}

/** TASK-1055 — one device judged by a refused load; structurally the preview's `ResidencyPlacementCandidate`. */
export interface ResidencyConflictCandidate {
  device: string;
  label: string;
  totalBytes: number | null;
  freeBytes: number | null;
  headroomBytes: number | null;
  remainingBytes: number | null;
  shortfallBytes: number;
  fits: boolean;
  exceedsDevice: boolean;
  livePathModels: number;
  evictable: ResidencyConflictEvictable[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const RESIDENCY_ERROR_CODES: ReadonlySet<string> = new Set<ModelResidencyErrorCode>([
  'DEVICE_UNAVAILABLE',
  'EXCEEDS_DEVICE',
  'IN_FLIGHT',
  'LIVE_PATH_REASON_REQUIRED',
  'LOAD_FAILED',
  'LOAD_IN_PROGRESS',
  'MODEL_UNKNOWN',
  'NO_SIZE',
  'OPTIONS_UNSUPPORTED',
  'OVER_BUDGET',
  'SERVICE_UNREACHABLE',
]);

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asEvictable(value: unknown): ResidencyConflictEvictable | null {
  if (!isRecord(value) || typeof value['service'] !== 'string' || typeof value['modelRef'] !== 'string') return null;
  return {
    service: value['service'],
    modelRef: value['modelRef'],
    name: typeof value['name'] === 'string' ? value['name'] : value['modelRef'],
    bytes: numberOrNull(value['bytes']),
    reason: typeof value['reason'] === 'string' ? value['reason'] : '',
  };
}

/** A candidate is kept only when it names a device and says whether it fits — anything else is dropped, never guessed. */
function asCandidate(value: unknown): ResidencyConflictCandidate | null {
  if (!isRecord(value) || typeof value['device'] !== 'string' || typeof value['fits'] !== 'boolean') return null;
  const evictable = Array.isArray(value['evictable'])
    ? value['evictable'].map(asEvictable).filter((e): e is ResidencyConflictEvictable => e !== null)
    : [];
  return {
    device: value['device'],
    label: typeof value['label'] === 'string' ? value['label'] : value['device'],
    totalBytes: numberOrNull(value['totalBytes']),
    freeBytes: numberOrNull(value['freeBytes']),
    headroomBytes: numberOrNull(value['headroomBytes']),
    remainingBytes: numberOrNull(value['remainingBytes']),
    shortfallBytes: numberOrNull(value['shortfallBytes']) ?? 0,
    fits: value['fits'],
    exceedsDevice: value['exceedsDevice'] === true,
    livePathModels: numberOrNull(value['livePathModels']) ?? 0,
    evictable,
  };
}

/**
 * The typed conflict carried by a refused load/unload, or null for any other
 * failure. Reads `GatewayError.details` (the parsed error body), never the
 * message string — `inFlight` is a NUMBER a confirmation renders, not prose.
 */
export function asModelResidencyConflict(error: unknown): ModelResidencyConflict | null {
  const details = (error as { details?: unknown } | null)?.details;
  if (!isRecord(details)) return null;
  const code = details['code'];
  if (typeof code !== 'string' || !RESIDENCY_ERROR_CODES.has(code)) return null;
  const message = typeof details['message'] === 'string' ? details['message'] : '';
  const inFlight = typeof details['inFlight'] === 'number' ? details['inFlight'] : undefined;
  const device = typeof details['device'] === 'string' ? details['device'] : undefined;
  const suggestedDevice =
    typeof details['suggestedDevice'] === 'string' || details['suggestedDevice'] === null ? (details['suggestedDevice'] as string | null) : undefined;
  const consumers = Array.isArray(details['consumers']) ? details['consumers'].filter((c): c is string => typeof c === 'string') : undefined;
  const shortfallBytes = numberOrNull(details['shortfallBytes']) ?? undefined;
  const candidates = Array.isArray(details['candidates'])
    ? details['candidates'].map(asCandidate).filter((c): c is ResidencyConflictCandidate => c !== null)
    : undefined;
  return {
    code: code as ModelResidencyErrorCode,
    message,
    inFlight,
    ...(device !== undefined ? { device } : {}),
    ...(suggestedDevice !== undefined ? { suggestedDevice } : {}),
    ...(shortfallBytes !== undefined ? { shortfallBytes } : {}),
    ...(candidates !== undefined ? { candidates } : {}),
    ...(consumers !== undefined ? { consumers } : {}),
  };
}

/**
 * The text a residency toast shows (TASK-1055 AC-6, R3-2): the server's own
 * message for a typed refusal, else the gateway's message, and the caller's
 * `fallback` whenever the failure carried no words — never a bare error code
 * (the code goes in the toast description, see `residencyErrorToast`).
 */
export function residencyErrorMessage(error: unknown, fallback: string): string {
  const conflict = asModelResidencyConflict(error);
  if (conflict) return conflict.message.trim() ? conflict.message : fallback;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/** The machine code a failure carries: a typed conflict's, or an operation error's own `code`. */
function residencyErrorCode(error: unknown): string | null {
  const conflict = asModelResidencyConflict(error);
  if (conflict) return conflict.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.trim() ? code : null;
}

export interface ResidencyErrorToast {
  title: string;
  description?: string;
}

/**
 * TASK-1055 R3-3 — one failure toast for every load / unload / reload / pin:
 * the title names the action and the model ("Couldn't unload Medical NER: nlp
 * agent did not answer"); the error code, and any `extra` context, go in the
 * description only. `what` is the action without a trailing full stop.
 */
export function residencyErrorToast(error: unknown, what: string, extra?: string): ResidencyErrorToast {
  const reason = residencyErrorMessage(error, '');
  const code = residencyErrorCode(error);
  const description = [extra, code ? `Error code: ${code}` : null].filter((part): part is string => !!part).join(' ');
  return { title: reason ? `${what}: ${reason}` : `${what}.`, ...(description ? { description } : {}) };
}
