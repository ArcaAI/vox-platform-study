# TASK-438 — Role Management Redesign: Role List + Permission Matrix

- **Status**: Pending
- **Type**: feature (UX/UI redesign — `/rbac/roles`)
- **Owner**: admin-console
- **Design source**: project "ARCAAI Hope Admin console" (`https://claude.ai/design/p/6a582386-939b-47d3-8c19-cd9338b34814`) — build spec §4; artboards `1d` (desktop), `5b` (dark), `5g` (mobile cards).
- **Related**: **depends on TASK-437** (DetailDrawer, viewport tiers); TASK-419 (admin RBAC API), TASK-430 (cross-tenant surfaces).

## Requirement Analysis

Route `/rbac/roles`, tier 20–29 (shared). Replace the opaque flat list (role → policy-name count) with a legible **resource × action permission matrix**.

- **Layout**: two-pane inside the shared frame — left **role list** (grouped *System · locked* / *Custom*, search, member counts); right **detail** with header (name · type badge · `resourceStatus` · member count · Edit / Delete) and tabs **Permissions** (matrix) · **Members** · **Policies**.
- **Matrix**: rows = resources; columns = actions (Read, Create, Update, Delete, Manage). Cell states: **✓ granted** (teal) · **— none** · **◐ inherited** (from a system policy). Legend always visible. **v1 is a derived, read-only view** computed from the role's attached policies (allow/deny rules, priority-ordered). Editing stays in the **Policies** tab (attach/detach). Phase 2 (out of scope): inline cell toggles writing a role-scoped policy.
- **States**: skeleton list + matrix; empty "No custom roles yet" (system roles always present); error retry; system role → matrix read-only, attach/detach hidden; OCC 412 → inline conflict alert preserving edits.
- **Responsive**: tablet — role list collapses to a drawer; mobile (5g) — role fills the screen, matrix → per-resource cards with action chips (✓ Read · ✓ Create · — Delete …).
- **Endpoints (unchanged)**: `GET/POST /admin/rbac/roles`, `GET/PATCH/DELETE /admin/rbac/roles/:id` (delete = break-glass), `POST/DELETE /admin/rbac/roles/:id/policies/:pid` (detach = break-glass).

### Acceptance criteria (from spec §4)

- [ ] Matrix renders effective permissions per resource×action with the 3 cell states + legend.
- [ ] System roles are visibly locked; no attach/detach/edit affordances shown.
- [ ] Delete and detach route through the break-glass step-up; errors surface in-dialog, not as toasts.
- [ ] 412 on update shows the OCC alert and preserves the user's edits.
- [ ] Dark theme + mobile card fallback verified.

## Current State Evaluation

Verified 2026-07-08 (`apps/admin-console/src/features/rbac/`):

- **List**: `components/roles-screen.tsx` — `AdminDataGrid` full-width table (`gridId="rbac-roles"`), columns Role / Type (`RoleTypeBadge`) / Policies (count) / Status / Updated / Actions; `ScreenTemplate` `contentMode="fill"`; footer `GET /admin/rbac/roles`. No grouping, no two-pane.
- **Detail**: `components/role-detail-sheet.tsx` — right Sheet (`sm:max-w-xl`): lock notice, description, dl-meta, "Attached policies (N)" as a bordered `<ul>` with priority badges + trash detach; attach via Select + button (`AttachPolicyRow`, policies fetched `pageSize:100`). Edit = nested `EditRoleDialog` (Dialog); delete bubbles to screen-level `BreakGlassDialog`.
- **No permission matrix exists.** Rules render nowhere on the roles screen; they live only as a raw JSON textarea in `policy-form-sheet.tsx`.
- **Rule model** (`api/types.ts:60-68`) is **CASL grammar**: `{ action, subject, conditions?, fields?, inverted?, reason? }` — deny = `inverted: true`; **no `effect`/per-rule `priority`**. Priority exists only on the role↔policy attachment (`Role.policies[]: { id, name, priority }`).
- **API client** (`api/client.ts`): plain `getJson/patchJson/…` — RBAC does **not** use ETag/If-Match; OCC handled via `GatewayError.isVersionConflict` (412) → `OccConflictAlert` in `EditRoleDialog`; 428 → break-glass step-up (policy editor). Break-glass = body credentials, errors in-dialog (already matches spec).
- **Members**: no members endpoint is consumed today; `Role` has no member list in the client. Member **counts** appear in the design (list + detail). Users list API (`features/users`) supports role filtering — to confirm during build; if no cheap count/listing exists, the Members tab ships with the available user-search-by-role listing and the count chip degrades gracefully (see Plan step 6).

