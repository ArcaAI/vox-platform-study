# TASK-335 — Unified Working-Tenant Scope (Admin Console + Playgrounds)

| | |
|---|---|
| Ticket Number | TASK-335 |
| Short name | Unified-Working-Tenant-Scope |
| Created | 2026-06-05 |
| Updated | 2026-06-05 |
| Status | `Completed` — all 3 issues implemented UI-only via TDD; full ui-playground suite green (103 files / 927 tests), type-check + lint clean. |
| Type | refactor / UX + multi-tenancy (defect & limitation remediation) |
| Branch | `fix/2605-review` (current) |
| Builds on | TASK-331 (review umbrella → themes **T4** fragmented tenant-selection, **T2** GLOBAL_ADMIN, **T3** seed); TASK-327 (console shell, "scope-not-visibility"); TASK-305 (multi-tenancy, SYSTEM tenant); TASK-295 (impersonation) |

> **Origin.** Follow-up to the work shipped under [`docs/implementation/TASK-331-Admin-Console-Vox-Production-Review`](../TASK-331-Admin-Console-Vox-Production-Review/README.md). After the TASK-331 remediation landed, the user identified three remaining items. All `file:line` citations below were produced during this review; the ones marked **✓ verified** were hand-confirmed against source, the rest should be re-confirmed before the fix.

---

## 1. Requirement Analysis

Three issues, defects, and limitations to fix/improve in the admin console + SDK playgrounds (`apps/ui-playground`):

1. **Clarify System tenant vs Global tenant.** The two special tenants are easy to confuse; we need a precise, documented difference and a decision on how each should behave in the working-tenant picker.
2. **Remove the redundant in-page "Tenant(s)" column from the multi-column-layout pages.** A Global/Super admin already picks a *working tenant* from the header dropdown (`ScopeSwitcher`); the per-page tenant-selection column duplicates that and wastes horizontal space.
3. **Make the Playgrounds reflect the selected (working) tenant.** Selecting a tenant in the header dropdown does not coherently scope the clinical/AI playgrounds.

### Root-cause framing (single theme)

All three are facets of **TASK-331 theme T4 — "fragmented tenant-selection state"**: there is no single source of truth for "which tenant am I working in". Today the app has **three** competing tenant pickers plus an impersonation flow that silently overrides the selection. This ticket unifies them around the header `ScopeSwitcher` as the canonical *working tenant*.

| Persona | Today | Target |
|---|---|---|
| Super/Global admin | Header dropdown **+** per-page Tenants column **+** playground Overview `TenantSelector` card; impersonation overwrites the choice | **One** header dropdown is the working tenant; all admin pages + playgrounds read it; impersonation is layered *on top of* it, not a replacement |
| Tenant admin | Locked badge (correct) | Unchanged |

---

## 2. Issue 1 — System tenant vs Global tenant

### 2.1 Definitive difference

Both are seeded in `packages/database/src/prisma/db_main/seed/05-tenant.ts:6-19` (**✓ verified**). Neither has a schema discriminator — the `Tenant` model has **no** `type`/`kind`/`isSystem` column (`tenant.prisma:1-29`); identity is purely by `key` + well-known UUID.

