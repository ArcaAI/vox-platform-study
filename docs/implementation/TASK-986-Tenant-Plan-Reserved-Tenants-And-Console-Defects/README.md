# TASK-986 — Tenant Plan, Reserved Tenants & Console Delete/Export Defects

| Field | Value |
|---|---|
| **Status** | `Completed` — all six items resolved and merged to `dev-2.2`; two e2e specs written but not yet run |
| **Type** | `bugfix` (5 defects) + `feature` (1 new capability) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-18 |
| **Related** | TASK-890 (reference set / OD-M), TASK-974 (hidden platform agent / D-1), TASK-983 (admin-console defect sweep), TASK-962 (entitlement rows) |

---

## 1. Requirement Analysis

Six items were reported by the owner. Items 4 and 5 were ambiguous between "defect" and
"policy"; the owner confirmed on 2026-09-18 that **both are defects — delete should work**.

| # | Reported as | Classification |
|---|---|---|
| R1 | "platform admin cannot upgrade plan of any tenant" | defect — missing console affordance |
| R2 | "make sure no one can suspend `__SYSTEM__` and `__GLOBAL__` tenants" | defect — guard is incomplete |
| R3 | "new tenant is a copy/cloned version from `__SYSTEM__`, except the assigned plan" | already implemented; the gap is what SYSTEM *holds* |
| R4 | "tenant admin cannot delete any department" | defect — console-side only; the API works |
| R5 | "tenant admin cannot delete a selected user, except from the user detail" | defect — route shadowing, reproduced live |
| R6 | "it exports all users instead of selected users" | new capability — no `ids` concept exists on either side |

`__SYSTEM__` and `__GLOBAL__` are the literal `Tenant.key` values
(`seed/05-tenant.ts:7-27`), confirmed against the live dev DB.

---

## 2. Current State Evaluation

All findings below were produced by five parallel read-only investigation lanes and then
**independently re-verified** by the orchestrator against the source, the live dev database,
and (for R4/R5) live HTTP probes against the dev gateway on :8868.

### R1 — Plan assignment

The API is complete and works. `PATCH /admin/tenants/:id` whitelists `plan`
(`updateTenant.request.ts:27-31`), `TenantEntity` has a change-tracked setter, and
`TenantService.update` (`tenant.service.ts:667`) persists it through the normal OCC path.

The blocker is purely the console: the tenant detail screen renders `plan` as a read-only
badge with header actions Suspend / Restore / Archive / Resync / Delete and **no Edit**
(`tenant-detail-screen.tsx:75,141,147-175`). `useUpdateTenant()` exists
(`features/tenants/api/hooks.ts:102`) and its **only caller in the repo is its own unit test**.

The one working plan-change control is on `/entitlements`, reachable only by pasting a raw
tenant UUID, labelled **"Trigger downgrade"**, styled `destructive`, warning that it
"disables anything over quota" (`tenant-override-panel.tsx:292-352`). Its `Select` offers all
four plans, so an *upgrade* through it emits a toast reading "Downgrade to Enterprise complete".

**Privilege hole found in passing (verified end to end).** The seed grants tenant admins
`{ action: 'update', subject: 'Tenant', conditions: { id: '${context.tenantId}' } }`
(`seed/01-policy.ts:188`); `assertTenantInScope` passes a caller acting on its own tenant
(`apps/api/src/shared/tenant-scope.ts:69-75`); `plan` is writable on the DTO; and
`TenantService.update` has **no field-level gate**. A tenant admin can therefore
`PATCH /admin/tenants/{own-id}` with `{"plan":"ENTERPRISE"}`. This contradicts
`00-project-context.md` — "entitlements bound what a tenant MAY set; they never supply a value".

Two adjacent gaps, both confirmed by grep for callers:
- `BillingService.recordPlanChange` (`billing.service.ts:360`) — the only `TenantPlanHistory`
  writer — has **zero production callers**, so plan-fee proration runs against an empty table.
- `applyPlanStorageQuota` (`tenant-bucket.service.ts:392`) is called **only at tenant creation**
  (`tenant.service.ts:155`), so an upgraded tenant keeps its old bucket quota.

### R2 — Reserved tenant protection

