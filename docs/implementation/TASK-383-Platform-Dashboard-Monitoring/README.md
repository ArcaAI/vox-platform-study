# TASK-383 — Platform Dashboard + Monitoring (frames 10 & 11)

| | |
|---|---|
| **Ticket** | TASK-383 |
| **Type** | Feature (design-approved build) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Completed — build + design/traceability/test artifacts in place; feasible gates green (type-check · 215 vitest · both Playwright `--list`). **Live backend E2E run: 7/7 green.** **F-NAV1 RESOLVED** (Monitoring nav now `requireSuperAdmin`). **T1 (platform-metrics backend) RESOLVED by [TASK-386](../TASK-386-Platform-Metrics-Backend/README.md)** — DB roll-ups + sockets fully live; Prometheus-derived values env-dependent (opt-in `prometheus` profile, em-dash otherwise). Remaining follow-up: **R1** (route-level `beforeLoad` super-admin guard). |
| **App** | `apps/admin` |
| **Design** | `HOPE-Admin-Console` frames `10 · Dashboard` (`69:1265`) + `11 · Monitoring` (`70:1692`) |
| **Refs** | TASK-371 [`README.md`](../TASK-371-Admin-Console-Redesign/README.md) §5.9 (Pass 9) · TASK-377 [Shared Metrics](../TASK-377-Shared-Metrics-Components/README.md) · TASK-380 [Tenant Dashboard](../TASK-380-Tenant-Dashboard/README.md) |

> **Scope guard:** work is confined to `apps/admin` — a new `/dashboard` route, the existing
> `/system-health` (Monitoring) route, `nav.ts`, the generated `routeTree.gen.ts`, and a new
> `features/platform-dashboard/*` pure-logic folder. **No** edits to `packages/ui` (compose its
> primitives), the SDK (`packages/agentic-sdk-v2`), `app-shell.tsx`, `roles.tsx`, `api-keys.tsx`,
> `settings.tsx`, or the TASK-371 design docs.

---

## 1. Requirement Analysis

Build the two **already-approved** super-admin **platform** surfaces from the TASK-371 Pass-9 redesign
that are designed but not yet implemented:

1. **Platform Dashboard** (frame `10`) — a new `/dashboard` route: a cross-tenant overview answering
   *"is the whole platform healthy & busy right now?"*
2. **Monitoring** (frame `11`) — the Service-Health redesign, built **in place** on the existing
   `/system-health` route: real-time health, latency & throughput across all microservices.

Both compose the shipped TASK-377 metrics primitives (`StatCard`, `MetricChart`,
`DateRangeSelector`, `TenantFilter`, `MetricTable`, `StatusDot`, `ServiceStatusItem`) and mirror the
REAL-vs-TARGET data handling + loading/empty/error variants proven by TASK-380's tenant `overview.tsx`.

### Acceptance criteria (Pass-9 spec)

**Dashboard (frame 10):**
- Headline KPIs: Active tenants · Live sessions · Processing jobs · **Degraded services**.
- Secondary KPI row: Total users · Transcription min (24h) · Summaries (24h) · Storage used.
- Full-width `MetricChart` (Consultation sessions / day) with `DateRangeSelector` (Week/Month/Year)
  + `TenantFilter` (All tenants) controls.
- Loading / empty / error variants.

**Monitoring (frame 11):**
- Headline KPIs: Requests/min · Error rate · Sockets/min · Total sockets.
- `MetricChart` (Request volume) with the same Week/Month/Year + All-tenants controls.
- **Services** table: per-service dot+label status · P95 ms · uptime % (SMR shown Degraded).
- **Models & running tasks** table: whisper-large-v3-turbo, silero-vad-v5, gemma-4-e4b,
  granite-guardian-4.1-8b, Medical-NER, symps-disease-bert (service · running · avg latency).
- Loading / empty / error variants.

**Nav:** add a new **Overview** section (first) with `Dashboard → /dashboard` (super-admin only);
relabel **System Health → Monitoring**.

## 2. Current State

- `routes/_authenticated/system-health.tsx` (the screen Monitoring replaces) renders an overall-status
  card + a 4-KPI row + a service card grid off `useHealthCheck` / `useMonitoring`, polling every 30s.
- `lib/nav.ts` has 5 sections; "System Health" lives under **Observability** pointing at
  `/system-health` (`requireSuperAdmin` gates the Platform tier; nav-level only, no route guard).
- `routes/index.tsx` redirects authenticated users to `/tenants`; the router context only carries
  `isAuthenticated` (no roles) — so a role-aware default landing is **not** trivial → keep `/tenants`.
