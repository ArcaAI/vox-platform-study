# HOPE — Technical Architecture Overview

| Field | Value |
|---|---|
| **Last Updated** | 2026-05-27 (TASK-306 W5.6 — DDD-layers follow-up close-out) |
| **Audience** | Architects, tech leads, compliance officers |
| **Scope** | Cross-service architectural concerns that span the monorepo |

This document is the canonical pointer for cross-cutting architectural
decisions. Codemaps (`docs/CODEMAPS/`) describe individual services and
packages; this document focuses on the architectural *seams* between
them — auth, multi-tenancy, observability, etc. — and records the
decisions behind each one.

---

## Document map

- [§ Multi-tenancy enforcement layers](#-multi-tenancy-enforcement-layers) — TASK-305 (2026-05-27), extended by TASK-306 (2026-05-27) + TASK-317 browser-SDK client layer (2026-05-30)
- Future chapters will be added as cross-cutting concerns are
  formalised (auth + RBAC, observability, eventing).

For service-by-service walkthroughs see
[`docs/CODEMAPS/INDEX.md`](./CODEMAPS/INDEX.md).
For the backend implementation conventions see
[`packages/database/README.md`](../packages/database/README.md) and
each service's own README.

---

## Multi-tenancy enforcement layers

> Companion to `packages/database/README.md` § "Tenant scoping & RLS
> posture" — the database README has the implementation-level detail
> (file paths, ESLint rules, allow-lists); this chapter is for an
> architecture audience and records the *why*.

### TL;DR

HOPE is a **pooled-model multi-tenant** SaaS — one PostgreSQL database
holds every tenant's rows, discriminated by a `tenantId` column on
every tenant-scoped table. Isolation is enforced by **three composed
layers** rather than a single point-of-trust:

```
                  ┌─────────────────────────────────────┐
   HTTP request ──▶ NestJS middleware: nestjs-cls       │
                  │   sets { tenantId, user.roles, … }  │
                  └─────────────────┬───────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
   Service /     │ Domain guards (Phase D)              │
   controller ──▶│   assertEqualTenants                 │
                  │   assertUserBelongsToTenant         │
                  │   assertParentInScope               │
                  └─────────────────┬───────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
   Repository ──▶ │ Prisma `$extends` (Phase B)         │
                  │   tenantScope: where merge / data   │
                  │   enforce; SUPER_ADMIN bypass when  │
                  │   no CLS context exists.            │
                  └─────────────────┬───────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
   PostgreSQL ──▶ │ Schema substrate (Phase A)          │
                  │   tenantId NOT NULL, scoped uniques,│
                  │   composite [tenantId,X] indexes,   │
                  │   reserved 'system' Tenant row.     │
                  │ + RLS (Phase C — DEFERRED)          │
                  └─────────────────────────────────────┘
```

A request only writes a row if **all three layers** agree on the
tenant. A regression in any one layer is caught by the next.

### Layer-by-layer

#### 1 — Schema substrate (Phase A, merged W2)

- `tenantId String` (NOT NULL) on 27 tenant-scoped models; the
  `'50000000-…'` sentinel default removed everywhere.
- Reserved `system` Tenant row (UUID `00000000-…`) absorbs former
  nullable rows — login audit, platform-wide events, system
  pipelines.
- Scoped uniques: `Webhook(tenantId, name)`,
  `Tag(tenantId, resourceTypeName, resourceId, tagKey)`.
- 14 composite `[tenantId, X]` indexes lead the query plans the
  RLS rollout will rely on (no seq-scan regressions when policies
  land).
- The reviewer-flagged FK transformation (`tenantId` →
  `Tenant.id` `@relation`) was **deliberately not pursued**
  — see Decision Log below.

#### 2 — Extension layer (Phase B, merged W2)

- `applyTenantScopeExtension(prisma, { getTenantId, isSuperAdmin })`
  in `packages/database/src/extensions/tenant-scope.ts`.
- Composed AFTER `applySoftDeleteExtension` in
  `createExtendedPrismaClient()` so the tenant filter runs first,
  then soft-delete runs against the tenant-filtered args.
- 27-model allow-list mirrors the schema (`TENANT_SCOPED_MODELS`
  Set); all 16 Prisma ops hooked
  (`find*`/`count`/`aggregate`/`groupBy`/`create*`/`update*`/
  `upsert`/`delete*`).
- Bidirectional mismatch detection: throws if the caller passed an
  explicit `tenantId` that disagrees with the CLS context — closes
  the "buggy code path tried to read tenant B from tenant A" case.
- NestJS wiring lives in `apps/api/src/database/
  tenant-context.provider.ts` (`ClsTenantContextProvider`) — a tiny
  framework-agnostic adapter that registers itself with the
  extension at bootstrap and reads from `nestjs-cls`.

#### 3 — Service / domain guards (Phase D, merged W1-W3; TASK-306 finale merged W5.1-W5.5)

The extension cannot reach cross-aggregate equality
(`parent.tenantId === child.tenantId`) or User-tenant membership
(does this `User` have an `ENABLED` `UserRoleAssignment` in the
target tenant?). Those checks live in
`packages/applications/src/common/tenant-guards.ts`:

| Helper | Used by |
|---|---|
| `assertEqualTenants(parent, child)` | `Department.create/update`, `ContextService` parent + array loaders, `SummaryService.regenerate*`, `ConsultationService.createRevisit` + (TASK-306 W5.2) `getById` / `getByIdWithRelations` / `getConsultationChain`, `DnaWritingStyleService.regenerate`, (TASK-306 W5.3) `WebhookService` 5-method sweep, (TASK-306 W5.3) `ResourceSubscriptionService` 5-method sweep |
| `assertUserBelongsToTenant(repo, userId, tenantId)` | `Consultation.createConsultation/createRevisit` (doctorId), `NotificationService.create` (targetUserId), `ApiKeyService.issue` (userId), `DnaWritingStyleService.start` (doctorId) |
| `assertParentInScope(repo, parentId, callerTenantId)` | The shared sugar — load parent + assert same tenant in one call |
| `isSuperAdmin()` / `buildTenantScope()` | `AuthorizationAuditService` (TASK-305 W1.4), (TASK-306 W5.1 + W5.3) `TenantService.fetchById` / `fetchByCodeName` / `fetchTenantConfigs` SUPER_ADMIN gate, `NotificationService` + `ApiKeyService` + `WebhookService` `fetchAllByTenantId` CLS comparison + SUPER_ADMIN bypass |
| `resolveEffectiveTenantId(request.tenantId)` | (TASK-305 W3.2) `NotificationService.create`, (TASK-306 W5.1.4) `WebhookService.create` — pins non-SUPER_ADMIN callers to CLS while preserving SUPER_ADMIN cross-tenant create flow (impersonation) |

Plus the BullMQ / event-handler CLS-rebind pattern (D.9): every
queue worker and `@OnEvent` handler wraps its body in
`cls.run(() => …)` populated from `job.data.tenantId` /
`payload.tenantId`, then `assertEqualTenants` against the loaded
entity. Fail-closed when the payload omits `tenantId` (BullMQ DLQ;
event handlers log + early return).

**TASK-306 finale (2026-05-27).** TASK-305 closed every cross-aggregate
WRITE path. TASK-306 closes the remaining READ-path gaps so the
service-layer explicit-assert is now uniform across PHI-bearing read
flows. Specifically:

- **`ConsultationService` reads** — `getById`, `getByIdWithRelations`,
  `getConsultationChain` each apply `assertEqualTenants` against the
  loaded entity (W5.2). Even though the Prisma extension already
  filters at the DB layer, the explicit service-layer assert
  guarantees a deterministic `NotFoundException` ("Resource not
  found") with no existence leak — and survives any future code path
  that bypasses the extension (raw query, platform-admin path, mocked
  CLS in tests, BullMQ poisoned payload).
- **`ContextService` array inputs** — `resolveLinkedConsultationIds`
  pre-filters chain + same-day id arrays to the CLS tenant (W5.4),
  closing the last C-3 surface. No SUPER_ADMIN bypass on this
  clinical-PHI hot read path.
- **`TenantService` SUPER_ADMIN gate** — `fetchById`, `fetchByCodeName`,
  `fetchTenantConfigs` now refuse non-SUPER_ADMIN cross-tenant reads
  (W5.1 + W5.3), closing the tenant-enumeration leak.
- **`AuthorizationAuditService.logToDatabase`** — `tenantId` is now
  derived from CLS, not from the caller-supplied `entry.tenantId`,
  with fail-closed semantics when CLS is missing (W5.1).
- **`WebhookService`, `ResourceSubscriptionService`** — full
  5-method DEF-C3 tenant-guard sweep (W5.3); previously tenant-blind
  on every surface.
- **`BaseService.broadcastSysEvent`** — merge order swapped so CLS
  wins on `tenantId` (W5.5.1), closing the last M-5 surface where a
  caller could override the audit-row tenant attribution.
- **`CoreUnitOfWorkService.startTransaction()`** — silent in-place
  fix of the broken self-resolved-tx pattern + canonical
  `runInTransaction(callback)` alternative (W5.5.2). Zero
  production-caller churn.
- **`DataNotFoundException` HTTP filter** — production responses are
  now `404 { message: "Resource not found" }` instead of the model
  name + id payload (W5.5.4); dev/staging retain the debug payload.

The explicit service-layer assert is now the canonical second line of
defense on every PHI-bearing read path. The DEF-C3 "no existence
leak" pattern is uniform; the audit's "single point of failure"
framing (`03-ddd-layers-review.md` §F) is closed. See
[`docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md`](./multi-tenancy-audit/07-ddd-layers-followup-closure.md)
for the canonical TASK-306 closure record.

#### 4 — Row-Level Security (Phase C, DEFERRED)

Plan §3.3 Phase C — `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
SECURITY` with per-op policies (`SELECT` / `INSERT WITH CHECK` /
`UPDATE USING+WITH CHECK` / `DELETE USING`) on the 7 PHI tables —
is drafted but blocked on **TASK-302** (PgBouncer + Vault dynamic
credentials, `hope_tenant_user NOSUPERUSER NOBYPASSRLS` role
split). When that lands, every `$transaction(callback)` will open
with `SELECT set_config('app.tenant_id', $1, true)` and the DB
itself becomes the last-line defence.

The application-layer guards above already provide the same
isolation invariant in production. RLS is defence-in-depth — it
backstops any future escape route (ad-hoc `psql`, BI dashboards,
raw `$queryRawUnsafe`, etc.).

#### 5 — Browser-side SDK isolation (client defense-in-depth, TASK-317)

The four layers above are **server-side** and remain authoritative.
The browser SDK `@arcaai/vox` (`packages/agentic-sdk-v2`) adds a
*client-side* tenant/user isolation layer so a shared workstation, a
fast tenant switch, or a concurrent multi-tenant operator console
cannot bleed PHI across tenants **in the browser** before a request
ever reaches the server:

- **Per-provider store** — each `<AgenticProvider>` owns its own
  Zustand store (`createAgenticStore()` + `AgenticStoreContext`); there
  is no module-level singleton shared across concurrent tenants.
- **Namespaced persistence** — IndexedDB personalization and
  `localStorage` selected-models/preferences are keyed
  `${tenantId}::${userId}` and re-keyed (with a one-time legacy-row
  drop) on auth/tenant switch; a tenant switch clears tenant-scoped
  PHI/session via `clearTenantSessionData()`.
- **Per-tenant cross-tab / WS keys** — BroadcastChannel
  `agentic.<tenantId>`, a per-tenant HKDF HMAC subkey, and
  `wsDedupKey(id, userId)` (fail-closed on user mismatch).

This closes the 2026-05-25 vox-SDK audit
([`05-vox-sdk-review.md`](./multi-tenancy-audit/05-vox-sdk-review.md)).
The **server boundary stays the source of truth** — the SDK layer is a
defense-in-depth complement, not a replacement. Canonical closure
record:
[`docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md`](./multi-tenancy-audit/09-vox-sdk-followup-closure.md).

### Decision log

| Decision | Choice | Rationale |
|---|---|---|
| **Tenancy model** | **Pooled-model** (one DB, `tenantId` discriminator) | Silo-model (one DB per tenant) was rejected — operational cost grows linearly with tenant count, schema migrations require fan-out, RLS gives us the same isolation guarantee at much lower ops cost. |
| **Context propagation** | **CLS (AsyncLocalStorage) via `nestjs-cls`** | Explicit `tenantId` parameter passing was rejected — every repository/service/controller would need a new arg, the diff would touch >300 call sites, and forgetting to thread it through is exactly the bug class the extension is supposed to backstop. CLS makes the tenant id an ambient request property that the extension reads from the lowest layer. |
| **`tenantId` → `Tenant.id` FK** | **Skipped** | Adding `@relation` from every tenant-scoped model to `Tenant` was the audit's bare-minimum recommendation but was rejected by the user during plan approval — it bloats every Prisma model with a relation field while the extension + RLS together cover the same isolation invariant. Tenant deletion is handled by an application-layer cascade (Phase C follow-up + tenant-CRUD service). |
| **Unscoped client export** | **`getPlatformAdminPrismaClient_Unscoped` + ESLint allow-list** | The unscoped client cannot be deleted — seed scripts, migrations, the tenant CRUD service, and platform-admin flows all need it. Renaming it from `getPrismaClient` to a self-documenting name + a custom ESLint rule (`no-restricted-imports`) + an 8-site allow-list means every escape is intentional and visible. |
| **SUPER_ADMIN bypass** | **Allowed only when no CLS context is set** | When CLS *is* active and the caller has `SUPER_ADMIN`, the extension *still* injects `tenantId` — bypass is opt-in via the unscoped client. A `SUPER_ADMIN` reading cross-tenant data must do it via the platform-admin route which is allow-listed. |

### Open items

1. **`User` / `UserMedia` as global entities** — these models do not
   carry `tenantId`. Today they extend `BaseTenantEntity` with a
   `tenantId: ''` placeholder. Plan §6.7 follow-up #1: introduce
   `BaseGlobalEntity` or extend `BaseAggregate` directly so the
   sentinel-by-empty-string pattern goes away. _TASK-306 status:
   deferred as F-1 (architectural — needs `BaseGlobalEntity` design)._
2. **`UnitOfWork.transactionClient` + `tenant.service.ts:534`** still
   go through the unscoped `baseClient`. Should switch to
   `databaseService.client.$transaction(callback)` — Prisma 7 carries
   `$extends` into the `tx` parameter. Plan §6.7 follow-up #4.
   _**CLOSED by TASK-306 W5.5.2 + W5.5.3** (`ec67a0d4`) — silent
   in-place fix of `CoreUnitOfWorkService.startTransaction()` +
   canonical `runInTransaction(callback)` alternative; callers swept
   onto the extended `$transaction(callback)` shape._
3. **`CoreDataModel` wildcard re-export** — `core.database.types.ts`
   re-exports the entire `@arcaai/database` surface (including the
   unscoped client) via `export * as CoreDataModel`. The ESLint rule's
   `importNames` doesn't follow wildcard re-exports; this is a latent
   footgun. Plan §6.7 follow-up #5. _TASK-306 status: deferred as F-8
   (zero current consumers verified)._
4. **`NotificationService` SUPER_ADMIN posture** — Notification
   allows SUPER_ADMIN cross-tenant access while the parallel DNA
   service refuses. Inconsistent and reviewer-flagged. Plan §6.7
   follow-up #7. _TASK-306 status: deferred as F-3 (product
   decision — tighten or audit-log)._
5. **`fetchAllByTenantId` pre-existing gaps** —
   `NotificationService.fetchAllByTenantId`,
   `ApiKeyService.fetchAllByTenantId`, `DnaWritingStyleService.listReports`
   accept arbitrary DTO `tenantId` without CLS comparison. Predates
   TASK-305 — separate ticket. Plan §6.7 follow-up #8.
   _**PARTIALLY CLOSED by TASK-306 W5.1.5** (`78e7b354`) —
   `NotificationService.fetchAllByTenantId` + `ApiKeyService.fetchAllByTenantId`
   now CLS-gate with SUPER_ADMIN bypass. `DnaWritingStyleService.listReports`
   deferred as F-2 / NEW-5 (product decision on whether `GLOBAL_ADMIN`
   is deliberately cross-tenant)._

### Related documents

- [`docs/multi-tenancy-audit/02-prisma-schema-review.md`](./multi-tenancy-audit/02-prisma-schema-review.md)
  — the audit that drove the TASK-305 plan.
- [`docs/multi-tenancy-audit/03-ddd-layers-review.md`](./multi-tenancy-audit/03-ddd-layers-review.md)
  — the DDD-layers audit that drove the TASK-306 plan (TASK-306 closure
  banner at top + per-finding `[CLOSED W5.x <sha>]` markers in §A/§B/§C/§D/§E).
- [`docs/multi-tenancy-audit/06-implementation-summary.md`](./multi-tenancy-audit/06-implementation-summary.md)
  — what TASK-305 closed vs. deferred vs. out-of-scope, plus §6 wave-by-wave
  summary of the TASK-306 follow-up.
- [`docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md`](./multi-tenancy-audit/07-ddd-layers-followup-closure.md)
  — canonical TASK-306 closure record (per-finding ledger, deferrals,
  wave sequence, lessons learned).
- [`docs/multi-tenancy-audit/05-vox-sdk-review.md`](./multi-tenancy-audit/05-vox-sdk-review.md)
  — the browser-SDK audit that drove the TASK-317 plan (TASK-317 closure
  banner at top + per-finding `[CLOSED W<n> <sha>]` markers on every
  §C/§D/§E heading).
- [`docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md`](./multi-tenancy-audit/09-vox-sdk-followup-closure.md)
  — canonical TASK-317 closure record for the browser-side SDK isolation
  layer (per-provider store, namespaced persistence, per-tenant
  cross-tab/WS keys; deferrals + lessons learned).
- [`docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`](./implementation/TASK-305-Multi-Tenancy-Hardening/README.md)
  — the implementation plan, §1.5 has the user-locked decisions and
  §3.3 has the (deferred) RLS rollout.
- [`docs/implementation/TASK-306-DDD-Layers-Followup/README.md`](./implementation/TASK-306-DDD-Layers-Followup/README.md)
  — TASK-306 implementation plan (waves W5.1-W5.6, AC-1..AC-15, deferred
  follow-ups F-1..F-8 + 306-F1..306-F14).
- [`packages/database/README.md`](../packages/database/README.md)
  § "Tenant scoping & RLS posture" — implementation-level detail
  (file paths, allow-list, SET LOCAL template).
- [`packages/applications/src/common/tenant-guards.ts`](../packages/applications/src/common/tenant-guards.ts)
  — the service-layer guard helpers (`assertEqualTenants`,
  `assertUserBelongsToTenant`, `assertParentInScope`,
  `resolveEffectiveTenantId`, `isSuperAdmin`).
- [`packages/database/src/extensions/tenant-scope.ts`](../packages/database/src/extensions/tenant-scope.ts)
  — the Prisma `$extends` extension.
- [`apps/api/src/database/tenant-context.provider.ts`](../apps/api/src/database/tenant-context.provider.ts)
  — the `nestjs-cls` ↔ extension adapter.
