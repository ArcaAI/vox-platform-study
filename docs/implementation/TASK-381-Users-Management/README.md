# TASK-381 — Users Management (frames 20u + 38u)

| | |
|---|---|
| **Ticket** | TASK-381 |
| **Name** | Users Management — Data Grid (20u) + 7‑tab User Detail (38u) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Review — design / traceability / E2E added; **V1 + V2 backlog gaps RESOLVED + live-validated** (2026‑06‑30) |
| **Surface** | `apps/admin` — tenant‑scoped Users tab (`/tenants/$tenantId/users`) + `$userId` detail |
| **Parent** | TASK-371 Admin Console Redesign — Pass 14 #2 Users (README §5.14 / §5.14.1), PHASE‑3‑PLAN §1 #2 / §2 / §3, TRACEABILITY‑MATRIX rows U1–U13 |
| **Artifacts** | [`DESIGN-SPEC.md`](../../designs/admin/users-management.md) · [`TRACEABILITY-MATRIX.md`](../../qa/traceability/users-management.md) · [`MANUAL-E2E-TESTS.md`](../../qa/manual-tests/06-users-management.md) · backend `apps/api/tests/e2e/task-381-users-management.spec.ts` · frontend `apps/admin/e2e/task-381-users-management.spec.ts` |

> Design‑approved build. Work is confined to `apps/admin`: the tenant Users route subtree
> (restructured into a directory) and the `features/users/*` feature folder. `packages/ui`,
> the SDK (`@arcaai/vox`) and sibling‑owned files are **not** modified.

---

## 1. Requirement Analysis

Deepen the tenant **Users** area into the full management surface described by frames
**20u** (Users Data Grid, `120:9015`) and **38u** (7‑tab User Detail, `120:10575`).

### Acceptance criteria

**20u — Users Data Grid**
- `VirtualizedDataGrid` with: avatar · name · email, role badges, departments, **dot+label** status (incl. Invited/Inactive).
- Faceted filters: **+ Status**, **+ Role**, **+ Department**, **+ Type**; global search; **View** column‑toggle (never a standalone Columns button); server pagination footer.
- Primary toolbar action **+ Add user**; **Export ▾** (CSV near‑term; Excel/PDF = TARGET); per‑row kebab (**Reset password** = TARGET · **Quick‑disable** = REAL · **View**).
- **Bulk‑selected** action bar: Disable · Assign department · Export · Clear (UI‑real; backend = client loop / TARGET).
- Grid **states**: loading / empty / error.

**Create User dialog** (`120:10354`) — username · email · temp password · service‑account toggle · initial department(s) · role; inline validation + saving state (REAL `useUsers.create`, then `assignDepartments` + `assignRoleToUser`).

**38u — User Detail** (breadcrumb `… / «Tenant» / Users / «name»`): header (avatar · name · role chip · status · Edit / Reset‑password[TARGET] / ⋯) + **7 tabs/panels**:
- **a Profile** — `User` profile fields; edit (username/email/status/service‑account REAL; name/phone profile fields = TARGET where SDK lacks them).
- **b Preferences** — `useUserSettings` by namespace (self = REAL; **admin‑for‑other = TARGET**).
- **c Agent instructions (by dept)** — `PromptTemplate` per assigned department (`usePrompts.list({departmentId})`); per‑user `USER_PERSONAL`/`ownerUserId` filtering = TARGET (SDK gap).
- **d DNA writing‑style instructions** — closest REAL source is the DNA report style (`useDnaStyle.getByDoctor`); editable `DNA_ANALYSIS` `USER_PERSONAL` prompt = TARGET.
- **e Department assignment** — `useUserDepartments` list / assign / setPrimary[OCC] / unassign + Assign‑Departments dialog (REAL).
- **f DNA reports & versions** — `useDnaStyle` getByDoctor / getVersions / getVersionDiff / generate / setDefault (REAL).
- **g Activity history** — `useAuditLog.byUser` + CSV export (REAL).

