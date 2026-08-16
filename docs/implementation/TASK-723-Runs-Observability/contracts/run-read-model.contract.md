# TASK-723 Task 1 — Run Read Model Contract

Establishes, with `file:line` into TASK-718's delivered code, what exists today and what TASK-723
must build. Written before any TASK-723 schema/code — this file is the gate for Tasks 2–11.

## 1. Verdict

**No run row is persisted anywhere. TASK-723 must create `WorkflowRun` — Tasks 3–4 are NOT
skipped.**

TASK-718's dispatcher API (`apps/harness/src/harness/api/endpoints/interpreter.py`) is entirely
Temporal-native and ephemeral:

- `POST /workflow-runs:start` (`interpreter.py:83-133`) starts the Temporal workflow and returns
  `{ runId, workflowId, temporalRunId, status }` — nothing is written to Postgres.
- `GET /workflow-runs/{run_id}` (`interpreter.py:139-169`) calls `handle.describe()` +
  `WorkflowInterpreter.state` (a Temporal query) — a **live** read against Temporal's own history,
  not a queryable list, and unavailable once Temporal's retention for that execution expires.
- `POST /workflow-runs/{run_id}:cancel` (`interpreter.py:172-190`) — a signal, no persistence.

`grep`-confirmed: no `recordRunStarted`/`recordRunFinished`, no `WorkflowRun` model, entity,
repository, or controller exists anywhere in `packages/database`, `packages/domains`, `apps/api`,
or `apps/harness` before this ticket.

## 2. Run identity — how a run correlates to trajectory steps

**`sessionId`, not `runId`, is the join key**, and it is a *derived, deterministic string*, not a
value threaded through `TrajectoryContext`:

1. The domain run id is `InterpreterInput.run_id` (`= body.run_id` from the `POST
   /workflow-runs:start` request, `interpreter.py:96`).
2. The interpreter workflow's **Temporal workflow id** is
   `interpreter_workflow_id(run_id) = f"workflow-interpreter-{run_id}"`
   (`apps/harness/src/harness/temporal/interpreter/workflow.py:53-58`, prefix constant at `:52`).
   `POST /workflow-runs:start` calls `client.start_workflow(..., id=workflow_id, ...)`
   (`interpreter.py:106-111`); idempotent-on-start by id collision (`WorkflowAlreadyStartedError`
   caught at `interpreter.py:113-116`).
3. Every trajectory row emitted for that run carries
   `session_id = str(info.workflow_id)` and `run_id = str(info.workflow_run_id)`
   (`apps/harness/src/harness/temporal/activities.py:395-396`, inside `_TrajectoryBatch.record`).
   `info.workflow_id` **is** the string from step 2. `info.workflow_run_id` is Temporal's own
   execution-attempt id — a DIFFERENT value from the domain `run_id`, and one that can change if
   the same workflow id is ever re-executed (a new Temporal execution).
4. `TrajectoryContext` (`apps/harness/src/harness/temporal/models.py:174-207`) carries
   `tenant_id`, `consultation_id`, `correlation_id`, `seq`, `is_regen`, plus the TASK-718-added
   additive-optional `workflow_version_id`, `stage_id`, `node_id`, `node_type` — **no
   `session_id`/`run_id` field**; those two are read from `activity.info()` inside the activity
   (docstring, `models.py:186-188`), confirming step 3.

**Consequence for `getRunTrace`:** query
`AgentTrajectoryStep` by `sessionId = "workflow-interpreter-" + WorkflowRun.runId` and
**`sessionId` alone** (do not additionally filter on the trajectory row's `runId` column — that
column is Temporal's execution-attempt id, not the domain run id, and filtering on it would drop
steps from a retried execution of the same logical run). `IAgentTrajectoryService.listSteps`
already supports an optional `runId?: string` filter (§2.2 of the ticket) that narrows to one
Temporal execution — TASK-723's rollup deliberately does NOT pass it, for the reason above.

Naming trap for a later reader: `StartWorkflowRunRequest.session_id` (`interpreter.py:71`, alias
`sessionId`) is a **separate, caller-supplied field** on `InterpreterInput`
(`workflow.py`'s `InterpreterInput`) that is NOT what ends up in the trajectory row's `sessionId`
column — that column is always the derived `workflow-interpreter-{runId}` string regardless of
what the caller passes as `sessionId` in the start request. `WorkflowRun.sessionId` (this ticket's
new column) stores the **derived** value (`workflow-interpreter-{runId}`), matching the trajectory
join key, not the request body's `sessionId` field.

## 3. Retry/attempt marker

**None exists.** `grep`-confirmed no `attempt` field anywhere in `apps/harness/src/harness/temporal/interpreter/`. TASK-718's node-level retry budget (`caps.py`
`MAX_NODE_ATTEMPTS` / `clamp_attempts()`, referenced in TASK-718 README lines 507-510) governs
Temporal's own `RetryPolicy` on the node's `execute_activity` call — a retried activity attempt is
invisible to the trajectory table (only the terminal outcome of the whole `execute_activity` call
is recorded via `_record_and_flush`, `interpreter/activities.py:35-51`). **Pitfall 4 stands as
written**: retries surface only as repeated `name` at increasing `seq` within a session, and Task 9
must label any such grouping as **derived**.

## 4. Sandbox flag

