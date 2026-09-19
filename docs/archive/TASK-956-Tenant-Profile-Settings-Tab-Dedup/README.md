# TASK-956 — Tenant profile: retire the duplicate Settings tab

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | refactor (console) |
| **Surface** | `apps/admin-console` — `/tenant-profile` (frame 25), `/settings` (frame 24), `/settings-registry` |
| **Reported** | 2026-09-12, owner: "the Settings tab in the Tenant profile is duplicated with the Settings registry and Settings rows & secrets, let's review and fix that" |
| **Branch** | `dev-2.2` |

## 1. Requirement Analysis

Three console surfaces edit the tenant's settings. The owner asks for the duplication to be
reviewed and removed. The house rule is rule 13 §Routing, "one authoritative editor per backend
resource": when two screens would write the same row, one owns the write and the other demotes
to a read-only summary plus a plain-href deep link (precedent: `/agentic-policy` owns the
harness policy rows; `/harness/policy` reads and links).

## 2. Current State Evaluation (2026-09-12)

### 2.1 The three surfaces over ONE table

| Surface | Reads | Writes | What it is |
|---|---|---|---|
| `/settings` — "Settings rows & secrets" (`features/settings`) | `GET admin/settings` (tenant-pinned for a tenant admin, `locked` rows excluded since TASK-954) | `POST/PATCH/DELETE admin/settings/:id`, reveal, rotate | The ROW editor: `AdminDataGrid`, `DetailDrawer` with a real code editor for Json/Array, step-up secret reveal, guided rotation, OCC If-Match, audit-backed History tab |
| `/settings-registry` — "Settings registry" / "Tenant settings" (`features/settings-registry`) | `GET admin/settings/catalog` + `registry/:key` | `PUT/DELETE admin/settings/registry/:key` | The KEY editor: descriptor-governed, tenant → platform cascade, tier / maxScope / failMode / lock derived server-side |
| `/tenant-profile?tab=settings` — Settings tab (`features/account/components/tenant-settings-tab.tsx`) | `GET tenants/me/config` → `TenantService.fetchTenantConfigs` → **the same `GlobalSetting` rows** (+ one synthetic raw-capture row) | `PATCH tenants/me/config`, one request per dirty row with its own If-Match | A THIRD editor: a category rail from a client-side keyword heuristic (`config-categories.ts`: "auth" → Security, "stt" → Clinical, unknown → General), plain `Input`/`Textarea`/`Switch` controls, its own OCC client |

`TenantService.fetchTenantConfigs` queries `globalSettingRepository` by `tenantId` — there is no
separate tenant-config table. The tab was written on 2026-07-08 (`b77388740`), before the row
editor grew its drawer (TASK-4xx) and before the registry lane existed (TASK-870/932).

### 2.2 Why the tab is not merely redundant but wrong

