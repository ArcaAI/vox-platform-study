# TASK-399 — Mobile Full-Screen Dialogs · Long Tail (D6)

| | |
|---|---|
| **Ticket** | TASK-399 |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Type** | Frontend / responsive presentation only |
| **Origin** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` item **P1-8**; deferred item **D6** of TASK-384 (clears RSP-04.7) |

## 1. Requirement Analysis

TASK-384 established the responsive admin pattern and made the high-traffic
mutation dialogs (tenant/user/department forms, checkbox picker, tags dialog)
full-screen on mobile via the `MOBILE_DIALOG_CONTENT` / `MOBILE_DIALOG_FOOTER`
fragments in `apps/admin/src/lib/responsive.ts`. It deferred the "long tail"
(D6): agent/entitlement/role/policy dialogs, the `AlertDialog` confirms, the
role-policies sheet, and the ≥44px touch-target bump for **in-form**
inputs/controls (WCAG 2.2 AA · 2.5.8).

**Acceptance criteria**

- Every `DialogContent` / `AlertDialogContent` in `apps/admin/src` renders
  full-screen on mobile (< 640px) using the SAME TASK-384 fragments — no new
  pattern; desktop/tablet presentation byte-identical.
- In-form `Input` / `Select` triggers inside dialogs reach ≥44px touch height
  on mobile; footers keep the 44px action bump.
- Sheets: full-bleed on mobile with ≥44px interactive controls.
- Zero behavioral change (FE presentation only, no backend/SDK/schema/DB).
- Live Playwright evidence on the running stack (`:8868` API, `:5174` admin)
  plus a task-384 regression re-run.

## 2. Current State Evaluation

- `lib/responsive.ts` (TASK-384) shipped `MOBILE_DIALOG_CONTENT`,
  `MOBILE_DIALOG_FOOTER`, `MOBILE_DIALOG_FOOTER_DEEP`. Already applied to:
  tenant-form, department-form, user-create, user-edit, checkbox-picker,
  tenant-tags dialogs — and by the TASK-394/395/396/398 additions
  (reset-password, assign-role, reveal-secret, sectioned-settings, roles-browser,
  instructions-panel, users-bulk-bar).
- Missing (the D6 long tail): agent-instruction, policy-form, role-form,
  plan-edit, tenant-override, assign-slot, roles route view-dialog, settings
  route create-dialog, api-keys route create/rotate dialogs, both
  `AlertDialogContent` confirms (`confirm-delete`, `tenant-lifecycle-menu`),
  and the role-policies sheet controls. No fragment existed for
  `AlertDialogContent`, and no in-form control bump existed.

## 3. Implementation Plan (approved)

1. Extend `lib/responsive.ts` — shared full-screen geometry + in-form 44px
   controls + `MOBILE_ALERT_DIALOG_CONTENT`. Local fragments only; the shared
   `@arcaai/ui` primitives stay untouched (also used by `ui-playground`).
2. Apply fragments across the long-tail dialogs/sheets (list below).
3. New live spec `apps/admin/e2e/task-399-mobile-dialogs.spec.ts` across the
   three viewport projects; re-run `task-384-responsive.spec.ts`.
4. Gates: type-check, build, lints, screenshots into `.uxu-verify/`.

## 4. Implementation Summary

### 4.1 Pattern (extended in `apps/admin/src/lib/responsive.ts`)

- `MOBILE_FULL_SCREEN_MODAL` (private): `max-sm:h-dvh max-sm:max-h-dvh
  max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0
  max-sm:overflow-y-auto` — shared by both modal primitives.
- `MOBILE_FORM_CONTROLS` (private): `max-sm:[&_[data-slot=input]]:min-h-11
  max-sm:[&_[data-slot=select-trigger]]:min-h-11` — bumps in-form `Input` /
  `Select` triggers to ≥44px on mobile via `min-h` (wins over the primitives'
  `h-9` regardless of CSS order; `Textarea` is already ≥44px).
- `MOBILE_DIALOG_CONTENT` = full-screen geometry **+ in-form controls** (all
  existing TASK-384 call sites gain the input bump automatically).
- `MOBILE_ALERT_DIALOG_CONTENT` (new) = full-screen geometry only (confirms
  carry no inputs; the stacked `flex-col-reverse` footer lands thumb-reachable).
- `MOBILE_DIALOG_FOOTER` / `MOBILE_DIALOG_FOOTER_DEEP` unchanged (44px footer
  actions).

### 4.2 Dialogs/sheets treated (by feature)

| Feature | File | Applied |
|---|---|---|
| Tenants | `features/tenants/agent-instruction-dialog.tsx` | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER_DEEP` |
| Tenants | `features/tenants/tenant-lifecycle-menu.tsx` (suspend/archive/restore confirm) | `MOBILE_ALERT_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Roles | `features/roles/role-form-dialog.tsx` | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Roles | `features/roles/policy-form-dialog.tsx` (70vw/80vh editor) | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Roles | `features/roles/role-policies-sheet.tsx` | direct control bumps: search `max-sm:min-h-11`, detach `max-sm:size-11`, attach `max-sm:h-11` (sheet is already full-bleed via `w-full`) |
| Roles route | `routes/_authenticated/roles.tsx` (policy view dialog) | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Entitlements | `features/entitlements/plan-edit-dialog.tsx` | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Entitlements | `features/entitlements/tenant-override-dialog.tsx` | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Agents | `features/agents/assign-slot-dialog.tsx` | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Settings route | `routes/_authenticated/settings.tsx` (create dialog) | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| API keys route | `routes/_authenticated/api-keys.tsx` (create + rotate) | `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |
| Common | `features/common/confirm-delete.tsx` (ALL `ConfirmDelete` confirms: roles, policies, api-keys, departments, entitlements, users-bulk, instructions, tenant disable) | `MOBILE_ALERT_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` |

