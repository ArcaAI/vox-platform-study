/**
 * TASK-996 Phase 5 — the ONE mutating surface in `/ai-services/*`.
 *
 * Owner decision D-1 reversed the read-only stance of these screens narrowly:
 * this module, and nothing else under `features/inference-engines`, calls a
 * route that changes what the engine is doing. Everything else here stays a
 * read (`client.ts`).
 *
 * These are gateway routes, not engine routes. The console never opens a socket
 * to LM Studio — the gateway owns the loader, the super-admin gate and the VRAM
 * precheck, exactly as it owns the discovery probe this feature already reads.
 */

import { getJson, postJson } from '@/shared/api';
import type { LmStudioRuntimeResponse, LoadModelRequest, LoadModelResponse, UnloadModelResponse } from './serving-types';

/** Base path of the serving-control plane, relative to `/api/v1`. */
export const LM_STUDIO_SERVING_BASE = 'admin/inference-engines/lm-studio';

/** Loaded instances, live per-device VRAM and the platform default profile. */
export function getLmStudioRuntime(): Promise<LmStudioRuntimeResponse> {
  return getJson(`${LM_STUDIO_SERVING_BASE}/runtime`);
}

/**
 * Load (or RELOAD) one model on an explicit profile.
 *
 * Addressed by `modelKey`, not by the running `identifier`: a model that is not
 * loaded has no identifier, and this is the route that brings it up.
 */
export function loadLmStudioModel(modelKey: string, body: LoadModelRequest): Promise<LoadModelResponse> {
  return postJson(`${LM_STUDIO_SERVING_BASE}/models/${encodeURIComponent(modelKey)}/load`, body);
}

/**
 * Unload one running instance, addressed by its `identifier`.
 *
 * Advisory by nature — see `UnloadModelResponse`. Callers must carry the JIT
 * caveat into the confirmation and into the success message; a console that
 * reports "unloaded" and stops there has told the operator something that will
 * stop being true at the next inference request.
 */
export function unloadLmStudioModel(identifier: string): Promise<UnloadModelResponse> {
  return postJson(`${LM_STUDIO_SERVING_BASE}/models/${encodeURIComponent(identifier)}/unload`);
}
