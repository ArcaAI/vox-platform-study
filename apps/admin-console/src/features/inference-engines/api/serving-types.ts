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
 *
 * TASK-1005 §5.1 moved LOADING off this plane entirely — `POST .../load` no
 * longer accepts a profile — onto `admin/model-residency/load`
 * (`@/shared/residency`); the request/response/conflict shapes for that route
 * live there, not here. This file keeps only what `/runtime` (the read) and
 * `/unload` (unchanged) still own.
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