### Design contract (PHASE‑3‑PLAN §2)
Semantic tokens only · dot+label status · `tabular-nums` · `font-mono` IDs · ≥44px touch targets · loading/empty/error/selected states · responsive (tabs → `Select`, grid → card‑list).

---

## 2. REAL vs TARGET (PHASE‑3‑PLAN §3 — authoritative; do NOT fabricate)

| Capability | State | Backing |
|---|---|---|
| List/paginate/sort/filter users | **REAL** | `useUsers.listPaginated` (CSV `PaginatedQuery`) |
| Create user | **REAL** | `useUsers.create` |
| Quick‑disable / enable | **REAL** | `useUsers.disable` / `enable` (`resourceStatus`) |
| Assign departments | **REAL** | `useUsers.assignDepartments`, `useUserDepartments.assign/setPrimary/unassign` |
| Assign role on create | **REAL** | `useRoles.listRoles` + `assignRoleToUser` |
| Profile username/email/status/service‑account edit | **REAL** | `useUsers.update` |
| Profile name/phone/specialty edit | **TARGET** | not in `UpdateUserInput` |
| Preferences (self) | **REAL** | `useUserSettings.list/updateByKey` (`/user/me`) |
| Preferences (admin editing another user) | **TARGET** | no admin‑for‑other settings endpoint |
| Agent instructions per **department** | **REAL** | `usePrompts.list({departmentId})` |
| Agent instructions scoped per **user** (`USER_PERSONAL`/`ownerUserId`) | **TARGET** | `PromptTemplate` SDK type has no `scope`/`ownerUserId`; `list` filters only category/dept/tags |
| DNA reports + versions + diff + generate + set‑default | **REAL** | `useDnaStyle.*` |
| Activity history + CSV export | **REAL** | `useAuditLog.byUser` / `exportCsv` |
| Reset password (row kebab + detail header) | **TARGET** | no SDK endpoint |
| Excel / PDF export | **TARGET** | CSV is the near‑term format |
| Bulk action server endpoint | **TARGET** | implemented as a client loop (`Promise.allSettled`) |

TARGET items are drawn realistically and wired **disabled / empty + flagged** (inline `Target ·` note or disabled control); they never call a fabricated endpoint.

---

## 3. Implementation Plan

### Route restructure (mirrors the `departments/` directory pattern, TASK‑379)
```
tenants/$tenantId/users.tsx   ──▶   tenants/$tenantId/users/
                                      route.tsx      # pathless <Outlet/> layout
                                      index.tsx      # 20u grid (the Users tab)
                                      $userId.tsx    # 38u 7‑tab detail
```
The parent `$tenantId/route.tsx` (read‑only) keeps the tenant header + tab nav; its **Users** tab points at the new `index.tsx`. The detail renders under that layout (tenant tabs visible), consistent with the existing department‑detail page.

### Pure logic (TDD‑first, `features/users/*`)
| Module | Exports | Tested behavior |
|---|---|---|
| `user-query.ts` (extend) | `toUserListQuery` (existing), `deriveUserStatus`, `USER_STATUS_FACET_OPTIONS`, `USER_TYPE_FACET_OPTIONS`, `userTypeLabel` | 0→1 page (existing); status enum → design label+role; facet option shapes; type label |
| `user-draft.ts` | `suggestUsername`, `validateCreateUserDraft`, `isCreateUserValid`, `toCreateUserInput`, `toUpdateUserInput` | username derivation; validation errors; trim/omit‑empty mapping to SDK inputs |
| `bulk-selection.ts` | `selectedRowIds`, `selectionCount`, `bulkSelectionReducer` | id extraction (drops `false`); count; set normalizes / clear empties |
| `user-export.ts` | `buildUserExportRows`, `toUserCsv` | row mapping (type/status/departments); CSV header + RFC‑escaping |