`suspend()`, `archive()` and `deleteById()` are guarded by `assertNotSystemTenant`
(`tenant.service.ts:740-747`). The guard is asymmetric:

```ts
const isGlobalKey = (tenant.key ?? '').toUpperCase() === GLOBAL_TENANT_KEY.toUpperCase();
if (isGlobalKey || tenant.id === SYSTEM_TENANT_ID) { throw new ForbiddenException(...) }
```

- SYSTEM is matched by its **immutable id**.
- Global is matched **only by its mutable `key` string** — never by `SEED_TENANT_ID`.

**Gap 1 (critical).** `TenantService.update()` calls no reserved-tenant guard at all, and
`UpdateTenantRequest.resourceStatus` permits `DISABLED` (`updateTenant.request.ts:22-25`).
`PATCH /admin/tenants/00000000-…` with `{"resourceStatus":"DISABLED","expectedVersion":1}`
deactivates the SYSTEM tenant today. Both reserved rows are at `_version: 1` (live DB), so the
OCC precondition is trivially satisfiable.

**Gap 2 (critical, compounding).** `UpdateTenantRequest.key` has no reserved-key validator
(only `CreateTenantRequest.key` does, `createTenant.request.ts:19`). A PATCH can rename Global's
key away from `__GLOBAL__`, which **permanently disarms the guard for that row** — a subsequent
`suspend`/`archive`/`delete` then succeeds.

**Gap 3 (UX).** The console offers Suspend / Archive / Delete on the reserved rows with no
special-casing (`tenant-detail-screen.tsx:150,162,170`; `tenant-lifecycle-dialogs.tsx:59,71,77`).

**Gap 4 (defence in depth).** The protection is one `if` in one service method; nothing at the
repository or Prisma-extension layer.

No test anywhere asserts a block against the literal `00000000-…` / `50000000-…` ids; the
existing lifecycle test uses a random-id fixture with key `__GLOBAL__`
(`tenant.service.lifecycle.test.ts:97-131`) and never exercises `update()`.

### R3 — Tenant creation cloning

**Already implemented and correct.** `TenantReferenceSetService` runs automatically at
`tenant.service.ts:205` and clones seven content kinds with provenance: consultation context
schemas, prompt templates, agents + model fallbacks, agent assignments, document templates,
workflow definitions, workflow assignments. Creation additionally provisions storage buckets,
the plan storage quota, a default `GEN` department and the golden department catalogue.

The perceived emptiness is a **content** gap, not a copier gap. Live dev DB:

| Tenant | Agents | Workflows | Prompts | Doc templates | Ctx schemas | Departments |
|---|---|---|---|---|---|---|
| System (`__SYSTEM__`) | 7 | 2 | 17 | 2 | 1 | 8 |
| Global (`__GLOBAL__`) | 7 | 2 | 37 | 2 | 1 | 8 |
| ArcaAI (customer) | 29 | 13 | 40 | 24 | 3 | 11 |

The rich clinical library lives in **ArcaAI, a customer tenant**. A new tenant clones SYSTEM
faithfully and receives 6 agents (the 7th, `dna-writing-style-analyst`, is tagged
`visibility:hidden` and correctly excluded per owner decision D-1), 2 workflows, 2 document
templates.

**Conflict with the literal ask.** "A copy of SYSTEM except the plan" would also copy
*configuration* rows. `00-project-context.md` §"Content is cloned; configuration cascades"
(OD-M) states a per-tenant copy of a configuration row **is a bug**, and three live tests pin
their absence (`tenant-reference-set.service.test.ts:217`, `task-890-reference-set.spec.ts:108`,
plus the hidden-agent tests). Implementing the literal reading would mean reversing OD-M and
deleting those tests. **Owner ruling required (D-3 below).**

Latent gap worth closing cheaply: `copyAgentAssignments` reads TENANT scope only
(`tenant-reference-set.service.ts:394-445`) and, unlike its workflow twin
(`:643-650`), does **not** report the DEPARTMENT-scope omission.

### R4 — Department delete

**The backend works.** Proven live against the dev gateway as the seeded `tenant_admin`:

```
POST   /api/v1/admin/departments            → 201  {id: 01a0b45d-fb1b-…, code: ZZTMP986}
DELETE /api/v1/admin/departments/01a0b45d-… → 200  {resourceStatus: "DELETED", version: 2}
```

