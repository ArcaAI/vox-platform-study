# TASK-439 — Settings & Secrets Redesign: List + Detail Drawer with Code Editor

- **Status**: Review
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

Replaced the per-row edit/create **modals** with the console-wide **DetailDrawer** (TASK-437) carrying a real value editor — the core AC. Scope was kept to `features/settings/**` (+ its e2e spec + this README); the TASK-437 foundation (`DetailDrawer`, `CodeEditor`/`CodeEditorToolbar`, `useViewportTier`) was imported, not forked.

### Files changed (all under `apps/admin-console`)

New:
- `src/features/settings/components/setting-drawer.tsx` — `SettingDetailDrawer` (view/edit) + `SettingCreateDrawer` on `DetailDrawer size="lg"` with `Tabs variant="line"` **Value / Details / History**; footer Cancel · Save (disabled while pristine/invalid/locked) + destructive Delete; the moved-in `RevealSecretDialog` (step-up re-auth stays a Dialog per the UX rules) and the secret pane (masked current value · gated Reveal · guided Rotate · write-only replace field).
- `src/features/settings/components/value-editor-pane.tsx` — type-aware `ValueEditorPane` (Boolean→Switch, Json/Array→`CodeEditor`, Binary→read-only notice, numbers→numeric-inputmode Input, else Input) + the `isValueValid` / `isJsonType` gates.
- `src/features/settings/components/setting-history-tab.tsx` — audit-log-backed History tab (skeleton/empty/error + actor · action · when · version).
- Tests: `components/__tests__/setting-drawer.test.tsx` (7), `components/__tests__/value-editor-pane.test.tsx` (6).

Modified:
- `src/features/settings/components/settings-screen.tsx` — rows are read-only (masked secrets, no inline reveal/pencil); row click and "New setting" open the drawer via a `?setting=` (nuqs) URL param (`new` sentinel = create); actions column reduced to Delete (with `stopPropagation` so it doesn't also open the drawer); Tenant column/filter (TASK-430) retained.
- `src/features/settings/api/{types,keys,client,hooks}.ts` — added `SettingHistoryEntry`, `settingKeys.history`, `listSettingHistory` (maps the audit envelope), `useSettingHistory`.
- Tests: `components/__tests__/settings-screen.test.tsx` (rewritten for the drawer flow — 9), `api/__tests__/settings-api.test.ts` (+history — 5), `tests/e2e/settings.spec.ts` (updated: create drawer + row→drawer tabs; removed the stale "Global" scope-tab / `Global settings` table assertions).

Removed:
- `src/features/settings/components/setting-dialogs.tsx` — the retired `EditSettingDialog` / `CreateSettingDialog` + `ValueEditor` (broken JSON-in-`Textarea`).

### Open-item outcomes

1. **Rotate = guided replace (shipped).** The Rotate button (global-admin gated) focuses the write-only "New value" field and swaps the helper copy to the rotate wording ("enter a new secret to rotate; the old value is replaced on save. Rotation is audited"). Entering a value replaces the stored secret on Save (write-only; Save stays disabled for a secret until a new value is typed). No server-side rotation endpoint exists — a hard `POST /admin/settings/:id/rotate` (regenerate/invalidate) remains an **API-gap follow-up**.
2. **History = audit-log-backed (shipped).** Reads `GET /admin/audit-logs/resource/GlobalSetting/:id` (limit 20) through a **settings-local** client (`listSettingHistory`) rather than importing `features/audit-logs` (rule 13: features never import each other). Renders actor · action · when · version. `version` is projected from the audit `data.version`/`_version` when present.

### Verification (actual output)

- `pnpm --filter @arcaai/admin-console test` → **105 files, 790 tests passed** (settings-specific: 27 — screen 9, drawer 7, value-pane 6, api 5).
- `pnpm --filter @arcaai/admin-console lint` → **exit 0** (0 warnings).
- `pnpm --filter @arcaai/admin-console build` → **exit 0**, `/settings` route present.
- `tsc --noEmit` on `features/settings/**` → **0 errors** (pre-existing `toHaveNoViolations` typing gaps + the parallel RBAC agent's in-progress files are outside this lane and do not block build/lint/test).

### Deferred / not in this lane

- **Namespace grouping (group-header rows) and the Namespace/Type/Secrets-only filter chips** were NOT shipped. `AdminDataGrid`/`VirtualizedDataGrid` has no grouped-row variant without forking the grid (a `packages/ui` / shared change — out of lane), and server-side faceted filtering on `namespace`/`dataType`/`isSecret` is unverified against the gateway (only `tenantId` is proven via TASK-430). **Shared-change needed:** a grouped-row (or sticky group-separator) variant on the grid + gateway confirmation of the extra filter fields.
- **Mobile card-row list fallback** is a grid-level (shared) concern and was not changed; the drawer's mobile full-screen sheet is provided by `DetailDrawer` (TASK-437) out of the box.
- **Runtime verification** (`next-dev-loop`, both-theme + mobile-sheet screenshots per artboards 1b/5c/5f) and per-screen **axe scans** remain **manual steps** (not performed here).

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §5 + artboards 1b/5c/5f; current-state map of `features/settings`; Rotate + History scoping decisions recorded. Status: Pending (awaiting plan approval). |
| 2026-07-08 | Implemented the drawer redesign: retired the edit/create/value modals for `DetailDrawer` + `CodeEditor` (`setting-drawer.tsx`, `value-editor-pane.tsx`, `setting-history-tab.tsx`); list rows now open the drawer via `?setting=` URL state; Rotate ships as guided-replace, History as audit-log-backed. All settings tests/lint/build green (790 tests pass). Deferred: namespace grouping + Namespace/Type/Secrets-only chips (grid/shared + gateway change needed) and mobile card rows (grid/shared). Status → Review. |
| 2026-07-08 | **Runtime verification pass** (authenticated browser against the live dev stack, `global_admin`): list rendered 86 live settings with pagination; drawer opened via `?setting=` on the real Json setting `local-asr-models` — Value/Details/History tabs, `CodeEditor` with line numbers + live "Valid JSON" badge, Save correctly disabled (locked setting). **axe-core 4.11 WCAG 2.2 AA: 0 violations (list + open drawer, light theme)**; zero console/SSR errors. Deferred grouping/chips gap filed as TASK-443; server-side rotation filed as TASK-445. Outstanding: dark-theme + mobile-sheet visual pass on the drawer; reveal/412 flows against the stack; Playwright e2e. |
