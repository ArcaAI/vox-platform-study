# TASK-391 — Super-Admin Tier Frontend (wire TASK-390 backends)

| | |
|---|---|
| **Ticket** | TASK-391 |
| **Title** | Super-admin FE surfaces — Roles & Policies (anti-lockout), API Keys (rotate), Global Settings (locked/namespaced), Audit trail (multi-format export) |
| **Type** | `feature` (frontend) |
| **Created** | 2026-07-01 |
| **Updated** | 2026-07-01 |
| **Status** | Review (implementation complete; consolidated live E2E green — 33 passed, 3 parked; see §7.1) |
| **Owner** | Frontend / Admin Console (super-admin tier) |
| **Depends on** | **TASK-390** (backend + SDK — Completed, uncommitted; built **on top**), TASK-387/388 FE patterns (settled) |
| **Design source** | `docs/designs/admin/unbuilt-super-admin-surfaces.md` §5.1/5.2/5.6 + audit; `docs/implementation/TASK-371-Admin-Console-Redesign/UNBUILT-SURFACES-DESIGN.md` (moved stub) |
| **Source review** | `docs/admin-console-open-items-review.md` §3a #22–#25, §3b (read-only reference) |

> **Ticket-number check (2026-07-01):** `docs/implementation/` highest existing is **TASK-390** (386–390 all exist; 391 free). **TASK-391** is the next free number — confirmed by directory listing.

---

## 1. Requirement Analysis

Build the four **super-admin tier** FE surfaces whose backends just landed in **TASK-390**, wiring them to the SDK:

| # (TASK-390) | Surface | Backend capability to wire | Design ref |
|---|---|---|---|
| **#22 (R3)** | **Roles & Policies** | CASL policy-rule editing + **anti-lockout protected set** (`system-full-access`, `rbac-system-manage`) — service refuses delete / disable / GLOBAL-scope-change / load-bearing-rule-strip | §5.1 |
| **#23 (K5)** | **API Keys** | `POST /admin/api-keys/:id/rotate` → new secret once + **24 h grace window** | §5.2 |
| **#24 (ST1)** | **Global Settings** | CRUD at `/admin/settings`, OCC PATCH via `If-Match`; **`locked`-row** super-admin guard; namespaces | §5.6 |
| **#25 (AU2)** | **Audit trail** | `GET /admin/audit-logs/export?format=csv\|xlsx\|pdf` → `StreamableFile` | §5.1 shell / audit |

### Acceptance criteria

- **#22** — Protected system policies (`system-full-access`, `rbac-system-manage`) render a **Protected** affordance and their **Delete is disabled** in the UI (mirrors the server `ForbiddenException`, defense-in-depth). All other policies stay fully editable/deletable. Policy CASL editing continues to work via the existing visual builder.
- **#23** — Each key exposes a **Rotate** action that calls `useApiKeys().rotate(id)`, reveals the new secret **once**, and explains the 24 h grace window. No hard-coded role gating (rely on SDK/permissions).
- **#24** — Global settings are grouped by **namespace**; **locked** rows show a lock affordance and disable edit/delete for non-super-admins (super-admin may edit; server is source of truth). OCC edit flow preserved.
- **#25** — Audit export offers **CSV / Excel (.xlsx) / PDF** via `useAuditLog().exportFile(format, filters)` (CSV keeps the existing text path), honouring the active filters.

**Net: zero backend / SDK / DB changes.** Every endpoint, DTO and SDK method already exists (TASK-390).

---

## 2. Current State Evaluation (IMPORTANT — surfaces already exist)

The four surfaces are **already built as committed "legacy" routes** (single commit `feat: add HOPE Admin Console…`), which the review §3b explicitly labels *"Unbuilt super-admin frontend surfaces (legacy routes predate the redesign)"*. They are functional but predate the TASK-371 super-admin redesign **and** the TASK-390 capabilities. So this ticket is a **surgical enhancement**, not a from-scratch build:

