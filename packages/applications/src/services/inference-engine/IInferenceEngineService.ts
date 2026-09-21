import type { LmStudioRuntimeResponse, LoadLmStudioModelRequest, LoadLmStudioModelResponse, UnloadLmStudioModelResponse } from './dto';

export const IInferenceEngineService = Symbol('IInferenceEngineService');

/**
 * TASK-996 Phase 3 — the platform-admin control surface over the LM Studio
 * serving engine.
 *
 * SUPER_ADMIN ONLY, imperatively. The gate is row-INDEPENDENT — it answers the
 * same for every model key, existing or not — so it runs FIRST, which is the
 * promotion-route ordering in `05-nestjs-api.md` rather than the
 * existence-then-privilege ordering a split gate needs. It is a 403 privilege
 * boundary, NOT the 404-over-403 cross-tenant posture: an unknown model key is
 * still a 404.
 */
export interface IInferenceEngineService {
  /** Engine reachability, per-device VRAM, loaded instances, and the platform serving default. */
  runtime(): Promise<LmStudioRuntimeResponse>;

  /**
   * Resolve the serving profile for one model and load it.
   *
   * Runs the full gate chain — 403 / 404 / 400 on an incoherent resolved
   * profile / 409 on the live VRAM budget — and then refuses with 501
   * `ENGINE_LOAD_UNSUPPORTED`, because this engine build exposes no
   * gateway-reachable loader that can carry a profile. See
   * `LoadLmStudioModelResponse`.
   */
  load(modelKey: string, request: LoadLmStudioModelRequest): Promise<LoadLmStudioModelResponse>;

  /** Evict one loaded instance. ADVISORY — JIT reloads it on the next request. */
  unload(identifier: string): Promise<UnloadLmStudioModelResponse>;
}
