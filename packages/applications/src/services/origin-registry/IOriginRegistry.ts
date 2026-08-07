// Origin registry contract — frozen contract (TASK-610 §4.1, lane W0-A).
//
// SUPERSEDED §4B.4 (lane W6-B) — many-to-many origins ↔ tenants. `ownerOf`
// (single owner) is REMOVED. An origin no longer has an owner; it has a SET
// of tenants it may act on, because a single `origin` row can now be granted
// to more than one tenant (`@@unique([origin, tenantId])`, not a global
// unique on `origin` alone — see the ticket §4B.2).
//
// This file is a CONTRACT: the symbol token and interface. Lane W2-A
// (`origin-registry.service.ts`) implements `IOriginRegistry`; lane W3-A
// (`apps/api/src/cors.config.ts`) and lane W3-B (`OriginTenantBindingGuard`)
// are the consumers — see lane W6-D for their post-§4B.4 rewrite. This file
// is the reverse index the rest of the CORS/tenant-binding design (plan §3.0)
// is built on:
//
//   TenantAllowedOrigin rows  (now: (origin, tenantId) GRANTS, many-to-many)
//           │  (refreshed on app-settings:invalidate + 45s cron)
//           ▼
//   IOriginRegistry impl  →  Map<origin, Set<tenantId>> ∪ pattern grants
//           │                                │
//           │ pre-auth                       │ post-auth
//           ▼                                ▼
//   CORS callback + WS handshake      OriginTenantBindingGuard
//     allow ⟺ has(origin)               reject ⟺ !allows(origin, tenantId)
//     (browser-facing, advisory)        (the actual isolation control, FR-4)
//
// §4B.3 — resolution is now a UNION, and precedence disappears from the
// authorization path entirely:
//
//   tenantsFor(origin) = ⋃ { row.tenantId : row is exact-equal OR row is a
//                            pattern matching origin }
//
// Union is monotone — adding a grant can never remove access — so there is
// no tie-break to compute and no "exact beats pattern, longest suffix wins"
// rule left to apply here (that rule lived in the single-owner world; see
// `origin-registry.service.ts` for what became of `patternSpecificity`).

export const IOriginRegistry = Symbol('IOriginRegistry');

export interface IOriginRegistry {
  /**
   * Tenants this origin may act on. EMPTY = unregistered. Contains SYSTEM ⇒
   * every tenant (see `allows()`, which encapsulates that rule).
   *
   * §4B.3 union rule: the union of the exact-match row's granted tenants (if
   * any) and every PATTERN row's granted tenants whose pattern matches this
   * origin. There is no precedence and no tie-break — a more specific
   * pattern does NOT suppress a less specific one (including the `*`
   * allow-all pattern); every matching grant contributes its tenant(s).
   */
  tenantsFor(origin: string): ReadonlySet<string>;

  /**
   * CORS admission — is this origin registered to ANY tenant at all?
   * Equivalent to `tenantsFor(origin).size > 0`, exposed separately because
   * the CORS callback (pre-auth, browser-facing/advisory) only ever needs
   * this yes/no answer — it has no tenant to check against yet.
   */
  has(origin: string): boolean;

  /**
   * May `tenantId` be acted on from `origin`? This is the ONE place the
   * SYSTEM rule lives — `tenantsFor(origin).has(tenantId) ||
   * tenantsFor(origin).has(SYSTEM)`. Callers (the tenant-binding guard, the
   * WS handshake) MUST call this rather than re-deriving the SYSTEM
   * carve-out themselves: this ticket already paid for that lesson once — a
   * lane "fixed" an HTTP/WS disagreement by copying a rule into both sides,
   * and it had to be consolidated back into one place.
   */
  allows(origin: string, tenantId: string): boolean;

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

  /**
   * Count of DISTINCT registered origin/pattern strings — grants of the same
   * origin to multiple tenants collapse to one. This mirrors the field's
   * pre-§4B.4 meaning ("the total count of registered origins") and is what
   * `PlatformKnobsBinder` reads as a coarse "is anything registered at all"
   * signal; it is not a count of (origin, tenantId) grant rows.
   */
  size(): number;
}

/**
 * Installed by the API layer (`apps/api/src/modules/platform-knobs/platform-knobs.binder.ts`,
 * lane W3-A) so pre-bootstrap CORS code — which runs ahead of Nest DI and
 * ahead of `UnifiedAuthGuard` — can reach the registry without importing the
 * NestJS module graph. Returns `null` before the registry has loaded for the
 * first time (plan §3.4 bootstrap fallback, FR-6).
 *
 * §4B.4: narrowed to `'has' | 'allows'` (was `'has' | 'ownerOf'`) — `has` is
 * what `cors.config.ts` needs (CORS admission has no tenant to check yet);
 * `allows` is what the tenant-binding guard needs, and it is also the ONLY
 * correct way to consult the SYSTEM rule (see `IOriginRegistry.allows` doc).
 *
 * NOTE: the plan's §4.1 originally placed this type (and its setter) in
 * `apps/api/src/cors.config.ts`. It has been MOVED here (contracts commit) to
 * avoid a file-ownership collision with lane W3-A, which owns `cors.config.ts`
 * outright. The setter function itself (`setOriginRegistryResolver`) stays in
 * `cors.config.ts` — only the type moved.
 */
export type OriginIndexResolver = () => Pick<IOriginRegistry, 'has' | 'allows'> | null;