- **It disagrees with `/settings` about what a tenant admin sees.** TASK-954 R-3 ("what I cannot
  update must not be displayed") removed `locked` rows from the tenant admin's list, server-side.
  The tab still lists them (value blanked, badge "Platform-managed"). Same rows, two answers.
- **It is read-only for the people it was built for.** `readOnly={!effectiveIsElevated}` — a
  TENANT ADMIN gets disabled controls, while `/settings` lets the same admin edit the same rows.
  For a super admin it is an editable duplicate with a weaker editor.
- **Secrets and JSON in plain controls.** `TenantConfig` carries no `isSecret`; a secret row would
  render in a text `Input`. Json/Array rows get a `Textarea` — rule 11's anti-pattern table names
  exactly this ("JSON/array value edited in a bare `<Textarea>` → `CodeEditor`").
- **Grouping by keyword is a client-side taxonomy.** The registry screen's own comment forbids it
  ("Group headers by the SERVER-side taxonomy — never a client keyword heuristic").
- **A second OCC client over the same rows**, with the per-row-header quirk of
  `PATCH tenants/me/config` (the header folds onto every row) worked around by sequential requests.

### 2.3 What else uses `tenants/me/config`

Only the tab, inside the console. The gateway route stays: the browser SDK reads it to map the
synthetic `enable-local-raw-capture` row into `audio.captureRawAudio`. Nothing in
`apps/admin-console` deep-links to `?tab=settings` except the two Playwright specs updated here.

## 3. Implementation Plan

1. RED — `tenant-profile-screen.test.tsx`: two tabs and no Settings tab; the Organization tab
   carries a `Settings` region with links to `/settings-registry` (read or manage
   `GlobalSetting`) and `/settings` (manage only); no region at all without either ability; the
   retired `?tab=settings` deep link lands on Organization; the screen never reads
   `tenants/me/config`.
2. GREEN — `tenant-settings-pointer.tsx` (new): the read-only pointer, plain hrefs (features stay
   isolated), gated on `usePermissions()` the same way the nav is. `tenant-profile-screen.tsx`:
   drop the tab, mount the pointer under the identity card.
3. Remove the orphans the change creates: `tenant-settings-tab.tsx`, `lib/config-categories.ts`,
   their tests, and the `tenants/me/config` client / hook / query key in `features/account/api`.
   `account-api.test.ts` pins their absence.
4. Update the Playwright specs (`tests/e2e/tenant-profile.spec.ts`, `account.spec.ts`).
5. Gates: `pnpm --filter @arcaai/admin-console test lint typecheck build`; runtime check of the
   pointer as super admin (working tenant), tenant admin, and an impersonated clinician.

## 4. Implementation Summary

### 4.1 Files changed (`apps/admin-console`)

| File | Change |
|---|---|
| `src/features/account/components/tenant-settings-pointer.tsx` | **New.** The read-only pointer: a `Settings` region with plain-href links to `/settings-registry` (any caller with `read` or `manage:GlobalSetting`) and `/settings` (`manage:GlobalSetting` only); renders nothing without either ability. Gated on `usePermissions()` exactly as the nav is, so it never links to a screen the caller would 404 on. |
| `src/features/account/components/tenant-profile-screen.tsx` | Two tabs (Organization, Plan & usage); the pointer mounts under the identity card; `contentMode` is always `scroll`. A stale `?tab=settings` falls back to Organization through the existing unknown-tab rule. |
| `src/features/account/components/tenant-settings-tab.tsx`, `src/features/account/lib/config-categories.ts` (+ both test files) | **Deleted.** The third editor and its client-side keyword taxonomy. |
| `src/features/account/api/{client,hooks,keys}.ts` | `listMyTenantConfigs` / `updateMyTenantConfigs` / `useMyTenantConfigs` / `useUpdateMyTenantConfigs` / `accountKeys.tenantConfigs` removed — nothing else in the console used them. |
| `src/features/account/components/__tests__/tenant-profile-screen.test.tsx` | Rewritten for the two-tab screen: pointer links per ability, hidden without abilities, no `tenants/me/config` read (the fetch stub has no branch for it — a stray read fails the test), retired deep link → Organization. |
| `src/features/account/api/__tests__/account-api.test.ts` | Pins the absence of the config client. |
| `tests/e2e/tenant-profile.spec.ts`, `tests/e2e/account.spec.ts` | Playwright: two tabs, the pointer's links, `?tab=settings` → Organization, a11y on the Organization tab. |

Nothing changed on the gateway: `GET/PATCH tenants/me/config` stays for the browser SDK.

### 4.2 Evidence (2026-09-12)

```
vitest run src/features/account            → Test Files 3 passed · Tests 27 passed
vitest run (full console suite)            → Test Files 319 passed · Tests 2915 passed
eslint src --max-warnings 0                → clean
tsc --noEmit                               → clean
pnpm --filter @arcaai/admin-console build  → exit 0
```

(2915 vs 2926 before: 14 tests went with the tab and the taxonomy, 3 new ones came in.)

Runtime, `next dev` on :5176 against the local gateway on :8868:

| Session | Tabs | Settings pointer | `tenants/me/config` read |
|---|---|---|---|
| `tenant_admin` (Global) | Organization only (Plan & usage stays elevated-only) | both links; "Settings rows & secrets" lands on `/settings` | none |
| `super_admin` acting on ArcaAI | Organization · Plan & usage | both links | none |
| `?tab=settings` for either | lands on Organization, no Settings tab, no category rail | — | none |

Both themes rendered; the pointer uses semantic tokens only.

### 4.3 What the owner should know

- A tenant admin's rows now live in ONE place (`/settings`), which already applies TASK-954 R-3
  (locked rows hidden). The old tab showed those locked rows too — that disagreement is gone.
- The synthetic `enable-local-raw-capture` row the tab displayed is not a stored setting; it is the
  server-computed effective flag the SDK reads. Its admin-facing source is the tenant frontend
  config / the `Feature Availability` descriptor, both already surfaced elsewhere.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened; the three surfaces mapped to the one `GlobalSetting` table (§2.1) and the tab's defects recorded (§2.2); plan §3. |
| 2026-09-12 | Tab retired, pointer landed, orphans removed, tests + Playwright specs updated; gates green and runtime verified for both session kinds (§4). Status → Completed. Not committed — awaiting the owner's go. |
