# TASK-512 — Agentic Global-Admin Console (TASK-508 Phase 3B)

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Parent** | TASK-508 Agentic SOTA Program — Phase 3B (Console) |
| **Depends on** | TASK-509 (generation stats), TASK-510 (trajectory), TASK-511 (agentic policy / prompt governance / instruction inventory) — all landed |
| **Scope (exclusive)** | `apps/admin-console/**` + this README only |
| **Design gate** | **WAIVED by owner** (see note below) — built against rules 11/12/13 + `ScreenTemplate` |

---

## Owner run decision — design-approval gate WAIVED

The rule-12 Figma design-approval gate is **waived for TASK-512** by owner directive. No
approved frames exist for these screens; instead each screen is built directly against:

- rule **11** (UX/UI principles — space, feedback, states, typography, a11y),
- rule **10** (skeleton loading states),
- rule **13** (Next.js App-Router / BFF conventions), and
- the shared **`ScreenTemplate`** frame (header → stats → statusBanner → tabs → content → footer).

Every screen still ships the full default + loading (skeleton) + empty + error state contract
in both themes, colocated vitest, and axe 0-violations — i.e. the design *quality bar* is met
even though the *frame-inventory + approval-date* gate is skipped.

---

## Requirement Analysis

Build the five global-admin console screens that visualize/operate the Phase 1/2/3A backend
that landed with TASK-509/510/511. Constraints:

- Data **only** via the `/api/hope/[...path]` BFF proxy + TanStack Query (no direct gateway fetch).
- **No new UI primitives** outside `@arcaai/ui` (shadcn/data-slot patterns).
- Role-guard each route/menu entry where the backend requires elevation; mirror the existing
  guard pattern (`WorkingTenantGate` for tenant-scoped reads; `manage:all` nav ability for the
  GLOBAL_ADMIN surfaces).
- Colocated `__tests__` (vitest + axe); Playwright is Phase 7 (not written here).
- Menu range **tier 10-19**; concrete numbers assigned in the nav registry.

## Current State Evaluation

Confirmed the backend route shapes by reading the gateway modules:

| Concern | Route(s) | Auth |
|---|---|---|
| Agentic instruction inventory | `GET admin/agentic/instructions` | `CanManage('HarnessPolicy')`, cross-tenant 404 |
| Harness / agentic policy | `GET/PATCH admin/harness/policy`, `GET/PATCH admin/harness/policy/global`, `GET/PATCH admin/harness/live/config` | `manage HarnessPolicy` + If-Match OCC; `policy/global` + `live/config` global-admin-only |
| Settings catalog (`agentic.*`) | `GET admin/settings/catalog` | global-admin |
| Prompt governance | `GET admin/prompt-templates` (+ versions/diff), `POST admin/prompt-templates/:id/approve` | prompt-management guards + OCC |
| Trajectory (read) | `GET admin/agent-trajectory/sessions`, `GET admin/agent-trajectory/sessions/:id/steps`, `GET admin/agent-trajectory/metrics/generation` | `CanManage('HarnessPolicy')`, 404-over-403 |
| Gate queue | `GET admin/harness/gate-queue` | `read HarnessWorkflow` |
| Workflow-ops | `POST admin/harness/workflows/:id/cancel`, `.../signal` | `manage HarnessWorkflow`, tenant-ownership enforced |
| Trajectory SSE | `GET consultations/:id/trajectory/stream` | JWT or single-use `?ticket=` (scope `consultation_trajectory:<id>`) |

Generation metrics aggregate landed with TASK-509 follow-up
(`GET admin/agent-trajectory/metrics/generation`); screen 2 consumes it. The console still has
**no Prometheus proxy / Grafana-iframe convention** (charts via `@arcaai/ui`
`MetricChart`/`StatCard`). MCP registry (TASK-516) powers screen 5.

## Implementation Plan (TDD, priority order)

