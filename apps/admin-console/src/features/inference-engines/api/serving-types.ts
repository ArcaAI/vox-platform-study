/**
 * TASK-996 Phase 5 — wire types for the LM Studio serving-control plane.
 *
 * Hand-declared mirrors of the gateway DTOs under
 * `admin/inference-engines/lm-studio` (Phase 3), reached through the BFF proxy
 * like every other read on this screen. The BFF boundary means no server
 * import, so these shapes must track the controller's own DTOs.
 *
 * `AiModelServingProfile` and its option tables are the ONE exception: they come
 * straight from `@arcaai/types`, which is already a dependency of this app and
 * is the single declaration the gateway validator, the Phase 1 loader, the seed
 * and this console all read. Copying the strategy list or the `[min, max]`
 * bounds into the console would put a second, silently-drifting copy of a
 * validation table in front of an admin whose edit the gateway then rejects.
 */

import type { AiModelServingProfile } from '@arcaai/types';

/** One visible CUDA device, as `nvidia-smi` reports it. Memory in MiB, not bytes. */
export interface LmStudioDevice {
  index: number;
  name: string;
  totalMib: number;
  usedMib: number;
  freeMib: number;
}

/**
 * One loaded instance.
 *
 * `kvCacheEstimateBytes` is DERIVED by the gateway from `contextLength ×
 * parallel`; nothing measures it. Every surface that renders it must say so —
 * LM Studio gives every parallel slot the full context, so the number is a
 * model of residency rather than an observation of it.
 */
export interface LmStudioLoadedModel {
  identifier: string;
  modelKey: string;
  weightsBytes: number;
  status: 'IDLE' | 'ACTIVE';
  effective: AiModelServingProfile;
  kvCacheEstimateBytes: number;
}

/** GET admin/inference-engines/lm-studio/runtime */
export interface LmStudioRuntimeResponse {
  engine: { reachable: boolean; version?: string };
  devices: LmStudioDevice[];
  loaded: LmStudioLoadedModel[];
  /** The platform fallback for a model whose row declares nothing (rule 09 §Tenant-first resolution). */
  platformDefault: AiModelServingProfile;
}

/**
 * Which tier of the cascade supplied one applied value. An admin who cannot see
 * this cannot reason about the cascade at all: an identical number means three
 * different things depending on whether it came from the request, the model row
 * or the platform default, and only the last is shared with every other model.
 */
export type ServingValueSource = 'request' | 'model' | 'platform';

/** POST admin/inference-engines/lm-studio/models/:modelKey/load */
export interface LoadModelRequest {
  profile?: AiModelServingProfile;
  /** Sends the load past the platform VRAM precheck. Never set implicitly. */
  force?: boolean;
}

export interface LoadModelResponse {
  identifier: string;
  applied: AiModelServingProfile;
  sources: Record<string, ServingValueSource>;
  estimateBytes: number;
}

/**
 * POST admin/inference-engines/lm-studio/models/:identifier/unload
 *
 * `jitReloadPossible` is always `true` on this build and that is the point of
 * the field: JIT loading cannot be disabled (no CLI flag, no REST key, no
 * settings key — ticket §2.5), so an unload is ADVISORY. The next inference
 * request loads the model again.
 */
export interface UnloadModelResponse {
  unloaded: boolean;
  jitReloadPossible: true;
}

/** The typed 409 from the load precheck (D-6). */
export interface VramBudgetConflict {
  code: 'VRAM_BUDGET_EXCEEDED';
  estimateBytes: number;
  freeBytes: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The VRAM refusal carried by a rejected load, or null for any other failure.
 *
 * Reads `GatewayError.details` (the parsed error body) rather than the message:
 * the two numbers are the whole point of this refusal — "over budget" without
 * them tells the admin nothing about how much to give back — and a message
 * string cannot be rendered as data.
 */
export function asVramBudgetConflict(error: unknown): VramBudgetConflict | null {
  const details = (error as { details?: unknown } | null)?.details;
  if (details === null || typeof details !== 'object') return null;
  const body = details as Record<string, unknown>;
  if (body['code'] !== 'VRAM_BUDGET_EXCEEDED') return null;
  if (!isFiniteNumber(body['estimateBytes']) || !isFiniteNumber(body['freeBytes'])) return null;
  return { code: 'VRAM_BUDGET_EXCEEDED', estimateBytes: body['estimateBytes'], freeBytes: body['freeBytes'] };
}
