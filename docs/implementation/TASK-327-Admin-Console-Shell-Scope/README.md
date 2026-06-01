# TASK-327 — Phase 1: Console Shell & Scope Model

| | |
|---|---|
| Ticket Number | TASK-327 |
| Short name | Admin-Console-Shell-Scope |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Pending` |
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
> Not started.

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 1). Scope = ScopeSwitcher, scope-not-visibility nav, persisted re-orderable menus, impersonation gate; Q3 SDK-first. Status `Pending`. | this README |