| Dimension | **System** (`__SYSTEM__`) | **Global** (`__GLOBAL__`) |
|---|---|---|
| UUID | `00000000-0000-0000-0000-000000000000` (`00-constants.ts` `SYSTEM_TENANT_ID`) | `50000000-0000-0000-0000-000000000000` (`00-constants.ts` `SEED_TENANT_ID`, aliased `DEFAULT_TENANT_ID`) |
| Introduced | TASK-305 Phase A — to replace the old `tenantId IS NULL` sentinel | Pre-existing original seed tenant |
| Purpose | **Platform catalog owner — NOT customer data** | **Rich "default" customer tenant + master config template** |
| Owns | AI Models, ASR Pipelines, the system service account + `super_admin`, 1 *locked* platform flag `enable-local-raw-capture` | 20 clinicians, 18 departments, ~40 prompt templates, 9 consultations, DNA reports, voice profiles, per-tenant `GlobalSetting` defaults, rate-limit settings, demo audit logs |
| Cross-tenant reads | `AsrPipeline` + `AiModel` rows are shared **read-only** to every tenant via `SYSTEM_SHARED_READ_MODELS` (`tenant-scope.ts:124-147`) — reads widen to `tenantId IN [caller, SYSTEM]` | None — isolated to GLOBAL-scoped queries |
| Login | Not a login tenant; system-tenant users are **membership-exempt** (`91-user.ts` `isMembershipExempt`) | Clinical users + `tenant_admin` log in here |
| Write protection | Addressed only by seed/platform paths (no service guard) | `TenantService` throws `ForbiddenException` if a non-`SUPER_ADMIN` edits GLOBAL; GLOBAL's settings are the clone source for new-tenant provisioning |
| Provisioning role | None | Master template — `provisionTenantConfigs` clones GLOBAL's `GlobalSetting` rows into every new tenant |

**One-line summary:** **System = the platform's internal infrastructure namespace** (models/pipelines/system accounts), shared read-only. **Global = the seed's flagship customer tenant** and the defaults template that new tenants are cloned from.

### 2.2 The ambiguity to be aware of (no code change required, documentation only)

"Global" is overloaded across the codebase in **three** unrelated senses — flagging so we don't conflate them while fixing Issues 2 & 3:
- the `__GLOBAL__` **tenant** (a customer tenant);
- "**global scope**" = a `SUPER_ADMIN`/`GLOBAL_ADMIN` role that crosses *all* tenants (`auth-store.ts:151-155`, `isGlobalScope()`) — **not** about the GLOBAL tenant;
- the `GlobalSetting` **model**, which holds per-tenant settings for *every* tenant.
- Note also `AppSettingsService` inlines a const literally named `GLOBAL_TENANT_ID = '50000000-…'` (i.e. the GLOBAL tenant, not SYSTEM) as its "platform tenant" — purely a naming clash, behaviour is correct.

### 2.3 Actionable decision for this ticket

The System tenant is **not** a valid "working tenant" for managing customer data or driving the playgrounds. Today the header `ScopeSwitcher` only filters `resourceStatus !== 'DISABLED'` (`scope-switcher.tsx:92`, **✓ verified**), so **System (and possibly Global) appear as selectable working tenants** — selecting "System" yields confusing/empty admin pages and a meaningless playground scope.

→ **Proposed:** exclude the System tenant from the *working-tenant* picker(s), and surface Global with a clear label ("Global — system defaults"). See Issue-2 fix (the picker is the shared surface). *Decision needed — see §6 Q-A.*

---

## 3. Issue 2 — Redundant in-page "Tenants" column in the multi-column layout

### 3.1 Current state (✓ verified on `departments`, agent-cited for the rest)

The header **`ScopeSwitcher`** (`components/layout/scope-switcher.tsx`, **✓ verified**) is the canonical working-tenant picker: a searchable combobox for global scope, a locked badge for tenant admins. Selecting writes the store via `setTenant(id, name)` → `{ tenantId, tenantKey, tenantName }` (`auth-store.ts:109`, **✓ verified**), and `ScopeSyncInit` invalidates the React-Query cache on change (`providers/scope-sync.tsx:27-33`, **✓ verified**).

Despite that, each multi-column admin page **also renders its own leftmost "Tenants" column** (a second picker), shown only for global scope:

| Page | Tenants-column definition | Render gate |
|---|---|---|
| **Departments** ✓ verified | `tenantsColumn`/`tenantsState` `departments/index.tsx:879-913`; rendered `:1075-1078` | `isSuperAdmin() ? [tenantsColumn] : []` |
| Prompts | `prompts/index.tsx:1411-1413` | `isGlobalScope() && !scopedTenantId` |
| DNA Reports | `dna-reports/index.tsx:648-650` | always (uses `useTenantsInfinite`) |
| Storage | `storage/index.tsx:722-724` | `isSuperAdmin && !scopedTenantId` |
| Configurations | `configurations/index.tsx:466` | own tenant (TA) / all (SA) |