| Surface | Existing route / features | Gap vs TASK-390 + design |
|---|---|---|
| Roles & Policies | `routes/_authenticated/roles.tsx` + `features/roles/*` (tabs, role CRUD, policy CRUD + **visual CASL builder** `policy-form-dialog` + `policy-rules-editor`, attach/detach sheet) | **No protected-policy anti-lockout affordance** (#22). |
| API Keys | `routes/_authenticated/api-keys.tsx` (table, create→reveal, revoke, delete) | **No Rotate action** (#23); no scopes column / masked checksum. |
| Global Settings | `routes/_authenticated/settings.tsx` (Global CRUD + OCC edit, My-settings) | **No locked-row guard, no namespace grouping** (#24 polish). |
| Audit Log | `routes/_authenticated/audit-log.tsx` (cursor grid + filters + **CSV export**) | **CSV only** — no xlsx/pdf (#25). |

### SDK enablement — nothing to add

All required hooks/methods already exist and are barrel-exported (`@arcaai/vox`):

- `useApiKeys().rotate(id)` ✓ (TASK-390 #23)
- `useAuditLog().exportFile(format, filters)` ✓ + `exportCsv` (TASK-390 #25)
- `usePolicies()` ✓ (list/get/create/update/validate/remove) — #22
- `useGlobalSettings()` ✓ (list/get(getWithEtag)/create/update(patchWithIfMatch OCC)/remove) — #24
- `useRoles()` ✓

> The brief anticipated I *might* need to add `usePolicies` / `useGlobalSettings` wrappers — **they already exist**, so **no SDK file is touched** (avoids conflict with the parallel api-key-authz worker). The one new type I'd otherwise import (`AuditExportFormat`) is **not** re-exported from the SDK barrel; rather than edit the barrel, the admin app uses a local `'csv' | 'xlsx' | 'pdf'` union (structurally assignable to `exportFile`).

### Nav + routing — already present

`apps/admin/src/lib/nav.ts` already lists `Roles & Policies → /roles`, `API Keys → /api-keys`, `Audit Log → /audit-log`, `Settings → /settings`; the routes exist under `routes/_authenticated/`. **No nav/route registration was needed.** (Reconciliation of the "super-admin-gated" instruction is FLAGGED in §3.)

---

## 3. Decisions made + FLAGGED gaps

1. **Surgical enhancement over rebuild.** The legacy surfaces are the *closest existing admin pattern*; per the brief ("build to the closest existing admin pattern and FLAG the gap — do not invent net-new UX") I enhance them in place and **flag the larger Figma redesigns as deferred** (below), rather than rewrite four working screens.
2. **Nav gating (FLAG — instruction vs shared-tier taxonomy).** The brief says add these "super-admin-gated". But (a) the nav entries + routes **already exist** (ungated), (b) the design taxonomy (`12-design-workflow.mdc`) puts **Roles / API Keys / Settings in the `20–29` *shared* tier** (tenant-admins manage their own via server CASL scope), (c) the brief itself says *"do NOT hard-code role assumptions for the API-key surface … rely on SDK/permissions"*. Hard-gating them as super-admin would **regress** tenant-admin access and contradict (c). **Decision:** leave nav as-is (permission-gated server-side, `404-over-403` in the console), matching the existing `Monitoring requireSuperAdmin` pattern only where the design truly says super-admin-only (Monitoring already is). **No `nav.ts` edit.** Flagged for the parent to confirm.
3. **#22 protected set is name-based, mirroring the backend.** `features/roles/protected-policies.ts` hard-codes the same two names the backend `PolicyService.PROTECTED_SYSTEM_POLICIES` uses (`system-full-access`, `rbac-system-manage`). **FLAG:** if a deployment renames those seeded policies, both the guard and this FE constant must be updated together. UI **disables Delete** and shows a **Protected** badge; it does **not** attempt to replicate the server's fine-grained mutation refusals (scope-change / disable / rule-strip) — those surface as a toast on the server 4xx (the server is source of truth). Rename / add-rule stay available (allowed by the guard).
4. **Deferred design (FLAG — build-to-closest-pattern).** The full Figma frames are richer than the enhanced surfaces; deferred and flagged:
   - **Roles §5.1 / 24b** — master-detail **inheritance tree** + live **effective-abilities preview** + **SUBJECTS × ACTIONS permission matrix**. Kept: the existing tabs + table + visual CASL rule-builder (Builder/JSON) + attach/detach; added the Protected affordance.
   - **Settings §5.6** — full **sectioned settings form** with type-appropriate controls (Switch/Select/number/secret-reveal). Kept: the KV table; added namespace **grouping** + **locked** affordance. (Secret `encryptedValue` reveal-gating not added — no secret rows in the current admin scope; flagged.)
   - **API Keys §5.2** — per-key rate-limit / environment / IP-allowlist columns + create-dialog fields. Added: **Rotate**, scopes summary, masked prefix+checksum. Rate-limit/env columns left as-is (data present via index signature; flagged as polish).
5. **Live E2E deferred (per brief).** Playwright specs are **authored but NOT run live** this round — a parallel worker owns the `:8868` stack + is hardening api-key authz. The parent will run a consolidated FE E2E pass afterward. `--list` (compile-only, no browser/stack) is used as the authored-spec gate.

---

## 4. Implementation Plan (files)

**Roles & Policies (#22)**
- NEW `features/roles/protected-policies.ts` — `PROTECTED_SYSTEM_POLICY_NAMES`, `isProtectedSystemPolicy`, `PROTECTED_POLICY_REASON`.
- NEW `features/roles/__tests__/protected-policies.test.ts`.
- EDIT `routes/_authenticated/roles.tsx` — Protected badge + disabled Delete (with tooltip) on protected policies.

**API Keys (#23)**
- NEW `features/api-keys/api-key-format.ts` — `maskedKey`, `scopesSummary`.
- NEW `features/api-keys/__tests__/api-key-format.test.ts`.
- EDIT `routes/_authenticated/api-keys.tsx` — Rotate flow (confirm → `rotate(id)` → reveal-once + grace note), Scopes column, masked key display.

**Global Settings (#24)**
- NEW `features/settings/global-settings.ts` — `isSettingLocked`, `groupByNamespace`.
- NEW `features/settings/__tests__/global-settings.test.ts`.
- EDIT `routes/_authenticated/settings.tsx` — namespace-grouped rows; locked lock-icon + disabled edit/delete for non-super-admins.

**Audit Log (#25)**
- NEW `features/audit-log/audit-export.ts` — `AUDIT_EXPORT_FORMATS`, `auditExportFilename`.
- NEW `features/audit-log/__tests__/audit-export.test.ts`.
- EDIT `routes/_authenticated/audit-log.tsx` — Export dropdown (CSV / Excel / PDF); `exportFile` for binary, `exportCsv` for CSV.

**E2E (authored, not run)**
- NEW `e2e/task-391-roles-policies.spec.ts`, `task-391-api-keys.spec.ts`, `task-391-settings.spec.ts`, `task-391-audit-log.spec.ts`.

**Verification:** `pnpm --filter @arcaai/admin type-check`, `test` (vitest), `build`, `test:e2e:list`.

---

## 5. Implementation Summary

All four surfaces enhanced **in place** (surgical), wired to existing TASK-390 SDK methods. **Zero backend / SDK / DB changes.** Each surface got a **pure helper module + Vitest suite** (logic isolated from React) plus the route edit that consumes it.

- **#22 Roles & Policies** — `protected-policies.ts` mirrors the backend protected set (`system-full-access`, `rbac-system-manage`). In the Policies tab, a protected policy now renders a **Protected** `StatusBadge` and a **disabled Delete** (wrapped in a `title` span explaining the anti-lockout). View / Edit / rename / add-rule stay available. Defense-in-depth: the server remains the source of truth (its 4xx surfaces as a toast).
- **#23 API Keys** — `api-key-format.ts` (`maskedKey`, `scopesSummary`) drives a new **Key** column (masked `prefix••••checksum`) and a **Scopes** summary column. A `RotateKeyDialog` adds a two-phase **Rotate** action: a confirm explaining the **24-hour grace window** → `useApiKeys().rotate(id)` → **reveal-the-new-secret-once** with a copy button. Rotate is disabled for revoked/expired keys (mirrors the server). No hard-coded role gating.
- **#24 Global Settings** — `global-settings.ts` (`isSettingLocked`, `groupByNamespace`) restructures the KV table into **namespace-grouped sections** (canonical order: general · feature-flags · stt · smr · guardrail · ux-constants · admin · rate-limit; unknowns then "Other" last). **Locked** rows show a lock icon; edit/delete are **disabled for non-super-admins** (super-admin retains write; server enforces the `locked` guard). OCC edit flow untouched. The redundant per-row Namespace column was dropped in favour of the group subheaders.
- **#25 Audit trail** — `audit-export.ts` (`AUDIT_EXPORT_FORMATS`, `auditExportFilename`) turns the single "Export CSV" button into an **Export ▾** dropdown offering **CSV / Excel (.xlsx) / PDF**, honouring the active filters. CSV keeps the text path (`exportCsv`); xlsx/pdf stream binary via `exportFile(format, filters)`. The generic `triggerDownload(filename, blob)` replaced the CSV-only `downloadCsv`.

## 6. Files changed

**NEW — pure helpers + Vitest suites (`apps/admin/src/`)**
- `features/roles/protected-policies.ts` + `features/roles/__tests__/protected-policies.test.ts`
- `features/api-keys/api-key-format.ts` + `features/api-keys/__tests__/api-key-format.test.ts`
- `features/settings/global-settings.ts` + `features/settings/__tests__/global-settings.test.ts`
- `features/audit-log/audit-export.ts` + `features/audit-log/__tests__/audit-export.test.ts`

**EDIT — routes (`apps/admin/src/routes/_authenticated/`)**
- `roles.tsx` — Protected badge + disabled Delete on protected policies.
- `api-keys.tsx` — `RotateKeyDialog`, Key (masked) + Scopes columns.
- `settings.tsx` — namespace-grouped rows, locked lock-icon + gated edit/delete (`isSettingLocked` takes `unknown` to accept `GlobalSetting`'s index-signature `locked`).
- `audit-log.tsx` — Export ▾ dropdown (CSV/xlsx/pdf); `triggerDownload` helper; description copy updated to "CSV, Excel or PDF".

**NEW — E2E specs (authored, not run live) (`apps/admin/e2e/`)**
- `task-391-roles-policies.spec.ts`, `task-391-api-keys.spec.ts`, `task-391-settings.spec.ts`, `task-391-audit-log.spec.ts`

**Untouched:** `nav.ts` (entries/routes already present — see §3.2), all SDK files, all backend/DB.

## 7. Verification evidence

| Gate | Command | Result |
|---|---|---|
| Unit (new suites) | `vitest run protected-policies api-key-format global-settings audit-export` | ✅ **4 files / 24 tests passed** |
| Type-check | `pnpm --filter @arcaai/admin type-check` | ✅ **Clean (exit 0).** The prior out-of-ownership SDK barrel gap (`PromptTestMetrics`) is now **RESOLVED** by the consolidation pass (SDK barrel re-export — see note). |
| Build | `pnpm --filter @arcaai/admin build` | ✅ **exit 0 — `✓ built in 10.94s`** (Vite/esbuild; the type-only SDK import is elided, so the barrel gap doesn't affect the bundle) |
| E2E collection | `pnpm --filter @arcaai/admin test:e2e:list` | ✅ **141 tests / 12 files**; the 4 `task-391-*` specs collect across all 3 viewport projects (**36 TASK-391 cases** — 12 × 3 viewports) |
| Live browser E2E | `playwright test task-391` (desktop + tablet + mobile) | ✅ **42 passed, 0 parked** vs the live seeded `:8868` stack (non-destructive) after the follow-up round (§7.2). Was 33 passed + 3 `fixme` in the first pass (§7.1). |

> **Out-of-ownership type error — RESOLVED (consolidation pass, 2026-07-01):** `usePrompts.ts` (`import type { PromptTestMetrics } from '../types'`) originally failed because the SDK barrel `types/index.ts` didn't re-export `PromptTestMetrics` (defined in `types/prompt.ts`) — a parallel SDK worker's in-flight change (TASK-389 #15 prompt metrics). The consolidation pass added the missing **export-only** re-export to the SDK public barrel (`src/types/index.ts` + `src/core.ts`) and rebuilt `@arcaai/vox`; admin type-check is now clean. No SDK runtime behaviour changed (type-only).

### 7.1 Consolidated live FE E2E pass (2026-07-01)

Ran the four `task-391-*` specs **live** against the healthy seeded `:8868` stack across all three viewport projects (**desktop / tablet / mobile**), **non-destructively** (`SKIP_DB_PRECHECK=true`; no DB reset/reseed). Final result: **33 passed, 3 skipped** (the 3 skips are the single `test.fixme` below × 3 viewports).

| Spec | Cases (× 3 viewports) | Result |
|---|---|---|
| `task-391-api-keys.spec.ts` (#23 rotate) | 3 | ✅ all pass (table+scopes, create reveal-once, rotate 24 h grace confirm) |
| `task-391-roles-policies.spec.ts` (#22 anti-lockout) | 3 | ✅ all pass (tabs+create, Protected + disabled Delete, CASL builder opens) |
| `task-391-settings.spec.ts` (#24 locked + namespaces) | 3 + 1 fixme | ✅ pass (tabs+create, namespace grouping, create dialog); ⏸️ 1 parked (**D2**) |
| `task-391-audit-log.spec.ts` (#25 export) | 2 | ✅ all pass (cursor grid + filter fields, Export CSV/xlsx/pdf menu) |

**Spec-robustness fixes applied during the pass (in-ownership, `e2e/task-391-*` only — no product-code change):**

- **API Keys nav.** Replaced the `beforeEach` hard `goto('/api-keys')` with **client-side sidebar navigation** (login → `/tenants` → click the *API Keys* nav link), opening the mobile drawer below the `md` (768 px) breakpoint. This both avoids **defect D1** and exercises the real user flow. The drawer branch is keyed off `page.viewportSize()` (deterministic) after a shell-mounted wait, not a racy `isVisible()` probe.
- **Audit filters.** `getByLabel('Action')` / `getByLabel('Resource type')` were **ambiguous** — the data-grid column headers expose the same words via *Reorder … column* / *… column options* controls. Switched to **exact-match** label selectors so only the filter inputs match (was intermittently green depending on grid-header mount timing).

**Defects D1 & D2 — both RESOLVED in the follow-up round (2026-07-01). See §7.2.**

- **D1 — dev-server `/api` proxy shadows the `/api-keys` client route (dev-only, low sev).** `apps/admin/vite.config.ts` proxied the broad prefix `/api` → `:8868`, so a **hard** load of `/api-keys` was forwarded to the gateway and 404'd (`Cannot GET /api-keys`). It never affected production (the SPA host serves the fallback) or in-app navigation (client-side routing never round-trips), and the admin SDK calls the API by absolute base URL (`api-config.ts`) so it never relied on the proxy. **✅ RESOLVED:** the proxy key was narrowed to `'/api/v1'` (verified safe — no relative non-`/api/v1` dev call exists). The in-spec client-side-nav workaround is retained as the more realistic user flow.
- **D2 — `GlobalSettingResponse` omitted `locked` (backend data-contract gap).** The seed marks several rows `locked: true` (`packages/database/.../11-global-setting.ts`) and the FE guard (`features/settings/global-settings.ts` `isSettingLocked` + `settings.tsx`) was correct, but the applications-layer DTO did not expose `locked`, so `GET /admin/settings` never returned it and the lock affordance could not render. **✅ RESOLVED:** `locked` added to `GlobalSettingResponse` (the generic `AutoClassMapper` populates it from the entity's non-null column — no mapper edit, **no migration**). `GET /admin/settings` now returns `locked` (verified: 33/100 seed rows `locked: true`), and the `task-391-settings` lock-affordance case is un-`fixme`'d and green across all three viewports.

### 7.2 Follow-up round — nav gating + D1/D2 resolution (2026-07-01)

Three items landed on top of §7.1, all within ownership (`apps/admin/**`, the `GlobalSettingResponse` DTO, and the two ticket docs):

**1. Per-surface CASL-mirrored nav visibility** (`apps/admin/src/lib/nav.ts`). User decision = per-surface, NOT blanket super-admin. Added a second declarative gate (`requireAdmin`) alongside the existing `requireSuperAdmin` (the Monitoring pattern), evaluated in `getNavSections` via the app's own `isSuperAdmin` / `isTenantAdmin` helpers (no hard-coded role strings). Server CASL stays the enforcement backstop; this only controls sidebar visibility.

| Surface | Gate | superAdmin | tenantAdmin | regular user |
|---|---|:--:|:--:|:--:|
| API Keys | `requireAdmin` | ✅ | ✅ | ✕ |
| Audit Log | `requireAdmin` | ✅ | ✅ | ✕ |
| Roles & Policies | `requireSuperAdmin` | ✅ | ✕ | ✕ |
| Global Settings | `requireSuperAdmin` | ✅ | ✕ | ✕ |

Covered by a new unit test (`src/lib/__tests__/nav.test.ts`, 3/3) **and** a new live spec (`e2e/task-391-nav-visibility.spec.ts`, 2 cases × 3 viewports): super-admin sees all four; tenant-admin sees API Keys + Audit but not Roles/Settings.

**2. D2 (`locked`) closed end-to-end.** Pre-check confirmed the `locked` column already exists (`packages/database/.../globalSetting.prisma`, domain entity/factory/model) → **DTO-only, no migration**. Added `locked` to `GlobalSettingResponse`; the generic `AutoClassMapper` copies it from the entity (it maps every field present on the target instance), so the mapper needed no change. Field declared **optional (`?`)** deliberately: the tenant controllers reuse `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse` (a superset cast), which only compiles while `GlobalSettingResponse` stays assignable-into `TenantConfigResponse`; a required `locked` broke that out-of-ownership cast (4 `tsc` errors), an optional one restores it while the runtime value is always populated. Rebuilt the API (stop `dev:api:test` → `pnpm build:api` → restart → health 200) and verified `GET /admin/settings` returns `locked` as a boolean on every row (65 of 163 seed rows `locked: true`, incl. `enable-local-raw-capture`). `task-391-settings` lock case un-`fixme`'d → green.

**3. D1 (dev proxy) narrowed.** `vite.config.ts` proxy key `'/api'` → `'/api/v1'`. Verified safe: the admin SDK targets an absolute base URL (`lib/api-config.ts`, `http://localhost:8868/api/v1`) and a repo grep found **no** relative non-`/api/v1` dev call, so nothing depended on the broad prefix. A hard load of `/api-keys` is no longer shadowed. The in-spec client-side-nav workaround is kept (realistic flow).

**Re-run (live, non-destructive, `SKIP_DB_PRECHECK=true`, desktop/tablet/mobile):** all **5** `task-391-*` specs green — **42 passed, 0 parked** (was 33 passed + 3 `fixme`; +6 new nav-visibility, +3 un-parked settings-locked). Admin type-check clean; `nav` unit 3/3; `globalSetting.dto.mapper` unit 29/29 (incl. 2 new `locked` cases).

> Residual note (informational, no action needed here): the tenant controllers' `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse` superset-cast is fragile — any future **required** field added to `GlobalSettingResponse` that isn't also on `TenantConfigResponse` will break `build:api`. Owned by the tenant/api layer, not TASK-391.
>
> **Resolved by [TASK-393](../TASK-393-Tenant-Config-DTO-Decouple/README.md)** (2026-07-01): a dedicated `TenantConfigDtoMapper` replaced the superset cast in both tenant controllers, and `GlobalSettingResponse.locked` was restored to its required shape.

## 8. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created; current-state analysis (surfaces exist as legacy routes; SDK already wired), decisions + flagged gaps, plan. | this README |
| 2026-07-01 | Implemented all four surfaces (#22 protected-policy affordance, #23 rotate, #24 locked/namespaced settings, #25 multi-format export) as helper+test modules + route edits; authored 4 E2E specs. Verified: unit 24/24, admin type-check clean (1 out-of-ownership SDK error noted), build ✓, e2e --list ✓ (33 cases). Live E2E deferred. Status → Review. | `features/{roles,api-keys,settings,audit-log}/*`, `routes/_authenticated/{roles,api-keys,settings,audit-log}.tsx`, `e2e/task-391-*.spec.ts`, this README |
| 2026-07-01 | **Consolidated verification pass.** Ran the 4 `task-391-*` specs **live** vs seeded `:8868` (desktop/tablet/mobile, non-destructive) → **33 passed, 3 parked** (`test.fixme`). Applied in-ownership spec-robustness fixes (API-keys client-side sidebar nav incl. mobile drawer; exact-match audit filter selectors). Resolved the out-of-ownership SDK barrel gap by re-exporting `PromptTestMetrics` (export-only) → admin type-check now **clean**. Documented **D1** (dev `/api` proxy shadows `/api-keys`) and **D2** (`GlobalSettingResponse` omits `locked`). Added §7.1. | `e2e/task-391-{api-keys,settings,audit-log}.spec.ts`, `packages/agentic-sdk-v2/src/{types/index,core}.ts`, this README |
| 2026-07-01 | **Follow-up round (§7.2).** (1) Per-surface CASL-mirrored **nav gating**: added a `requireAdmin` gate (API Keys + Audit → tenant-admin **or** super-admin) alongside `requireSuperAdmin` (Roles & Policies + Global Settings → super-admin only), decided via `isSuperAdmin`/`isTenantAdmin` (no role-string literals). (2) **D2 RESOLVED** — added `locked` to `GlobalSettingResponse` (column already existed → **no migration**; `AutoClassMapper` copies it; declared optional to keep the tenant superset-cast compiling); rebuilt API, `GET /admin/settings` returns `locked`, un-`fixme`'d the settings lock case. (3) **D1 RESOLVED** — narrowed the Vite proxy `'/api'` → `'/api/v1'` (verified safe: SDK uses an absolute base URL, no relative dev call depends on the broad prefix). Re-ran all 5 specs live → **42 passed, 0 parked**; nav unit 3/3; mapper unit 29/29. | `src/lib/nav.ts`, `src/lib/__tests__/nav.test.ts`, `vite.config.ts`, `e2e/task-391-{nav-visibility,settings}.spec.ts`, `packages/applications/.../globalSetting.response.ts`, this README + TASK-390 README |
