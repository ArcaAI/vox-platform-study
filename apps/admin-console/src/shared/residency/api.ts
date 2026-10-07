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
  'IN_FLIGHT' | 'LOAD_FAILED' | 'LOAD_IN_PROGRESS' | 'MODEL_UNKNOWN' | 'NO_SIZE' | 'OPTIONS_UNSUPPORTED' | 'OVER_BUDGET' | 'SERVICE_UNREACHABLE';

/** The gateway house error form: `ConflictException`'s object body — `{ code, message, ...details }`. */
export interface ModelResidencyConflict {
  code: ModelResidencyErrorCode;
  message: string;
  inFlight?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const RESIDENCY_ERROR_CODES: ReadonlySet<string> = new Set<ModelResidencyErrorCode>([
  'IN_FLIGHT',
  'LOAD_FAILED',
  'LOAD_IN_PROGRESS',
  'MODEL_UNKNOWN',
  'NO_SIZE',
  'OPTIONS_UNSUPPORTED',
  'OVER_BUDGET',
  'SERVICE_UNREACHABLE',
]);

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
  return { code: code as ModelResidencyErrorCode, message, inFlight };
}
