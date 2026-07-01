# TASK-380 — Tenant Dashboard (frame 18d)

| | |
|---|---|
| **Ticket** | TASK-380 |
| **Type** | Feature (design-approved build) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | **Completed** — design/traceability/test review pass done; feasible gates green; **live backend E2E run** — all dashboard sources pass. The prior open contract finding **TD3** (super_admin `GET /admin/consultations` with no tenant scope → **400**) is **RESOLVED by [TASK-386](../TASK-386-Platform-Metrics-Backend/README.md)** — that path now returns **cross-tenant** data (tenant-admins stay pinned; see §7); **FE** live E2E authored, run pending stack |
| **App** | `apps/admin` |
| **Design** | `HOPE-Admin-Console` frame `18d · Tenant Dashboard` (`120:8843`) + state variants |
| **Refs** | TASK-371 [`README.md`](../TASK-371-Admin-Console-Redesign/README.md) §5.14 / §5.14.1 / §5.14.2 · [`PHASE-3-PLAN.md`](../TASK-371-Admin-Console-Redesign/PHASE-3-PLAN.md) §1 #1, §2, §3 · [`TRACEABILITY-MATRIX.md`](../TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md) O1/O2/O3 |

> **Scope guard:** work is confined to `apps/admin`, and within it to the tenant **Overview tab**
> (`routes/_authenticated/tenants/$tenantId/overview.tsx`) and a new feature folder
> `features/tenant-dashboard/*`. No edits to `packages/ui`, the SDK (`packages/agentic-sdk-v2`),
> the tenant-detail shell (`$tenantId/route.tsx`), `app-shell.tsx`, `nav.ts`, or any other feature.

---

## 1. Requirement Analysis

Upgrade the tenant **Overview tab** (`18p`, built by TASK-379) into the operational **Tenant
Dashboard** (`18d`) by composing the shipped metrics primitives (TASK-377) and collection
foundations (TASK-378). The dashboard answers *"is this tenant healthy & busy right now?"* with a
headline KPI row, a secondary KPI row, a focal consultation chart, a recent-activity audit feed, and
an audio-pipeline health strip — each with loading / empty / error / tenant-admin variants.

### Acceptance criteria (from PHASE-3 §1 #1 + §3 REAL/TARGET)

- **Headline KPIs** (`StatCard`): Active users (REAL), Departments (REAL), Running sessions (REAL),
  Services healthy `n/total` incl. degraded (REAL).
- **Secondary KPIs** (`StatCard`): Open sockets **[TARGET]**, Processing jobs (REAL), Consultations
  today = new vs re-visit (REAL), Pending review (REAL), Consumption **[TARGET]**.
- **Focal chart** (`MetricChart` bar) of consultation sessions per day, with `DateRangeSelector`
  (Week/Month/Year) + `TenantFilter` (All-tenants super-admin only / disabled for tenant-admin).
- **Recent-activity** card: audit feed via `ItemList` from `useAuditLog.list({ limit })`.
- **Audio-pipeline strip**: STT · VAD · SMR(degraded) · Guardrail · NLP via `ServiceStatusItem`
  (REAL health; per-model running counts = TARGET).
- **State variants**: loading (skeletons), empty ("No activity in this tenant yet"), error (retry),
  tenant-admin (own-tenant scope, no cross-tenant filter).
- Semantic tokens only; dot+label status; `tabular-nums`; ≥44px targets; responsive.

## 2. Current State

`overview.tsx` (TASK-379) already renders 4 KPI tiles (Users / Departments / Agent instructions /
Pipelines-TARGET), an About card, and a Recent-activity `ItemList`, plus the super-admin
`ActingOnBanner`. It reads the viewed tenant from `useTenantDetailStore` and derives counts from
`useUsers.listPaginated`, `useDepartments.list`, `usePrompts.list`, and `useAuditLog.list`. This
ticket deepens that page into the full `18d` operator surface and adds the live-metrics hooks
(`useMonitoring`, `useHealthCheck`, `useAdminConsultations`).

### SDK reality (drives REAL vs TARGET)

- `useMonitoring().sessions` → `{ activeSessions, processingJobs, total }` (no socket field).
- `useHealthCheck().services` → per-service `{ status, version, uptime_seconds }`.
- `useAdminConsultations().list()` → tenant-wide consultations; `parentConsultationId` (NULL = new
  visit) is the new-vs-revisit discriminator; `status` carries the lifecycle (PENDING_REVIEW /
  DRAFT_PENDING_SENSORS = unsigned). **No date-range filter or aggregate endpoint** → the chart
  buckets the most-recent page client-side (full server aggregation = TARGET).
- No open-sockets / consumption / per-model-stream endpoints → **TARGET**.