**Proof of redundancy (Departments, ✓ verified):** the page already derives its tenant from the store — `effectiveTenantId = tenantKey || selectedTenantId` (`departments/index.tsx:751`) — and a `useEffect` mirrors the header selection into local state (`:754-758`). The in-page `handleTenantSelect` (`:760-766`) just calls the same `setTenantKey`. So the two pickers are bidirectionally synced through the store; the in-page column adds **no capability** the header dropdown lacks — it only duplicates UI and consumes ~180px (`width: '180px'`, `:883`).

> The genuine flat per-row **Tenant column** in **Audit Logs** (`audit-logs/index.tsx:333-356`) is a different, *correct* case: it's a cross-tenant log view gated by `showTenant = isGlobalScope()` (already conditional). **Out of scope** — leave as-is.

### 3.2 Proposed solution

Remove the in-page Tenants column from the five multi-column pages; rely on the header `ScopeSwitcher` as the sole working-tenant selector. Concretely, per page:
- Drop `tenantsColumn`/`tenantsState` from the `columns`/`columnStates` arrays (and the now-unused local tenant fetch/`selectedTenantId`/`handleTenantSelect` that *only* fed that column — surgical, per Karpathy §3).
- Continue reading the effective tenant from the store (`tenantId`/`tenantKey`).
- Keep the existing **empty/disabled state** when no tenant is selected ("Select a tenant from the header to continue") so the page is coherent before a pick.
- Reclaim the freed width for the remaining content columns.

This directly implements TASK-331's deferred quick-win for T4 (unify `tenantKey`/`tenantId`/`selectedTenantId`).

---

## 4. Issue 3 — Playgrounds do not reflect the selected tenant

### 4.1 Current state

The working tenant **is** wired into the SDK: `SDKProvider` feeds `tenantId` from the store into `AgenticConfig.api.tenantId` (`providers/sdk-provider.tsx:33,39`, **✓ verified**), and `AgenticProvider` re-applies it on change. So API calls from the playgrounds *do* carry the selected tenant. The breakdown is elsewhere — **three** gaps:

**Gap A — A second, competing tenant picker lives inside the playground Overview.**
`features/playground/overview/components/tenant-selector.tsx` (**✓ verified**) renders its own "Tenant Context" card for super-admins, backed by the **SDK** `useTenants()` (not the admin API the header uses) and writing the same `setTenant`. Two pickers for one concept = the T4 fragmentation, user-visible. Its comment even notes the SDK list "may fail without tenant context… expected for super_admin" (`:24`), so it can render empty while the header dropdown works.

**Gap B — Clinical/AI playgrounds are gated behind impersonation regardless of the selected tenant.**
`useDoctorContext()` computes `requiresImpersonation = isAdmin && !isDoctor && !isImpersonating` (`features/summarization/hooks/use-doctor-context.ts:33`, **✓ verified**). Consultation, Audio, Voice, DNA, Pre-Summary, and Summary all render an `ImpersonationGuard` for an admin who hasn't impersonated. **Picking a working tenant does not clear this** — so "select tenant → open playground" shows the guard, not that tenant's data. The guard/user-picker is also not anchored to the selected working tenant.

**Gap C — Starting impersonation silently overwrites the selected working tenant.**
`startImpersonation(user, token, tenantId)` sets `tenantId` to the impersonated user's tenant when provided (`auth-store.ts:113-120`, **✓ verified**), saving the prior value in `originalTenantId` (restored on `endImpersonation`, `:122-129`). So the header dropdown choice is replaced by the impersonated doctor's tenant — fine when they match, surprising when they don't, and there's no guard that the impersonated user even belongs to the selected working tenant.

