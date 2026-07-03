# TASK-404 — Components Library Page · TASK-377 Metrics Follow-ups · Real Chart Series

| | |
|---|---|
| **Ticket** | TASK-404 |
| **Type** | feature (frontend `apps/admin` + `packages/ui` primitives polish) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Scope** | `apps/admin` (new `/components` route + `features/components-library`, `system-health.tsx`, `features/platform-dashboard`), `packages/ui` (legacy `service-status-bar` retirement, `Progress` value forward) |
| **Source backlog** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` — **P2-2** (`01 · Components` library slice), **P2-5** (TASK-377 metrics follow-ups), **P2-1** (real chart series slice) |
| **Siblings** | TASK-403 (nav.ts owner — adds the `Components` nav entry), TASK-405 (icon/dark-mode polish) |

> **Ticket-number check:** `docs/implementation/` existing tickets run through TASK-402 (+ a sibling worker is creating TASK-403, and TASK-405 exists); **TASK-404** was the next free number (confirmed by directory listing on 2026-07-02).

---

## 1. Requirement Analysis

### 1.1 Description

Three P2 items from the open-items backlog, delivered as one frontend ticket:

1. **P2-2 slice — `01 · Components` library page.** The design taxonomy (`12-design-workflow.mdc`, `docs/designs/admin/README.md`) reserves the `00–09` foundations band for design-system references; `01 · Components` is listed as an unbuilt surface in `docs/admin-console-open-items-review.md` §3b (grouped under *unbuilt super-admin frontend surfaces*) and TASK-371 §5.16. Build the app surface: a design-system showcase at `/components` rendering the grouped `@arcaai/ui` primitives, semantic tokens, and states.
2. **P2-5 — TASK-377 metrics follow-ups** (TASK-377 README §4 "Follow-ups"):
   - migrate `system-health.tsx` onto the canonical metrics primitives — the page already composes `StatCard`/`MetricChart`/`MetricTable`/`StatusDot` (TASK-383); the missing piece was the canonical **`ServiceStatusBar`** from `@arcaai/ui/components/metrics`;
   - **retire the legacy `components/custom/service-status-bar.tsx`** once unused (grep-verified), dissolving the root-barrel name collision documented in TASK-377 §5;
   - **forward the `Progress` `value` to the Radix root** (minimal, additive) so Radix reports `aria-valuenow`/`data-state` natively (TASK-377 deviation #2).
3. **P2-1 slice — real chart series.** The design-review flag "charts are illustrative rects" refers to chart surfaces whose real series were deferred to implementation. Audit of the three `MetricChart` call sites (see §2.3): the consultation charts already render real recharts series; the one remaining fake chart was **Monitoring's Request-volume chart**, hard-wired to `data={[]}`. TASK-386 E1 now ships a real `requestVolumeSeries` (30-min Prometheus window) on `usePlatformMetrics` — wire it in with a pure view-model.

### 1.2 Acceptance criteria

- `/components` renders a grouped, token-driven design-system showcase (tokens · type · shape · status grammar · shadcn primitives · metrics primitives), super-admin-guarded via the existing `requireSuperAdmin` `beforeLoad`, **without touching `lib/nav.ts`** (TASK-403 owns the nav entry).
- `system-health.tsx` renders the canonical `ServiceStatusBar` (metrics subpath) fed by real health/monitoring data; the legacy `custom/service-status-bar.tsx` is deleted along with its story + CT test and the root-barrel export; the canonical bar takes over the root-barrel names.
- `Progress` forwards `value` to `ProgressPrimitive.Root`; a unit test pins `aria-valuenow`/`data-state` for determinate + indeterminate.
- Monitoring's Request-volume chart renders the real `requestVolumeSeries` when Prometheus reports; the honest "telemetry not instrumented" empty state remains when the series is empty. No fabricated data.
- No new dependencies (charts stay on the existing shadcn `chart` shell + `recharts@2.15.4` in `@arcaai/ui`).
- Static + unit verification green: `pnpm --filter @arcaai/admin type-check`, `pnpm --filter @arcaai/admin build`, admin + ui Vitest suites, `pnpm build --filter @arcaai/ui`. Playwright specs `task-404-*` authored (+ one live-run attempt against the shared stack).

---

## 2. Current State Evaluation

### 2.1 Components page (P2-2)

- No `/components` route exists. The design source for the showcase content is the `00 · Foundations` Figma frame (TASK-371 §5.1: 6 semantic role cards with token + on-color "Aa" + usage, 50→950 ramps, Inter/JetBrains Mono type specimen, radius scale, dot+label status chips) plus the 5 design-system pillars (TASK-371 §3). `01 · Components` itself was never drawn (spec-only, §5.16) — the app page is grounded in those foundations + the shipped `@arcaai/ui` primitive set the console actually composes (`button/badge/input/select/switch/checkbox/tabs/alert/skeleton/progress/empty` + `components/shared` `StatusBadge` + `components/metrics` `StatusDot/StatCard/MetricChart/MetricTable/ServiceStatusItem`).
- Tier: foundations (`00–09`) is a reference band, and the open-items review files the page under **super-admin surfaces** → guarded with `requireSuperAdmin` (same defense-in-depth pattern as Dashboard/Monitoring/Roles/Settings, `lib/route-guards.ts`).

### 2.2 TASK-377 follow-ups (P2-5)

- `system-health.tsx` (rebuilt by TASK-383/386) already imports `StatCard`/`MetricChart`/`MetricTable`/`StatusDot`/`DateRangeSelector`/`TenantFilter` from `@arcaai/ui/components/metrics` — the TASK-377 README's "apps/admin still imports it" note is stale. The **canonical `ServiceStatusBar` was still unused** anywhere in `apps/admin`.
- Legacy `packages/ui/src/components/custom/service-status-bar.tsx` (hardcoded emerald/amber/red) grep audit — consumers before this ticket:
  - `packages/ui/src/index.ts:90` (root barrel `export *`),
  - its own story (`__stories__/custom/service-status-bar.stories.tsx`) and Playwright-CT test (`__tests__/custom/service-status-bar.test.tsx`),
  - **no app imports** (`apps/ui-playground`'s `ServiceStatusBar` is its own local component; `apps/admin` has none).
- `shadcn/progress.tsx` destructures `value` for the indicator transform and never passes it to `ProgressPrimitive.Root` → Radix reports `data-state="indeterminate"` and omits `aria-valuenow` (TASK-377 deviation #2; `RunningTasksList` works around it at the call site).

### 2.3 Chart audit (P2-1 slice)

| Chart | File | Series before | Status |
|---|---|---|---|
| Platform consultation sessions | `routes/_authenticated/dashboard.tsx` | REAL — `bucketConsultations` (`features/tenant-dashboard/chart.ts`) over `useAdminConsultations`, recharts bars via `MetricChart` | already real (TASK-380/383/386 TD3) |
| Tenant consultation sessions | `routes/…/tenants/$tenantId/overview.tsx` | REAL — same model, tenant-scoped | already real |
| Monitoring request volume | `routes/_authenticated/system-health.tsx` | **`data={[]}`** — permanent "not instrumented" empty state | **the gap** — TASK-386 E1 `requestVolumeSeries` (requests rate + open sockets, 30-min window, 60 s step) was fetched by the page but never rendered |

- Chart machinery: `MetricChart` (TASK-377) wraps the shadcn `chart` shell over `recharts@2.15.4` (already a `@arcaai/ui` dependency) — **no new chart dependency needed**.
- The dead `DateRangeSelector` + `TenantFilter` on the request-volume card drove nothing (the card's data was always `[]`, and a Prometheus range query is a fixed server-side window) — with a real 30-minute series they would be actively misleading.
- `apps/admin/e2e/task-383-platform-dashboard.spec.ts` asserted the request-volume chart is *always* the "not instrumented" empty state — true only while the series was unwired; needs to accept either honest state.

---

## 3. Implementation Plan

1. **`packages/ui` Progress forward** — add `value={value}` on `ProgressPrimitive.Root` (single line, additive). RED test first: `components/shadcn/__tests__/progress.vitest.tsx` (determinate → `aria-valuenow`/`data-state="loading"`/`"complete"`; no value → `indeterminate`, no `aria-valuenow`) → verify fail → GREEN.
2. **Legacy bar retirement** — delete `components/custom/service-status-bar.tsx` + story + CT test; replace the root-barrel `export *` with the canonical metrics `ServiceStatusBar`/`ServiceStatusBarProps` root export (collision dissolved); update the metrics barrel comment. Grep gate: zero remaining references.
3. **`system-health.tsx` migration** — compose the canonical `ServiceStatusBar` (services from `buildServiceRows` + `version` passthrough, sessions/jobs from `useMonitoring`, refresh → `refreshAll`) as the page footer strip. Extend `ServiceRow` with optional `version` (additive; unit test).
4. **Request-volume series** — new pure model `features/platform-dashboard/request-volume.ts` (`buildRequestVolumeRows` + `REQUEST_VOLUME_SERIES`: ISO `t` → `HH:mm` label, req/s → req/min, sockets passthrough; invalid points skipped) + Vitest suite; wire into the Monitoring chart (`kind="area"`, two series), drop the dead range/tenant controls on that card, keep the honest empty state; loosen the task-383 assertion to accept series-or-empty.
5. **Components page** — `features/components-library/tokens.ts` (pure showcase model: semantic roles, ramps, radius/type scales, status grammar; unit-tested) + `features/components-library/showcase.tsx` (section components) + route `routes/_authenticated/components.tsx` (`requireSuperAdmin`, crumb `Platform / Components`). Sections: Tokens (role cards + ramps) · Typography · Shape & density · Status grammar (dot+label proof) · Primitives (buttons/badges/inputs/selection/tabs/alert/skeleton/progress/empty) · Metrics primitives (StatCard/MetricChart sample/MetricTable/ServiceStatusItem) — each grouped under an anchored `h2` with the primitive's import path in `font-mono`.
6. **E2E (authored)** — `task-404-components-page.spec.ts` (guard + groups render), `task-404-system-health-metrics.spec.ts` (StatCards + canonical status bar), `task-404-chart-series.spec.ts` (consultation chart renders real series bars; request-volume renders series-or-honest-empty). One live-run attempt against the shared stack (health-gated).
7. **Verify + document** — type-check/build/unit both packages; screenshots to `.uxu-verify/`; this README.

---

## 4. Implementation Summary

### 4.1 `packages/ui`

| File | Change |
|---|---|
| `src/components/shadcn/progress.tsx` | Forward `value` to `ProgressPrimitive.Root` (additive single-prop change). Radix now reports `aria-valuenow` + `data-state` (`loading`/`complete`/`indeterminate`) natively; the `RunningTasksList` call-site workaround keeps working (its explicit ARIA props override with identical values). |
| `src/components/shadcn/__tests__/progress.vitest.tsx` | **NEW** — 4 tests pinning determinate (`aria-valuenow`, `data-state` loading/complete) + indeterminate + indicator transform. RED-first (2 failed pre-fix for the right reason: `aria-valuenow` missing, `data-state="indeterminate"`). |
| `src/components/custom/service-status-bar.tsx` | **DELETED** — legacy hardcoded-emerald/amber/red bar, unused after the system-health migration (grep-verified: no app imports remained). |
| `src/components/__stories__/custom/service-status-bar.stories.tsx` · `src/components/__tests__/custom/service-status-bar.test.tsx` | **DELETED** — story + Playwright-CT suite of the deleted component. |
| `src/index.ts` | Legacy `export *` removed; the canonical metrics `ServiceStatusBar` + `ServiceStatusBarProps` are now root-exported (TASK-377 §5 collision dissolved). |
| `src/components/metrics/index.ts` | Barrel comment updated (subpath no longer the only import path). |

### 4.2 `apps/admin` — system-health migration + real request-volume series

| File | Change |
|---|---|
| `src/features/platform-dashboard/service-table.ts` | `ServiceRow` gained optional `version` (passthrough from the health map) so the status bar/table can show it — additive. |
| `src/features/platform-dashboard/request-volume.ts` | **NEW** pure view-model — `buildRequestVolumeRows(series)` (ISO `t` → `HH:mm` label, req/s → req/min rounded, sockets rounded, invalid/non-finite points skipped/zeroed) + `REQUEST_VOLUME_SERIES` (`requests`/`sockets` → `--chart-1/2`). Type-only `RequestVolumePoint` import keeps it testable under the `@arcaai/vox` stub. |
| `src/features/platform-dashboard/__tests__/request-volume.test.ts` | **NEW** — 7 tests (mapping, rounding, label format, null/empty/invalid handling, series contract). |
| `src/features/platform-dashboard/__tests__/service-table.test.ts` | +2 tests for the `version` passthrough. |
| `src/features/platform-dashboard/index.ts` | Barrel += `request-volume`. |
| `src/routes/_authenticated/system-health.tsx` | (1) Request-volume `MetricChart` now renders the REAL `metrics.requestVolumeSeries` (area, Requests/min + Open sockets, last-30-min caption); honest "not instrumented" empty state kept for when Prometheus reports nothing; dead `DateRangeSelector`/`TenantFilter`/`useTenants` on that card removed. (2) Page footer now composes the canonical **`ServiceStatusBar`** (`@arcaai/ui/components/metrics`) with real services (status/uptime/version), live session/job counts and a Refresh wired to `refreshAll` — completing the TASK-377 migration. |
| `e2e/task-383-platform-dashboard.spec.ts` | One assertion loosened (consequence fix): request-volume now legitimately renders **either** the real series chart (Prometheus up) **or** the not-instrumented empty state (Prometheus absent) — asserted as exactly-one-of. |

### 4.3 `apps/admin` — `01 · Components` library page

| File | Change |
|---|---|
| `src/features/components-library/tokens.ts` | **NEW** pure showcase model: `SEMANTIC_ROLES` (6 role cards: primary/ai/hope/success/warning/destructive with usage notes), `COLOR_RAMPS` (teal/indigo/saffron/green/slate 50→950 CSS-var references), `RADIUS_SCALE`, `TYPE_SCALE` (Display 30 → Caption 12), `STATUS_GRAMMAR` (role → dot+label examples), `SHOWCASE_SECTIONS` (anchor nav). All values are token *references* (`var(--…)`) — no hardcoded colors. |
| `src/features/components-library/__tests__/tokens.test.ts` | **NEW** — 8 tests (ramps complete 50→950 & var-referenced, roles/status grammar/type scale/radius/sections invariants). |
| `src/features/components-library/showcase.tsx` | **NEW** section components: `TokensSection` (role cards + ramps), `TypographySection` (specimen + scale + tabular-nums/mono proofs), `ShapeSection` (radius + density + shadow), `StatusSection` (StatusDot/StatusBadge grammar — never color-only), `PrimitivesSection` (Buttons, Badges, Inputs, Selection controls, Tabs, Alerts, Progress *(value forwarded — determinate demo)*, Skeleton, Empty), `MetricsSection` (StatCard, MetricChart sample series, MetricTable, ServiceStatusItem) — every group headed by its `font-mono` import path. |
| `src/routes/_authenticated/components.tsx` | **NEW** route `/components` — `requireSuperAdmin` `beforeLoad` (same guard as Dashboard/Monitoring), crumb `Platform / Components`, sticky in-page anchor nav, composes the six sections. **`lib/nav.ts` untouched** — TASK-403 adds the nav entry. |

### 4.4 E2E specs (authored)

| Spec | Asserts |
|---|---|
| `e2e/task-404-components-page.spec.ts` | super-admin sees the showcase (heading + all six group headings + role cards + primitives render); tenant-admin deep-link is bounced (guard); section anchor nav present (desktop). |
| `e2e/task-404-system-health-metrics.spec.ts` | Monitoring composes ≥4 `StatCard`s + the canonical `ServiceStatusBar` (`data-slot`, `role="status"`, session/job counts, ≥44px Refresh); Services/Models `MetricTable`s intact. |
| `e2e/task-404-chart-series.spec.ts` | Dashboard consultation chart renders real recharts series (accessible `img` + sr-only data table + bar paths when sessions exist); request-volume renders exactly-one-of real-series/not-instrumented; no dead range controls on the request-volume card. |

### 4.5 Verification evidence (actual output)

**Unit — `@arcaai/ui`** (`pnpm --filter @arcaai/ui test`): full suite green incl. the new progress suite (legacy bar CT suite removed) —

```
 Test Files  236 passed (236)
      Tests  565 passed (565)
