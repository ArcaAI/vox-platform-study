# TASK-440 — Tenant Settings Redesign: Profile Tabs + Category Sub-Nav

- **Status**: Review
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

- [x] Categories navigable; each field uses the control matching its dataType. *(rail nav + `controlFor`; test "navigates settings categories and renders the type-aware control")*
- [x] Locked + computed rows are non-editable and clearly marked. *(lock icon + "Platform-managed"/"Read-only" badge + disabled control; test "locked and synthetic read-only rows cannot be edited")*
- [x] Save sends per-row If-Match; 412 preserves drafts and reloads versions. *(sequential per-row PATCH; tests "per-category save…If-Match" + "surfaces the OCC alert on 412…keeping the draft")*

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

Status: **Review** (implemented 2026-07-08; runtime `next-dev-loop` + screenshot QA remain as manual steps — see below).

### Files changed (all under `apps/admin-console`)

| File | Change |
|---|---|
| `src/features/account/lib/config-categories.ts` | **New.** Pure category model: ordered `CONFIG_CATEGORIES`, `categorize()` (key/namespace → CategoryId, unknown → `general`), `groupByCategory()`, and `controlFor(dataType)` → control kind. |
| `src/features/account/lib/__tests__/config-categories.test.ts` | **New.** 5 tests: keyword bucketing, unknown fallback, determinism/case-insensitivity, grouping order, dataType→control mapping. |
| `src/features/account/components/tenant-settings-tab.tsx` | **New.** Settings tab: category rail (vertical desktop/tablet, horizontal chip scroll on mobile via `useViewportTier`), type-aware form pane (`ConfigControl`), per-category save bar, sequential per-row OCC save, `OccConflictAlert`, skeletons, empty states. |
| `src/features/account/components/tenant-profile-screen.tsx` | **Reworked** into a 3-tab shell (`Organization` · `Plan & usage` · `Settings`) using `<Tabs>` + `TabsList variant="line"` in the `ScreenTemplate` `tabs` slot; `?tab=` via nuqs. Identity (read-only) and entitlements panels relocated into tabs; skeleton/no-tenant/error gates preserved. |
| `src/features/account/components/__tests__/tenant-profile-screen.test.tsx` | **Rewritten** for the tabbed structure: tab render + `?tab=` deep-link, category nav, per-dataType control, per-row If-Match PATCH, 412→OCC (drafts kept + versions reloaded), read-only rows non-editable, mobile chip rail (mocked tier), skeleton, error-retry. 14 tests. |
| `tests/e2e/account.spec.ts` | **Extended** with a defensive `tenant profile — tabs + settings sub-nav (TASK-440)` describe: tab presence, `?tab=plan` deep-link, Settings rail/empty, axe (light+dark). Tolerates the seeded admin's NoTenant state. |

### Batch-save / If-Match decision (step 4 — resolved during build)

**Decision: sequential per-row PATCH, one request per dirty row, each carrying its own `If-Match: "<row.version>"`. NOT a single batched request.**

Root cause (verified in the gateway, `apps/api/src/modules/tenant/my-tenant.controller.ts`): `PATCH me/config` is decorated `@RequiresIfMatch()` (the `If-Match` header is **mandatory** — omitting it → 428) **and** when the header is present the controller overwrites *every* row's `expectedVersion` with the header value (`configs.map((c) => ({ ...c, expectedVersion: expectedFromHeader }))`). A heterogeneous multi-version batch therefore cannot be expressed in one request — a single header version would spuriously 412 any row whose real version differs. The plan's fallback path applies: fire the dirty rows sequentially, each as a single-item `updates` array with its own header version. This preserves per-row OCC (AC 3). Client transport confirms body-only versions are not viable here: `shared/api/http.ts` only sends `If-Match` when an `etag` is passed, and the route rejects its absence with 428.

Semantics note: because each row is its own request, a mid-run 412 stops the loop with already-saved rows committed and the conflicting/unsaved rows' drafts retained ("no silent loss"); the user reloads versions and re-saves. This is per-row all-or-nothing rather than whole-category atomicity (the gateway offers no atomic heterogeneous-version bulk path).

### Category key mapping

`categorize()` scans `"<namespace> <key>"` (lower-cased), first match wins, unknown → `general`:

| Category | Matches (namespace or key contains) |
|---|---|
| **Security** | security, auth, session, password, mfa, sso, login, lockout, token |
| **Data & residency** | residency, region, retention, storage, backup, `data-`, archive, export |
| **Notifications** | notif, email, webhook, alert, smtp, digest, reminder |
| **Clinical defaults** | clinic, consult, transcription, stt, asr, diariz, capture, audio, summar, dna, harness, documentation, noise, vad |
| **General** | everything else (feature flags, UI, misc) — the fallback |

Control mapping (`controlFor`, case-insensitive; tolerates PascalCase `ValueType` and lowercase gateway aliases): `Boolean`→Switch · `Integer/Float/Double/Decimal/number`→numeric Input (`inputmode=decimal`) · `Date/DateTime`→date Input · `Json/Array`→mono Textarea · else→text Input. Per the plan, the heavy `CodeEditor` stays a settings-screen concern; Json rows use a mono textarea here (the seeded tenant config surfaces no Json key on this self-service screen — only the synthetic Boolean `enable-local-raw-capture` and string/number/locked rows).

### Verification evidence

- `pnpm exec vitest run src/features/account` → **Test Files 4 passed (4), Tests 26 passed (26)** (includes the 5 lib tests + 14 rewritten screen tests + pre-existing account-screen/api tests).
- `pnpm exec eslint src/features/account tests/e2e/account.spec.ts` → **clean (exit 0)**.
- `pnpm exec tsc --noEmit` → **0 errors in `features/account`** (Next `build` compiled successfully in 12.2s; the whole-project type-check is currently blocked by an unrelated in-progress file `features/rbac/components/role-detail.tsx` owned by a parallel task — outside this ticket's lane).

### Remaining manual steps (not done here)

- Runtime verification via `next-dev-loop` against a seeded tenant with config rows (dirty→save-bar→412 flow) and light/dark + mobile chip-rail screenshots (2b/5h) for the ticket.
- Full-app `pnpm --filter @arcaai/admin-console build lint test` will go green once the parallel RBAC/settings work lands (the RBAC `role-detail.tsx` type error and an rbac `_dbg.test.tsx` lint error are not in this ticket's scope).

### Shared-change needed (deferred)

- The TASK-440 screen lives at route `/tenant-profile`; its natural e2e home is `tests/e2e/tenant-profile.spec.ts`, but that file is outside this task's edit lane (only `account.spec.ts` was permitted). The tab/category/no-tenant e2e coverage was appended to `account.spec.ts` instead. A follow-up may migrate/duplicate these into `tenant-profile.spec.ts` for locality. (`tenant-profile.spec.ts` still passes unchanged — the redesign preserves the `region "Organization"` it asserts.)

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §6 + artboards 2b/5h; current-state map of `features/account`; endpoint discrepancy (`entitlements/me`) and batch-save/If-Match decision recorded. Status: Pending (awaiting plan approval). |
| 2026-07-08 | Implemented redesign: category lib (`config-categories.ts`) + tab shell + Settings tab (rail/form pane/per-category save bar) + mobile chip rail. Resolved batch-save decision to **sequential per-row If-Match PATCH** (gateway route is `@RequiresIfMatch()` and folds the header version onto every row, so heterogeneous batches are impossible in one request). Account tests 26/26 pass; account lint clean; account files type-clean. Status → Review. Runtime `next-dev-loop`/screenshot QA flagged as remaining manual steps. |
