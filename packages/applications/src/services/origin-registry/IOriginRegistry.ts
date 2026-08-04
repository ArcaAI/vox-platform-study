// Origin registry contract — frozen contract (TASK-610 §4.1, lane W0-A).
//
// This file is a CONTRACT STUB: the symbol token and interface only, no
// implementation. Lane W2-A (`origin-registry.service.ts`) implements
// `IOriginRegistry`; lane W3-A (`apps/api/src/cors.config.ts`) and lane W3-B
// (`OriginTenantBindingGuard`) are the consumers. This file is the reverse
// index the rest of the CORS/tenant-binding design (plan §3.0) is built on:
//
//   TenantAllowedOrigin rows
//           │  (refreshed on app-settings:invalidate + 45s cron)
//           ▼
//   IOriginRegistry impl  →  Map<origin, ownerTenantId>
//           │                                │
//           │ pre-auth                       │ post-auth
//           ▼                                ▼
//   CORS callback + WS handshake      OriginTenantBindingGuard
//     allow ⟺ index.has(origin)         reject ⟺ owner ∉ {SYSTEM, resolvedTenantId}
//     (browser-facing, advisory)        (the actual isolation control, FR-4)

export const IOriginRegistry = Symbol('IOriginRegistry');

export interface IOriginRegistry {
  /** Owner tenant id for a registered origin, else null. */
  ownerOf(origin: string): string | null;
  has(origin: string): boolean;
  /**
   * Rebuild the in-memory index from the database.
   *
   * MUST NOT be called inside a request CLS scope. It runs OUTSIDE a request
   * scope specifically so the tenant-scope Prisma extension passes through
   * and it legitimately sees every tenant's rows — the same mechanism
   * `AppSettingsService.refresh()` relies on
   * (`packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts:314`).
   * Called inside a request scope, the tenant-scope extension would inject
   * the CALLER's tenantId into the read and this would silently return only
   * that one tenant's rows — every other tenant's (and every SYSTEM) origin
   * would then be missing from the index until the next refresh.
   */
  refresh(): Promise<void>;
  size(): number;
}

/**
 * Installed by the API layer (`apps/api/src/modules/platform-knobs/platform-knobs.binder.ts`,
 * lane W3-A) so pre-bootstrap CORS code — which runs ahead of Nest DI and
 * ahead of `UnifiedAuthGuard` — can reach the registry without importing the
 * NestJS module graph. Returns `null` before the registry has loaded for the
 * first time (plan §3.4 bootstrap fallback, FR-6).
 *
 * NOTE: the plan's §4.1 originally placed this type (and its setter) in
 * `apps/api/src/cors.config.ts`. It has been MOVED here (contracts commit) to
 * avoid a file-ownership collision with lane W3-A, which owns `cors.config.ts`
 * outright. The setter function itself (`setOriginRegistryResolver`) stays in
 * `cors.config.ts` — only the type moved.
 */
export type OriginIndexResolver = () => Pick<IOriginRegistry, 'has' | 'ownerOf'> | null;