## 3. Implementation Plan

### Files

| File | Purpose |
|---|---|
| `features/tenant-dashboard/service-health.ts` | Normalize `useHealthCheck` statuses; summarize healthy/total + degraded; audio-pipeline rows |
| `features/tenant-dashboard/consultations.ts` | new-vs-revisit split, pending-review count, today filter (on `AdminConsultation`) |
| `features/tenant-dashboard/activity.ts` | audit → activity view model (title / actor / code / dot role) + tenant scoping |
| `features/tenant-dashboard/chart.ts` | range → time buckets + window; bucket consultations into a new/re-visit per-bucket series |
| `features/tenant-dashboard/index.ts` | barrel |
| `routes/_authenticated/tenants/$tenantId/overview.tsx` | compose the `18d` dashboard + state variants (deepened in place) |

### TDD test list (vitest — `features/tenant-dashboard/__tests__/`)

`@arcaai/ui`/`@arcaai/vox` are stubbed in `vitest.config.ts`, so the logic modules use type-only SDK
imports (and `date-fns`); the page composes them.

- **service-health.test.ts**
  - `normalizeServiceHealth` maps healthy/ok/up→healthy, degraded/warn→degraded, down/error/unhealthy→unhealthy, checking/idle→checking, unknown→unknown.
  - `summarizeServiceHealth` counts healthy/total and lists degraded display names (e.g. `SMR`); handles empty/missing maps.
  - `audioPipelineRows` returns the fixed STT/VAD/SMR/Guardrail/NLP rows with normalized status + model name; VAD derives from STT (TARGET).
- **consultations.test.ts**
  - `isRevisitConsultation` true for top-level `parentConsultationId`, true for `metadata.parentConsultationId`, false for empty/missing.
  - `splitVisits` returns `{ total, newVisits, revisits }`.
  - `countPendingReview` counts PENDING_REVIEW + DRAFT_PENDING_SENSORS (case-insensitive).
  - `filterToday` keeps only consultations created on the reference calendar day.
- **activity.test.ts**
  - `humanizeAction`, `actorOf`, `actionCode`, `activityDotRole` (success/destructive/warning/neutral).
  - `scopeToTenant` drops cross-tenant rows; keeps rows with no tenantId.
  - `toActivityItems` maps entries → view-model items.
- **chart.test.ts**
  - `buildRangeBuckets` → 7 day buckets (week), 12 month buckets (year), labels/ordering correct.
  - `bucketConsultations` assigns by `createdAt`, splits new/revisit, ignores out-of-window/unparseable dates, zero-fills empty buckets.
  - `rangeWindow` spans first→last bucket.

### Verification

`pnpm --filter @arcaai/admin type-check` · `test` · `lint` (no `build` — coordinator owns it). Output
pasted in §5.

---

## 4. Implementation Summary

The Overview tab was deepened in place into the `18d` Tenant Dashboard. The page
(`routes/_authenticated/tenants/$tenantId/overview.tsx`) reads the viewed tenant from
`useTenantDetailStore` and fans out across the available SDK endpoints with
`Promise.allSettled` (each source degrades independently; a failure of the focal
consultations metric drives the error variant), then composes:

- **Headline + secondary KPI rows** (`StatCard`): Active users, Departments, Running
  sessions, Services healthy `n/total` (incl. degraded) — REAL; Processing jobs,
  Consultations today (new vs re-visit), Pending review — REAL; Open sockets and
  Consumption — drawn disabled and flagged **TARGET** (no socket/consumption endpoint).
- **Focal consultation chart** (`MetricChart` bar) driven by `bucketConsultations` +
  `buildRangeBuckets`, with a `DateRangeSelector` (Week/Month/Year) and a `TenantFilter`
  shown only for super-admins (navigates between tenant dashboards; no fabricated
  cross-tenant aggregate).
- **Recent activity** (`ItemList`) from `useAuditLog.list({ limit })` via `scopeToTenant`
  + `toActivityItems`.
- **Audio-pipeline strip** (`ServiceStatusItem`) from `audioPipelineRows` /
  `summarizeServiceHealth` over `useHealthCheck().services` (REAL health; per-model
  running counts = TARGET).
- **State variants**: skeleton loading, empty ("No activity in this tenant yet"), error
  (retry), and tenant-admin scope (no cross-tenant filter); semantic tokens, dot+label
  status, `tabular-nums`, ≥44px targets, responsive.

### Files changed

| File | Change |
|---|---|
| `routes/_authenticated/tenants/$tenantId/overview.tsx` | Composed the full `18d` dashboard (KPIs, chart, activity, pipeline strip, state variants). |
| `features/tenant-dashboard/{service-health,consultations,activity,chart}.ts` + `index.ts` | Pure logic (composed by the page; unit-tested). |

