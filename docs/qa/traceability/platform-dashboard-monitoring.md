> _Relocated from `docs/implementation/TASK-383-Platform-Dashboard-Monitoring/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-383 — Platform Dashboard + Monitoring Traceability Matrix

> **What this is:** the row-level **use-case → design frame → backend API (`file:line`) → test →
> status** map for the two super-admin platform surfaces shipped in TASK-383 (`10 · Dashboard`,
> `11 · Monitoring`). Mirrors the format of
> [TASK-371 `TRACEABILITY-MATRIX.md`](./README.md) and
> **expands its rows P1–P3 / M1–M3** (§2.A/§2.B there) with the as-built routes, verified API refs,
> and the new TASK-383 tests.

| | |
|---|---|
| **Ticket** | TASK-383 |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Built (Review). Backend + frontend E2E **authored** (run pending a seeded stack); unit tests green. |
| **Cross-link** | Expands [TASK-371 matrix §2.A (P1–P3)](./README.md#2a--platform-dashboard-10--built-task-383) + [§2.B (M1–M3)](./README.md#2b--monitoring--system-health-11--built-task-383) |
| **Sources** | Designs = `HOPE-Admin-Console` frames `10` `69:1265` / `11` `70:1692` + [TASK-371 README §5.9](../../implementation/TASK-371-Admin-Console-Redesign/README.md); API = live source (`apps/api`); Tests = `apps/api/tests/e2e`, `apps/admin/e2e`, `apps/admin/src/features/platform-dashboard/__tests__`, this folder's `MANUAL-E2E-TESTS.md` |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — exists in code but only unit (mocked), authored-not-yet-run E2E, or manual coverage |
| 🔴 | **Gap** — designed, but **no backend endpoint** and/or **no test** |
| 🎯 | **Target** — design-only metric/flow with no backend yet (intentional; "never fabricate" → em-dash) |
| 🔒 | endpoint is **strictly super-admin-only** (tenant-admin lacks the CASL ability) |

**Conventions (apply to every API cell):**

- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts`). No further URI versioning.
- Authz is CASL (`@Authorize` / `@Can*`) via a global `UnifiedAuthGuard`. The two **platform-ops**
  data sources are 🔒 super-admin: `MonitoringController` is class-gated `@Authorize(['manage','all'])`
  (`monitoring.controller.ts:14`) and `/health/services` is method-gated `@Authorize(['manage','all'])`
  (`health.controller.ts:182`). `admin/tenants`, `admin/users`, `admin/consultations` are shared with
  `TENANT_ADMIN` but reach **cross-tenant** only for a super-admin (no tenant binding) — see each row.
- `file:line` verified against live source on **2026-06-30**.

## Coverage snapshot

- **6 primary use cases** (P1–P3 Dashboard, M1–M3 Monitoring) + 1 cross-cutting gate + 1 risk.
- **REAL & backed today:** active-tenants, live-sessions/processing-jobs, degraded-services,
  total-users, consultation chart, per-service health, uptime, model/service identity — **8** data
  bindings across **5** live endpoints (`/admin/tenants`, `/admin/users`, `/monitoring/sessions`,
  `/monitoring/uptime`, `/health/services`) + `/admin/consultations`.