### TDD test list
- **`user-query.test.ts`** (extend): `deriveUserStatus` maps ENABLED→Active/success, DISABLED→Inactive/warning, ARCHIVED→Archived/neutral, INVITED→Invited/info, unknown→Unknown/neutral; `USER_TYPE_FACET_OPTIONS`/`USER_STATUS_FACET_OPTIONS` carry backend values; `userTypeLabel(true|false)`.
- **`user-draft.test.ts`**: `suggestUsername` ("Dr. Maya Chen"→"maya.chen", accents, apostrophes, junk→""); `validateCreateUserDraft` (required username/email, username pattern, password min‑len when present, service‑account email optional); `toCreateUserInput` (omits empty email/password, forwards service‑account); `toUpdateUserInput` (trims, omits empties).
- **`bulk-selection.test.ts`**: `selectedRowIds` filters `false`; `selectionCount`; reducer `set` normalizes (drops `false`) and `clear` → `{}`.
- **`user-export.test.ts`**: `buildUserExportRows` (departments joined by name, type/status labels, missing email→`''`); `toUserCsv` (header row; escapes comma/quote/newline; CRLF rows).

### UI composition (not unit‑tested — type‑checked; routes/pages/panels compose the pure logic)
`user-create-dialog.tsx`, `user-edit-dialog.tsx`, `users-bulk-bar.tsx`, `download.ts`, and `detail/{profile,preferences,instructions,departments,dna-reports,activity}-panel(s).tsx`.

### Coordination note (additive, backward‑compatible)
The `… / Users / «name»` breadcrumb needs a dynamic user label. Mirroring the existing
`{ from: 'tenant' | 'department' }` mechanism, this adds a **`user`** field to
`store/tenant-detail-store.ts` and a `'user'` arm to `components/layout/breadcrumbs.tsx`.
Both changes are purely additive (new union member + new store field) and do not alter
sibling‑owned behavior.

### Plan review (2026‑06‑30)

Verified §3 against the shipped subtree (`routes/.../users/{route,index,$userId}.tsx`,
`features/users/*` incl. `detail/*`) and the backend it consumes (`apps/api` /
`packages/applications`). **The plan matches the build** — the route restructure, the
pure‑logic modules (`user-query` · `user-draft` · `bulk-selection` · `user-export` ·
`download`) with their tests, the composed dialogs/panels, and the additive breadcrumb
arm are all present as planned. **No trivial in‑scope gap warranted a code change** in
this docs/test pass; the remaining deltas are pre‑known TARGETs. The two backend/SDK
contract mismatches first surfaced here (**V1**, **V2**) have since **landed and are
live‑validated** (see Change History 2026‑06‑30):

- **TARGET (design‑only, §2 — drawn disabled/flagged):** reset‑password, profile
  name/phone/specialty, admin‑for‑another‑user **Preferences** UI, per‑**user** prompt
  scope, DNA **edit / generate‑for‑others**, **Excel/PDF** export, **server** bulk endpoint.
- **V1 · `email` on create — RESOLVED.** `CreateUserRequest` now whitelists `email?`
  (`createUser.request.ts:18`) and the service upserts it onto `UserProfile`, so a **human**
  create no longer `400`s under `forbidNonWhitelisted`. Asserted by `task-381` §V1
  (`POST /admin/users {email}` → profile `email` round‑trips).
- **V2 · `PATCH /admin/users/:id/departments` — RESOLVED.** A `setDepartments` handler now
  exists (`user.controller.ts:103`) that bulk‑reconciles a user's memberships to the exact
  `{departmentIds, primaryDepartmentId}` set, backing the Create‑dialog initial‑departments
  and the **bulk Assign‑department** path. The per‑assignment `POST` / `:assignmentId` routes
  (detail Departments tab) are unchanged. Asserted by `task-381` §V2.

Detail + grounding live in [`DESIGN-SPEC.md`](../../designs/admin/users-management.md) and
[`TRACEABILITY-MATRIX.md`](../../qa/traceability/users-management.md) (§Verification notes, rows U2/U6/U8/U11).