### Deviations

- **`ConsultationChartRow` index signature** — added `[key: string]: string | number` to
  the chart row type in `features/tenant-dashboard/chart.ts` so a row is assignable to
  `MetricChart`'s `data: Record<string, string | number>[]` prop (the explicit
  `label`/`newVisits`/`revisits` fields are unchanged and remain compatible).
- **REAL/TARGET** honored exactly as planned: Open sockets, Consumption, per-model stream
  counts, and full server-side range aggregation remain TARGET (no backing endpoint —
  drawn/flagged, never fabricated).

## 5. Verification Evidence

All five gates were run once from the repo root (zsh) after every edit across TASK-380/381/382.

Dashboard logic suite (`features/tenant-dashboard`):

```
$ pnpm --filter @arcaai/admin exec vitest run src/features/tenant-dashboard
 Test Files  4 passed (4)
      Tests  45 passed (45)
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

## 6. Review Pass — Design, Traceability & Tests (2026-06-30)

A documentation + test review pass per [`docs/qa/E2E-AND-QA-CONVENTIONS.md`](../../qa/E2E-AND-QA-CONVENTIONS.md).
The `18d` surface is shipped/in-review — **no product code was rebuilt**; only review artifacts
and test files were added (surgical, additive-only).

### 6.1 Plan-vs-code verification (§3 ↔ shipped)

The §3 plan matches the shipped code; **no trivial in-scope gaps were open**, so no product
code changed:

- **Files** — all present: `service-health.ts`, `consultations.ts`, `activity.ts`, `chart.ts`,
  `index.ts`, and `routes/.../$tenantId/overview.tsx`.
- **Functions/behaviors** — all planned units exist and match the TDD list:
  `normalizeServiceHealth` / `summarizeServiceHealth` / `audioPipelineRows` (VAD derived from STT);
  `isRevisitConsultation` (top-level + `metadata` fallback) / `splitVisits` / `countPendingReview`
  (PENDING_REVIEW + DRAFT_PENDING_SENSORS, case-insensitive) / `filterToday`;
  `humanizeAction` / `actorOf` / `actionCode` / `activityDotRole` / `scopeToTenant` (keeps
  tenant-less rows) / `toActivityItems`; `buildRangeBuckets` / `bucketConsultations` (zero-fill,
  drops out-of-window/unparseable) / `rangeWindow`.
- **Composition** — `overview.tsx` fans out with `Promise.allSettled` (independent degradation),
  error surface driven by the consultations source, super-admin `TenantFilter`, tenant-admin
  read-only banner + no cross-tenant filter, TARGET tiles → em-dash + "· Target" hint.
- **Documented deviation** (`ConsultationChartRow` index signature) is present in `chart.ts`.
- **Observation (non-blocking):** `rangeWindow` is exported and unit-tested but not consumed by
  `overview.tsx` (harmless dead export; left in place per the surgical rule — not removed).

### 6.2 Deliverables added this pass

| Artifact | Path |
|---|---|
| Design spec (Desktop/Tablet/Mobile + state variants) | `DESIGN-SPEC.md` |
| Traceability matrix (TD1–TD7; cross-links O1/O2/O3, P1/P3, M1) | `TRACEABILITY-MATRIX.md` |
| Manual E2E suite (persona-based; X1/X6) | `MANUAL-E2E-TESTS.md` |
| Backend E2E (REAL contracts + tenant scoping) | `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts` |
| Frontend E2E (render + controls + KPI reflow) | `apps/admin/e2e/task-380-tenant-dashboard.spec.ts` |

### 6.3 Documented gaps (NOT closed — intentional / future backend)

These are drawn-and-flagged, never fabricated, and are **out of scope** for this `apps/admin`
ticket (candidate backend tickets):

- **TARGET tiles** — Open sockets, Consumption, per-model audio-stream counts, and full
  **server-side range aggregation** (the chart buckets the most-recent consultations page
  client-side). Asserted as em-dash/empty-state in tests; never asserted as populated.
- **🔒 Super-admin-only telemetry** — `GET /monitoring/sessions` and `GET /health/services` are
  gated to `manage all`, so for a **tenant-admin** they 403 and the *Running sessions* /
  *Services healthy* / audio-pipeline tiles **degrade to em-dash / Unknown** (REAL behavior,
  verified in TDB-07). A tenant-scoped sessions/health read would be needed to back these for
  tenant-admins.

### 6.4 Gate evidence (repo root, zsh)

```
$ pnpm --filter @arcaai/admin type-check                                  # tsc --noEmit → exit 0 (no errors)
$ pnpm --filter @arcaai/admin test                                        # Test Files 30 passed (30) · Tests 215 passed (215)
$ pnpm exec playwright test --config apps/admin/playwright.config.ts --list   # 15 TASK-380 tests (5 × desktop/tablet/mobile); 72 admin specs total → exit 0
$ pnpm exec playwright test apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts --list   # 15 TASK-380 backend tests [api-tests] → exit 0
$ curl -s -o /dev/null -w '%{http_code}' localhost:8868/api/v1/health     # 000 (no stack) → live E2E authored, run pending stack
```

> The code block above is the **review-pass** snapshot (no stack on `:8868`). The **backend** live E2E
> was **subsequently run** against a reseeded stack (see §7 · 2026-06-30): every dashboard source passed
> **except TD3** — a super_admin `GET /admin/consultations` with **no tenant scope** → **400**
> (`listConsultationsForTenant` then required a tenant; the tenant-admin path passes). That contract
> finding has since been **RESOLVED by [TASK-386](../TASK-386-Platform-Metrics-Backend/README.md)** — the
> no-scope super-admin path now returns **cross-tenant** data (regression `task-386-platform-metrics.spec.ts`
> `PM7`); it was a contract nuance, not a dashboard product change. The **frontend** live E2E remains
> authored/discoverable, run pending a seeded stack (`pnpm test:e2e` for the API project).

## 7. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Ticket created; plan + TDD test list for the `18d` Tenant Dashboard build. | `README.md` |
| 2026-06-30 | Built + wired the `18d` dashboard; composed `features/tenant-dashboard/*`; all 5 admin gates green (45 dashboard tests, 184 total). Status → Review. | `overview.tsx`, `features/tenant-dashboard/chart.ts`, `README.md` |
| 2026-06-30 | Review pass: added DESIGN-SPEC, TRACEABILITY-MATRIX, MANUAL-E2E-TESTS + FE/BE Playwright specs (15 + 15). Verified §3 plan ↔ code (no in-scope gaps); documented TARGET + 🔒 super-admin-only telemetry gaps. Gates green (type-check 0, vitest 215/215, both `--list` discovered); live E2E pending stack. Status → Completed. | `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts`, `apps/admin/e2e/task-380-tenant-dashboard.spec.ts`, `README.md` |
| 2026-06-30 | **Live backend E2E run** (reseeded test stack). All tenant-dashboard sources pass **except `TD3` — `GET /admin/consultations` for a super_admin with no tenant scope → 400** (`listConsultationsForTenant` requires a tenant; the tenant-admin path and every other dashboard read pass). **Finding (not a regression):** the super_admin consultations case must scope to a tenant (log into a working tenant or pass the tenant context, as the users surface does) — a spec/contract nuance flagged for the spec owner; no dashboard product change needed. | `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts` |
| 2026-07-01 | **Status reconciliation across the three TASK-380 docs (docs only — no code touched).** The README header said "Completed … live E2E run pending stack" while §6 said "Live E2E (FE+BE) not executed" — yet the prior Change-History row recorded the **backend** run + the **TD3-400** finding. Reconciled so all three docs tell the same truthful story: README header → **"Completed (one open contract finding)"** + reflects the BE run + TD3-400; README §6 → notes the subsequent BE run (FE still pending); [`traceability/tenant-dashboard.md`](../../qa/traceability/tenant-dashboard.md) header **Review → Completed** + TD3 row carries the live 400 finding; [`manual-tests/05`](../../qa/manual-tests/05-tenant-dashboard.md) keeps manual UI cases **Not Run** but records **TD3-400** under Defects & observations. **TD3 is *not* claimed fixed** — it stays an open finding deferred to the spec owner. | `docs/qa/traceability/tenant-dashboard.md`, `docs/qa/manual-tests/05-tenant-dashboard.md`, `README.md` |
| 2026-07-01 | **TD3 forward-reconciled to RESOLVED (docs only — no product code touched); supersedes the "stays open" note in the row above.** [TASK-386](../TASK-386-Platform-Metrics-Backend/README.md) changed super_admin `GET /admin/consultations` with no tenant scope from **400** to **cross-tenant** data (tenant-admins stay pinned; regression `task-386-platform-metrics.spec.ts` `PM7`), closing the open contract finding (it also shipped `GET /admin/consultations/aggregate` for server-side range bucketing). Updated the README header Status (→ **"Completed"**) + §5 note, [`traceability/tenant-dashboard.md`](../../qa/traceability/tenant-dashboard.md) (TD3 row + header + P3 cross-link + backlog #5), and [`manual-tests/05`](../../qa/manual-tests/05-tenant-dashboard.md) (TD3-400 → RESOLVED). | `README.md`, `docs/qa/traceability/tenant-dashboard.md`, `docs/qa/manual-tests/05-tenant-dashboard.md` |