A delete against a non-existent id returns **404, not 403** — so neither the route guard
(`manage:Department`, held by the seeded TENANT_ADMIN via `tenant-full-access`,
`seed/01-policy.ts:176` + `seed/03-role.ts:34-40`) nor the service blocks a tenant admin.

The service's only business guard is "refuse if the department has ENABLED children"
(`department.service.ts:428-431`). That guard **cannot be the cause**: every ArcaAI department
is a flat root with zero children (live DB), so it never fires.

**Therefore the defect is console-side.** The delete action is not discoverable from the
departments screen: there is no row or tree-level delete. It is reachable only via
select a department → Prompt Config panel "Edit" (`department-prompt-config-panel.tsx:187-189`)
→ `DepartmentDetailDrawer` → footer Delete (`department-detail.tsx:369-372`).

⚠ **Open — needs a UI reproduction.** Static reading and API probes cannot distinguish
"the user could not find the buried action" from "the drawer path throws at runtime". This is
the first step of implementation, not a conclusion.

### R5 — Delete selected user(s)

**Root cause: NestJS/Express route shadowing. Reproduced live.**

`UserController` declares `delete` with `path: '/:id'` at line **426** and `bulkDelete` with
`path: 'bulk'` at line **458**. Routes register in class-declaration order and `:id` matches any
literal segment, so `DELETE /admin/users/bulk` is captured by `delete(id="bulk")`.

Live probe (empty id list — deletes nothing by construction):

```
DELETE /api/v1/admin/users/bulk  {"ids":[]}
→ 404 {"message":"User not found","code":"HTTP.NOT_FOUND"}
```

The `bulkDelete` handler is unreachable. This affects **every** caller, not only tenant admins —
the shadow happens before any CASL check. The row-menu and detail-screen deletes call
`DELETE admin/users/:id` with a real UUID and are unaffected, which is exactly the
"works from the detail page" the owner described. Bulk enable/disable is unaffected because it
uses `POST admin/users/bulk-actions`, which has no competing param route.

The codebase already knows this failure mode and fixed it for the sibling GET route —
`@Get('export')` (line 205) is declared before `fetchById`'s `/:id` (line 287) with an explicit
comment saying why (`user.controller.ts:198-203`). The same fix was never applied to DELETE.

**Why the green suite missed it:** `user.controller.test.ts:530-598` calls
`controller.bulkDelete(...)` **as a method**, bypassing routing entirely. No e2e spec sends a
real `DELETE /api/v1/admin/users/bulk`.

### R6 — Export ignores selection

Not a regression — **the capability does not exist on either side of the BFF boundary**. The
handler says so in a comment (`users-list-screen.tsx:261`): "Export the current filtered view
(not just the selection)". `selectedIds` (defined at `:228`) is never referenced in
`handleExport` (`:262-280`).

Structurally: `ExportUsersParams` (`features/users/api/types.ts:36-40`) has no `ids` field;
`ExportUsersQuery` (`apps/api/src/modules/user/dto/export-users.query.ts:11-28`) has no `ids`
field; and `collectExportRows` (`user.controller.ts:236-263`) builds the row set purely from
`fetchAll`/`fetchAllByTenantId` driven by the query filters.

The grid selection model itself is **not** at fault — `users-list-screen.tsx:190,228,441` wires
the controlled `selection` API correctly.

No console screen implements selection-scoped export today; there is no precedent to copy.

---

## 3. Owner Decisions — RESOLVED 2026-09-18