---

## 4. Implementation Summary

The flat `users.tsx` route was restructured into a directory and the `features/users/*`
pure logic + components were composed into the **20u grid** and the **38u 7‑tab detail**.

**Grid (20u)** — `routes/.../users/index.tsx`: a `VirtualizedDataGrid<User>` (server‑side
pagination/sorting/filtering via `toPaginatedQuery` + `useGridPersistence`) with columns
Member (avatar+email), Roles (best‑effort badges, em‑dash when absent), Departments,
Status, and Type (Human / Service Account); faceted Status/Type filters; a header row with
**+ Add user** (`UserCreateDialog`) and **Export** (CSV via `buildUserExportRows`/`toUserCsv`
+ `download.ts`); and a conditional `actionBar` (`UsersBulkBar`) for bulk Disable / Assign
department / Export selected. The TARGET‑only "Last active" column was omitted (would render
an all‑em‑dash column); the Role facet works server‑side regardless.

**Detail (38u)** — `routes/.../users/$userId.tsx`: user header (avatar, status dot+label,
edit + status‑toggle actions) over a 7‑tab interface, each tab a panel in
`features/users/detail/`:

| Tab | Panel | REAL / TARGET |
|---|---|---|
| Profile | `profile-panel.tsx` (`user-edit-dialog.tsx`) | REAL: username/email/status/service‑account; TARGET fields flagged |
| Preferences | `preferences-panel.tsx` | TARGET (admin‑for‑other settings view — disabled controls) |
| Agent instructions | `instructions-panel.tsx` | REAL: per‑assigned‑department prompts; per‑user personalization = TARGET |
| DNA style | `dna-style-panel.tsx` | REAL read‑only `DnaReport`; editing = TARGET |
| Departments | `departments-panel.tsx` | REAL: assign / set‑primary (OCC) / unassign |
| DNA reports | `dna-reports-panel.tsx` | REAL: version history + diff; "generate" disabled for other users (self‑scoped SDK) = TARGET |
| Activity | `activity-panel.tsx` | REAL: audit history + CSV export |

### Files changed

| File | Change |
|---|---|
| `routes/.../users/route.tsx` · `users/index.tsx` · `users/$userId.tsx` | New pathless layout + 20u grid + 38u detail (replaces deleted flat `users.tsx`). |
| `features/users/{user-query,user-draft,bulk-selection,user-export,download}.ts` | Pure logic (composed; unit‑tested except `download.ts`). |
| `features/users/{user-create-dialog,user-edit-dialog,users-bulk-bar}.tsx` + `detail/*.tsx` (7 panels) | Composed UI (type‑checked). |
| `store/tenant-detail-store.ts` · `components/layout/breadcrumbs.tsx` | Additive `user` field + `'user'` breadcrumb arm for the `… / Users / «name»` label. |

### Deviations

- **No "Last active" column** — purely TARGET (no backing field); omitted rather than
  shown as an all‑em‑dash column. Documented as deferred.
- **Roles column is best‑effort** — `User` has no native roles; badges render only when the
  payload carries roles, else an em‑dash. The Role facet filters server‑side.
- **DNA report generation** for another user is disabled/flagged TARGET (`useDnaStyle.generate`
  is self‑scoped). No endpoints fabricated.

## 5. Verification Evidence

All five gates were run once from the repo root (zsh) after every edit across TASK-380/381/382.

Users logic suite (`features/users` + shared `features/common/occ`):

```
$ pnpm --filter @arcaai/admin exec vitest run src/features/users src/features/common
 Test Files  5 passed (5)
      Tests  37 passed (37)
```

Full admin gates:

```
$ pnpm --filter @arcaai/admin generate-routes   # tsr generate → exit 0
$ pnpm --filter @arcaai/admin type-check         # tsc --noEmit → exit 0 (no errors)
$ pnpm --filter @arcaai/admin test
 Test Files  25 passed (25)
      Tests  184 passed (184)
$ pnpm --filter @arcaai/admin lint               # ✖ 9109 problems (0 errors, 9109 warnings) → exit 0
$ pnpm --filter @arcaai/admin build              # ✓ built in 9.70s → exit 0
```

