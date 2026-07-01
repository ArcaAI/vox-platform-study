# TASK-371 — Admin Console Traceability Matrix

> _Relocated from `docs/implementation/TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment). This is the **master** matrix; per-surface matrices are siblings in this folder:_
> [Shared components](./shared-components.md) · [Tenant detail](./tenant-detail.md) · [Tenant dashboard](./tenant-dashboard.md) · [Users management](./users-management.md) · [Agent management](./agent-management.md) · [Platform dashboard + monitoring](./platform-dashboard-monitoring.md) · [Responsive](./responsive.md)

> **What this is:** a living **use-case → design → backend API → test** map for the Admin Console. It doubles as a backlog: rows where the design exists but the API or test does not are flagged as **gaps**.
>
> **How to extend:** add one `## Section` per capability area. First section below is **Tenant Management (Global / Super-Admin)** per request. Keep node IDs, route paths, and `file:line` refs exact — they are the value of this doc.

| | |
|---|---|
| **Ticket** | TASK-371 |
| **Created** | 2026-06-29 |
| **Updated** | 2026-06-30 |
| **Status** | §1 Tenant-management mapped · **§2 super-admin platform tier added** — designs done (6 frames, [UNBUILT-SURFACES-DESIGN.md](../../designs/admin/unbuilt-super-admin-surfaces.md); **layout-pattern reworked v2 2026-06-30** — matrix/form/cards/tree, de-avatared), **Dashboard + Monitoring built** ([TASK-383](../../implementation/TASK-383-Platform-Dashboard-Monitoring/README.md)), responsive pass done ([TASK-384](../../implementation/TASK-384-Responsive-Admin-Surfaces/README.md)) |
| **Sources** | Designs = `HOPE-Admin-Console` (Figma) + [README §5](../../implementation/TASK-371-Admin-Console-Redesign/README.md) + [UNBUILT-SURFACES-DESIGN.md](../../designs/admin/unbuilt-super-admin-surfaces.md); Use cases = [README §1.3](../../implementation/TASK-371-Admin-Console-Redesign/README.md) capability map + §2 current-state gaps; API = live source (`apps/api`, `packages/applications`); Tests = `apps/api/tests/e2e`, `docs/qa/manual-tests` |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — exists in code but only negative/RBAC E2E, frontend-unit (mocked), or manual coverage |
| 🔴 | **Gap** — designed, but **no backend endpoint** and/or **no test** |
| 🎯 | **Target** — design-only metric/flow with no backend yet (intentional, per README §5.14.1) |
| 🔒 | endpoint is **strictly super-admin-only** (tenant-admin lacks the CASL permission) |

**Conventions (apply to every API cell):**

- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts:64`). No further URI versioning.
- Authz is CASL (`@Authorize` / `@Can*`) enforced by a global `UnifiedAuthGuard`. **Most** tenant-management endpoints are **shared with `TENANT_ADMIN`** (tenant-scoped); super-admins get **cross-tenant** reach via inline `isSuperAdmin(user)` checks. Only 🔒 rows are exclusive to super-admins.
- A boot-time check (`auditAdminRoutePermissions`, `main.ts:227`) refuses startup if any route lacks `@Public()` or a permission decorator.

## Scope & perspective (this section)

"Tenant management for global/super-admins" = **(1)** managing the **tenant fleet** (list / create / edit / lifecycle / archive / usage / working-tenant switch) and **(2)** drilling into **any** tenant (cross-tenant) to manage its **users, departments, configuration, storage, agent instructions, and audit trail**. Tenant-admins use the same sub-resource endpoints, scoped to their own tenant.

## Coverage snapshot

- **40 use cases** mapped across 8 sub-areas.
- **~32** have a backend endpoint; **8** are backend gaps/targets: tenant **archive-status** · tenant **tags** · user **reset-password** · user **export** · prompt **compareVersions** · storage **quota** · dashboard **live sockets/consumption** · user **DNA reports**.
- Only **~8** have solid automated **backend E2E**; the majority are partial (negative/RBAC-only, frontend-unit, or manual-checklist).
- The biggest test debt is **mutations**: tenant update happy-path, tenant lifecycle, and *all* user/department/prompt write flows have **no backend E2E** today.
- **§2 — super-admin platform tier (added 2026-06-30):** 7 surfaces mapped. Backends are mostly **REAL** — RBAC roles (`admin/rbac/roles`), API Keys (`admin/api-keys`), Rate Limits (`admin/rate-limit` 🔒), Queues & Jobs (`admin/queues` 🔒), Monitoring/Health (`monitoring/*` · `health/*`). **Backend gaps:** CASL **policy-rules editing**, **global-settings CRUD**, **api-key rotate**. **Frontends mostly not built** — the old `/roles`, `/api-keys`, `/settings` pages predate the redesign; only `/dashboard` + `/system-health` are built ([TASK-383](../../implementation/TASK-383-Platform-Dashboard-Monitoring/README.md)). The 6 designs were **reworked off the table pattern (v2, 2026-06-30)** — matrix / sectioned-form / cards / master-detail tree, de-avatared — and are now design-gate-cleared for implementation (see UNBUILT-SURFACES-DESIGN.md §8).

---

# 1. Tenant Management (Global / Super-Admin)

## 1.A — Tenant fleet (`13 · Tenant Management`)

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| F1 | List + search/filter/paginate tenants (US 57; closes gap #7 `MT-01.4/.7`) | `13 · Tenant Management` `69:1416`; foundation `04 · Full-Screen Table` `59:155`, `02 · DataGrid` `60:745` | `GET /admin/tenants` `tenant.controller.ts:113` → `TenantService.fetchAll` `tenant.service.ts:447` | `tenants.spec.ts` (401 + list + pagination); `authorization.spec.ts`; `task-326…cross-tenant.spec.ts` (isolation) | 🟢 |
| F2 | View one tenant (US 61) | `18p · Overview` `95:6164` / `18d · Tenant Dashboard` `120:8843` | `GET /admin/tenants/:id` `tenant.controller.ts:168` → `fetchById :551`; also `…/code-name/:code-name :180` | `tenants.spec.ts` (401 only) | 🟡 |
| F3 | Create tenant (US 61; uniqueness pattern #8 `DEF-ADM-001`) | `Dlg · Add Tenant` `110:7669` | 🔒 `POST /admin/tenants` `tenant.controller.ts:102` (`@CanManage('Tenant')`) → `create :83` | `tenant-access-control.spec.ts` (super create→delete; doctor 403); dup-key only **manual** `MT-02` | 🟡 |
| F4 | Edit tenant (US 62; closes gap #1 `MT-03` read-only) | `Dlg · Add Tenant` `110:7669` (reused) / `22p · Configuration` `109:6768` | `PATCH /admin/tenants/:id` `tenant.controller.ts:218` (`update:Tenant`, `@RequiresIfMatch`) → `update :610` | **401 only** — no happy-path E2E; manual `MT-03 = NA` | 🔴 |
| F5 | Enable / disable tenant (US 63) | `Dlg · Disable Tenant` `110:8662` (AlertDialog) | ⚠️ `PATCH /admin/tenants/:id {resourceStatus}` — DTO allows **`ENABLED\|DISABLED` only** `updateTenant.request.ts:22` | 🔴 no tenant-level `resourceStatus` test (only roles/buckets: `task-219-gaps` A1/A7) | 🟡 API · 🔴 test |
| F6 | Archive / soft-delete tenant (X2 soft-delete · X7 confirm; closes gap #3 `DEF-ADM-002`) | `Dlg · Disable Tenant` `110:8662` ("recoverable archive") | 🔴 **no `SUSPENDED`/`ARCHIVED` status** (DTO limited to ENABLED/DISABLED). 🔒 `DELETE /admin/tenants/:id` `:244` → `deleteById :657` is the only removal | 🔴 manual `MT-04` not run; `DEF-ADM-002` (system tenant unprotected) open | 🔴 |
| F7 | Tenant usage stats (US 58/103) | `18d` KPI tiles `120:8843` | `GET /admin/tenants/:id/usage` `tenant.controller.ts:156` → `getUsageStats :898` | `task-219-gaps.spec.ts` **A8** (asserts `totalUsers`,`totalDepartments`) | 🟢 |
| F8 | Working-tenant switch / "Acting on" context (US 66, 94; closes gaps #4 NoTenant, #5 banner) | `06 · Multi-Tenancy & Impersonation` `61:985` + banner across detail pages | `GET /tenant/me` `my-tenant.controller.ts:42`; cross-tenant via header + `isSuperAdmin` | `tenant-access-control.spec.ts` (super-admin no-tenant → 400 on `/tenant/me`) | 🟡 |
| F9 | Tenant tags | tag chips on `13 · Tenant Management` rows | 🔴 **no `tags` field/endpoint** on tenant DTO | 🔴 | 🎯 |

## 1.B — Tenant Overview / Dashboard (`18p` / `18d`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| O1 | Tenant dashboard headline KPIs — active users, departments, running sessions, services (US 53–58, 103) | `18d · Tenant Dashboard` `120:8843` + states `120:10826/10998/11169/11341` | ⚠️ `GET /admin/tenants/:id/usage` (users/depts) `:156`. **Running sessions · open sockets · consumption = 🎯** (no endpoint) | `task-219-gaps` A8 (usage only) | 🟡 · 🎯 |
| O2 | Recent-activity feed (US 42, 89) | `18d` audit feed | `GET /admin/audit-logs` `audit-log.controller.ts:65` | `audit-log.spec.ts` (full) | 🟢 |
| O3 | Audio-pipeline status strip — STT/VAD/SMR/Guardrail/NLP (US 53) | `18d` pipeline strip | 🎯 service-health endpoints out of this scope (cross-ref Monitoring §future) | 🔴 | 🎯 |

## 1.C — Users management (`20u` · `38u` + panels a–g)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| U1 | Users data grid — search/filter/sort/paginate (US 26) | `20p · Users` `97:6529` / `20u · Data Grid` `120:9015`; states `120:10134` | `GET /admin/users` `user.controller.ts:100` → `fetchAll :174` | `task-375-admin-features.spec.ts` (sort/filter/search/paging); `task-326` isolation | 🟢 |
| U2 | Create user (US 27) | `Dlg · Create User` `120:10354` | `POST /admin/users` `user.controller.ts:89` → `UserService.create :55` | 🔴 no automated create; manual `UAC-01` | 🔴 |
| U3 | View / edit user detail — profile (US 28) | `38u · User Detail` `120:10575` + `38u-a · Profile` `121:11980` | `GET/PATCH /admin/users/:id` `:157`/`:236`; profile `:429`/`:439` | 🟡 frontend-unit `users.task328`; no backend mutation E2E | 🟡 |
| U4 | Enable / disable (deactivate) user (US 30) | `20u` quick-disable · `38u` | `PATCH /admin/users/:id/status` `user.controller.ts:251` | 🔴 manual `UAC-04` | 🔴 |
| U5 | Reset user password (US 31) | `20u` row action · `38u` | 🔴 **no endpoint** (per README §5.14.1: both link-reset **and** admin-temp-password are TARGET) | 🔴 | 🔴 |
| U6 | Bulk actions — assign dept / reset / disable / export (US 26) | `20u · Bulk Selected` `120:9913` | ⚠️ only `DELETE /admin/users/bulk` `:300`; no bulk enable/disable/assign | 🔴 | 🔴 |
| U7 | Export users CSV/Excel/PDF (US 26) | `20u` Export ▾ | 🔴 **no endpoint** (only audit-log CSV exists) | 🔴 | 🎯 |
| U8 | View/update user preferences (US 28) | `38u-b · Preferences` `121:11981` | `GET/PATCH /admin/users/:id/settings` `:351`/`:364`. *Admin editing another user's prefs = ⚠️ TARGET* | 🟡 `task-375` (own settings) | 🟡 |
| U9 | Personalized agent instructions, per dept (US 117–126) | `38u-c` `121:11982` | `prompt-templates` personal + preferred `prompt-template.controller.ts:55/74/86` | 🟡 frontend-unit | 🟡 |
| U10 | DNA writing-style instructions (US 117–126) | `38u-d` `121:11983` | ⚠️ `prompt-templates`; *per-dept DNA-style default slot = 🎯* | 🔴 | 🟡 · 🎯 |
| U11 | Department assignment (US 28) | `38u-e` `121:11984`; `Dlg · Assign Departments` `110:7981` | `GET/POST/PATCH/DELETE /admin/users/:id/departments` `user-departments.controller.ts:32/41/60/76` | 🟡 frontend-unit `users.task328` (CRUD+OCC, mocked); no backend E2E | 🟡 |
| U12 | DNA reports + versions (US 117–126) | `38u-f` `121:11985` | 🎯 no DNA-report endpoint found in this scope | 🔴 | 🎯 |
| U13 | User activity history (US 42) | `38u-g` `121:11986` | `GET /admin/audit-logs/user/:userId` `audit-log.controller.ts:237` | `audit-log.spec.ts` (Fetch by User) | 🟢 |

## 1.D — Departments (`34p` · `36p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| D1 | Department card-grid + create (US 43–44) | `34p · Departments` `110:7195`; foundation `08 · Card-Grid` `82:2231` | `GET /admin/departments` `department.controller.ts:44`; `POST :35` | 🟡 frontend-unit `department-create-summary-template`; no backend E2E | 🟡 |
| D2 | Department detail — members + agent instructions (US 43) | `36p · Department Detail — Cardiology` `110:7414` | `GET /admin/departments/:id :77`. 🔴 **no `GET /admin/departments/:id/users`** (reverse listing) | 🔴 | 🟡 · 🔴 |
| D3 | Default agents per dept — pre-summary / new-visit / re-visit / DNA (US 45–52) | `36p` / `30 · Agent Management` slots | `PATCH /admin/departments/:id/prompt-config` `:162`; `POST /admin/prompt-templates/assign-department` `:290`. *DNA-style slot = 🎯* | 🔴 | 🟡 · 🎯 |
| D4 | Add members to dept (both directions) (US 28) | `Dlg · Add Members` `110:8201`; `Dlg · Assign Departments` `110:7981` | `POST /admin/users/:id/departments` `user-departments.controller.ts:41` | 🟡 frontend-unit; no backend E2E | 🟡 |

## 1.E — Configuration (`22p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| C1 | Tenant config — KV / feature flags / ASR pipeline / engine (US 66; closes gap #2 `MT-06`) | `22p · Configuration` `109:6768` | `GET/PATCH /admin/tenants/configs/:identifier` `:257`/`:275`; `GET/PUT /admin/tenant-frontend-config` `tenant-frontend-config-admin.controller.ts:36/61` | 🟡 `optimistic-locking.spec.ts` (OCC/If-Match), `tenant-access-control` (403); value-validation **not** asserted; manual `MT-06 = NA` | 🟡 |

## 1.F — Storage (`37p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| S1 | Storage buckets — list / create / manage (US 60, 65) | `37p · Storage` `110:6976` | `/admin/tenants/storage/buckets*` `tenant-bucket.controller.ts:47…176` | 🟢 `task-307-*` (cross-tenant isolation), `task-219-gaps` A7 (CRUD) | 🟢 |
| S2 | Provision system buckets for a tenant | `37p` (implied) | 🔒 `POST /admin/tenants/storage/buckets/provision/:tenantId` `:165` → `provisionSystemBuckets :217` | 🔴 | 🟡 · 🔴 |
| S3 | Storage quota / usage (quota bar 92%) | `37p` quota meter | ⚠️ **no quota endpoint**; tenant-level usage via `GET /admin/tenants/:id/usage` | 🔴 quota never asserted | 🎯 |

## 1.G — Agent instructions / prompts (`30`–`33`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| A1 | Agent management by department + default-agent slots (US 45–52) | `30 · Agent Management` `120:9200` | `GET /admin/prompt-templates :66` + `assign-department :290` + dept `prompt-config :162` | 🔴 no backend; frontend-unit only | 🔴 |
| A2 | Create / edit agent instruction (editor) (US 43–52) | `31 · Agent Instruction Editor` `120:9454`; `Dlg · New Agent Instruction` `110:8440` | `POST /admin/prompt-templates :51`; `PATCH …/:id :145` | 🔴 | 🔴 |
| A3 | Version diff / compare | `32 · Version Diff` `120:9567` | 🔴 **no `compareVersions` endpoint** (only `GET …/:id/versions :178` + `…/:versionNumber :190`) | 🔴 | 🔴 |
| A4 | Version rollback / activate | `32` (activate action) | `POST /admin/prompt-templates/:id/versions/:versionNumber/activate :259` | 🟡 frontend-unit `prompt-activate-version` (mocked) | 🟡 |
| A5 | Test playground / evaluate output | `33 · Test Playground` `120:9681` | `POST /admin/prompt-templates/:id/test :236`. *Eval score 0.92 = 🎯* | 🔴 | 🟡 · 🎯 |

## 1.H — Audit log (`12`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| AU1 | Audit viewer — actor / resource / correlation + filters (US 42, 64, 89, 107) | `12 · Audit Log` `70:1843` | `GET /admin/audit-logs :65`, `…/cursor :144`, `…/:id :177`, `…/resource/:type/:id :205` | 🟢 `audit-log.spec.ts` (auth/structure/actions/isolation) + `task-326` | 🟢 |
| AU2 | Export audit trail | `12` export action | ⚠️ `GET /admin/audit-logs/export` **CSV only** `:106` (no Excel/PDF) | 🔴 no explicit export-CSV test found | 🟡 |

---

# 2. Platform Operations & Identity (Super-Admin)

> Added 2026-06-30 from [UNBUILT-SURFACES-DESIGN.md](../../designs/admin/unbuilt-super-admin-surfaces.md). **Dashboard + Monitoring are built** (TASK-383); the other surfaces are **designed only** — their layouts were **reworked off the table pattern (v2, 2026-06-30)** into matrix / sectioned-form / cards / master-detail-tree and are design-gate-cleared for implementation (per-area notes below; UNBUILT-SURFACES-DESIGN.md §8). Backend `file:line` refs verified live 2026-06-30; new-surface frontends are not built, so Test = ⬚ (n/a until built).

## 2.A — Platform Dashboard (`10`) — **built** (TASK-383)

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| P1 | Cross-tenant KPIs — active tenants · live sessions · processing jobs · degraded services | `10 · Dashboard` `69:1265` → built `/dashboard` (`routes/_authenticated/dashboard.tsx`) | `GET /monitoring/sessions` `monitoring.controller.ts:69`; `GET /monitoring/uptime` `:25`; tenants `GET /admin/tenants` + `:id/usage` | frontend-unit (TASK-383, +14) | 🟡 |
| P2 | Secondary KPIs — total users · transcription min · summaries · storage | `10` secondary row | ⚠️ users via `admin/users`; **transcription-min · summaries · storage = 🎯** | TASK-383 unit | 🟡 · 🎯 |
| P3 | Cross-tenant consultation chart + date/tenant filter | `10` chart | 🎯 no aggregate-metrics endpoint (built on `useAdminConsultations` client bucketing) | TASK-383 unit | 🎯 |

## 2.B — Monitoring / System Health (`11`) — **built** (TASK-383)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| M1 | Per-service health + uptime table (SMR degraded) | `11 · Monitoring` `70:1692` → rebuilt `/system-health` | `GET /health/services` `health.controller.ts:176`, `…/:serviceKey :219`; `GET /monitoring/uptime` `:25` | TASK-383 unit | 🟡 |
| M2 | Throughput KPIs (req/min · error rate · sockets) + request-volume chart | `11` KPI row + chart | 🎯 no metrics endpoint (P95 / req-min / sockets) | — | 🎯 |
| M3 | Models & running-tasks table | `11` models table | 🎯 no per-model runtime metrics | — | 🎯 |

## 2.C — Roles & Policies (`24` / `24b`) — designed, FE not built

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| R1 | Roles roster + hierarchy + CRUD | `24 · Roles & Policies` `166:12233` | `GET /admin/rbac/roles` `roles.controller.ts:32`, `:id :56`, `POST :72`, `PUT :91`, `PATCH :110`, `DELETE :130` | ⬚ | 🔴 (FE = old `/roles`; **pattern-rework: master-detail + tree**) |
| R2 | Attach / detach policy to role (priority) | `24` "N policies" | `POST/DELETE /admin/rbac/roles/:roleId/policies/:policyId` `:144` / `:161` | ⬚ | 🔴 |
| R3 | Edit a policy's CASL ability rules (builder) | `24b · Policy / Ability Builder` `167:12507` | 🔴 **no `Policy` CRUD / rules-edit endpoint** (policies are seed-only; no `policies.controller.ts`) | ⬚ | 🔴 · 🎯 (**wrong pattern → matrix/rule-builder**) |
| R4 | Per-role assigned-user count · effective-ability preview | `24` / `24b` | 🎯 no roll-up / simulation endpoint | ⬚ | 🎯 |

## 2.D — API Keys (`25`) — designed, FE not built

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| K1 | List / search keys (masked) | `25 · API Keys` `167:12781` | `GET /admin/api-keys` `api-key.controller.ts:54` (tenant-scoped or all); scopes `:31` | ⬚ | 🔴 (FE = old `/api-keys`) |
| K2 | Create key — secret shown once (X8) | `25b` (spec-only dialog) | `POST /admin/api-keys` `:39` → `rawKey` once | ⬚ | 🔴 |
| K3 | View key + usage | `25` row → detail | `GET /admin/api-keys/:id` `:76`; `…/:id/usage` `:131` (scalar) | ⬚ | 🔴 · 🎯 (usage-over-time) |
| K4 | Update / revoke / delete key | `25` kebab | `PATCH …/:id :89`; `POST …/:id/revoke :117`; `DELETE …/:id :103` | ⬚ | 🔴 |
| K5 | Rotate key (grace window) | `25` rotate (spec) | 🔴 **no rotate endpoint** (model has rotation fields) | ⬚ | 🔴 · 🎯 |

## 2.E — Rate Limits (`14`) — designed, FE not built 🔒

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| RL1 | View throttle config — global switch · tiers · route overrides | `14 · Rate Limits` `167:13055` | 🔒 `GET /admin/rate-limit` `rate-limit-admin.controller.ts:29` | ⬚ | 🔴 (**pattern-rework: tier cards + prominent kill-switch**) |
| RL2 | Toggle global kill-switch | `14` switch (buried in subtitle as built) | 🔒 `PUT /admin/rate-limit/enabled` `:36` | ⬚ | 🔴 |
| RL3 | Edit a tier baseline | `14` tier rows (should be cards) | 🔒 `PUT /admin/rate-limit/tiers/:tier` `:43` | ⬚ | 🔴 |
| RL4 | Edit a route override | `14` route table | 🔒 `PUT /admin/rate-limit/routes/:routeId` `:51` | ⬚ | 🔴 |
| RL5 | Live usage / throttled-now counters | `14` (TARGET col) | 🎯 runtime hit-counts not exposed | ⬚ | 🎯 |

## 2.F — Queues & Jobs (`15`) — designed, FE not built 🔒

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| Q1 | List queues + counts + Redis health | `15 · Queues & Jobs` `168:13329` | 🔒 `GET /admin/queues` `queue-admin.controller.ts:47`; `…/:queueName :54` | ⬚ | 🔴 (**augment: depth/throughput viz + Redis card**) |
| Q2 | Pause / resume / clean a queue | `15` row actions | 🔒 `POST …/:queueName/{pause,resume,clean}` `:62` / `:72` / `:82` | ⬚ | 🔴 |
| Q3 | Jobs list + retry / promote / remove + bulk | `15` jobs drawer | 🔒 `GET …/:queueName/jobs :94`; `…/jobs/bulk :102`; `…/:jobId :111`; retry `:120`; promote `:131`; `DELETE :142` | ⬚ | 🔴 |

## 2.G — Settings (`16`) — designed, **backend gap**

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| ST1 | Global settings KV editor by namespace | `16 · Settings` `168:13603` | 🔴 **no dedicated `admin/global-settings` CRUD**; `GlobalSetting` seeded + consumed; only `rate-limit.*` via `admin/rate-limit`, tenant-scoped via `admin/tenants/configs/:identifier` (C1) | ⬚ | 🔴 · 🎯 (**pattern-rework: sectioned form, typed controls**) |
| ST2 | Locked-row protection + secret masking | `16` Access col | ⚠️ enforced at write-path; no editor endpoint to enforce against | ⬚ | 🎯 |
| ST3 | Bulk import / export settings | `16` (TARGET) | 🎯 | ⬚ | 🎯 |

---

## Backlog rollup (gaps → tickets)

Derived from the 🔴 / 🎯 rows above — candidate backend/test tickets:

**Backend — missing endpoints**
1. **Tenant archive lifecycle** (F6) — add `SUSPENDED`/`ARCHIVED` to tenant `resourceStatus` + soft-delete semantics; protect system tenant (`DEF-ADM-002`, X2/X4).
2. **Tenant tags** (F9) — `tags` field + management endpoint.
3. **User reset-password** (U5) — both emailed-link (audited) and admin-set temp password forcing change at next login.
4. **User export** (U7) — CSV/Excel/PDF (currently only audit CSV).
5. **User bulk actions** (U6) — bulk enable/disable/assign-dept beyond `DELETE /admin/users/bulk`.
6. **Prompt `compareVersions`** (A3) — diff endpoint backing `32 · Version Diff`.
7. **Department → users listing** (D2) — `GET /admin/departments/:id/users`.
8. **Per-dept DNA-style default agent** (D3/U10) — column/`promptConfig` key.
9. **Dashboard live metrics** (O1/O3) — running sessions, open sockets, consumption, audio-pipeline health.
10. **Storage quota** (S3) — quota limit + enforcement/read endpoint.
11. **CASL policy-rules editing** (R3) — no `Policy` CRUD / rules-update endpoint backs the `24b` ability builder (policies are seed-only; no `policies.controller.ts`).
12. **Global-settings CRUD** (ST1) — no `admin/global-settings` endpoint behind the `16 · Settings` editor (values are seeded + consumed; only `rate-limit.*` and tenant configs are writable).
13. **API-key rotate** (K5) — model has rotation fields but no dedicated rotate endpoint (only create/revoke/delete).
14. **Platform runtime metrics** (P2/P3 · M2/M3 · RL5 · K3) — transcription-min/summaries/storage roll-ups, P95/req-min/open-sockets, per-model runtime, rate-limit live counters, api-key usage-over-time.

**Frontend — designed, not yet built** (backends mostly exist; legacy routes predate the redesign)
- `24 · Roles & Policies` + `24b · Policy Builder` · `25 · API Keys` · `14 · Rate Limits` · `15 · Queues & Jobs` · `16 · Settings` — implement the new frames, replacing the legacy `/roles`, `/api-keys`, `/settings` pages. **Design-gate cleared — rework done (v2) below.**

**Design — layout-pattern rework** ✅ **DONE (v2, 2026-06-30 — verified by eye, all PASS)** · screenshots `*-v2.png` · log: UNBUILT-SURFACES-DESIGN.md §8
- ✅ `24b · Policy / Ability Builder` — flat table → **permission matrix** (subjects × actions, allow/deny/conditional) + **rule-detail editor** (cannot-toggle · conditions · reason · CASL JSON mirror). `admin-24b-policy-builder-v2.png`
- ✅ `16 · Settings` — KV table → **sectioned settings form** with type-appropriate controls (Switch / Select / number+unit / JSON / masked secret); locked = disabled + lock; dirty-state Save/Discard. `admin-16-settings-v2.png`
- ✅ `14 · Rate Limits` — tier baselines as **4 cards** + prominent **global kill-switch**; route-overrides table retained. `admin-14-rate-limits-v2.png`
- ✅ `15 · Queues & Jobs` — **Redis-health card** + per-queue **depth bars + throughput/min**; dense table retained. `admin-15-queues-jobs-v2.png`
- ✅ `24 · Roles & Policies` — **master-detail + inheritance tree** + real **effective-abilities preview** (not just counts). `admin-24-roles-v2.png`
- ✅ cross-cutting — decorative 2-letter avatars dropped on non-person entities (monochrome type icons / key tile); avatars reserved for people. `admin-25-api-keys-v2.png`

**Test — missing automated backend E2E** (design + endpoint exist, no E2E)
- Tenant **update happy-path** (F4) · tenant **enable/disable** (F5).
- User **create** (U2) · **disable** (U4) · **department assignment** (U11, backend).
- **Department CRUD** (D1) + **prompt-config / default agents** (D3).
- **Prompt** create/update/activate (A2/A4) and **test** (A5).
- **Storage provision** (S2).

> **Design-vs-backend reconciliation** is also tracked narratively in [README §5.14.1](../../implementation/TASK-371-Admin-Console-Redesign/README.md). This matrix is the row-level, testable view of the same gaps.
