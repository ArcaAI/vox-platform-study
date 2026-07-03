# TASK-394 — Admin Console P0 Frontend Wiring

**Ticket:** TASK-394
**Created:** 2026-07-02
**Updated:** 2026-07-02
**Status:** Completed
**Depends on:** TASK-381 (Users FE), TASK-382 (Agents FE), TASK-383 (Platform FE), TASK-388 (Users backend), TASK-389 (Agents backend)

> Source of scope: `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` — items **P0-1**, **P0-2**, **P0-3**.
> This ticket is **pure FE wiring** — every backend endpoint + SDK hook already exists (TASK-388/389).
> References TASK-381/382/383 without editing their READMEs.

---

## 1. Requirement Analysis

Three P0 (highest-leverage) frontend items — ship value the backend already paid for, plus one
defense-in-depth security guard.

### P0-1 — Wire the TASK-381 Users surfaces to the TASK-388 backends
Six sub-surfaces were shipped as `Target` placeholders in TASK-381 while the backend landed. Wire them
to the now-existing SDK hooks:

| Sub-item | SDK (confirmed signatures) |
|---|---|
| Reset password (temporary password **or** emailed reset link) | `useUsers().resetPassword(userId, { mode, temporaryPassword? })` → `{ mode, temporaryPassword?, token?, resetPath?, expiresInSeconds?, emailSent? }`; public completion `useUsers().completePasswordReset({ token, newPassword })` |
| Server-side bulk bar (enable / disable / delete / assign-departments) | `useUsers().bulkAction({ action, ids, departmentIds?, primaryDepartmentId? })` → per-item `{ total, succeeded, failed, results }` |
| Excel / PDF export | `useUsers().exportUsers({ format: 'csv'\|'xlsx'\|'pdf', … })` → `Blob` |
| Admin-edit **another** user's preferences | `useUserSettings().listForUser(userId)` / `updateForUser(userId, ns, key, value)` |
| Per-user `USER_PERSONAL` prompts | `usePrompts().list({ scope: 'USER_PERSONAL', ownerUserId })` |
| Cross-user DNA | `useDnaStyle().adminGetReportForDoctor / adminGetVersions / adminGenerateForDoctor` |

### P0-2 — Wire TASK-382 version-diff to the TASK-389 server diff
`usePrompts().compareVersions(id, v1, v2)` is already server-backed (hits `…/versions/:from/diff/:to`).
The base repoint already lives in the working tree. Remaining value: **surface the richer per-field
breakdown** (content vs variables) that the server returns but the SDK's back-compat mapping drops.

### P0-3 — Route-level super-admin `beforeLoad` guard (R1, defense-in-depth)
`requireSuperAdmin` routes (`/dashboard`, `/system-health`, `/roles`, `/settings`) rely only on nav-hide
+ API-403. Thread roles through the TanStack Router context and add a role-aware `beforeLoad` that
redirects non-super-admins.

### Acceptance criteria
- Reset-password (both modes), server bulk actions, xlsx/pdf export, admin edit-other preferences,
  per-user personal prompts, and cross-user DNA generate are all live (no `Target` placeholders left on
  those surfaces).
- Version diff surfaces the per-field breakdown from the server diff.
- Non-super-admins are redirected away from super-admin routes by a `beforeLoad` guard (in addition to
  the existing nav-hide + API-403).
- FE typecheck + `pnpm build` (admin) clean; live Playwright `task-394-*` specs green across viewports.

---

## 2. Current State Evaluation

- SDK dist (`packages/agentic-sdk-v2/dist`) is current with source (contains `bulkAction`, `exportUsers`,
  `resetPassword`, `completePasswordReset`, `listForUser`, `updateForUser`, `adminGenerateForDoctor`, …).
  Admin **typecheck** resolves `@arcaai/vox` → source (tsconfig paths); **Vite runtime/E2E** resolves →
  dist (package `exports`). Any new SDK method therefore requires a `dist` rebuild for runtime.
- Users list/detail (`routes/_authenticated/tenants/$tenantId/users/*`) + detail panels
  (`features/users/detail/*`) render the `Target` placeholders described above.
- `features/agents/version-diff.tsx` + `diff-model.ts` already consume the server `DiffResult` via the
  diff route calling `compareVersions`.
- Router context (`__root.tsx` `RouterContext`) carries only `isAuthenticated`; `main.tsx` supplies it.

### Ownership boundaries (per task brief)
- **OWN:** `apps/admin/src/**` for the **users** + **agents(version-diff)** features, the
  **route-definition / router-context / guards**, `apps/admin/e2e/task-394-*` specs, this doc, and a
  minimal additive SDK wrapper if a thin gap blocks wiring.