## 6. Change History

- **2026-06-30** — Ticket created; plan + TDD list authored (this document).
- **2026-06-30** — Restructured `users.tsx` → directory; wired the 20u grid + 38u 7‑tab detail; composed `features/users/*` (dialogs, bulk bar, 7 panels); added additive `user` breadcrumb support. All 5 admin gates green (37 users tests, 184 total). Status → Review.
- **2026-06-30** — Docs/test review pass (no rebuild). Added [`DESIGN-SPEC.md`](../../designs/admin/users-management.md) (D/T/M for 20u + 38u a–g), [`TRACEABILITY-MATRIX.md`](../../qa/traceability/users-management.md) (U1–U13 cross‑linked to TASK‑371; backend `file:line` verified live; corrects two stale TASK‑371 cells), [`MANUAL-E2E-TESTS.md`](../../qa/manual-tests/06-users-management.md) (persona/RBAC/X1–X8, cross‑ref `02-user-access-control.md`), and two E2E specs — backend `apps/api/tests/e2e/task-381-users-management.spec.ts` (REAL: list/sort/filter/search/paginate, create, status, dept‑OCC, roles, settings, audit, X1/X2/X7) + frontend `apps/admin/e2e/task-381-users-management.spec.ts` (grid/dialog/7‑tab, D/T/M). Plan review (§3) recorded; surfaced backlog gaps **V1** (`email` not whitelisted on create) and **V2** (`PATCH :id/departments` has no handler).
- **2026-06-30** — **V1 + V2 backlog gaps RESOLVED + live-validated.** **V1:** `email` whitelisted on `CreateUserRequest` and persisted to `UserProfile` (`user.service` injects `IUserProfileService`; module wires `UserProfileServiceModule`). **V2:** new `PATCH /admin/users/:id/departments` for bulk department reconciliation — DTO `set-user-departments.request.ts`, `IUserDepartmentService.setDepartments` + impl (add / soft‑delete / primary reconcile, inline final fetch to avoid a spurious `ResourceViewed`), controller route. Domain/app/api unit gates green (controller test updated for the new dependency). **Live backend E2E `task-381` passes**, incl. new V1 (email persists on create) + V2 (bulk dept set) cases. Spec fixes: `sort=field:direction` param + collation‑agnostic sort assertion. **FE browser E2E:** 6 passed; remaining failures are selector defects in the never‑run subagent FE spec (e.g. non‑`exact` `getByText`) — unrelated to V1/V2, recorded for follow‑up. Files: `packages/applications/src/services/user/**`, `apps/api/src/modules/user/user.controller.ts` (+`__tests__`), `apps/api/tests/e2e/task-381-users-management.spec.ts`.
- **2026-07-01** — **QA-doc reconciliation (docs only — no code touched).** Re‑verified V1 (`createUser.request.ts:18`) + V2 (`user.controller.ts:103`) and the `task-381` §V1/V2 E2E block, then brought the still‑stale §3 body of this README in line with its own header/Change History (the two contract mismatches were still framed as "backlog" / "may 400" / "no handler"). Also reconciled the QA docs that still listed V1/V2 as open caveats: [`traceability/users-management.md`](../../qa/traceability/users-management.md) (coverage snapshot, U2 → 🟢, U6, U2b → 🟢, §Verification notes → RESOLVED) and [`manual-tests/06`](../../qa/manual-tests/06-users-management.md) (`T381-C.6` "may 400 / log a defect" → **expect 200 + email persists**; `T381-G.17` / `T381-C.8` dept‑PATCH caveat → **200, handler shipped**). | `docs/qa/traceability/users-management.md`, `docs/qa/manual-tests/06-users-management.md`, `README.md`
