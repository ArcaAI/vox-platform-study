import { CreateTenantAllowedOriginRequest, TenantAllowedOriginResponse, UpdateTenantAllowedOriginRequest } from './dto';

/**
 * CORS control plane — admin CRUD over the `TenantAllowedOrigin` registry.
 *
 * ## Where the privilege boundaries live
 *
 * Originally this resource was governed entirely at the controller — a blanket
 * `assertGlobalAdmin()` on every handler — and this doc said so. **That is no
 * longer true.** A `TENANT_ADMIN` may self-serve the origins
 * its own application is served from, so the controller gate is relaxed to the
 * ordinary `manage:TenantAllowedOrigin` ability and the two boundaries that
 * survive it are enforced HERE, imperatively. The split, in full:
 *
 * | Enforced by | Boundary |
 * |---|---|
 * | Ability decorator (controller) | `manage:TenantAllowedOrigin` — who may reach these methods at all |
 * | CLS + Prisma tenant-scope extension | WHICH tenant a row belongs to. `tenantId` is read from CLS, NEVER from a DTO; neither request DTO declares the field and the global pipe runs `forbidNonWhitelisted`. A tenant admin cannot forge, read, or steal another tenant's grant |
 * | **This service — `403`** | **Wildcard gate.** Any `origin` containing `*` (a pattern OR the bare allow-all token) requires `GLOBAL_ADMIN`, on `create` **and** on `update`. The decorator expresses `action + subject` and cannot see the SHAPE of the value |
 * | **This service — `403`** | **SYSTEM gate.** A write whose resolved (CLS) tenant is SYSTEM requires `GLOBAL_ADMIN` regardless of role — a SYSTEM row is treated as valid for EVERY tenant by `OriginRegistryService.allows()` |
 * | This service — `404` | Cross-tenant id, via `findOwnedOrThrow`. Unchanged |
 *
 * Both service-side gates are the "global-admin-only action on a
 * tenant-manageable resource" pattern of `05-nestjs-api.md`, and both carry an
 * `// AUTH-NOTE:` marker at their implementation. They are **403s (privilege)**
 * — deliberately NOT the 404-over-403 cross-tenant posture, which continues to
 * apply, separately, to every by-id lookup.
 *
 * **`update` is the load-bearing case for the wildcard gate, not `create`.** A tenant admin
 * legitimately holding an exact row could otherwise PATCH its `origin` into
 * `https://*.evil.com:*`. Both methods funnel through one private
 * `normalizeIncomingOrigin()` seam, which is where the exact-vs-pattern branch
 * was already made — so the gate cannot be present on one path and missing on
 * the other.
 *
 * ## Invalidation contract (unchanged)
 *
 * Every successful mutation (create / update / delete) MUST emit
 * `origin-registry.invalidate` on the shared `EventEmitter2` — the frozen
 * invalidation contract that `OriginRegistryService`
 * (W2-A) listens on to rebuild its `Map<origin, ownerTenantId>` without a
 * restart. A REFUSED mutation must not emit it.
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
   * @throws ForbiddenException — the caller is not a `GLOBAL_ADMIN` and either
   *   the origin contains `*` or the resolved tenant is SYSTEM 
   * @throws ArgumentInvalidException — malformed/disallowed origin (from `normalizeOrigin`)
   * @throws ConflictException — the normalized origin is already registered (pre-check + DB race both covered)
   */
  create(dto: CreateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse>;

  /**
   * Compare-and-set update. `origin` is re-normalized when present in the DTO.
   *
   * @throws NotFoundException — missing or cross-tenant id (checked BEFORE the
   *   wildcard gate, so a cross-tenant id carrying a wildcard payload still 404s)
   * @throws ForbiddenException — a non-`GLOBAL_ADMIN` PATCHing `origin` to a
   *   value containing `*` (the escalation path), or any write whose
   *   resolved tenant is SYSTEM. Editing only `label`/`description` on an
   *   existing pattern row is ALLOWED: no origin change, no trust change.
   * @throws ConflictException — the (re-)normalized origin collides with another row
   * @throws OptimisticConcurrencyException — `_version` drift; HTTP 412 at the controller
   */
  update(id: string, dto: UpdateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse>;

  /**
   * Soft-delete.
   *
   * @throws NotFoundException — missing or cross-tenant id
   * @throws ForbiddenException — non-`GLOBAL_ADMIN` deleting a SYSTEM row 
   */
  deleteById(id: string): Promise<TenantAllowedOriginResponse>;
}