> Backend note (agent-cited, **re-confirm**): for a super-admin with an empty JWT tenant, `ContextInterceptor` "elevates" CLS tenant from the `X-Tenant-Id` header (`apps/api/src/interceptors/context.interceptor.ts:64-103`), which is why the admin pages already scope correctly. Tenant-bound callers (TENANT_ADMIN/DOCTOR) get a `400` on a divergent header by design (TASK-295 SEC-J) — so cross-tenant for them is **out of scope** here.

### 4.2 Proposed solution (frontend-only; pending the product decision in §6 Q-B)

1. **Single source of truth.** Remove the Overview `TenantSelector` card (Gap A); the header `ScopeSwitcher` is the only working-tenant control. Overview keeps a read-only badge of the active tenant.
2. **Anchor impersonation to the working tenant** (Gap B/C): the Overview impersonation user-list filters to users **within the selected working tenant**; block impersonation until a tenant is picked (the gate already exists — `user-list.tsx` "Select a tenant first"); and on `startImpersonation`, do **not** clobber the working tenant — assert the impersonated user's tenant **equals** the selected one (warn/deny on mismatch) instead of silently overwriting.
3. **Make the guard tenant-aware** (Gap B): `ImpersonationGuard` copy names the selected working tenant ("Impersonate a clinician in *{tenantName}* to use this playground").

---

## 5. Implementation Plan (TDD — RED → GREEN → REFACTOR)

> **Gate:** user approves this plan before any code is written (workflow Phase 3). Layer chain is **UI-only** for Issues 2 & 3; Issue 1 is **docs + a small picker filter**. No DB/domain/service/API change anticipated (the backend already supports super-admin tenant elevation).

### Wave 1 — Issue 2: remove redundant in-page Tenants column
- **Tests (RED):** for each page's test (`departments`, `prompts`, `dna-reports`, `storage`, `configurations` `__tests__`), assert the layout renders **without** a "Tenants" column and that the page scopes to the header-store tenant; assert empty-state when `tenantId === ''`.
- **GREEN:** drop `tenantsColumn`/`tenantsState` from the layout arrays; remove the now-orphaned local tenant fetch + `selectedTenantId` + `handleTenantSelect` where they only fed that column.
- **REFACTOR:** factor the shared "no working tenant selected" empty state if duplicated.
- **Verify:** `pnpm --filter @arcaai/ui-playground test` + `type-check`.

### Wave 2 — Issue 3: unify playground tenant + impersonation
- **Tests (RED):** Overview no longer renders the standalone `TenantSelector`; impersonation user-list is filtered to the working tenant; `startImpersonation` with a mismatched tenant is rejected/warned and does **not** overwrite `tenantId`; `ImpersonationGuard` shows the working tenant name.
- **GREEN:** delete/retire `tenant-selector.tsx` usage in `overview/index.tsx`; thread `tenantId`/`tenantName` into the user-list query + guard; adjust `startImpersonation` semantics (or its caller) per Q-B.
- **Verify:** `pnpm --filter @arcaai/ui-playground test`; manual: pick tenant → Overview reflects it → impersonate an in-tenant doctor → playgrounds operate as that tenant.

### Wave 3 — Issue 1: picker hygiene + canonical doc
- **Tests (RED):** `scope-switcher.test.tsx` asserts the System tenant (`key === '__SYSTEM__'`) is excluded from the working-tenant list; Global shown with its label.
- **GREEN:** filter `__SYSTEM__` out of the `ScopeSwitcher` (and the soon-removed in-page pickers are already gone).
- **Docs:** keep §2 of this README as the canonical System-vs-Global reference; optionally link from `00-project-context`.
- **Verify:** `pnpm --filter @arcaai/ui-playground test`.

---

## 6. Decisions (approved 2026-06-05)

