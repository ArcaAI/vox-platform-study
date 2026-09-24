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
import type { LmStudioRuntimeResponse, UnloadModelResponse } from './serving-types';

/** Base path of the serving-control plane, relative to `/api/v1`. */
export const LM_STUDIO_SERVING_BASE = 'admin/inference-engines/lm-studio';

/** Loaded instances, live per-device VRAM and the platform default profile. */
export function getLmStudioRuntime(): Promise<LmStudioRuntimeResponse> {
  return getJson(`${LM_STUDIO_SERVING_BASE}/runtime`);
}

// Loading a model is NOT this route any more (TASK-1005 §5.1): the gateway
// removed `{profile}` support from `POST .../models/:key/load` (400) and the
// route stayed synchronous past Cloudflare's 100s edge timeout for a real
// LLM load. "Apply & reload" now posts to `admin/model-residency/load`
// (`useLoadLmStudioModelViaResidency`, `serving-hooks.ts`) — async, and this
// engine's own `/runtime` read (below) is still how the drawer sees the
// result once the operation settles.

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