```

(RED first: the 2 forward-pinning tests failed pre-fix for the right reason — `expect(element).toHaveAttribute("aria-valuenow", "42") … Received: null`.)

**Unit — `@arcaai/admin`** (`pnpm --filter @arcaai/admin test`): includes the new `request-volume` (7), `service-table` version (+2) and `components-library/tokens` (7) suites —

```
 Test Files  43 passed (43)
      Tests  332 passed (332)
```

**Build — `pnpm build --filter @arcaai/ui`**: tsup + tailwind success — `Tasks: 1 successful, 1 total`.

**Type-check + build — admin**: `pnpm --filter @arcaai/admin type-check` → clean (exit 0); `pnpm --filter @arcaai/admin build` → `✓ built in 9.65s` (exit 0). Route tree regenerated (`generate-routes`) for the new `/components` route.

**Lint**: ReadLints on every touched file → no errors.

**Legacy-bar grep gate**: zero remaining `custom/service-status-bar` code references (only two explanatory comments in the two barrels).

### 4.6 E2E live-run status

`:8868/api/v1/health` polled → 200; one live run of the three `task-404-*` specs plus the touched `task-383` spec against the shared stack (`:5174` dev server reused, never restarted):

```
  36 passed (13.2s)
```

(= `task-404-*` 7 scenarios × 3 viewport projects + `task-383` 5 × 3. Includes the super-admin/tenant-admin guard bounce, the canonical status bar across viewports, real consultation series, and the request-volume series-or-honest-empty contract.)

**Live-data note:** in the current dev stack the metrics endpoint answers 200 but with `requestVolumeSeries: []` (probed with an authenticated curl: `rpm: 0, seriesLen: 0` — Prometheus itself is up with the `api-gateway` target healthy, so the empty series is what the backend currently computes; backend is out of this ticket's lane). The page therefore renders the honest empty state; the real-series area path is pinned by the `@arcaai/ui` MetricChart unit suite + the either-or E2E, and the real-series *bar* path is proven live on the Dashboard (screenshot below, tooltip `Jul 1 · New 8 · Re-visit 4`).

**Screenshots** (from the live app): `.uxu-verify/task-404-components-page.png` (components showcase, desktop, full page) · `.uxu-verify/task-404-system-health-real-chart.png` (Monitoring: canonical `ServiceStatusBar` footer with per-service badges/uptime/version + live session/job counts; request-volume card in its honest empty state) · `.uxu-verify/task-404-dashboard-real-series.png` (platform dashboard consultation chart rendering the real bucketed series — teal `New` 8 / indigo `Re-visit` 4 on Jul 1).

### 4.7 Deviations / notes

1. **Request-volume card controls removed** (not migrated): the `DateRangeSelector` + `TenantFilter` on that card never drove the (empty) data and cannot drive a fixed 30-minute Prometheus window — keeping them would fabricate affordances. The Dashboard's controls (which do drive `bucketConsultations`) are untouched.
2. **`task-383-platform-dashboard.spec.ts` single-assertion touch-up** is a direct consequence of un-fabricating the chart (the old spec pinned the permanently-empty state); it now accepts exactly one of the two honest states.
3. **Consultation charts needed no change** — P2-1's "illustrative rects" applied to the Figma frames and the request-volume surface; the consultation charts have rendered real series since TASK-380/383 (§2.3 audit). Documented rather than re-built.
4. **Components-page tier**: guarded `requireSuperAdmin` per the open-items review's grouping (§3b *super-admin surfaces*); foundations content itself is tenant-agnostic, so loosening later is a one-line change.

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; plan per §3. | this README |
| 2026-07-02 | Implemented all three P2 items (Progress forward + legacy bar retirement + system-health `ServiceStatusBar` + real request-volume series + `/components` showcase); unit/build/type-check green; `task-404-*` specs authored + one live run green (36 passed, 13.2s); screenshots captured. | §4.1–4.4 file lists |