- **DO NOT TOUCH:** roles / settings / api-keys **feature components** (may only add the P0-3 guard to
  their *route-definition* files), `docs/qa/**`, TASK-380 README, any `apps/api` / backend `packages/**`,
  entitlements FE.

---

## 3. Implementation Plan

1. `features/users/download.ts` — add `downloadBlob` + timestamped export filename helper.
2. Reset-password: new `features/users/reset-password-dialog.tsx` (temp + link modes via `resetPassword`);
   new public `routes/reset-password.tsx` completion page (`completePasswordReset`); wire the dialog into
   the users list row-action + the user-detail header.
3. Bulk bar: `users-bulk-bar.tsx` → real enable/disable/delete/assign + Excel/PDF; users list page drives
   them through one `bulkAction` round-trip (per-item toast) and the toolbar Export through `exportUsers`.
4. `detail/preferences-panel.tsx` — read/write another user's settings via `listForUser` / `updateForUser`.
5. `detail/instructions-panel.tsx` — add a `USER_PERSONAL` personal-prompts section (`list({ scope, ownerUserId })`).
6. `detail/dna-reports-panel.tsx` + `dna-style-panel.tsx` — cross-user read/generate via `admin*` methods.
7. P0-2: add `usePrompts().compareVersionsDetailed` (returns the server superset incl. `fields`); surface a
   per-field breakdown row in `version-diff.tsx` via a `diff-model.ts` summarizer. Rebuild `@arcaai/vox` dist.
8. P0-3: extend `RouterContext` with `roles`; supply from `main.tsx`; add `lib/route-guards.ts`
   (`requireSuperAdmin` beforeLoad) and apply to `/dashboard`, `/system-health`, `/roles`, `/settings`.

### Test list (Playwright `apps/admin/e2e/task-394-*.spec.ts`)
- `task-394-users-p01.spec.ts` — reset-password dialog (both modes), bulk bar server actions present +
  Excel/PDF export enabled, preferences edit-other, personal prompts section, cross-user DNA generate.
- `task-394-version-diff-p02.spec.ts` — diff renders server-backed columns + per-field breakdown.
- `task-394-route-guard-p03.spec.ts` — non-super-admin redirected from `/dashboard` + `/system-health`;
  super-admin allowed.

---

## 4. Implementation Summary

All three P0 items are wired, live, and verified. Pure FE wiring on top of the existing
TASK-388/389 backends; the only SDK change is one **additive** method (`compareVersionsDetailed`).

### P0-1 — Users surfaces → TASK-388 backends
- **Reset password** — new `features/users/reset-password-dialog.tsx` runs both flows through
  `useUsers().resetPassword(userId, { mode })`: *emailed reset link* (`mode: 'link'`, audited) and
  *temporary password* (`mode: 'temporary'`, shows the one-time secret to copy). New **public**
  `routes/reset-password.tsx` completes a link reset via `useUsers().completePasswordReset({ token, newPassword })`.
  Wired into the users-list row action **and** the user-detail header + `ProfilePanel` button (the old
  `Target` placeholder + the misleading "Target" copy are gone).
- **Server bulk bar** — `features/users/users-bulk-bar.tsx` now performs enable / disable / delete /
  assign-departments in one `useUsers().bulkAction({ action, ids, … })` round-trip with a per-item
  result toast. (Tagged `data-testid="users-bulk-bar"` for deterministic E2E scoping.)
- **Excel / PDF export** — the users-list toolbar export runs `useUsers().exportUsers({ format })`
  (`csv` | `xlsx` | `pdf`) → `Blob`, saved via the new `downloadBlob` + timestamped-filename helpers in
  `features/users/download.ts`.
- **Admin edit-other preferences** — `features/users/detail/preferences-panel.tsx` reads/writes another
  user's settings via `useUserSettings().listForUser(userId)` / `updateForUser(userId, ns, key, value)`.
- **Per-user personal prompts** — `features/users/detail/instructions-panel.tsx` gained a
  `USER_PERSONAL` section (list/create/edit/delete) via doctor-scoped `usePrompts` (`scope`, `ownerUserId`).
- **Cross-user DNA** — `dna-reports-panel.tsx` / `dna-style-panel.tsx` read + generate through the
  `adminGetReportForDoctor` / `adminGetVersions` / `adminGenerateForDoctor` methods.

### P0-2 — Version diff → TASK-389 server diff
- `features/agents/version-diff.tsx` + `diff-model.ts` render the server `DiffResult`, and now also a
  **per-field breakdown** (content vs variables) surfaced as a chip row. That richer superset comes from a
  thin **additive** SDK method `usePrompts().compareVersionsDetailed(id, v1, v2)` →
  `PromptVersionDiff` (new type in `types/diff.ts`, re-exported from the SDK barrels). The diff route
  (`…/agents/$promptId/diff.tsx`) calls the detailed variant. **`@arcaai/vox` dist rebuilt** so the Vite
  runtime/E2E picks up the new method (dist is gitignored build output; presence verified in `dist/index.mjs`).