3 → 4 → 1 → 2 → 5, each fully (screen + states + colocated tests + axe) before the next, so a
mid-run stop leaves a buildable tree. Register each route/menu entry (unique icon) and bump the
governance `nav-config.test.ts` counts as each screen lands.

---

## Implementation Summary

All five screens completed. Each lives under `src/features/<feature>/` (api/ + components/ +
colocated `__tests__/`) with an App-Router `page.tsx` + `loading.tsx` under
`src/app/(console)/(global)/`, and a `NAV_ENTRIES` row (tier 10-19, `manage:all`, unique icon).

### Screen inventory

| # | Screen | Route | Feature dir | Nav icon | Tenant scope | Backend |
|---|---|---|---|---|---|---|
| 3 | **Agentic Policy** | `/agentic-policy` | `features/agentic-policy` | `IconShieldBolt` | global (no gate) | harness policy/global + live/config + settings catalog; If-Match OCC + kill-switches |
| 4 | **Prompt Studio** | `/prompt-studio` | `features/prompt-studio` | `IconWritingSign` | `WorkingTenantGate` | prompt-templates list/versions/diff + `approve` (OCC) |
| 1 | **AI Operations — Runs** | `/ai-operations/runs` | `features/ai-operations-runs` | `IconTimeline` | `WorkingTenantGate` | trajectory sessions→steps (live SSE), gate queue, cancel/signal |
| 2 | **AI Operations — Metrics** | `/ai-operations/metrics` | `features/ai-operations-metrics` | `IconChartHistogram` | `WorkingTenantGate` | `metrics/generation` aggregate (TASK-509) + gate-queue regen counts |
| 5 | **Tools & MCP** | `/tools-mcp` | `features/tools-mcp` | `IconPlugConnected` | global (elevated) | `admin/mcp-servers` CRUD (TASK-516) — If-Match OCC |

### Per-screen notes

- **Agentic Policy** — tabs: *Global default* (tri-state / integer / switch knob editor with
  If-Match OCC, `OccConflictAlert` on 412, audit reason), *Engine kill-switch* (live-doc engine
  enable/disable with reason), *Agentic context* (read-only `agentic.*` catalog inspection —
  editing stays on Settings & secrets, which mutates `GlobalSetting` rows by id).
- **Prompt Studio** — master/detail list → versions + server-side diff + test score, with a
  `GLOBAL_ADMIN`-gated **Approve** panel (OCC). Behind `WorkingTenantGate` (templates are
  tenant-scoped).
- **AI Operations — Runs** — session rail (kind filter) → ordered step timeline with per-step
  `GenerationStats`, a live SSE toggle (ticket-authed `useEventStream`), and cancel/signal wired
  to harness workflow-ops for `HARNESS_DOC` runs; second tab is the clinician gate queue.
- **AI Operations — Metrics** — TTFT (p50/p95) + avg tok/s + stop-reason distribution from
  `GET admin/agent-trajectory/metrics/generation` (TASK-509; default last 7d + hard row cap),
  plus regeneration-rate / gate-pending from the gate queue. Footer discloses sample count +
  "server aggregate".
- **Tools & MCP** — writable SYSTEM MCP registry (`GET/POST/PATCH/DELETE admin/mcp-servers`,
  TASK-516). Table shows name, base URL, PHI boundary, tool allowlist, enabled, and **masked
  auth presence** (`Configured` / `None` — Vault path never echoed in the grid). Create/edit
  dialog + soft-delete with If-Match OCC; GLOBAL_ADMIN gate (no working-tenant requirement).

### Files created