- TASK-380's `tenants/$tenantId/overview.tsx` is the tenant-scoped sibling — its `Promise.allSettled`
  fan-out, REAL/TARGET (`value={undefined}` em-dash + "Target" hint) handling, and loading/empty/error
  variants are reused as the composition template.

### SDK reality (drives REAL vs TARGET)

- `useMonitoring().sessions` → `{ activeSessions, processingJobs, total }`; `.uptime` →
  `{ service, status, uptimeSeconds }[]`. **No** requests/min, error-rate, or socket telemetry.
- `useHealthCheck().services` → per-service `{ status, version?, uptime_seconds? }` (REAL health).
- `useAdminConsultations().list()` → cross-tenant consultations (no date filter → client-bucketed).
- `useTenants().list()` / `useUsers().listPaginated()` → tenant count / user total (REAL).

### REAL vs TARGET split

**Dashboard — mostly REAL.**

| Element | Source | REAL/TARGET |
|---|---|---|
| Active tenants | `useTenants().list()` length | **REAL** |
| Live sessions | `sessions.activeSessions` | **REAL** |
| Processing jobs | `sessions.processingJobs` | **REAL** |
| Degraded services | `summarizeServiceHealth(services)` count + names | **REAL** |
| Total users | `useUsers().listPaginated({page:1,limit:1}).total` | **REAL** |
| Consultation chart | `bucketConsultations(useAdminConsultations.list(), range)` | **REAL** (client-bucketed; server aggregation = TARGET) |
| Transcription min · 24h | — | **TARGET** (em-dash + "Target") |
| Summaries · 24h | — | **TARGET** |
| Storage used / 5 TB quota | — | **TARGET** (no quota field — TASK-371 §5.11) |
| "▲ N this week" deltas, "across 9 tenants" | — | **TARGET** (omitted — no historical/breakdown endpoint) |

**Monitoring — REAL service health, TARGET throughput.**