**Delta summary**: two-pane layout + grouped role list (new), matrix derivation engine (new), Members tab (new, endpoint to confirm), detail moves from Sheet+nested dialogs to the shared `DetailDrawer`, mobile card fallback (new). Break-glass, OCC alert, badges, break-glass-on-detach all reusable as-is.

## Implementation Plan

TDD; layer order: pure derivation lib → components → screen wiring → responsive → e2e.

### 1. Matrix derivation engine (pure, test-first)

`features/rbac/lib/permission-matrix.ts`:

- Input: `policies: Policy[]` (each with `rules: PolicyRule[]`, `scope`, `isProtected`, source flag) ordered by attachment `priority`, plus the catalog of matrix rows/columns.
- Row catalog: start from the subjects present in attached policies ∪ a curated ordered list (Consultation, Patient record, Department, Prompt template, Audio pipeline, DNA report/writing style, Tenant settings, …) — final list confirmed against gateway CASL subjects during build; unknown subjects append below the curated set.
- Column mapping: CASL `action` → columns `read, create, update, delete, manage`; `manage` implies all (render ✓ in Manage and implied ✓ in the rest, per artboard 1d where Owner shows full rows); action aliases (`list`→read) normalized in one table.
- Cell resolution (priority-ordered, first-match): `inverted: true` → none (deny wins at its priority); allow → granted; allow originating from a **system/global policy** (policy `scope === 'GLOBAL'` or attached system policy) → **inherited**; nothing → none. `conditions`/`fields` on a matching rule render as granted with a "conditional" dot + tooltip (documented; artboard shows plain ✓ — tooltip is additive).
- Output: `{ rows: [{ subject, label, cells: Record<Action, 'granted' | 'inherited' | 'none' | 'conditional'> }], legend }`.
- **Tests first** (`lib/__tests__/permission-matrix.test.ts`): allow sets ✓; `inverted` masks lower-priority allow; `manage` expansion; GLOBAL-scope source → inherited; alias normalization; unknown subject appended; deterministic order.

### 2. PermissionMatrix component

`features/rbac/components/permission-matrix.tsx`:

- Desktop/tablet: semantic `<table>` (`<caption>` = legend), sticky first column, mono glyphs ✓ / — / ◐ paired with `sr-only` text (never color-only); teal = `text-primary`.
- Mobile (< 768, via `useViewportTier` from TASK-437): per-resource cards with action chips (artboard 5g).
- Skeleton variant matching the table shape.
- Tests: renders 3 states + legend; sr-only labels; card fallback on mobile tier; axe 0 violations.

### 3. Two-pane roles screen

Rework `roles-screen.tsx`:

- Left pane (~280px, `shrink-0`): search input, grouped sections **SYSTEM · LOCKED** / **CUSTOM** with member-count chips; selection in URL (`?role=` via nuqs, matching the console pattern); "New role" stays in `PageHeader`.
- Right pane: detail header (name, `RoleTypeBadge`, `ResourceStatusBadge`, member count, Edit / Delete buttons) + `Tabs variant="line"`: **Permissions** (matrix from step 2, reading `useRole(id)` → `policies[]` then `usePolicies` details), **Members** (step 6), **Policies** (move the existing attached-policies list + `AttachPolicyRow` + detach break-glass from `role-detail-sheet.tsx` into this tab, unchanged behaviour).
- `ScreenTemplate` `contentMode="fill"` retained; `StatusFooter` endpoint hint unchanged. Empty state: "No custom roles yet". System role selected → lock notice, no Edit/Delete/attach/detach affordances (hidden, not disabled).
- Edit: keep `EditRoleDialog` + `OccConflictAlert` behaviour (412 preserves inputs) — moved behind the detail header's Edit button.
- `role-detail-sheet.tsx` is retired (deleted) once the two-pane screen carries its behaviour; grid columns file cleanup.
- Component tests (rewrite `__tests__/roles-screen.test.tsx`): grouping, selection→detail render, system-role lockdown, tab switching, delete → BreakGlassDialog, 412 path.

### 4. Responsive behaviour

- Tablet (768–1279): role list becomes a toggleable drawer (`Sheet` side=left) with a list toggle button in the header; detail fills the width.
- Mobile: selecting a role navigates the pane full-screen (list ↔ detail swap with back affordance); matrix cards per step 2.
- Tests: tier-mocked rendering states.

### 5. Break-glass + OCC (verify, no rework)

Existing flows reused: delete role (confirm ROLE name), detach policy (confirm POLICY name), errors in-dialog. Add tests asserting no toast on in-dialog errors (AC 3).