- **Q-A (Issue 1 / picker):** ✅ **Exclude System; keep Global selectable.** The `__SYSTEM__` tenant is filtered out of the working-tenant picker; Global stays selectable.
- **Q-B (Issue 3 model):** ✅ **Always via impersonation.** No new non-impersonated admin path; we make the existing impersonation flow tenant-coherent (no overwrite of the working tenant, filter the impersonation list to in-tenant clinicians, tenant-aware guard copy).
- **Q-C (Issue 2 scope):** ✅ **All five pages** (Departments, Prompts, DNA Reports, Storage, Configurations).
- **Q-D (ticket):** ✅ **TASK-335 / Unified-Working-Tenant-Scope** confirmed.

---

## 7. Affected files (anticipated — no changes made yet)

- `apps/ui-playground/src/components/layout/scope-switcher.tsx` — filter System; (Issue 1/2)
- `apps/ui-playground/src/features/admin/{departments,prompts,dna-reports,storage,configurations}/index.tsx` — drop Tenants column (Issue 2)
- `apps/ui-playground/src/features/playground/overview/index.tsx` + `components/tenant-selector.tsx` (retire) + `components/user-list.tsx` (tenant-filtered) (Issue 3)
- `apps/ui-playground/src/store/auth-store.ts` — `startImpersonation` tenant semantics (Issue 3, pending Q-B)
- `apps/ui-playground/src/components/impersonation-guard.tsx` — tenant-aware copy (Issue 3)
- `apps/ui-playground/src/features/summarization/hooks/use-doctor-context.ts` — if Q-B adds a non-impersonated admin path
- Each page's `__tests__/` — RED tests first

---

## 8. Implementation Summary

All three issues were implemented **UI-only** (no DB/domain/service/API change), via TDD. Final verification on `apps/ui-playground`: **vitest 103 files / 927 tests passed**, `tsc --noEmit` clean, eslint clean on all touched files.

### Issue 1 — System vs Global (picker hygiene + canonical doc)
- **Doc:** §2 of this README is the canonical System-vs-Global reference (one-liner: **System = platform infrastructure namespace, shared read-only; Global = the flagship seed customer tenant + the defaults template new tenants are cloned from**).
- **Code:** `ScopeSwitcher` now filters the `__SYSTEM__` tenant out of the working-tenant list (`scope-switcher.tsx:91-104`) — `__GLOBAL__` stays selectable. Selecting "System" used to yield empty/confusing admin pages and a meaningless playground scope.
- **Test:** `scope-switcher.test.tsx` seeds a `__SYSTEM__` tenant and asserts it is **not** rendered while customer tenants remain.

### Issue 2 — Remove redundant in-page "Tenants" column (all 5 pages)
- Dropped the leftmost Tenants column (and its now-orphaned local state — `selectedTenantId`/`handleTenantSelect`/`useTenantsInfinite`/tenant search) from **Departments, Prompts, DNA Reports, Storage, Configurations**. Each page now reads the effective tenant solely from the header store (`tenantId`/`tenantKey`) and shows an empty-state pointing at the **header switcher** when none is selected.
- Tests for each page updated to assert the column is gone and the page scopes to the header tenant. The genuine per-row Tenant column in **Audit Logs** was left as-is (correct cross-tenant log view) — out of scope as planned.

### Issue 3 — Playgrounds reflect the selected tenant
- **Gap A (competing picker) — fixed:** deleted the dead `features/playground/overview/components/tenant-selector.tsx` ("Tenant Context" card). It was never rendered by `overview/index.tsx`; the header `ScopeSwitcher` is now the single working-tenant control. Overview keeps its read-only active-tenant badge. Guarded by a source-graph regression test (`overview-tenant-selector-removal.test.ts`).
- **Gap B (guard not tenant-aware) — fixed:** added a shared `WorkingTenantNotice` (`components/working-tenant-notice.tsx`) rendered inside **both** `ImpersonationGuard`s (`components/impersonation-guard.tsx` + `features/summarization/components/impersonation-guard.tsx`). It names the header-selected working tenant ("Working tenant: **{name}**. Impersonate a clinician in this tenant to continue."), and degrades gracefully: a global-scope admin with no tenant is pointed at the header switcher; a tenant-locked admin gets a neutral prompt. Covered by `working-tenant-notice.test.tsx` (all branches).
- **Gap C (impersonation overwrites working tenant) — already coherent; no change (deviation from plan §4.2 item 2):** the live `user-list.tsx` already (a) blocks impersonation until a working tenant is picked, pointing at the header switcher (`:51-54`, `:197-200`), and (b) forwards the active tenant as `targetTenantId` to `impersonate()` (`:210-211`). Because the user list is itself fetched through the SDK apiClient (which carries `X-Tenant-Id` = working tenant), only in-tenant clinicians are listable, so the server-returned `result.user.tenantId` equals the working tenant by construction. Adding a mismatch assertion to `startImpersonation` (as the plan floated) would be speculative defensive code (Karpathy §2) with no reachable trigger, so it was intentionally **not** added.