| Element | Source | REAL/TARGET |
|---|---|---|
| Services table — SERVICE/STATUS | `useHealthCheck().services` (canonical order, normalized dot+label) | **REAL** |
| Services table — UPTIME | `useMonitoring().uptime[].uptimeSeconds` → duration (health `uptime_seconds` fallback) | **REAL** (elapsed uptime, not the mock's SLA %) |
| Models/Service identity | grounded `PLATFORM_MODELS` inventory (real deployed models) | **REAL** (identity) |
| Requests/min · Error rate · Sockets/min · Total sockets | — | **TARGET** (no metrics endpoint — TASK-377 §1) |
| Request-volume chart | — | **TARGET** (no time-series endpoint) |
| Services table — P95 | — | **TARGET** |
| Models table — Running · Avg latency | — | **TARGET** (no per-model inference telemetry) |

Nothing is fabricated: TARGET values render as an em-dash + a "Target" hint exactly as TASK-380's
`overview.tsx` draws "Open sockets —".

## 3. Implementation Plan

### Files

| File | Purpose |
|---|---|
| `features/platform-dashboard/service-table.ts` | `SERVICE_ORDER`, `healthStateToRole`, `buildServiceRows` (health+uptime → canonical Services rows) |
| `features/platform-dashboard/models.ts` | grounded `PLATFORM_MODELS` inventory (model → service) |
| `features/platform-dashboard/format.ts` | `formatCount` (locale KPI numbers; nullish → em-dash) |
| `features/platform-dashboard/index.ts` | barrel |
| `routes/_authenticated/dashboard.tsx` | **new** — frame 10 (KPIs + chart + state variants) |
| `routes/_authenticated/system-health.tsx` | redesigned in place — frame 11 (KPIs + chart + Services/Models tables + state variants) |
| `lib/nav.ts` | add **Overview → Dashboard** (super-admin, first); relabel **System Health → Monitoring** |
| `routeTree.gen.ts` | regenerated by `tsr generate` |

Reused (not rebuilt) from TASK-380 `features/tenant-dashboard/*`: `summarizeServiceHealth`,
`normalizeServiceHealth`, `serviceDisplayName`, `bucketConsultations`, `buildRangeBuckets`,
`CHART_SERIES`.

### TDD test list (vitest — `features/platform-dashboard/__tests__/`)

Logic modules use type-only SDK imports (the app stubs `@arcaai/vox`/`@arcaai/ui/*` in vitest).

- **service-table.test.ts** — `healthStateToRole` (healthy→success, degraded→warning, unhealthy→destructive,
  checking→info, unknown→neutral); `buildServiceRows` returns the 6 canonical services in order
  (API/STT/SMR/NLP/Guardrail/Harness), normalizes status, joins uptime (monitoring overrides health
  `uptime_seconds`), marks SMR degraded, missing service → unknown/neutral, tolerates null map.
- **models.test.ts** — `PLATFORM_MODELS` is the grounded 6-model inventory with unique ids and a
  known host service each; `whisper-large-v3-turbo`+`silero-vad-v5`→STT, `gemma-4-e4b`→SMR, etc.
- **format.test.ts** — `formatCount` (1847→"1,847", 0→"0", nullish/NaN→em-dash).

### Verification

`pnpm --filter @arcaai/admin generate-routes` · `type-check` · `test` · ReadLints · `build`. Output in §5.

---

## 4. Implementation Summary

Both surfaces were built by composing the TASK-377 metrics primitives over a
`Promise.allSettled` SDK fan-out (mirroring TASK-380's `overview.tsx`), with REAL data wired where a
hook provides it and a `value={undefined}` em-dash + "Target" hint everywhere the backend is
un-instrumented. **No `packages/ui` primitive needed extension** — everything composes the shipped
components.

### Platform Dashboard (`/dashboard`, new — frame 10)

- **Headline KPIs** (`StatCard`): Active tenants (`useTenants().list()` count) · Live sessions
  (`sessions.activeSessions`) · Processing jobs (`sessions.processingJobs`) · Degraded services
  (`summarizeServiceHealth`, count + a `StatusDot` dot+label footer of the degraded names) — all REAL.
- **Secondary KPIs**: Total users (`useUsers().listPaginated().total`, REAL) · Transcription min 24h ·
  Summaries 24h · Storage used — the last three drawn em-dash + "Target".
- **Focal chart** (`MetricChart` bar) of cross-tenant consultation sessions/day via
  `bucketConsultations` + `CHART_SERIES`, with a `DateRangeSelector` (Week/Month/Year) and a
  super-admin `TenantFilter` ("All tenants" → drills into a tenant's `…/overview`).
- **Header actions**: `New tenant` opens the reused `TenantFormDialog` (real create + toast + reload);
  `Export` is a flagged placeholder (toast).
- **State variants**: skeleton (primitive `isLoading`), empty ("No platform activity yet" + create CTA),
  error (focal consultations failure → retry card). Super-admin gated in nav (`requireSuperAdmin`).

### Monitoring (`/system-health`, redesigned in place — frame 11)

- **Headline KPIs** (`StatCard`): Requests/min · Error rate · Sockets/min · Total sockets — all
  em-dash + "Target" (no throughput/error/socket telemetry endpoint; TASK-377 §1).
- **Request-volume chart** (`MetricChart`) with the Week/Month/Year + All-tenants controls; data is
  TARGET so it renders a custom "telemetry not instrumented (Target)" empty state.
- **Services table** (`MetricTable` + `StatusDot`): SERVICE · STATUS (REAL dot+label from
  `buildServiceRows` over `useHealthCheck().services`, canonical API/STT/SMR/NLP/Guardrail/Harness
  order, SMR surfaces Degraded when reported) · P95 (TARGET em-dash) · UPTIME (REAL duration from
  `useMonitoring().uptime`, health `uptime_seconds` fallback).
- **Models & running tasks table** (`MetricTable`): the grounded `PLATFORM_MODELS` inventory
  (MODEL + SERVICE REAL) · RUNNING + AVG LATENCY (TARGET em-dash).
- Keeps the 30s `startPolling` refresh. **State variants**: skeleton, empty ("No service health
  reported."), error (health endpoints unreachable on first load → retry card).

### Nav / routing

- `lib/nav.ts`: added a new **Overview** section (first) → `Dashboard → /dashboard`
  (`LayoutDashboard`, `requireSuperAdmin`); relabelled **System Health → Monitoring** (path kept at
  `/system-health` to avoid breaking links; description updated).
- Breadcrumbs set via each route's `staticData.crumb` → `Home / Platform / Dashboard` and
  `Home / Platform / Monitoring` (matches the design); no `breadcrumbs.tsx` edit needed.
- **Default landing left at `/tenants`** — the router context carries only `isAuthenticated` (no
  roles), so a role-aware `/dashboard` redirect is not trivial (per the task's "only if trivial").
- `routeTree.gen.ts` regenerated by `tsr generate`.

### Files changed

| File | Change |
|---|---|
| `features/platform-dashboard/service-table.ts` | NEW — `SERVICE_ORDER`, `healthStateToRole`, `buildServiceRows` |
| `features/platform-dashboard/models.ts` | NEW — grounded `PLATFORM_MODELS` inventory |
| `features/platform-dashboard/format.ts` | NEW — `formatCount` |
| `features/platform-dashboard/index.ts` | NEW — barrel |
| `features/platform-dashboard/__tests__/{service-table,models,format}.test.ts` | NEW — 14 unit tests |
| `routes/_authenticated/dashboard.tsx` | NEW — frame 10 screen |
| `routes/_authenticated/system-health.tsx` | Redesigned in place — frame 11 screen |
| `lib/nav.ts` | Overview→Dashboard section; System Health→Monitoring relabel |
| `routeTree.gen.ts` | Regenerated (registers `/dashboard`) |

### Deviations (with rationale)

- **TARGET values render as em-dash + "Target", not the mock's numbers** — faithful to the design's
  *structure/labels* but honoring the design-system "never fabricate" pillar + the task's explicit
  "render TARGET exactly the way `overview.tsx` does". Monitoring's 4 headline KPIs, its chart, P95,
  and per-model running/latency are therefore drawn as flagged TARGET.
- **Chart axis labels** use the shipped `bucketConsultations` "MMM d" format (consistent with the
  sibling tenant `overview.tsx`) rather than the mock's weekday axis — chosen for consistency with the
  screen the task told me to mirror.
- **"▲ N this week" deltas / "across 9 tenants"** omitted (no historical / per-tenant-breakdown
  endpoint) rather than fabricated.
- **Global footer `ServiceStatusBar`** (shown on every design frame) intentionally **not** added — it
  is shared chrome that lives in `app-shell.tsx`, which is outside this ticket's allowed file set.

## 5. Verification Evidence

All gates run from the repo root (zsh).

**Logic suite (`features/platform-dashboard`):**

```
$ pnpm --filter @arcaai/admin exec vitest run src/features/platform-dashboard
 Test Files  3 passed (3)
      Tests  14 passed (14)
```

**Five admin gates:**

```
$ pnpm --filter @arcaai/admin generate-routes   # tsr generate → exit 0 (registers /dashboard)
$ pnpm --filter @arcaai/admin type-check         # tsc --noEmit → exit 0 (no errors)
$ pnpm --filter @arcaai/admin test
 Test Files  28 passed (28)
      Tests  198 passed (198)
$ pnpm --filter @arcaai/admin lint               # ✖ 9468 problems (0 errors, 9468 warnings) → exit 0
$ pnpm --filter @arcaai/admin build              # ✓ built in 10.18s → exit 0
```

- `generate-routes` — **PASS** (exit 0; `/dashboard` registered in `routeTree.gen.ts`).
- `type-check` — **PASS** (exit 0, no errors).
- `test` — **PASS** (28 files / 198 tests; +3 files / +14 tests vs the 184 baseline).
- ReadLints (every changed file) — **PASS** (no linter errors). The eslint `lint` script is the
  repo's pre-existing `prettier/prettier` warning baseline (0 errors → exit 0).
- `build` — **PASS** (`✓ built in 10.18s`).

> Live in-browser verification was not possible — the admin dev server was not listening (connection
> refused on 5173-5175) and the authenticated screens require a login the environment can't supply.
> The screens were built directly against the approved design screenshots
> (`admin-10-dashboard.png`, `admin-11-monitoring.png`) composing the verified TASK-377 primitives.

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Ticket created; plan + TDD test list + REAL/TARGET split for frames 10 & 11. | `README.md` |
| 2026-06-30 | Implemented both surfaces: new `/dashboard` (frame 10), redesigned `/system-health` Monitoring (frame 11), `platform-dashboard` helpers + 14 unit tests, nav Overview/Monitoring changes. All 5 gates green (generate-routes, type-check, test 198/198, lint 0 errors, build). Status → Review. | `dashboard.tsx`, `system-health.tsx`, `nav.ts`, `features/platform-dashboard/*`, `routeTree.gen.ts`, `README.md` |
| 2026-06-30 | **Doc + test review pass** (per [`E2E-AND-QA-CONVENTIONS.md`](../../qa/E2E-AND-QA-CONVENTIONS.md)). **Plan review:** §3 plan verified against shipped `dashboard.tsx` / `system-health.tsx` / `features/platform-dashboard/*` — matches as-built; **no trivial code gap to close** (all remaining gaps are documented TARGET → backlog **T1**). Added 4 artifacts: **DESIGN-SPEC.md** (Desktop/Tablet/Mobile + state variants + super-admin gating + "Figma frames to create later"), **TRACEABILITY-MATRIX.md** (P1–P3 / M1–M3 cross-linked to TASK-371 §2.A/§2.B; backend `file:line` verified live), **backend E2E** `apps/api/tests/e2e/task-383-platform-dashboard.spec.ts` (7 tests — cross-tenant tenants/users + sessions/uptime/health + 🔒 doctor-403), **frontend E2E** `apps/admin/e2e/task-383-platform-dashboard.spec.ts` (5 cases × 3 viewports — KPIs/chart/tables + 1→2→4 reflow), **manual** `MANUAL-E2E-TESTS.md` (PDM-01..04; X5 default-deny). **Gates:** type-check ✅ · vitest **215/215** ✅ · FE `--list` 72 ✅ · BE `--list` 7 ✅; live E2E **authored — run pending stack** (API not up). **Findings flagged (documented, not rebuilt):** **F-NAV1** — Monitoring nav item lacks `requireSuperAdmin` (visible to tenant-admins; data still API-403); **R1** — no route-level guard on `/dashboard` · `/system-health`. Status → Completed. | `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, `apps/api/tests/e2e/task-383-platform-dashboard.spec.ts`, `apps/admin/e2e/task-383-platform-dashboard.spec.ts`, `README.md` |
| 2026-06-30 | **F-NAV1 RESOLVED + live BE E2E run.** Added `requireSuperAdmin: true` to the **Monitoring** nav item so the Platform-tier link is hidden from non-super-admins (matching `/dashboard`); admin unit gates remain green. **Live backend E2E `task-383` passed 7/7** against the reseeded test stack (cross-tenant tenants/users, sessions/uptime/health, 🔒 doctor-403). **R1** (route-level guard) + **T1** (platform-metrics backend) remain documented backlog. | `apps/admin/src/lib/nav.ts`, `apps/api/tests/e2e/task-383-platform-dashboard.spec.ts` |
| 2026-07-01 | **QA-doc reconciliation (docs only — no code touched).** Verified `nav.ts:58` carries `requireSuperAdmin: true` for Monitoring, then flipped the downstream QA/design docs that still described F-NAV1 as open: [`manual-tests/08`](../../qa/manual-tests/08-platform-dashboard-monitoring.md) `PDM-03.3` + Findings (F-NAV1 → **RESOLVED**, Monitoring nav now hidden; R1 kept **OPEN**), [`traceability/platform-dashboard-monitoring.md`](../../qa/traceability/platform-dashboard-monitoring.md) (R1 row, coverage snapshot, backlog rollup — both surfaces now nav-hidden), and [`designs/admin/platform-dashboard-monitoring.md`](../../designs/admin/platform-dashboard-monitoring.md) §4. **Precision preserved:** only the **nav** guard is resolved; the **route-level** `beforeLoad` guard (R1) stays an open follow-up. | `docs/qa/manual-tests/08-platform-dashboard-monitoring.md`, `docs/qa/traceability/platform-dashboard-monitoring.md`, `docs/designs/admin/platform-dashboard-monitoring.md`, `README.md` |
| 2026-07-01 | **T1 (platform-metrics backend) RESOLVED by [TASK-386](../TASK-386-Platform-Metrics-Backend/README.md) — docs reconciliation (no TASK-383 product code touched).** TASK-386 shipped `/admin/platform/{metrics,sockets,consumption}`, `/admin/consultations/aggregate`, extended `/admin/tenants/:id/usage` (+ `quotaBytes`), widened tenant telemetry, Redis socket aggregation + ~12 s caching — the backend behind every platform TARGET tile (P2 · P3 · M1-P95 · M2 · M3). **DB roll-ups + open/total sockets are fully live;** the Prometheus-derived values (req/min, error-rate, per-service P95, per-model running/avg-latency, request-volume series) are **env-dependent** (need the opt-in `prometheus` profile + scraped services; em-dash otherwise). Updated the README Status + [`traceability/platform-dashboard-monitoring.md`](../../qa/traceability/platform-dashboard-monitoring.md) (T1 coverage/backlog + P2/P3/M1/M2/M3 rows). **R1** (route-level `beforeLoad` super-admin guard) stays the **only** remaining follow-up. | `README.md`, `docs/qa/traceability/platform-dashboard-monitoring.md` |