| Id | Question | Ruling |
|---|---|---|
| **D-1** | A tenant admin can currently set their own `plan` to `ENTERPRISE`. Block it? | **BLOCK — super admin only.** Field-level gate in `TenantService.update` with an `// AUTH-NOTE:` marker, 403, resolved after `findById` so an unknown id still 404s. |
| **D-2** | Where does the plan editor live? | **Tenant detail screen** (one authoritative editor per resource, rule 13). Re-label the entitlements "Trigger downgrade" control. *(Orchestrator default; not contested.)* |
| **D-3** | Does "a copy of SYSTEM" mean **content only**? | **CONTENT ONLY. OD-M stands** — configuration continues to cascade, and no per-tenant config copy is introduced. The copier needs no change. |
| **D-4** | Enrich SYSTEM's reference set from the ArcaAI library? | **YES, as a SEPARATE ticket**, via the sanctioned Global → `promote-to-system` path (owner directive D-8). Out of scope for TASK-986. |
| **D-5** | R2 lockdown scope? | **BLOCK ALL PATCH EDITS** on both reserved rows, in addition to the existing suspend/archive/delete guard. |
| **D-6** | R5 fix shape? | **Reorder the routes.** Same-file method move + the existing explanatory comment; no contract change. *(Orchestrator default; not contested.)* |
| **D-7** | Billing/storage gaps in scope? | **IN SCOPE.** Wire `recordPlanChange` into create / update / downgrade / trial-expiry, and re-apply `applyPlanStorageQuota` on every plan change. **No `TenantPlanHistory` backfill** — not sanctioned. |

---

## 4. Implementation Plan

Lanes are partitioned by **write surface** so no two writers touch the same file. W1 and W2 both
write `tenant.service.ts`, so they are **serialised**, not parallel.

### W1 — Reserved tenant lockdown (R2) · first, it is a live hole
1. Strengthen `assertNotSystemTenant` (`tenant.service.ts:740-747`) to match **both reserved ids
   directly** (`SYSTEM_TENANT_ID || SEED_TENANT_ID`) in addition to the `__GLOBAL__` key check.
2. Call it from the top of `update()` (`tenant.service.ts:667`), after `findById`.
3. Add `@Validate(NotReservedTenantKeyConstraint)` to `UpdateTenantRequest.key`.
4. Console: hide/disable Suspend / Archive / Delete for the two reserved ids, with a visible
   reason (rule 11 §7).
5. Tests (RED first): unit cases using the **literal** ids for `suspend`/`archive`/`delete`/`update`;
   e2e asserting `PATCH /admin/tenants/00000000-…` → 403.

### W2 — Plan assignment (R1, D-1, D-7) · after W1 lands
1. Field-level super-admin gate on `plan` in `TenantService.update` + `// AUTH-NOTE:` at the route.
2. "Change plan" editor on the tenant detail screen, wiring the existing `useUpdateTenant()`.
3. Re-label / demote the entitlements downgrade control.
4. Call `recordPlanChange` from every plan-change path; re-apply `applyPlanStorageQuota` on change.
5. Tests: unit (gate + billing call), e2e depth test (the authz matrix cannot express a per-field gate).

### W3 — User bulk delete (R5) · independent file
1. Move `bulkDelete` above `delete` in `user.controller.ts`, carrying the explanatory comment.
2. Regenerate the five artifacts if the manifest changes.
3. e2e regression sending a **real** `DELETE /api/v1/admin/users/bulk`.

### W4 — Export selected (R6) · independent files
1. `ids?: string[]` on `ExportUsersParams` and `ExportUsersQuery`.
2. `collectExportRows` scopes to `ids` when present, tenant-guarded per id.
3. `handleExport` passes `selectedIds`; button label reflects "Export selected (N)" vs "Export all".
4. Tests: unit + e2e for the id-scoped export, including a cross-tenant id → not leaked.

### W5 — Department delete (R4) · UI reproduction first
1. **Reproduce in a running console** before writing any code.
2. Fix what the reproduction shows; if it is discoverability, add a delete affordance at the
   tree/row level rather than only inside the edit drawer.
3. Backfill the missing tests the investigation surfaced: `deleteById` has **zero** unit coverage
   and `controller.delete()` is never invoked in any `it()`.

### W6 — Reference set follow-up (R3, cheap)
1. Report the DEPARTMENT-scope agent-assignment omission in `summary.warnings`, mirroring the
   workflow half.
2. Add a behavioural unit test that `TenantService.create` calls `referenceSet.provision` — today
   only a source-text grep proves the wiring, and the dependency is `@Optional()`.

---

## 5. Verification Criteria

- `pnpm --filter @arcaai/applications build test`
- `pnpm --filter @arcaai/domains build test`
- `pnpm api:build` + `pnpm test:unit`
- `pnpm --filter @arcaai/admin-console build lint test` (with `CI=true`)
- `pnpm api:route-manifest` if any route metadata changed; then the five-artifact regen
- e2e: `pnpm test:up:api` + targeted specs
- Live re-probe of the two reproductions in this document (bulk delete no longer 404s; reserved
  tenant PATCH now 403s)

