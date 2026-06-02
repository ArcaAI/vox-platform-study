# TASK-327 — Phase 1: Console Shell & Scope Model

| | |
|---|---|
| Ticket Number | TASK-327 |
| Short name | Admin-Console-Shell-Scope |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Completed` (2026-06-02) — type-check 0, tests 731/731 |
| Type | feature (shell / IA / scope) |
| Scope | `apps/ui-playground/` (primary); `@arcaai/vox` + `apps/api` only if a settings hook/endpoint is missing |
| Depends on | **TASK-326** (security scoping must land first) |

> Implements the global↔tenant scope model, moves nav gating from **visibility** to **data-scope**, adds re-orderable persisted menus, and restores the impersonation tenant-gate. Per **Q3**, all data flows through `@arcaai/vox` hooks.

---

## 1. Requirement Analysis

### 1.1 Description
Today the sidebar is hardcoded and SUPER_ADMIN-centric — a tenant admin sees only 5 of 11 admin pages (TASK-325 §2.2, `app-sidebar.tsx:92-176`). This phase makes the console scope-aware: one menu set for everyone, scoped by a header tenant selector, with persisted, user-reorderable menus.

### 1.2 Acceptance criteria
- [ ] Header **`ScopeSwitcher`**: GLOBAL admin picks a tenant via `Popover` + `Command`; TENANT admin shows a locked badge. The selection persists and is sent as `X-Tenant-Id` on every request (extract logic from `features/playground/overview/components/tenant-selector.tsx`).
- [ ] Admin nav renders **all 9 menus for tenant admins** (data-scoped), not hidden — gating moves from `isSuperAdmin` to scope.
- [ ] **Re-orderable persisted menus:** order stored in `UserSettings` (`namespace:'arcaai-admin'`, `key:'menuOrder'`, JSON); tenant default in `GlobalSetting`; resolution **user → tenant → hardcoded**; drag via `@dnd-kit/sortable`; optimistic Zustand update + persist on drop. (No DB migration — models already support this.)
- [ ] GLOBAL-admin **impersonation requires selecting a tenant first** (P1 gate restored); `ServiceStatusGrid` shown on `/playground/overview`.
- [ ] New/changed data access uses `@arcaai/vox` hooks (Q3); no new raw `fetch`.
- [ ] Honors rules `07`/`10`/`11`; gates green (§4).

### 1.3 Non-goals
- No new admin feature pages (Phase 2 / TASK-328). This is shell + scope + nav only.

---

## 2. Current State Evaluation
TASK-325 §2.2 (hardcoded sidebar, no scope switcher, no persisted menus) and §2.7 (design-system reuse: `@dnd-kit/sortable` and `Command`/`Popover` already available). The `TenantSelector` card holds working tenant-pick logic to extract.

---

## 3. Implementation Plan (TDD)
1. **`AdminPreferences` store/hook** — read/write `arcaai-admin:menuOrder` via the user-settings SDK hook; resolve user→tenant→default. RED: order round-trips through the API.
2. **`DraggableNavGroup`** — `@dnd-kit/sortable` wrapper around `NavGroup`; persists on drop.
3. **`ScopeSwitcher`** (header) — `Popover` + `Command` tenant list for global admin (via `useTenants`), locked badge for tenant admin; writes effective tenant to the store.
4. **Nav refactor** — `app-sidebar.tsx`: render the full admin menu set; replace `isSuperAdmin` visibility gating with scope-aware data loading.
5. **Impersonation gate** — restore the global-admin "select tenant first" guard on Overview; mount `ServiceStatusGrid` there. RED: RBAC matrix (tenant admin scoped; global admin blocked until tenant selected).

---

## 4. Verification Gates
```
pnpm --filter @arcaai/ui-playground type-check   # = 0 (TASK-321 baseline)
pnpm --filter @arcaai/ui-playground test          # no NEW failures vs baseline
# (if SDK/API extended) pnpm build:sdk && pnpm --filter @arcaai/vox test
# ReadLints on every edited file → clean
```

---

## 5. Implementation Summary

**Completed 2026-06-02.** All five plan items shipped; gates green (independently verified): `type-check` = **0 errors**, `test` = **731 passed / 0 failed** (69 files; +8 new test files, zero new failures), `@arcaai/ui build` success, lint clean.

### Decisions applied
- **D1** — `SUPER_ADMIN` ≡ `GLOBAL_ADMIN` = "global scope"; both must select a tenant for tenant-scoped views & impersonation. `TENANT_ADMIN` is locked to its own tenant.
- **D2** — drag-reorder reuses `@arcaai/ui` diceui `Sortable*` via a new `@arcaai/ui/sortable` re-export (no `@dnd-kit` added to ui-playground; resolves through the package's `"./*": "./src/*.tsx"` wildcard).
- **D3** — live-tenant was **already** wired in the SDK (`AgenticProvider` → `client.updateTenantId`), so `@arcaai/vox` was **not** modified; only React Query cache invalidation on tenant change was added.

### What shipped
| Item | Outcome |
|---|---|
| T1 Scope foundation | `auth-store.isGlobalScope()` (SA∪GA); `ScopeSyncInit` invalidates the React Query cache on tenant change (mounted inside `QueryClientProvider`) |
| T2 `useAdminPreferences` | Resolves menu order **USER → TENANT(`getByTenant`) → DEFAULT**; persists via `useUserSettings.updateByKey('arcaai-admin','menuOrder',…)`; optimistic + revert + toast; JSON-string/array tolerant |
| T3 `DraggableNavGroup` | `@arcaai/ui` Sortable; drag handle (focus-visible, aria-label); persists order on drop; plain `NavGroup` when sidebar collapsed |
| T4 `ScopeSwitcher` (header) | Global scope → `Popover`+`Command` searchable tenant picker (cached `useAdminTenants`, Skeleton while loading); `TENANT_ADMIN` → locked `Badge` + tooltip |
| T5 Nav refactor | `buildAdminNavItems` renders the full admin set for any admin (Overview, DNA Reports, Tenants, Users, Prompts, Departments, Audio Pipelines, Storage, Configurations, Audit Logs); **Prisma Studio stays global-scope only** (TASK-326 Q4); order from preferences |
| T6 Impersonation gate + Overview | Global-scope impersonation disabled with "Select a tenant first" tooltip + defensive re-check; `ServiceStatusGrid` mounted on `/playground/overview` |

### Files
- **New:** `packages/ui/src/sortable.tsx`; `apps/ui-playground/src/providers/scope-sync.tsx`; `components/layout/{scope-switcher,draggable-nav-group,admin-nav-items}.tsx`; `features/admin/hooks/use-admin-preferences.ts` (+ 8 new `__tests__` files).
- **Modified:** `store/auth-store.ts`, `main.tsx`, `components/layout/{app-sidebar,header,nav-group}.tsx`, `features/playground/overview/{index.tsx,components/user-list.tsx}`.
- **No DB migration; `@arcaai/vox` untouched.**

### Notes / deviations
- Tenant admins now see 10 admin menus (everything except Prisma Studio) — data-scoped server-side by `X-Tenant-Id`, satisfying "scope-not-visibility."
- The TASK-321 "92 pre-existing test failures" did not reproduce on this branch's worktree (clean 0-fail baseline); the bar held as "zero new failures."

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 1). Scope = ScopeSwitcher, scope-not-visibility nav, persisted re-orderable menus, impersonation gate; Q3 SDK-first. Status `Pending`. | this README |
| 2026-06-02 | **Implemented & shipped to `fix/2605-review`.** T1–T6 complete (decisions D1 SA≡GA / D2 reuse @arcaai/ui Sortable / D3 SDK already live — vox untouched). Gates: type-check 0, tests 731/731, @arcaai/ui build ok, lint clean. Status → `Completed`. | auth-store, main, scope-sync, app-sidebar/header/nav-group, scope-switcher, draggable-nav-group, admin-nav-items, use-admin-preferences, user-list, overview, packages/ui/sortable + 8 test files |
