# TASK-440 — Tenant Settings Redesign: Profile Tabs + Category Sub-Nav

- **Status**: Pending
- **Type**: feature (UX/UI redesign — `/tenant-profile`)
- **Owner**: admin-console
- **Design source**: project "ARCAAI Hope Admin console" (`https://claude.ai/design/p/6a582386-939b-47d3-8c19-cd9338b34814`) — build spec §6; artboards `2b` (desktop), `5h` (mobile).
- **Related**: **depends on TASK-437** (viewport tiers; banner conventions). TASK-426 (tenant buckets), TASK-430.

## Requirement Analysis

Route `/tenant-profile`, tier 20–29 (self-service). Reframe the flat profile into tabs and give the Settings tab a category sub-nav + focused form, replacing the flat list of tiny inline inputs.

- **Tabs**: **Organization** · **Plan & usage** · **Settings**.
- **Settings tab**: left category rail — General, Clinical defaults, Notifications, Security, Data & residency — right form pane; each row = label · description · type-appropriate control. Locked/computed rows read-only (lock icon; "platform-managed"/"read-only" note). **Footer save bar per category** (batch save of that category's dirty rows).
- **Data (unchanged)**: `GET /tenant/me` (identity; 400/404 → "pick a working tenant"); `GET /tenant/me/config?page=0` (appends a synthetic read-only row, id '', v0); `PATCH /tenant/me/config` (per-row If-Match + expectedVersion; all-or-nothing 412); entitlements for Plan & usage. *(Actual entitlements endpoint in code is `GET entitlements/me` — the spec's `/tenant/me/entitlements` is representative; keep the real one.)*
- **States**: no-tenant empty state; OCC alert keeps drafts ("no silent loss") and re-saves against fresh versions. Mobile (5h): category rail → horizontal chip scroll; single-column form; pinned Save.

### Acceptance criteria (spec §6)

- [ ] Categories navigable; each field uses the control matching its dataType.
- [ ] Locked + computed rows are non-editable and clearly marked.
- [ ] Save sends per-row If-Match; 412 preserves drafts and reloads versions.

## Current State Evaluation

Verified 2026-07-08 (`apps/admin-console/src/features/account/`):

- `components/tenant-profile-screen.tsx`: **flat single-column stack of three `<section>`s** inside `ScreenTemplate` — Organization (read-only Card `<dl>`), Plan & entitlements (badges + three `CapabilityList` cards fed by `useMyEntitlements` → `GET entitlements/me`), Tenant settings (config rows). **No tabs, no categories.**
- Config editing: per-row inline `Input h-8 w-56` + per-row Save; drafts map keyed by config id; `useUpdateMyTenantConfigs` → `PATCH tenant/me/config` with a **single-item** updates array `[{ id, value, expectedVersion: config.version }]` and `etag: '"version"'` (If-Match header folds onto every row server-side — `api/client.ts:22-25`). The bulk endpoint is already there; the UI just never batches.
- Synthetic read-only row: `readOnly = Boolean(config.locked) || !config.id` (line 361) with a "Read-only" badge — matches the locked/computed requirement, needs the lock icon + note styling.
- OCC: 412 → `OccConflictAlert` in the `statusBanner` slot; onReload keeps drafts + `configsQuery.refetch()` — matches "no silent loss".
- No-tenant: `isNoTenantError` (400 or 404) → `EmptyState` "No working tenant selected". Matches spec.
- Config rows carry no category metadata in the client type (`TenantConfig` from `features/tenants/api/types.ts`) — **categorization is a client-side mapping to build** (key-prefix/namespace → category), unknown keys land in "General".
- Value rendering is string-only Inputs today — no dataType-aware controls on this screen (unlike settings' `ValueEditor`).
- Tests exist: `components/__tests__/tenant-profile-screen.test.tsx` (includes axe), `api/__tests__/account-api.test.ts`.

**Delta summary**: tabs (new), category rail + form pane (new), per-category batch save bar (new — the PATCH already accepts an updates array), dataType-aware controls (port the pattern from settings), lock styling upgrade, mobile chip-rail (new). Identity card, entitlement cards, OCC alert, no-tenant gate all reusable.

## Implementation Plan

TDD; order: category mapping lib → tab shell → settings tab → batch save/OCC → responsive → e2e.

### 1. Category mapping (pure, test-first)

`features/account/lib/config-categories.ts`: ordered categories `general, clinical, notifications, security, data-residency` with label/description; `categorize(config: TenantConfig): CategoryId` from key prefix/namespace conventions (inventory actual keys from the seeded config during build; mapping table lives here, unknown → `general`). Also `controlFor(dataType)` mapping (reuse decisions from TASK-439's type-aware pane: Boolean→Switch, numeric→Input inputmode, Date→date input, Json→mono textarea for v1 on this screen — the heavy CodeEditor stays a settings-screen concern unless a Json tenant key exists; confirm during inventory).
- Tests: mapping determinism; unknown-key fallback; control mapping per dataType.

### 2. Tab shell

Rework `tenant-profile-screen.tsx`: wrap in `<Tabs>` with `TabsList variant="line"` in the `ScreenTemplate` `tabs` slot (house pattern from rule 11):
- **Organization** — existing read-only identity Card (unchanged, remains read-only; no tenant PATCH exists).
- **Plan & usage** — existing entitlements section (badges + CapabilityLists) relocated.
- **Settings** — new (step 3).
- URL state `?tab=` via nuqs. Tests: three tabs render relocated content; deep-link works.

### 3. Settings tab — category rail + form pane

`features/account/components/tenant-settings-tab.tsx`:

- Desktop: left rail (buttons list, counts, lock icon on categories containing only read-only rows) + right form pane: category heading + description, then rows — `<Label>` + muted description + control (from `controlFor`), lock icon + "platform-managed"/"read-only" note for `locked || !id` rows, meta line `v{n} · updated {rel}`.
- Selected category in URL (`?category=`).
- Skeletons matching the form shape; `Empty` for a category with no rows.
- Tests: rail navigation; per-dataType control rendering (AC 1); read-only rows non-editable + marked (AC 2).

### 4. Per-category batch save + OCC

- Drafts map keyed by config id (existing pattern) scoped per category; footer save bar (pinned within the tab pane, `shrink-0`) appears when the category has dirty rows: "N unsaved changes · Cancel · Save".
- Save: one `PATCH tenant/me/config` with **all dirty rows of the category** as `updates[] = [{ id, value, expectedVersion }]` — **omit the If-Match header** so each row's own `expectedVersion` is authoritative (the header would fold one version onto every row; confirm gateway accepts body-only versions during build — if the header is mandatory, fall back to sequential per-row saves with per-row If-Match, preserving AC 3 semantics either way; record the outcome here).
- 412 (all-or-nothing): `OccConflictAlert` above the save bar; drafts retained; "Reload latest" refetches versions; user re-saves (AC 3).
- Tests first: batch payload shape; partial-dirty selection; 412 → drafts intact + versions reloaded; save bar disable while pending.

### 5. Responsive (artboard 5h)

- Mobile: rail → horizontal scrollable chip row (`overflow-x-auto`, `snap`), single-column form, save bar pinned bottom (`shrink-0` inside the tab pane), ≥ 44px targets.
- Tablet: rail persists at reduced width. Tests under mocked tier.

### 6. Verification & evidence

- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (paste output)
- [ ] axe 0 violations (existing screen test extended)
- [ ] Both themes + mobile chip rail verified via `next-dev-loop`; screenshots (2b/5h) here
- [ ] Playwright e2e `tests/e2e/account.spec.ts` extended: tab nav, category nav, dirty→save bar, no-tenant empty state
- [ ] AC checklist checked with evidence; If-Match/batch decision from step 4 recorded

## Implementation Summary

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §6 + artboards 2b/5h; current-state map of `features/account`; endpoint discrepancy (`entitlements/me`) and batch-save/If-Match decision recorded. Status: Pending (awaiting plan approval). |