### 6. Members tab

- Build-time spike: confirm a users-by-role listing (`features/users` client, e.g. `GET /admin/users?roleId=`) or role member count from the gateway. If available: paginated member list (name, department, chip). If not: ship the tab with user-search filtered client-side + a note, and file a follow-up API gap ticket (pattern: TASK-419); member-count chips in the list render only when data exists.
- Tests for whichever variant ships.

### 7. Verification & evidence

- [ ] `pnpm --filter @arcaai/admin-console build lint test` green; new tests listed above pass (paste output)
- [ ] axe 0 violations (screen test) — matrix table + cards
- [ ] Both themes verified (screenshots: 1d light, 5b dark) via `next-dev-loop`
- [ ] Playwright e2e: `tests/e2e/rbac-roles.spec.ts` — list→select→matrix renders; system-role lockdown; break-glass delete cancelled path
- [ ] AC checklist above all checked, evidence pasted here

## Implementation Summary

Status: **Review** (code complete; runtime/browser verification via `next-dev-loop` + screenshots remain a manual step — see Verification below).

Delivered the two-pane Role Management redesign for `/rbac/roles`, TDD-first (pure lib → components → screen → e2e). All work stayed inside `features/rbac/**` plus the e2e spec and this README; the TASK-437 foundation (`DetailDrawer`, `useViewportTier`) and `@arcaai/ui` primitives were reused, not forked.

### Files changed

- **`features/rbac/lib/permission-matrix.ts`** (new) — pure derivation engine. Folds a role's attached policies (CASL `{ action, subject, conditions?, fields?, inverted? }` + attachment `priority`) into a `resource × action` grid. Semantics: fixed CRUD+manage columns; `manage`/`all`/`*` imply every column; policies evaluated in **ascending priority order (lower number = higher precedence, first-match)**; matching `inverted` → `none` (deny wins at its position), allow from a `GLOBAL`-scope policy → `inherited`, allow with `conditions`/`fields` → `conditional`, else `granted`. Row catalog = curated ordered subjects (Consultation, Patient record, Department, Prompt template, Audio pipeline, DNA writing style, Tenant settings) ∪ unknown subjects appended (first-seen, humanized labels); wildcard subjects apply to all rows without creating one.
- **`features/rbac/lib/__tests__/permission-matrix.test.ts`** (new) — 11 tests: allow→granted, manage expansion, deny masks lower-priority allow, first-match allow outranks later deny, GLOBAL→inherited, conditional, alias `list`→read, wildcard `all` fills all rows, unknown-subject append + humanize, deterministic order, legend.
- **`features/rbac/components/permission-matrix.tsx`** (new) — `PermissionMatrix` (semantic `<table>` with sticky first column + `<caption>`; mono glyphs `✓`/`◐`/`—` paired with `sr-only` text, teal = `text-primary` — never color-only) and a `layout="cards"` mobile fallback (per-resource cards with action chips, artboard 5g). Always-visible legend. `PermissionMatrixSkeleton` for loading.
- **`features/rbac/components/__tests__/permission-matrix.test.tsx`** (new) — 6 tests incl. two axe scans (table + cards), sr-only pairing, card fallback.
- **`features/rbac/components/role-detail.tsx`** (new) — the role detail, decomposed into shared tab panels reused by two shells: `RoleDetailPane` (desktop inline right pane) and `RoleDetailDrawer` (compact tiers, via the shared `DetailDrawer`). Tabs: **Permissions** (derived matrix — joins `role.policies[]` refs to full `usePolicies` details for the rules), **Members**, **Policies** (attach/detach + `EditRoleDialog`, moved verbatim from the retired sheet — detach = break-glass on the POLICY name, edit 412 → inline `OccConflictAlert` preserving inputs). Active tab is URL-driven (`?tab=`). System roles: Edit/Delete/attach/detach hidden (not disabled) + lock notice.
- **`features/rbac/components/roles-screen.tsx`** (rewritten) — two-pane frame: grouped role list (search + **System · locked** / **Custom**) with selection in the URL (`?role=` via nuqs). `useViewportTier`: desktop renders the inline pane (list `w-72` + detail); tablet/mobile render the list full-width and open the detail in `DetailDrawer` (matrix → cards on mobile). `ScreenTemplate contentMode="fill"`, `StatusFooter` endpoint hint retained. Screen-level break-glass delete (DELETE body = password + ROLE name). `RoleTypeBadge` kept here and exported.
- **`features/rbac/components/__tests__/roles-screen.test.tsx`** (rewritten) — 8 tests: grouped list + select-a-role prompt, select→matrix, system-role lockdown (no Edit/Delete, lock notice, no attach), screen-level break-glass delete, policy detach, 412 OCC alert preserving edits, create POST, mobile drawer + matrix-card fallback.
- **`features/rbac/components/role-detail-sheet.tsx`** (deleted) — retired; its attach/detach/edit behaviour moved into the Policies tab of `role-detail.tsx`.
- **`tests/e2e/rbac-roles.spec.ts`** (rewritten) — smoke for the two-pane UI: list→select→matrix, system-role lockdown, break-glass delete cancelled path (skips if no custom role seeded), + axe gates in light/dark.

