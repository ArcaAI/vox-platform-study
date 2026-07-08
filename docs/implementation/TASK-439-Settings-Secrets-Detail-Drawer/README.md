# TASK-439 — Settings & Secrets Redesign: List + Detail Drawer with Code Editor

- **Status**: Pending
- **Type**: feature (UX/UI redesign — `/settings`)
- **Owner**: admin-console
- **Design source**: project "ARCAAI Hope Admin console" (`https://claude.ai/design/p/6a582386-939b-47d3-8c19-cd9338b34814`) — build spec §5; artboards `1b` (desktop drawer), `5c` (dark), `5f` (mobile sheet).
- **Related**: **depends on TASK-437** (DetailDrawer, `CodeEditor`); TASK-430 (cross-tenant settings listing).

## Requirement Analysis

Route `/settings`, tier 20–29. Keep the searchable/filterable list; replace **all record modals** with a wide right **detail drawer** containing a real code editor — fixing broken JSON-in-modal editing.

- **List**: grouped by namespace; search; filter chips Namespace / Type / Secrets-only; Tenant column + filter for unscoped super-admins. Row click → drawer.
- **Drawer**: header (key · type badge · close) + meta (namespace · scope · version · updated-by). Tabs **Value · Details · History**.
- **Value tab is type-aware**: `Boolean` → switch; `String/Integer/Float/Double/Decimal/Date/DateTime/Uuid` → input; `Json/Array` → **code editor** (line numbers, syntax highlight, Format, live validate, copy). Secrets: masked; permission-gated **Reveal** (step-up re-auth) + **Rotate**; entering a value replaces the stored secret (write-only).
- **Interactions**: JSON — block Save while invalid, parse error with line/col, Format on demand. Reveal — re-auth dialog; plaintext held in-session only, hidden on demand, never persisted. OCC 412 — reload latest ETag in place, keep edits.
- **Responsive**: mobile (5f) — row opens a full-screen sheet with the editor; list rows → cards.
- **Endpoints (unchanged)**: `GET /admin/settings`, `GET /admin/settings/:id` (`{data, etag}`), `PATCH` (If-Match + expectedVersion, 412→OCC alert), `POST`, `DELETE`, `POST /admin/settings/:id/reveal` (`{password}`, audited, global-admin only). `dataType` ∈ String · Integer · Float · Double · Decimal · Boolean · Json · Date · DateTime · Array · Uuid · Binary.

### Acceptance criteria (spec §5)

- [ ] No modal is used for value/JSON editing — the drawer/sheet replaces it.
- [ ] JSON editor validates + formats; Save disabled while invalid.
- [ ] Secret values never returned to the client except via audited Reveal; reveal gated by permission + re-auth.
- [ ] PATCH carries If-Match + expectedVersion; 412 handled without data loss.
- [ ] Dark theme + mobile sheet verified.

## Current State Evaluation

Verified 2026-07-08 (`apps/admin-console/src/features/settings/`):

- `components/settings-screen.tsx`: flat `AdminDataGrid` (`gridId="settings"`), **no namespace grouping**; columns key (lock icon when `locked`) / namespace / tenant (TASK-430 multi-select filter) / type / value / updated / actions (pencil+trash). No Secrets-only chip.
- **Editing = modal**: `EditSettingDialog` (`setting-dialogs.tsx:129`) with `ValueEditor` — `Boolean`→Switch, `Json|Array`→plain `Textarea rows=5`, else Input. Exactly the broken pattern the redesign removes. Create = `CreateSettingDialog` (kept as a dialog is acceptable? — **design decision: creation moves into the drawer too**, "+ New" opens an empty drawer; see plan step 4).
- **Secrets**: `MASK` bullets; Reveal eye gated by `RequirePermission action="manage" subject="all"` → `RevealSecretDialog` (password re-auth) → session-only `revealed` map + Copy + hide. Matches spec. **No Rotate endpoint or flow exists** (delete warns about no downstream rotation).
- **OCC**: `getGlobalSetting` = `getWithEtag`; `updateGlobalSetting` = `patchWithEtag` (If-Match + `expectedVersion`); 412 → `OccConflictAlert` with `detail.refetch()` reloading the ETag in place while keeping edits. Already matches spec — port, don't rebuild.
- **History**: no history/versions endpoint on settings. Audit-logs feature exists (`features/audit-logs` + detail sheet) and can be queried per resource — candidate backing for the History tab.
- Tests: `components/__tests__/settings-screen.test.tsx`, `api/__tests__/settings-api.test.ts`.

**Delta summary**: namespace-grouped list + filter chips (new), row→drawer with tabs (new, on TASK-437 `DetailDrawer`), `CodeEditor` for Json/Array (new, from TASK-437), Rotate (backend gap — scoped decision below), History tab (backed by audit logs or deferred), mobile sheet + card rows (new). Reveal, OCC, delete-confirm reusable.

