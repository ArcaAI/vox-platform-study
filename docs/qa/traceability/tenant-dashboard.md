> _Relocated from `docs/implementation/TASK-380-Tenant-Dashboard/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-380 — Tenant Dashboard (frame 18d) Traceability Matrix

> **What this is:** a **use-case → design → backend API → test → status** map for the `18d`
> Tenant Dashboard, mirroring [`../TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md`](./README.md)
> (same legend + columns). Backend `file:line` refs were verified against live source under
> `apps/api` / `packages/applications` on 2026-06-30. This ticket **deepens** the TASK-371
> rows **O1 / O2 / O3** (Tenant Overview/Dashboard) and reuses the platform service-health
> logic behind **P1 / P3 / M1** — those rows are cross-linked per use case.

| | |
|---|---|
| **Ticket** | TASK-380 |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Surface **built — Completed** (matches [TASK-380 README](../../implementation/TASK-380-Tenant-Dashboard/README.md)); design-spec + matrix + automated/manual E2E authored; **live backend E2E run** — all sources pass. The former **TD3 contract finding** (super_admin `GET /admin/consultations` with no tenant scope → **400**) is **RESOLVED by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)** — that path now returns **cross-tenant** data (tenant-admins stay pinned). Manual UI suite still Not Run. |
| **Sources** | Design = `HOPE-Admin-Console` `18d` (`120:8843`) + states (`120:10826/10998/11169/11341`) + [README §5.14](../../implementation/TASK-371-Admin-Console-Redesign/README.md); Code = `routes/_authenticated/tenants/$tenantId/overview.tsx` + `features/tenant-dashboard/*`; API = live `apps/api` / `packages/applications`; Tests = `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts`, `apps/admin/e2e/task-380-tenant-dashboard.spec.ts`, `apps/admin/src/features/tenant-dashboard/__tests__/*`, [`MANUAL-E2E-TESTS.md`](../manual-tests/05-tenant-dashboard.md) |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — exists in code but only negative/RBAC E2E, frontend-unit (mocked/stubbed), or manual coverage |
| 🔴 | **Gap** — designed, but **no backend endpoint** and/or **no test** |
| 🎯 | **Target** — design-only metric/flow with no backend yet (intentional, per README §3 / TASK-371 §5.14.1) |
| 🔒 | endpoint is **strictly super-admin-only** (tenant-admin lacks the CASL ability → 403; the KPI degrades, never fabricates) |

**Conventions (apply to every API cell):**

- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts`). No further URI versioning.
- Authz is CASL (`@Authorize` / `@Can*`) enforced by the global `UnifiedAuthGuard`. The dashboard fans out with `Promise.allSettled`, so each source **degrades independently**; a failure of the focal **consultations** source is the only one that drives the page's error variant.
- 🔒 rows (`/monitoring/*`, `/health/services`) are gated `@Authorize(['manage','all'])` (SUPER_ADMIN). For a **tenant-admin** those calls 403 and the corresponding KPIs render em-dash / `unknown` — this is REAL behavior, asserted in the backend spec (not the error state).

## Coverage snapshot

- **7 use cases** mapped for the `18d` surface (TD1–TD7).
- Backed-today (no new backend): tenant **usage** (users/depts), **audit-logs**, **monitoring sessions** (🔒), **service health** (🔒), **admin consultations** list. The chart, today-split, pending-review, activity, and pipeline view-models are **pure client derivations** over those sources (unit-tested in `features/tenant-dashboard/__tests__/*`, 45 tests).
- **TARGET (no backend, drawn/flagged never fabricated):** Open sockets · Consumption · per-model audio-stream counts · **server-side range aggregation** for the chart (client-buckets the most-recent page).
- **Test posture:** backend REAL contract + tenant-scoping/RBAC in `task-380-tenant-dashboard.spec.ts`; frontend render + controls + KPI reflow in the admin `task-380` spec (authored — run when stack up); logic in vitest; black-box flows in `MANUAL-E2E-TESTS.md`.

---

# 1. `18d · Tenant Dashboard` — use cases

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| **TD1** | **Headline KPIs** — Active users · Departments · Running sessions · Services healthy `n/total` (US 53–58, 103) | `18d` `120:8843` headline row | Users/Depts: `GET /admin/tenants/:id/usage` `tenant.controller.ts:151` → `getUsage :156` → `getUsageStats` `tenant.service.ts:898`. Running sessions: 🔒 `GET /monitoring/sessions` `monitoring.controller.ts:69` → `getSessions :72`. Services healthy: 🔒 `GET /health/services` `health.controller.ts:176` → `checkServices :186`. Open sockets = 🎯 | `task-380` BE (usage shape + sessions/health 🔒 403 for tenant-admin); `service-health.test.ts` (`summarizeServiceHealth`); `task-380` FE (tiles render) | 🟡 · 🔒 |
| **TD2** | **Secondary KPIs** — Open sockets [TARGET] · Processing jobs · Consultations today (new vs re-visit) · Pending review · Consumption [TARGET] | `18d` `120:8843` secondary row | Processing jobs: 🔒 `GET /monitoring/sessions` `monitoring.controller.ts:69`. Today / pending: `GET /admin/consultations` `admin-consultation.controller.ts:52` (`list`). Open sockets · Consumption = 🎯 (no endpoint) | `consultations.test.ts` (`splitVisits`/`countPendingReview`/`filterToday`); `task-380` BE (consultations list + scope); `task-380` FE (today + pending tiles) | 🟡 · 🎯 |
| **TD3** | **Focal consultation chart** (new vs re-visit / day) + `DateRangeSelector` (Week/Month/Year) + `TenantFilter` (super-admin) | `18d` `120:8843` chart + range/tenant controls | `GET /admin/consultations` `admin-consultation.controller.ts:52` (client-buckets the page). Tenant list for the switcher: `GET /admin/tenants` `tenant.controller.ts:113`. **Server-side range aggregation now backed by `GET /admin/consultations/aggregate`** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md) E4 — zero-filled day/month buckets, new/re-visit split); the chart's client-side bucketing of the most-recent page is the remaining FE-wiring step. **TD3-400 RESOLVED ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)):** the super_admin **no-tenant-scope** call previously returned **400** and now returns **cross-tenant** data (`listConsultationsForTenant`; tenant-admins stay pinned) | `chart.test.ts` (`buildRangeBuckets`/`bucketConsultations`/`rangeWindow`); `task-380` FE (chart renders, range switch, super-admin filter present / tenant-admin absent); `task-380` BE; `task-386` BE (`PM7` cross-tenant contract, `PM4` aggregate) | 🟡 · 🎯 (chart FE wiring) · **TD3-400 resolved** (TASK-386) |
| **TD4** | **Recent-activity** audit feed (`ItemList`) (US 42, 89) | `18d` `120:8843` activity card | `GET /admin/audit-logs` `audit-log.controller.ts:65` (`fetchAll`, `@CanRead('AuditLog')`; tenant-scoped, super-admin cross-tenant; X5 ctx guard `:74`) | `activity.test.ts` (`humanizeAction`/`actorOf`/`activityDotRole`/`scopeToTenant`/`toActivityItems`); `task-380` BE (list + tenant scope); `task-380` FE (activity rows render) | 🟢 |
| **TD5** | **Audio-pipeline strip** — STT · VAD · SMR(degraded) · Guardrail · NLP (`ServiceStatusItem`) (US 53) | `18d` `120:8843` pipeline strip | 🔒 `GET /health/services` `health.controller.ts:176` → `checkServices :186` (REAL per-service health; **per-model running counts = 🎯**) | `service-health.test.ts` (`normalizeServiceHealth`/`audioPipelineRows`, incl. VAD-from-STT); `task-380` BE (health map 🔒); `task-380` FE (strip renders) | 🟡 · 🔒 · 🎯 |
| **TD6** | **State variants** — loading (skeletons) · empty · error (retry) · tenant-admin read-only | states `120:10826` / `120:10998` / `120:11169` / `120:11341` | derived from the same sources (no extra endpoint); error variant driven by the **consultations** rejection | `task-380` FE (empty/error/loading reachable via render); derivations exercised by the four vitest suites; `MANUAL-E2E-TESTS.md` TDB-05/06/07 | 🟡 |
| **TD7** | **Scope & RBAC** — super-admin cross-tenant + `TenantFilter`; tenant-admin own-tenant, **no** filter, 🔒 telemetry degrades | `18d` tenant-admin `120:11341` | `assertTenantInScope` `tenant.controller.ts:63` (other-tenant usage → **403**); 🔒 `monitoring`/`health` 403 for tenant-admin; `admin/consultations` `@CanManage('Consultation')` (doctor → 403) | `task-380` BE (tenant-admin 403 on monitoring/health + other-tenant usage; doctor 403 on consultations); `task-380` FE (filter present super-admin / absent tenant-admin); `MANUAL-E2E-TESTS.md` (X1 isolation) | 🟢 |

---

# 2. Cross-links to the TASK-371 matrix

This ticket is the **build + test** of TASK-371's tenant-dashboard rows, reusing the platform service-health logic. Statuses below are **after** this pass (TASK-371 listed O1/O3 as 🟡·🎯 / 🎯 before any FE wiring/tests):

| TASK-371 row | TASK-371 status (pre) | Covered by | TASK-380 status (post) |
|---|---|---|---|
| **O1** — Tenant dashboard headline KPIs (active users, departments, running sessions, services) | 🟡 · 🎯 | **TD1** | 🟡 · 🔒 (users/depts 🟢; sessions/health REAL but super-admin-only; open sockets 🎯) |
| **O2** — Recent-activity feed | 🟢 | **TD4** | 🟢 |
| **O3** — Audio-pipeline status strip (STT/VAD/SMR/Guardrail/NLP) | 🎯 | **TD5** | 🟡 · 🔒 · 🎯 (now wired to REAL `GET /health/services`; per-model counts remain 🎯) |
| **P1** — Cross-tenant platform KPIs (live sessions, jobs, degraded services) — TASK-383 | 🟡 | shares `monitoring`/`health` sources behind **TD1/TD2/TD5** | 🟡 (same 🔒 endpoints) |
| **P3** — Cross-tenant consultation chart + date/tenant filter — TASK-383 | 🎯 | same client-bucketing pattern as **TD3** | 🎯 (chart FE wiring; server aggregation now backed by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md) E4) |
| **M1** — Per-service health + uptime (SMR degraded) — TASK-383 | 🟡 | same `GET /health/services` source as **TD5** | 🟡 · 🔒 |

---

# 3. Backlog rollup (gaps → tickets)

Derived from the 🎯 / 🔒 rows above — these are **not** TASK-380 defects (the surface honors them by drawing em-dash / degrading), but candidate backend tickets (consistent with TASK-371 §Backlog #9 / #14):

1. **Tenant-scoped live telemetry** — `running sessions`, `processing jobs`, and `service health` come from **super-admin-only** `monitoring`/`health` endpoints (`@Authorize(['manage','all'])`). A **tenant-scoped** sessions/health read would let tenant-admins see live KPIs instead of em-dash.
2. **Open-sockets count** (TD1/TD2) — no concurrent-WS telemetry endpoint.
3. **Consumption / usage roll-up** (TD2) — no summaries-per-24h / quota endpoint.
4. **Per-model audio-stream counts** (TD5) — `version` labels are static; no per-model runtime metric.
5. **Consultation range aggregation** (TD3) — **backend RESOLVED by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)**: `GET /admin/consultations/aggregate` returns server-side zero-filled day/month buckets (new vs re-visit). The tenant-dashboard chart still buckets the most-recent page client-side until it is re-wired to the aggregate endpoint (FE follow-up).

> Narrative design-vs-backend reconciliation lives in [TASK-371 README §5.14.1](../../implementation/TASK-371-Admin-Console-Redesign/README.md); this matrix is the row-level, testable view for the `18d` surface.