### Decisions

- **Members tab endpoint — not available.** The gateway exposes no users-by-role listing or member-count field on `Role` (only the inverse `GET /admin/users/:id/roles`), and cross-feature imports are disallowed (rule 13). The Members tab therefore ships an honest empty state pointing to the Users screen, and **member-count chips are omitted** from the role list until an API gap is filled. *Shared-change / follow-up needed:* add a `GET /admin/rbac/roles/:id/members` (or `GET /admin/users?roleId=`) endpoint + member count, then wire the tab + count chips (pattern: TASK-419).
- **Matrix v1 is derived, read-only.** Editing stays in the Policies tab (attach/detach). Inline cell toggles are out of scope (Phase 2).
- **Tab activation is URL-driven (`?tab=`)** to match the console pattern (`tenant-detail`) — Radix automatic tab activation doesn't fire on `fireEvent.click` under happy-dom, and the URL param also makes the tab shareable.
- **Responsive model (simplification vs plan step 4):** desktop = inline two-pane; tablet **and** mobile open the detail in the shared `DetailDrawer` (right slide-over on tablet, full-screen on mobile) rather than a list-as-drawer. This reuses the console-wide detail surface (per the reuse constraint) and keeps one coherent compact path. No shared files were modified.

### Verification (evidence)

- `pnpm --filter @arcaai/admin-console test` (rbac only): **42 passed** across 5 files — new/changed: `permission-matrix.test.ts` 11/11, `permission-matrix.test.tsx` 6/6, `roles-screen.test.tsx` 8/8; unchanged: `rbac-api.test.ts` 5, `policies-screen.test.tsx` 12. Full app run: **781 passed / 11 failed — all 11 failures are in `features/settings/**`** (a parallel agent's in-progress work, incl. a leftover `dbg.test.tsx`); zero rbac failures.
- `pnpm --filter @arcaai/admin-console lint` — **clean** (0 warnings).
- `pnpm --filter @arcaai/admin-console build` — **success** (`/rbac/roles` compiled).
- `pnpm --filter @arcaai/admin-console check-types` — only pre-existing `vitest-axe` `toHaveNoViolations` matcher-type gaps remain (same as the untouched `shared/detail/__tests__/detail-drawer.test.tsx`); no new source-type errors. Not part of the `build lint test` DoD and does not affect `next build`.
- **Remaining manual steps:** `next-dev-loop` runtime pass + light/dark screenshots (artboards 1d/5b/5g) and Playwright e2e against a running stack were not executed here — flagged for follow-up.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §4 + artboards 1d/5b/5g; current-state map of `features/rbac` captured. Status: Pending (awaiting plan approval). |
| 2026-07-08 | Implemented the two-pane redesign end-to-end (TDD): permission-matrix derivation lib + tests, `PermissionMatrix` component (table + mobile cards, sr-only glyphs, axe-clean), `role-detail.tsx` (inline pane + `DetailDrawer`, Permissions/Members/Policies tabs), rewritten two-pane `roles-screen.tsx`, retired `role-detail-sheet.tsx`, rewritten screen + e2e tests. rbac tests 42 passed, lint clean, build green. Members tab shipped as an empty state (no users-by-role endpoint — follow-up API gap noted). Status: Review. |
| 2026-07-08 | **Runtime verification pass** (authenticated browser against the live dev stack, `global_admin`): live data rendered — grouped list "8 roles · 5 system + 3 custom" (SYSTEM·LOCKED/CUSTOM), selection via `?role=`, system-role lockdown, matrix desktop table (legend + Read/Create/Update/Delete/Manage columns, ◐-inherited glyphs with sr-only pairing) and narrow-viewport card fallback both exercised. **axe-core 4.11 WCAG 2.2 AA: 0 violations in light AND dark**; dark desktop screenshot captured; zero console/SSR errors. Members-endpoint API gap filed as TASK-444. Outstanding: true mobile-width (375px) visual pass; Playwright e2e against the stack. |