### Open items resolved in this plan

1. **Rotate**: no gateway endpoint. v1 ships Rotate as a **guided replace** — button focuses the write-only value field with helper copy ("enter a new secret to rotate; the old value is replaced on save"). A real server-side rotation (regenerate/invalidate) is filed as an API-gap follow-up. If the product owner wants a hard endpoint in v1, this ticket blocks on that API ticket.
2. **History tab**: v1 = read-only list from `GET /admin/audit-logs?resourceType=GlobalSetting&resourceId=:id` (endpoint shape confirmed during build against `features/audit-logs/api`); shows actor · action · timestamp · version. If the audit query can't filter this way, the tab ships showing current version/updatedBy meta only, with the gap noted here.

## Implementation Plan

TDD; order: list rework → drawer shell → value tab → secrets → history → responsive → e2e.

### 1. List rework (`settings-screen.tsx`)

- Namespace grouping: group header rows inside the grid (namespace label + count) — `AdminDataGrid` grouped-row variant; falls back to a namespace sort + sticky group separators if grouping is not supported by `VirtualizedDataGrid` (check `use-grid-layout.ts` first; do not fork the grid).
- Filter chips: Namespace (faceted multi-select), Type (dataType), **Secrets only** toggle chip; Tenant filter stays (unscoped admins). Search unchanged (nuqs).
- Row click opens the drawer (no more pencil-modal); actions column reduces to delete (+ overflow).
- Tests first: grouping renders; chips filter; row click sets `?setting=` URL state.

### 2. Drawer shell

`features/settings/components/setting-drawer.tsx` on `DetailDrawer` (TASK-437), `size="lg"`:

- Header: key (mono) · type badge · secret badge; meta row namespace · scope (Global/tenant) · `v{version}` · updated-by/at.
- Tabs `variant="line"`: **Value / Details / History**. Footer: Cancel · Save (disabled: pristine or invalid), destructive Delete in overflow.
- Detail data via existing `useGlobalSetting(id)` (fresh ETag on open — same pattern as `EditSettingDialog` today).
- Tests: opens from row, header/meta content, tab switching, focus trap, mobile full-screen variant.

### 3. Value tab (type-aware)

`features/settings/components/value-editor-pane.tsx` (supersedes `ValueEditor`):

- `Boolean` → Switch; String/Integer/Float/Double/Decimal/Uuid → Input (numeric inputmode where apt); Date/DateTime → native/typed inputs; `Binary` → read-only notice.
- `Json`/`Array` → `CodeEditor` (TASK-437) + `CodeEditorToolbar` (Format · Valid/parse-error badge with line/col · Copy). Save disabled while invalid (AC 2).
- OCC on save: `patchWithEtag` unchanged; 412 → `OccConflictAlert` inside the drawer above the footer; "Reload latest" refetches ETag, edits retained (AC 4).
- Tests first: per-type control mapping; invalid JSON blocks Save + shows line/col; Format normalizes; 412 → alert + edits intact.

### 4. Create flow

"+ New setting" opens the same drawer in create mode (name, key, namespace, dataType select, value pane, description in Details tab). `CreateSettingDialog` retired. Tests: create path posts the correct body; drawer resets after success.

### 5. Secrets

- Masked value pane with Reveal (existing `RevealSecretDialog` re-auth flow, moved into the drawer) → revealed plaintext + Copy + Hide (session-only map preserved).
- Rotate button per Open-item 1 (guided replace) with "audited" affordance copy (spec §9).
- Write-only edit: empty field = unchanged; non-empty replaces; Save disabled when secret & empty new value (existing rule carried over).
- Tests: reveal gated by `RequirePermission`; plaintext never in query cache (assert reveal not cached — mirrors `hooks.ts:50`); rotate focuses field.

### 6. History tab

Per Open-item 2: audit-log-backed list (actor, action, when, version) with skeleton/empty states. Tests with mocked audit client.

### 7. Responsive

Mobile: drawer → full-screen sheet (DetailDrawer built-in); list rows render as cards (key, type badge, masked value, updated) via grid card fallback. Tests under mocked tier.

### 8. Verification & evidence

- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (paste output)
- [ ] axe 0 violations (screen + drawer tests)
- [ ] Both themes (artboards 1b/5c) + mobile sheet (5f) verified via `next-dev-loop`; screenshots here
- [ ] Playwright e2e `tests/e2e/settings.spec.ts` updated: row→drawer, JSON invalid→Save disabled, reveal flow (mock), 412 path
- [ ] AC checklist all checked with evidence

## Implementation Summary

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §5 + artboards 1b/5c/5f; current-state map of `features/settings`; Rotate + History scoping decisions recorded. Status: Pending (awaiting plan approval). |