- **T1 — Platform runtime metrics backend: RESOLVED by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)** (= TASK-371 backlog #14). New `/admin/platform/{metrics,sockets,consumption}` + `/admin/consultations/aggregate` + extended `/admin/tenants/:id/usage` back the former TARGET tiles. **DB-aggregation values are fully live** (transcription-min, summaries, storage used/quota, consultation aggregate, tenant usage); **open/total sockets** are live via Redis aggregation. **Prometheus-derived values are env-dependent** (requests/min, error-rate, per-service **P95**, per-model **running + avg-latency**, request-volume series): they require the opt-in `prometheus` dev profile + scraped services and **degrade to em-dash** otherwise. The "▲ delta / across-N-tenants" annotations remain omitted (no historical/per-tenant-breakdown endpoint).
- **Tests:** **14** unit tests (`features/platform-dashboard/__tests__`, green); **1** backend E2E spec
  + **1** frontend E2E spec **authored** (run pending a seeded stack); **1** manual suite
  (`MANUAL-E2E-TESTS.md`).
- **Risk R1:** no **route-level** super-admin guard on `/dashboard` or `/system-health` (both are now
  nav-hidden — **F-NAV1 resolved** — plus API-403; the route `beforeLoad` guard is the remaining gap).
  Documented below; not fixed in this ticket.

---

# 1. Platform Dashboard (`10 · Dashboard` `69:1265`) — built `/dashboard`

Route: [`routes/_authenticated/dashboard.tsx`](../../../apps/admin/src/routes/_authenticated/dashboard.tsx). ↔ expands TASK-371 §2.A.

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| **P1** | Headline KPIs — **active tenants · live sessions · processing jobs · degraded services** (cross-tenant "healthy & busy now"). ↔ TASK-371 §2.A P1 | `10` headline row `69:1265` | `GET /admin/tenants` `tenant.controller.ts:113` (super-admin → cross-tenant list, count); `GET /monitoring/sessions` 🔒 `monitoring.controller.ts:69`; `GET /health/services` 🔒 `health.controller.ts:176` (degraded count + names via `summarizeServiceHealth`) | unit `service-table.test.ts`, `format.test.ts`; backend `task-383-platform-dashboard.spec.ts` (tenants list · sessions · services — authored); frontend `task-383-platform-dashboard.spec.ts` (KPIs render) | 🟡 |
| **P2** | Secondary KPIs — **total users** (REAL) · transcription-min · summaries · storage (now REAL via TASK-386). ↔ TASK-371 §2.A P2 | `10` secondary row | `GET /admin/users` `user.controller.ts:100` (super-admin cross-tenant `count` → Total users). **transcription-min · summaries · storage now backed by `GET /admin/platform/consumption` + `GET /admin/tenants/:id/usage`** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md) DB roll-up — fully live, incl. `quotaBytes`) | unit `format.test.ts` (nullish→em-dash); backend spec (users total — authored); `task-386` BE (`PM3` consumption, `PM5` usage) | 🟡 (REAL via TASK-386) |
| **P3** | Cross-tenant **consultation chart** + Date-range (Week/Month/Year) + Tenant filter (All tenants → drill to tenant overview). ↔ TASK-371 §2.A P3 | `10` chart + controls | `GET /admin/consultations` `admin-consultation.controller.ts:52` (`@CanManage('Consultation')`; **super-admin no-scope now returns cross-tenant data** — TASK-386 TD3 fix; client-bucketed by `bucketConsultations`). **Server-side aggregation / date-bucketing now backed by `GET /admin/consultations/aggregate`** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md) E4, DB zero-filled buckets — fully live); chart FE consumption is the remaining wiring | frontend spec (chart + range/tenant controls present — authored); bucketing logic covered in TASK-380 `tenant-dashboard` unit; `task-386` BE (`PM4` aggregate, `PM7` cross-tenant) | 🟡 · 🎯 (chart FE wiring) |

---

# 2. Monitoring (`11 · Monitoring` `70:1692`) — rebuilt `/system-health`

Route: [`routes/_authenticated/system-health.tsx`](../../../apps/admin/src/routes/_authenticated/system-health.tsx). ↔ expands TASK-371 §2.B.

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| **M1** | **Services table** — per-service dot+label status + uptime (SMR Degraded); canonical API/STT/SMR/NLP/Guardrail/Harness order. P95 now backed (TASK-386). ↔ TASK-371 §2.B M1 | `11` Services table `70:1692` | `GET /health/services` 🔒 `health.controller.ts:176` (REAL status); `GET /monitoring/uptime` 🔒 `monitoring.controller.ts:25` (REAL uptime, health `uptime_seconds` fallback). **Per-service P95 now backed by `GET /admin/platform/metrics`** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md), Prometheus `http_request_duration_seconds` — **env-dependent**: needs the `prometheus` profile, em-dash otherwise) | unit `service-table.test.ts` (order, role map, SMR degraded, uptime join, null-tolerant); backend spec (services + uptime — authored); frontend spec (Services rows) | 🟡 · P95 via TASK-386 (env-dependent) |
| **M2** | **Throughput KPIs** (requests/min · error rate · sockets/min · total sockets) + **request-volume chart**. ↔ TASK-371 §2.B M2 | `11` KPI row + chart | **Now backed by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)**: `GET /admin/platform/sockets` → **open/total sockets** (Redis aggregation — fully live); `GET /admin/platform/metrics` → requests/min · error-rate · sockets/min · request-volume series (Prometheus — **env-dependent**, em-dash without the `prometheus` profile) | frontend spec (KPIs render as em-dash/Target; chart empty-state) — authored; `task-386` BE (`PM1` metrics, `PM2` sockets) | 🟡 (sockets live; throughput env-dependent) |
| **M3** | **Models & running tasks** table — 6 grounded models × host service (identity REAL); running + avg-latency now backed (TASK-386). ↔ TASK-371 §2.B M3 | `11` models table | **identity REAL** = `PLATFORM_MODELS` inventory (grounded in TASK-371 §5.9 deployed models); **running · avg-latency now backed by `GET /admin/platform/metrics`** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md), Prometheus `model_running_instances` + `model_inference_latency_seconds` keyed `{service,model}` — **env-dependent**, missing scrape → em-dash/null) | unit `models.test.ts` (6 ids unique, host-service map); frontend spec (model rows) — authored | 🟡 · running/latency via TASK-386 (env-dependent) |

