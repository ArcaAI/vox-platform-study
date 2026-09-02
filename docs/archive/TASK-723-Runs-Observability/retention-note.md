# TASK-723 Task 10 — Retention and Volume Alignment

## Growth arithmetic

- `AgentTrajectoryStep` (`packages/database/src/prisma/db_main/agent-trajectory.prisma`) grows at
  **N rows per run** — one row per node execution (plus a row per retry attempt, since a retry is
  a repeated `name` at a new `seq`, not an update to the same row). For a typical multi-stage,
  multi-node workflow (design.md's worked examples run 3–8 nodes per stage across 2–4 stages),
  N is commonly in the tens per run.
- `WorkflowRun` (this ticket, `packages/database/src/prisma/db_main/workflow-run.prisma`) grows at
  **exactly 1 row per run**, regardless of how many nodes/stages/retries it contains.
- **Roughly two orders of magnitude apart** in a multi-node workflow — the same ratio the ticket's
  §3.2 calls out. A tenant that accumulates 100k runs generates on the order of 1–10M trajectory
  steps in the same period.

## Existing retention — what governs `AgentTrajectoryStep` today

`packages/applications/src/services/agent-trajectory-retention/agent-trajectory-retention.service.ts`
(`AgentTrajectoryRetentionService`) — a self-scheduling cron (`SchedulerRegistry` + AppSettings,
`@OnEvent('app-settings.cache-refreshed')`) that delegates the hard delete to
`AgentTrajectoryService.pruneOlderThan` (repository path only — no direct Prisma access).

Defaults, quoted from the file:

```
enabled: false,          // agentic.trajectory.enabled
cron: '0 4 * * *',       // agentic.trajectory.cron
retentionDays: 30,       // agentic.trajectory.retentionDays
```

`enabled: false` because "retention HARD-DELETES telemetry rows, so an operator must explicitly
opt in before any data is removed." **In most environments today nothing is pruned yet** — the
volume problem above is latent, not visible, until an operator turns this on (R5).

## Decision: `WorkflowRun` gets its OWN, LONGER retention window than `AgentTrajectoryStep`

Recommendation, per the ticket's §4 Task 10 guidance ("recommend the former"): **`WorkflowRun` rows
are retained longer than their trajectory steps.** Rationale:

1. A run row is cheap (1 row vs. tens), so keeping it far longer costs little.
2. A run row's audit/observability value — "this definition version executed, with this outcome,
   at this time" — outlives the step-level detail. An operator investigating "how often does
   workflow X fail" six months from now needs the run history; they rarely need the individual
   node timings from that far back.
3. Equal retention would silently couple two facts that don't need to move together: the moment
   trajectory pruning is enabled, the runs list would start showing runs with no explorable trace,
   indistinguishable (without Task 9's explicit state) from "nothing happened."

**This ticket does NOT build new retention machinery for `WorkflowRun`** (out of scope, per §4 Task
10 and the ticket's explicit instruction). When `WorkflowRun` needs its own prune job, it follows
the existing `AgentTrajectoryRetentionService` / `AuditRetentionService` pattern verbatim:

- A new self-scheduling service (`WorkflowRunRetentionService`), same `SchedulerRegistry` +
  AppSettings + `@OnEvent('app-settings.cache-refreshed')` shape.
- New AppSettings keys mirroring the trajectory ones, e.g. `agentic.workflowRun.enabled`,
  `agentic.workflowRun.cron`, `agentic.workflowRun.retentionDays` — with
  `agentic.workflowRun.retentionDays` defaulting to a value LARGER than
  `agentic.trajectory.retentionDays` (e.g. 180 vs. 30 — the actual number is an
  operator/compliance decision, not an engineering one, consistent with R4's HUMAN-GATED framing).
- Hard delete delegated to `WorkflowRunRepository` (no direct Prisma access), matching
  `AgentTrajectoryService.pruneOlderThan`'s posture.
- This is recorded here as a **separate, small follow-up task**, not built in this ticket.

## Making the consequence visible, not silent

Per the ticket: "make the consequence visible in the UI rather than silent." Two mechanisms, both
assigned:

1. **Task 9's "trace pruned" state** (`docs/implementation/TASK-723-Runs-Observability/README.md`
   pitfall 3 / acceptance criteria): a run whose `startedAt` predates the effective
   `agentic.trajectory.retentionDays` window, but whose row still exists, renders an explicit
   "trace pruned by retention on `<date>`" state — never an empty timeline.
   **Status: IMPLEMENTED (Phase C pass).** `TracePrunedState`
   (`apps/admin-console/src/features/workflow-runs/components/trace-pruned-state.tsx`) renders
   whenever `RunTraceResponse.tracePruned` is `true`. That field was found HARDCODED to `false`
   in `WorkflowRunService.getRunTrace` (Phase B's own output — `packages/applications/src/
   services/workflow-run/workflow-run.service.ts`), which would have made this state
   unreachable; fixed in the same Phase C pass by injecting `IAppSettingsService` (optional,
   mirroring the existing `IAgentTrajectoryService` DI pattern) and computing it from the SAME
   `agentic.trajectory.{enabled,retentionDays}` keys `AgentTrajectoryRetentionService` reads —
   never a second, possibly-drifted copy of the window. `tracePruned` is `true` only when the run
   has zero steps AND predates the window AND retention is actually enabled (R5: when disabled,
   nothing is pruned yet, so a zero-step run is honestly "no steps" rather than "pruned").
2. **Runs-list footer note** (Task 7's `StatusFooter`): names the retention mechanism so an
   operator can tell at a glance why old runs have no trace. **Status: IMPLEMENTED**, but as
   **static copy naming the setting key and its documented default**, not a live read of the
   effective value — `GET admin/settings/registry/:key` requires `read:GlobalSetting`, which a
   plain tenant admin (this screen's primary audience) does not necessarily hold, and the retry
   window is read once per page rather than per row anyway. If a future pass wants the LIVE
   effective value, add it in one place: `WorkflowRunsScreen`'s footer, via that registry read
   endpoint, gated on the caller actually holding `read:GlobalSetting` (fall back to the static
   copy otherwise).

## Summary of the decision actually recorded by this task

| Question | Answer |
|---|---|
| Same schedule as trajectory steps, or a longer one? | **Longer.** Run rows outlive their trace. |
| Build new retention machinery now? | **No** — explicitly out of scope; follow-up task when needed. |
| Exact window (days)? | **Not set here** — an operator/compliance decision (R4), left open. |
| Where is "old run, no trace" made visible? | Task 9's `TracePrunedState` + Task 7's footer note — both **implemented** in the Phase C pass, with the backend `tracePruned` computation fixed along the way. |