Already in-pattern before this ticket (TASK-384 + 394/395/396/398 additions,
now also gaining the in-form control bump through the shared fragment):
tenant-form, department-form, user-create, user-edit, checkbox-picker,
tenant-tags, reset-password, assign-role, reveal-secret, sectioned-settings,
roles-browser, instructions-panel, users-bulk-bar dialogs.

Sweep proof — every `DialogContent`/`AlertDialogContent`/`SheetContent` usage
in `apps/admin/src` now carries a mobile treatment; the only two files without
the fragment constant are intentional:

- `components/layout/app-shell.tsx` — the mobile nav drawer IS the mobile
  pattern (`w-[86vw] max-w-80` sheet).
- `features/roles/role-policies-sheet.tsx` — already full-bleed
  (`w-full` + `h-full`); given direct 44px control bumps instead.

### 4.3 Verification evidence (2026-07-02, live stack)

- `pnpm --filter @arcaai/admin type-check` — clean (`tsc --noEmit`, no output).
- `pnpm --filter @arcaai/admin build` — `✓ built in 10.08s` (pre-existing
  chunk-size advisory only).
- Live E2E against `:5174` → `:8868`
  (`SKIP_DB_PRECHECK=true pnpm --filter @arcaai/admin exec playwright test
  task-399-mobile-dialogs task-384-responsive`):
  **30 passed (14.0s)** — 18 task-399 (6 scenarios × desktop/tablet/mobile) +
  12 task-384 regression. Mobile asserts full-bleed geometry (x≈0, width/height
  ≥ viewport−4) and ≥44px controls; desktop/tablet assert the centered,
  width-capped modal is unchanged (controls still < 40px tall).
- Non-destructive: every dialog is opened then dismissed (Escape/Cancel);
  nothing submitted, no DB reset, API `/api/v1/health` 200 before/after.

Screenshots (mobile viewport, `.uxu-verify/`):

- `.uxu-verify/task-399-mobile-role-form-dialog.png`
- `.uxu-verify/task-399-mobile-policy-form-dialog.png`
- `.uxu-verify/task-399-mobile-alertdialog-confirm.png`
- `.uxu-verify/task-399-mobile-role-policies-sheet.png`
- `.uxu-verify/task-399-mobile-settings-create-dialog.png`

### 4.4 Files changed

| File | Change |
|---|---|
| `apps/admin/src/lib/responsive.ts` | Extended fragments (§4.1) |
| 12 dialog/sheet files (§4.2 table) | Fragment application only — class names, zero logic |
| `apps/admin/e2e/task-399-mobile-dialogs.spec.ts` | New live responsive spec |
| `docs/implementation/TASK-399-Mobile-Dialogs-Long-Tail/README.md` | This document |

No backend, SDK, schema, DB, `packages/**`, or `docs/qa/**` changes.

### 4.5 Deviations / notes

- The task-399 spec dismisses the tenant-Disable confirm with **Escape** rather
  than a coordinate click: the tenant detail page has a pre-existing horizontal
  overflow (an `sr-only` table wider than the 390px device) that makes mobile
  Chrome expand the layout viewport and skews synthetic touch coordinates.
  Flagged here as a pre-existing page issue — NOT addressed (out of scope).
- Geometry/touch assertions poll until the enter animations (zoom/slide,
  200–500ms) settle, since `getBoundingClientRect` reports transform-scaled
  transient boxes mid-animation.

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-07-02 | Initial implementation (P1-8 / D6, clears RSP-04.7) | see §4.4 |
