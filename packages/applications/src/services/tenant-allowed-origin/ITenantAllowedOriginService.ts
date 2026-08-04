import { CreateTenantAllowedOriginRequest, TenantAllowedOriginResponse, UpdateTenantAllowedOriginRequest } from './dto';

/**
 * TASK-610 CORS control plane — admin CRUD over the `TenantAllowedOrigin`
 * registry (lane W2-B). Governance is global-admin-only (owner decision,
 * README §Owner decisions); this service does not itself enforce that
 * boundary — the admin controller (W3-D) does, per the
 * "global-admin-only action on a tenant-manageable resource" pattern in
 * `05-nestjs-api.md`.
 *
 * Every successful mutation (create / update / delete) MUST emit
 * `origin-registry.invalidate` on the shared `EventEmitter2` — the frozen
 * invalidation contract (README §4.1) that `OriginRegistryService` (W2-A)
 * listens on to rebuild its `Map<origin, ownerTenantId>` without a restart.
 */
export const ITenantAllowedOriginService = Symbol('ITenantAllowedOriginService');

export interface ITenantAllowedOriginService {
  /** All allowed-origin rows owned by the caller's tenant. */
  getAll(): Promise<TenantAllowedOriginResponse[]>;

  /** One row by id. Throws `NotFoundException` when missing or cross-tenant (no existence leak). */
  getById(id: string): Promise<TenantAllowedOriginResponse>;

  /**
   * Register a new origin. The raw `dto.origin` is run through
   * `normalizeOrigin()` first and the NORMALIZED form is what gets persisted
   * and checked for uniqueness — never the raw string.
   *
   * @throws ArgumentInvalidException — malformed/disallowed origin (from `normalizeOrigin`)
   * @throws ConflictException — the normalized origin is already registered (pre-check + DB race both covered)
   */
  create(dto: CreateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse>;

  /**
   * Compare-and-set update. `origin` is re-normalized when present in the DTO.
   *
   * @throws NotFoundException — missing or cross-tenant id
   * @throws ConflictException — the (re-)normalized origin collides with another row
   * @throws OptimisticConcurrencyException — `_version` drift; HTTP 412 at the controller
   */
  update(id: string, dto: UpdateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse>;

  /** Soft-delete. @throws NotFoundException — missing or cross-tenant id */
  deleteById(id: string): Promise<TenantAllowedOriginResponse>;
}
