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

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §4 + artboards 1d/5b/5g; current-state map of `features/rbac` captured. Status: Pending (awaiting plan approval). |