Out of scope per the standing exclusion: `apps/compat-playground`, `apps/quick-compat-app`,
`packages/ui` suites.

---

## 6. Implementation Summary

Four write lanes: three in isolated worktrees (merged `--no-ff`, worktrees removed), one
(departments) taken by the orchestrator in the primary checkout because it needed a live UI
reproduction. Every lane's claims were re-verified by the orchestrator against source, the live
dev DB, or live HTTP — reports were not relayed on trust.

### R1 — plan assignment
`TenantService.update` gained an imperative super-admin gate on the `plan` FIELD, firing only when
the value actually changes and resolved AFTER `findById` so an unknown id still 404s
(`// AUTH-NOTE:` at `tenant.controller.ts:245`). The console gained its one plan editor
(`features/tenants/components/change-plan-dialog.tsx`), wiring the previously caller-less
`useUpdateTenant()`. The entitlements control was relabelled from the destructive
"Trigger downgrade" to a neutral "Change plan" with a deep link to the authoritative editor; the
API route was not renamed.

### R2 — reserved tenant lockdown
`assertNotSystemTenant` now matches BOTH reserved ids directly (`SYSTEM_TENANT_ID ||
SEED_TENANT_ID`), keeping the `__GLOBAL__` key check as defence in depth, and `update()` calls it
after `findById` — so every PATCH against either row is refused (D-5). `UpdateTenantRequest.key`
gained the reserved-key validator, closing the rename-then-disarm chain. The console hides the
lifecycle actions on those rows behind a visible locked notice.

### R3 — reference set
No copier change: cloning already worked and OD-M stands (D-3). Closed one latent gap —
`copyAgentAssignments` now REPORTS DEPARTMENT-scope SYSTEM rows in `summary.warnings` instead of
dropping them silently, symmetric with `copyWorkflowAssignments`. Enriching SYSTEM is deferred to
its own ticket (D-4).

**Latent bug found by the tenant lane:** `tenant.service.test.ts` was passing the prompt-version
repository into constructor slot 12, where the reference set belongs, so `referenceSet.provision`
threw a swallowed `TypeError` on every create in that suite. Corrected, plus a behavioural test
that `create` really does call `provision` — previously only a source-text grep proved that wiring,
and the dependency is `@Optional()`.

### R4 — department delete
**No backend defect existed.** Proven live: a tenant admin can create and delete a department
(201 → 200, row to `DELETED`); an unknown id answers 404 not 403; and the only business guard
("has ENABLED children") could not have fired, because every department in the tenant is a
childless root. The defect was DISCOVERABILITY — the sole route to delete was the "Edit" button
inside the *Prompt config* pane. Each hierarchy row now carries the console's standard row-action
menu (Edit / Delete), reusing the drawer's existing type-to-confirm flow.

A row-menu delete ARMS the confirm rather than opening it: the first implementation opened it
immediately, before the detail read landed, which handed `ConfirmDialog` an empty
`typeToConfirm` token — disabling the guard and collapsing a two-step destructive action into one
click. The new test caught it.

### R5 — delete selected users
Root cause was NestJS/Express route shadowing: `delete` (`path: '/:id'`) was declared before
`bulkDelete` (`path: 'bulk'`), so `DELETE /admin/users/bulk` was captured by the id handler and
404'd for EVERY caller. `bulkDelete` now precedes `delete`, carrying an explanatory comment
modelled on the one that already protects `GET export` from the same fate. The suite missed this
because the unit test calls `controller.bulkDelete(...)` as a method, bypassing routing; a real-HTTP
e2e spec now covers it.

### R6 — export honours the selection
`ids` added to both `ExportUsersParams` (console) and `ExportUsersQuery` (gateway).
`collectExportRows` folds the selection into the existing filter set as an `id[in]:…` token — a
FILTER, never a lookup — so the tenant branch that picks `fetchAll` vs `fetchAllByTenantId` is
untouched and naming an id can only REMOVE rows. A foreign id yields 200 with that row absent, not
404: an export is a set read, not a by-id route. The action bar reads "Export selected (N)" and a
separate "Export all" was added to the header, because the action bar renders only when rows are
selected and relabelling the single button would have deleted full-view export outright.