### P0-3 — Route-level super-admin guard (defense-in-depth)
- `RouterContext` (`routes/__root.tsx`) extended with `isSuperAdmin` + `tenantId`; `main.tsx` supplies
  them from `useAuthStore` and calls `router.invalidate()` whenever auth / roles / tenant change.
- New `lib/route-guards.ts` `requireSuperAdmin(context)` — `beforeLoad` that bounces a non-super-admin to
  their own `/tenants/$tenantId` (or the not-found screen for a degraded, tenant-less session). Applied to
  the four pure-platform surfaces: `/dashboard`, `/system-health`, `/roles`, `/settings`.
  **`/tenants` is deliberately NOT guarded** (shared post-login landing; tenant-admins legitimately see an
  API-scoped view). The edits to `roles.tsx` / `settings.tsx` are limited to the `beforeLoad` guard line
  (route-definition only — their feature components were untouched, per ownership).

### Files

**Created (4)**
- `apps/admin/src/features/users/reset-password-dialog.tsx`
- `apps/admin/src/features/users/sdk-types.ts` — local SDK-derived types (no SDK edit needed for these)
- `apps/admin/src/lib/route-guards.ts`
- `apps/admin/src/routes/reset-password.tsx` (public completion page)

**Modified — admin (18)**
- Users: `features/users/download.ts`, `users-bulk-bar.tsx`,
  `detail/{profile,preferences,instructions,dna-reports,dna-style}-panel.tsx`,
  `routes/_authenticated/tenants/$tenantId/users/{index,$userId}.tsx`
- Agents: `features/agents/{diff-model.ts,version-diff.tsx}`,
  `routes/_authenticated/tenants/$tenantId/departments/$departmentId/agents/$promptId/diff.tsx`
- Routing/guard: `main.tsx`, `routes/__root.tsx`,
  `routes/_authenticated/{dashboard,system-health,roles,settings}.tsx`

**SDK — additive only (4 src + dist rebuild)**
- `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` — `compareVersionsDetailed`
- `packages/agentic-sdk-v2/src/types/diff.ts` — `PromptVersionDiff` + `PromptVersionDiffField`
- `packages/agentic-sdk-v2/src/types/index.ts`, `src/core.ts` — barrel re-exports
- `dist/**` rebuilt (`pnpm --filter @arcaai/vox build`; gitignored)

**E2E specs (3, authored this ticket)**
- `apps/admin/e2e/task-394-users-wiring.spec.ts`
- `apps/admin/e2e/task-394-version-diff.spec.ts`
- `apps/admin/e2e/task-394-superadmin-guard.spec.ts`

### Verification (evidence)
- **Typecheck** — `pnpm --filter @arcaai/admin type-check` (`tsc --noEmit`) → exit 0, no output.
- **Build** — `pnpm --filter @arcaai/admin build` (`vite build`) → `✓ built in 8.73s` (only the
  pre-existing >500 kB chunk-size advisory; not an error).
- **Live Playwright** (`SKIP_DB_PRECHECK=true`, non-destructive, real API `:8868` + Vite `:5174`),
  across desktop / tablet / mobile:
  - Full `task-394` suite → **20 passed, 1 skipped** (the skip is the mobile bulk-bar case — server bulk
    selection is intentionally not offered on the mobile card-list).
  - Guard spec alone → **6/6 passed** on all three viewports (the mobile hard-load hydration race was
    hardened out: the assertion now proves the viewport-agnostic security property — a non-super-admin is
    never left on the guarded surface — via `expect.poll` on the pathname + heading-absent, which still
    fails if the guard were removed).
- **Stack** — clean `dev:api:test` confirmed: API `:8868` (rate-limiting OFF — 12 rapid `/health` hits all
  200) and admin dev `:5174` both healthy. No commits/pushes, no backend/DB edits, no DB reset, no edits
  to the roles/settings/api-keys feature components or `docs/qa`.

---

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; P0-1/2/3 plan captured. Clean `dev:api:test` restart (RATE_LIMIT default OFF). | this README |
| 2026-07-02 | P0-1/2/3 implemented + wired; SDK `compareVersionsDetailed` added (dist rebuilt); `task-394-*` specs authored. Typecheck + build clean; suite 20✓/1 skip across viewports. | see §4 Files |
| 2026-07-02 | Hardened mobile super-admin-guard spec against the cold hard-load hydration race (`expect.poll` on pathname + heading-absent). Guard spec 6/6 green all viewports. | `e2e/task-394-superadmin-guard.spec.ts` |
