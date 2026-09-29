import type { ResolvedServingSpec } from '@arcaai/types';

/**
 * TASK-1021 (C-2) — resolves the engine-build contract `apps/vllm` reads for one model slug,
 * for one tenant. Backs `GET /internal/models/:slug/serving-spec`.
 */
export interface IModelServingSpecService {
  /**
   * The tenant's own row first, the SYSTEM row only when the tenant has none; never another
   * customer's. 404 `MODEL_NOT_FOUND` when neither is visible or the row is not served by
   * `vllm`; 409 `MODEL_NOT_SERVABLE` (with a `reason`) when the row cannot be served.
   */
  resolve(slug: string, tenantId: string): Promise<ResolvedServingSpec>;
}
export const IModelServingSpecService = Symbol('IModelServingSpecService');