`sandbox: bool` is a per-run **input-only** flag (`StartWorkflowRunRequest.sandbox`,
`interpreter.py:78`; threaded onto `InterpreterInput.sandbox`, consumed at
`workflow.py:150-158` to dispatch `external_write` nodes as `SKIPPED(reason="sandbox")`). It is
**never persisted** — TASK-723's `WorkflowRun.isSandbox` is the only durable record of it, and it
must be captured at `recordRunStarted` time from the same value the caller passes to
`POST /workflow-runs:start`. This confirms §3.2's "single filter point" is, and must remain,
`WorkflowRun.isSandbox` (there is nothing else to filter on).

## 5. Degradation marker

**Not represented as a distinct persisted field anywhere.** Two separate facts exist, at two
different layers, and neither is durable today:

- **Workflow-level (ephemeral):** `NodeResult.status` — one of `SUCCEEDED | DEGRADED | SKIPPED |
  FAILED` (`interpreter/models.py:21, 59`) — lives only in the Temporal workflow's own state
  (`WorkflowInterpreter.state` query, `workflow.py`) and in `InterpreterResult.stages[].nodes[]`.
  It is visible via `GET /workflow-runs/{run_id}` only while the workflow's history is queryable,
  and is **not** copied anywhere else. `run_degraded` promotion logic:
  `workflow.py:100-103` (a stage's `DEGRADED`/`SKIPPED` node marks `run_degraded = True`) and
  `workflow.py:114-115` (`RunStatus = "DEGRADED"` when `run_failed` is false and `run_degraded` is
  true). Note `RunStatus` (`interpreter/models.py:26`) **includes** `"DEGRADED"` as a value — this
  is TASK-718's own ephemeral, in-workflow status literal, separate from and not to be confused
  with the **persisted** `WorkflowRunStatus` enum this ticket defines, which per pitfall 6
  deliberately excludes `DEGRADED` as a status (degradation is a count, not a state, at the
  persisted-read-model layer).
- **Trajectory-level (durable but lossy):** a degraded/failed activity's own exception causes
  `_record_and_flush(..., status=STATUS_ERROR, error_code=...)` to run **before** the exception
  propagates (`interpreter/activities.py:75-77`, the `raise_error` path). So the persisted
  trajectory row for a degraded OR a critically-failed node looks identical: `status = ERROR`, some
  `error_code`. The DEGRADED-vs-FAILED distinction is decided by the workflow at the *next* layer up
  from whether the failing node's `NodeSpec.critical` flag is set (`workflow.py:188`,
  `degraded_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"`) — `critical` is a
  property of the **compiled config** (the pinned definition version), not of the trajectory row.

**Consequence for `getRunTrace` (Task 5) and Task 9:** a degraded vs. critically-failed node cannot
be told apart from the trajectory row alone. The rollup must cross-reference the ERROR step's
`node_id` (from the additive `TrajectoryContext.node_id`/`node_type`, threaded onto the step via
`stats`/`payloadRef`... **actually not threaded at all today** — `_record_and_flush` records
`step_type`/`name`/`status`/`error_code` only; it does NOT read `payload.trajectory.node_id` into
the persisted row (`interpreter/activities.py:35-51` passes no `node_id` into `batch.record(...)`).
**This is a real gap**, separate from the ones TASK-718's own README names: the trajectory row for
an interpreter node carries `name = payload.node_type` (the node's *type*, e.g. `"interpreter.noop"`)
and no `node_id` at all, so multiple nodes of the same type in one run are indistinguishable in the
trajectory stream by node identity — only by `seq` order. Recorded here as a known limitation
Task 5's rollup must work around (fold by `seq` order matched against the compiled graph's node
list for that stage, not by a `node_id` column that does not exist on the persisted row) and as a
candidate follow-up for TASK-718 (stamp `node_id` into the trajectory row, not just the in-memory
`NodeResult`).

## 6. Consequence for Task 3's field list — one correction to the README's assumed shape

`packages/database/src/prisma/db_main/workflow-definition.prisma:12-20` states TASK-715 is
**"deliberately a SINGLE table whose rows ARE versions — NOT the house governance triple"**. There
is therefore no separate "definition head" id to put in a `workflowDefinitionId` column — the
stable cross-version identity is `(tenantId, slug)`, and the specific immutable row pinned for a
run is `WorkflowDefinition.id`. Task 3's field list (§4 Task 3 of the README) is adjusted:

| README's assumed field | Actual field authored in Task 3 | Why |
|---|---|---|
| `workflowDefinitionId String` | `workflowSlug String` | There is no definition-head id in the delivered TASK-715 schema; `slug` is the real stable lineage key (`workflow-definition.prisma:56`) |
| *(not present)* | `workflowVersionNumber Int` (added) | Denormalized for list-column display without a join, alongside `definitionName` — same rationale the README already gives for `definitionName` |
| `workflowVersionId String` | unchanged | `WorkflowDefinition.id` of the exact pinned, immutable version row |

`@@index([tenantId, workflowDefinitionId], ...)` becomes `@@index([tenantId, workflowSlug], ...)`
in Task 3; the `@@index([tenantId, workflowVersionId], ...)` from the README plan is added as a
second index (not a replacement) since Task 8's deep link resolves by version id specifically.

## 7. Write-side ownership gap (confirms R2)

TASK-718 (status: Review, per its README line 5) does **not** call any run-write contract — there
is nothing to call, since this ticket is what defines `recordRunStarted`/`recordRunFinished`. This
is the expected, acknowledged chicken-and-egg named in R2: TASK-723 defines the model and the two
write methods; wiring TASK-718's dispatcher (`interpreter.py`) or TASK-722's future gateway
controller to actually call them is **out of this ticket's landed scope** and is recorded as a gap
in §7 of the main README, not silently implied as done.