---

# 3. Cross-cutting

| ID | Concern | Design | Backend / code | Test | Status |
|---|---|---|---|---|---|
| **G1** | **Super-admin-only** access to platform-ops data (tier 10–19). | both frames are cross-tenant, super-admin only | 🔒 `MonitoringController` `@Authorize(['manage','all'])` `monitoring.controller.ts:14`; 🔒 `/health/services` `health.controller.ts:182`; nav `requireSuperAdmin` (`nav.ts`) | backend spec asserts `doctor` → **403** on `/monitoring/sessions`, `/monitoring/uptime`, `/health/services` (authored); manual `PDM-04` | 🟡 |
| **R1** | **No route-level guard** on `/dashboard` · `/system-health` (router context carries only `isAuthenticated`). **Both** Dashboard and Monitoring are now nav-hidden (`requireSuperAdmin`) — Finding **F-NAV1 RESOLVED** (`nav.ts:58` gained `requireSuperAdmin: true`). A tenant-admin deep-link still sees the shell, but cross-tenant data **403s at the API** (no leak); the remaining gap is the **route-level** `beforeLoad` guard. | — | nav-hide (now **both** surfaces) + API-403 (both); **route-level** guard deferred (TASK-384 / shell follow-up) | manual `PDM-03.2/.3` (deep-link default-deny, X5) | 🔴 (route guard only) · mitigated by G1 + nav-hide |

---

## Backlog rollup (gaps → tickets)

Derived from the 🎯 / 🔴 rows — candidate backend/test work:

**Backend — missing endpoints (TARGET → REAL)**

- **T1 · Platform runtime metrics** (P2 · P3 · M1-P95 · M2 · M3) — **RESOLVED by
  [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)** (= TASK-371 backlog
  #14). Shipped `/admin/platform/{metrics,sockets,consumption}`, `/admin/consultations/aggregate`,
  extended `/admin/tenants/:id/usage` (+ `quotaBytes`), widened tenant telemetry, Redis socket
  aggregation, and ~12 s caching. **DB roll-ups + sockets are fully live;** the Prometheus-derived
  values (req/min, error-rate, per-service **P95**, per-model **running** + **avg latency**,
  **request-volume time-series**) are **env-dependent** — they need the opt-in `prometheus` dev
  profile + scraped services and degrade to em-dash otherwise. The omitted "▲ N this week" deltas /
  "across N tenants" breakdowns remain unbacked (no historical / per-tenant-breakdown endpoint).

**Frontend / platform — risk**

- **R1 · Route-level super-admin guard** for `/dashboard` + `/system-health` — today **both** are
  nav-hidden (F-NAV1 resolved) + API-403; add a role-aware route `beforeLoad` guard (or redirect) once
  the router context carries roles. Tracked against the shell / TASK-384 follow-up.

**Test — pending a seeded stack**

- Backend `task-383-platform-dashboard.spec.ts` and frontend `task-383-platform-dashboard.spec.ts`
  are **authored**; promote the REAL rows (P1, P2-users, M1, G1) from 🟡 → 🟢 once run green against a
  seeded stack (`curl -s localhost:8868/api/v1/health`).

> The narrative REAL-vs-TARGET split lives in [README §2](../../implementation/TASK-383-Platform-Dashboard-Monitoring/README.md); this matrix is the
> row-level, testable view of the same surfaces.