```
src/features/agentic-policy/**            (api/*, components/*, __tests__)          [screen 3]
src/features/prompt-studio/**             (api/*, components/*, __tests__)          [screen 4]
src/features/ai-operations-runs/**        (api/*, components/*, __tests__)          [screen 1]
src/features/ai-operations-metrics/**     (api/{types,client,keys,aggregate,hooks,index}, components/*, __tests__) [screen 2]
src/features/tools-mcp/**                 (api/*, components/*, __tests__)          [screen 5]
src/app/(console)/(global)/agentic-policy/{page,loading}.tsx
src/app/(console)/(global)/prompt-studio/{page,loading}.tsx
src/app/(console)/(global)/ai-operations/runs/{page,loading}.tsx
src/app/(console)/(global)/ai-operations/metrics/{page,loading}.tsx
src/app/(console)/(global)/tools-mcp/{page,loading}.tsx
```

### Files modified

```
src/shared/navigation/nav-config.ts                       (+5 NAV_ENTRIES, +5 icon imports)
src/shared/navigation/__tests__/nav-config.test.ts        (route-map count 38→43, tier 10-19 12→17)
src/features/ai-operations-runs/components/gate-queue-panel.tsx (drop unused Card import — lint fix)
```

## Missing Backend Routes (reported, NOT worked around)

1. ~~**Aggregate generation-metrics endpoint**~~ — **RESOLVED** (2026-07-19, TASK-509 follow-up).
   Screen 2 now calls `GET admin/agent-trajectory/metrics/generation` (default last 7d + hard row
   cap). Prometheus proxy / Grafana-iframe convention still absent (optional later).
2. ~~**MCP tool registry UI**~~ — **RESOLVED** (2026-07-19). Screen 5 rewired to TASK-516
   `admin/mcp-servers` CRUD (list/create + If-Match PATCH/DELETE). Instructions inventory is no
   longer on this screen.

## Verification / Gate evidence

Package: `@arcaai/admin-console`.

- **Test (vitest + axe):** `pnpm --filter @arcaai/admin-console test`
  → `Test Files 132 passed (132) · Tests 976 passed (976)` (includes the 5 new screen suites, each
  with an axe 0-violations case, + the bumped `nav-config` governance test).
- **Lint:** `pnpm --filter @arcaai/admin-console lint` (`eslint src --max-warnings 0`) → clean
  (0 errors, 0 warnings; hard errors in apps).
- **Build/typecheck:** `pnpm --filter @arcaai/admin-console build` → success; all five routes
  (`/agentic-policy`, `/prompt-studio`, `/ai-operations/runs`, `/ai-operations/metrics`,
  `/tools-mcp`) compiled as dynamic (`ƒ`) server routes.

## Constraints honored

- **No git writes** of any kind.
- **Manifest-exclusive**: edits limited to `apps/admin-console/**` + this README. No other package
  (`apps/api`, `packages/**`, `apps/{harness,smr,guardrail}`, infra/deployment, root env/turbo) was
  touched.
- All data flows through the `/api/hope/[...path]` BFF proxy via TanStack Query; no new UI
  primitives outside `@arcaai/ui`.

## Change History

| Date | Change |
|---|---|
| 2026-07-19 | Initial implementation — all 5 screens (Agentic Policy, Prompt Studio, AI Operations Runs, AI Operations Metrics, Tools & MCP) with states + colocated vitest/axe; nav registration (tier 10-19); design-gate waiver recorded; two missing backend routes reported. Gates: test 976 pass, lint clean, build ok. |
| 2026-07-19 | Audit follow-up: Tools & MCP rewired from `GET admin/agentic/instructions` to TASK-516 `admin/mcp-servers` CRUD (list/create + If-Match PATCH/DELETE). GLOBAL_ADMIN gate (drop WorkingTenantGate); registry table + create/edit dialog; authRef masked presence only. Missing Backend Routes item 2 marked resolved. Gates: `vitest run src/features/tools-mcp` 9 pass; lint clean. |
| 2026-07-19 | Metrics screen rewired to TASK-509 `GET admin/agent-trajectory/metrics/generation`. Missing Backend Routes item 1 marked resolved (Prometheus proxy still open). Gate: `vitest run ai-operations-metrics`. |