### Files changed
| File | Change |
|---|---|
| `apps/ui-playground/src/components/layout/scope-switcher.tsx` | Filter `__SYSTEM__` out of the working-tenant list (Issue 1) |
| `apps/ui-playground/src/components/layout/__tests__/scope-switcher.test.tsx` | RED→GREEN test: `__SYSTEM__` excluded |
| `apps/ui-playground/src/features/admin/departments/index.tsx` | Remove Tenants column + orphaned tenant state (Issue 2) |
| `apps/ui-playground/src/features/admin/prompts/index.tsx` (+ tests) | Remove Tenants column + orphaned state; tests updated |
| `apps/ui-playground/src/features/admin/dna-reports/index.tsx` | Remove Tenants column + orphaned state |
| `apps/ui-playground/src/features/admin/storage/index.tsx` (+ test) | Remove Tenants column + orphaned state; test updated |
| `apps/ui-playground/src/features/admin/configurations/index.tsx` (+ tests) | Remove Tenants column + orphaned state; tests updated |
| `apps/ui-playground/src/components/working-tenant-notice.tsx` | **New** — shared tenant-aware notice (Issue 3 Gap B) |
| `apps/ui-playground/src/components/__tests__/working-tenant-notice.test.tsx` | **New** — branch coverage for the notice |
| `apps/ui-playground/src/components/impersonation-guard.tsx` | Render `WorkingTenantNotice` |
| `apps/ui-playground/src/features/summarization/components/impersonation-guard.tsx` | Render `WorkingTenantNotice` |
| `apps/ui-playground/src/features/playground/overview/components/tenant-selector.tsx` | **Deleted** — dead competing picker (Issue 3 Gap A) |
| `apps/ui-playground/src/features/playground/overview/__tests__/overview-tenant-selector-removal.test.ts` | Rewritten from tautology → real source-graph guard |

### Deviations from plan
1. **Gap C** — no `startImpersonation` change (justified above).
2. The pre-existing `overview-tenant-selector-removal.test.ts` and `user-list.tsx` empty-state copy were already partly done under TASK-331 doc-05/06; this ticket finished the deletion + made the guards tenant-aware rather than re-implementing those.

---

## 9. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-05 | Ticket created. Reviewed the TASK-331 follow-up items via parallel read-only exploration; documented the System-vs-Global difference (✓ verified against `05-tenant.ts`/`00-constants.ts`), the redundant in-page Tenants column (✓ verified on Departments), and the three playground tenant-coherence gaps (✓ verified store/SDK/doctor-context). Drafted a UI-only TDD plan across 3 waves with an approval gate. No source code changed. | this README |
| 2026-06-05 | Implemented all 3 issues (TDD). Issue 1: `ScopeSwitcher` filters `__SYSTEM__`. Issue 2: removed Tenants column from 5 admin pages. Issue 3: deleted dead `TenantSelector`, added shared `WorkingTenantNotice` into both impersonation guards; confirmed impersonation is already tenant-coherent (Gap C no-op). Full ui-playground suite green (103/927), type-check + lint clean. | see §8 Files changed |