**Defect found and fixed by the orchestrator after merge:** the lane validated each id with
`@IsUUID('all')`, which enforces the version nibble. This platform's reserved rows are NOT
version-compliant uuids — `60000000-…` (system user) and `70000000-…` (every seeded account) carry
version `0`. Proven live: a selection containing a seeded id answered
`400 each value in ids must be a UUID` while a runtime uuidv7 id answered 200, i.e. the feature
worked for runtime rows and failed for every seeded user. Replaced with a hex-and-hyphens shape
match, which preserves the reason the constraint exists (the grammar separators `;` `|` `[` `]:`
stay unrepresentable, so a filter-injection token still cannot be built) and is pinned by
`export-users.query.task986.test.ts`.

### D-7 — billing and storage on the plan-change path
`recordPlanChange` had ZERO production callers, so `TenantPlanHistory` was never written and plan-fee
proration ran against an empty table; `applyPlanStorageQuota` ran only at tenant creation. Both are
now wired into create / update / downgrade / trial-expiry, best-effort after the plan column commits.
The update path rebinds CLS to the TARGET tenant for those two side effects (a super admin editing
tenant B while working in tenant A would otherwise have had the history row silently rejected by the
tenant-scope extension) and restores it before the audit broadcast. No backfill, per the ruling.

### Verification (actual output, not assertions)

| Gate | Result |
|---|---|
| `@arcaai/applications` build | exit 0 |
| `@arcaai/applications` test | **901 files / 14,415 tests pass**; 1 pre-existing failure (`membership-bounded-sync.integration.test.ts`, live-DB, reproduced on the UNTOUCHED primary before any merge) |
| `pnpm api:build` | 12/12 tasks |
| api tenant+user modules | 24 files / 324 tests pass |
| admin-console lint | 0 warnings |
| admin-console test | 366 files / **3,587 tests pass** |
| admin-console build | compiled, 95/95 pages |
| `api:openapi:check` | OK |
| `api:portal:check` | no drift (673 admin / 202 business ops) |
| `vox-node gen:admin:check` | no drift (49 areas, 431 routes, 456 schemas) |
| `route-manifest.json` | byte-identical — no authz metadata changed |

### Live verification against the dev gateway (:8868)

| Probe | Before | After |
|---|---|---|
| `DELETE /admin/users/bulk {"ids":[]}` | `404 User not found` | `400 ids must contain at least 1 elements` (handler reached) |
| `PATCH /admin/tenants/00000000-… {"resourceStatus":"DISABLED"}` | would have disabled the platform tier | `403 The system tenant cannot be edited.` |
| `PATCH /admin/tenants/50000000-… {"key":"NOTGLOBAL"}` | would have disarmed the guard | `403` |
| tenant admin PATCHes own `plan` | `200` (the hole) | `403 Only a platform administrator can change a tenant plan.` |
| super admin changes a plan | no console path | `200` + a `TenantPlanHistory` row (table was empty) |
| export with 2 own + 1 foreign seeded id | n/a | `200`, both own rows, foreign row absent |
| department delete via row menu | affordance absent | row menu → confirm → `DELETE 200` → toast |

Reserved rows remain at `_version: 1`, confirming the 403s wrote nothing. ArcaAI's plan was moved
PRO and restored to ENTERPRISE. Probe departments `ZZTMP986`/`B`/`C` are left soft-deleted in dev.

### Not done
- **The two new e2e specs have never been executed** (`task-986-tenant-plan-and-reserved.spec.ts`,
  `task-986-users-bulk-and-export.spec.ts`). The e2e harness needs the isolated test infra on
  :5433/:6380, which is occupied by unrelated containers on this host. Expect first-run adjustments.
- A pre-existing spec, `users-bulk-role-export.spec.ts`, creates users with no role or department,
  which the gateway should reject with 400 — it may already be red, independently of this ticket.

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Five parallel read-only investigation lanes; findings re-verified against source, live dev DB and live HTTP probes. R5 root cause (route shadowing) and R4 backend-works both reproduced live. Plan drafted; seven owner decisions raised. |
| 2026-09-18 | Owner resolved D-1..D-7. Four write lanes implemented and merged `--no-ff` into `dev-2.2`; worktrees removed. Two defects found DURING implementation and fixed: the export id validator rejected every seeded/reserved id, and the departments row-menu delete initially opened its confirm with an empty type-to-confirm token. All gates green except one pre-existing live-DB integration test. Seven live probes recorded in §6. |
| 2026-09-18 | **Follow-up fix — `05f4a36f5` broke the `@arcaai/vox-node` build.** Adding `ids?: string[]` to the export query made the regenerated admin surface emit an array-typed query param, which the transport's `QueryValue` union (`string \| number \| boolean \| undefined \| null`) did not admit: `src/resources/admin/user.ts(480,7) TS2322`, DTS build error. Because turbo's `^build` graph fans out from that package, `pnpm admin:typecheck` / `admin:lint` could not run **at all** for `apps/admin-console` — the failure surfaced while verifying an unrelated ticket. Fixed in the TRANSPORT, not the generated file: `QueryValue` now admits `readonly QueryPrimitive[]` and `buildQueryString` REPEATS a list (`?ids=a&ids=b`) instead of `String(array)`-joining it. The generator was correct and is unchanged — `gen:admin:check` passes untouched. See §8. |

---

## 8. Follow-up — array-valued query params in the Node SDK transport (2026-09-18)

### Why the generated file was not the thing to fix

`packages/vox-node/src/resources/admin/**` is generated from the route manifest cross-checked
against `openapi.json`. The DTO declares `@ApiPropertyOptional({ type: [String] })` on `ids`, so
the OpenAPI document says *array of string*, and
`buildQueryParams` (`packages/vox-node-codegen/src/surface.ts:359`) renders the declared schema
faithfully. **The generator was telling the truth**; the transport was the incomplete party, having
never admitted a legitimate HTTP concept. Narrowing the generator to emit `string` would have made
the SDK's type contradict the published contract and pushed comma-joining onto every caller.

It is also a class fix rather than an instance fix: `ids` is currently the **only** array-typed
query param in the generated surface (verified by walking every `query?: {` block across all 384
routes), so the next route to declare `type: [String]` would have broken the build in exactly the
same way.

### Why repeated params, not comma-joining

The gateway accepts **both** — `parseIdsQuery` (`apps/api/src/modules/user/dto/export-users.query.ts`)
flattens a repeated param *and* splits on commas, and the route's `@ApiQuery` documents both. So the
choice was made on correctness, not compatibility: `String(['a','b'])` yields `a,b`, which is lossy
the moment one item contains a comma — the set the server rebuilds is not the set that was sent.
`URLSearchParams.append` per item cannot be.

An **empty** list appends nothing and vanishes from the URL rather than arriving as `ids=`. That is
deliberate and mirrors `parseIdsQuery`, which answers `undefined` rather than `[]`: an absent `ids`
means "no id scope, export the whole view", whereas a present-but-empty one would read as a
selection.

### Changed

| Path | Change |
|---|---|
| `packages/vox-node/src/core/url.ts` | `QueryValue` admits `readonly QueryPrimitive[]`; `buildQueryString` repeats list items |
| `packages/vox-node/src/core/__tests__/url.test.ts` | 4 new cases (repeat, per-item encoding, empty-list omission, mixed primitives) |

`QueryValue` is consumed in exactly one place (`buildQueryString`); `transport.ts` only passes it
through, so the widening is contained. `QueryPrimitive` needs no barrel export — tsup inlines it
into the emitted `.d.ts`.

### Evidence

- All 4 new tests seen RED first, failing with the comma-joined URL.
- `npx turbo run build --filter=@arcaai/vox-node` — **3 successful, 3 total** (was: DTS build error).
- `pnpm --filter @arcaai/vox-node test` — **39 files / 583 tests** green; `typecheck`, `lint`, and
  `gen:admin:check` all exit 0 (the last proves no generator drift).
- `pnpm admin:typecheck` — green, i.e. the `^build` fan-out is unblocked.

### Not changed, deliberately

`apps/admin-console`'s own `buildQuery` (`src/shared/api/http.ts`) still comma-joins, because its
`QueryParams` type does not accept arrays and the console composes the id list itself. That is not
broken — the gateway splits on commas — so it is left alone rather than widened speculatively.
