# TASK-721 Task 2 — TASK-718's sandbox-mode contract, as delivered

Written against the tree at HEAD of `feat/loop` on 2026-08-16, reading TASK-718's **uncommitted,
in-progress** working tree (its README self-reports Status: "Review — core interpreter (Tasks
1–11) built and green; Task 12 partial"). Every claim below carries a `file:line` into that code.
Where TASK-718 (or a ticket it depends on) does not deliver something this ticket needs, that is
recorded as a **blocking open question** rather than guessed at, per this ticket's Task 2
instruction and rule `_karpathy.md` §1 ("if something is unclear, stop... ask").

## 1. How a run is started in sandbox mode

**Route exists, but only on the harness side — there is no gateway (apps/api) route yet.**

- `POST /api/v1/internal/workflow-runs:start` —
  `apps/harness/src/harness/api/endpoints/interpreter.py:82-135`. Guarded by
  `Depends(require_service_token)` (`:84`, reusing `internal.py`'s `X-Service-Token` middleware
  per rule 06 §Gateway Integration).
- Request body — `StartWorkflowRunRequest` (`interpreter.py:64-79`):
  `{ runId, sessionId, workflowVersionId, tenantId, configRef: ClaimCheckRef, sandbox: bool = false }`.
  **`sandbox` is a plain boolean field on the start request** — there is no separate enum/mode
  value; `sandbox: true` is the only signal.
- `configRef` is a **pre-minted `ClaimCheckRef`** to the version's `compiledConfig`
  (`interpreter.py:67-70`) — the endpoint never accepts a raw graph or compiled config inline.
  Minting that ref (i.e. resolving a `workflowDefinitionId` + `version` into a stored,
  claim-checkable `compiledConfig` blob) is **not implemented anywhere in this tree**. It is not
  this ticket's job to invent it (TASK-715/716 own the compiled artifact; TASK-722 owns exposing
  it), but the Workbench's "run a definition… against a chosen synthetic input" (§1 item 1) cannot
  produce a `configRef` without it.
- Idempotency: duplicate starts for the same `runId` collide on `interpreter_workflow_id(run_id)`
  and return the existing run, HTTP 200, `status: "already_running"`
  (`interpreter.py:104-116`, confirmed against TASK-718 README Acceptance Criteria).

**BLOCKING — no gateway route.** `apps/api/src/modules/` has no controller for
`workflow-runs`/`interpreter` anything (verified: `find apps/api/src/modules -iname
"*interpreter*" -o -iname "*workflow-run*"` returns nothing). The one existing harness proxy
client, `apps/api/src/modules/harness-admin/harness-ops.client.ts:11` (`HARNESS_ADMIN_BASE =
'/api/v1/internal/harness'`), targets a **different URL prefix** (the ConsultationDoc-family ops
surface) and does not touch `/api/v1/internal/workflow-runs*` at all. Per rule 13 §Auth (BFF),
the admin console can only reach the harness dispatcher through a gateway route (never directly),
and per rule 06 §Gateway Integration, "services do NOT self-register... reached through the
gateway". **This gateway proxy is `TASK-722`'s (`exposure-v1`) explicit deliverable** — confirmed
by `docs/implementation/TASK-718-Workflow-Interpreter/README.md:745` ("`TASK-722`
(`exposure-v1`) | `POST /api/v1/internal/workflow-runs:start` + status + cancel (Task 10). The
gateway proxies to these; it never talks to Temporal directly.") — and by this ticket's own §1
scope table, which lists "Exposing sandbox runs over the REST/SSE channel plane" as TASK-722's,
not this ticket's. **TASK-722's status is Pending** (`docs/implementation/TASK-722-Exposure-V1/README.md:4`)
— nothing has been built. **There is today no code path by which a browser (or the BFF proxy) can
start an interpreter run at all**, sandboxed or not.

## 2. Which writes are suppressed, and what isn't covered

- Mechanism: `_dispatch_node` (`apps/harness/src/harness/temporal/interpreter/workflow.py:132-157`)
  checks `if inp.sandbox and spec.external_write:` (`:154`) **before** `workflow.execute_activity`
  is ever called (`:179`), and returns an observable `NodeResult(status="SKIPPED",
  reason="sandbox")` (`:155-157`) — the exact same shape as `unsupported_node_type`
  (`:137-142`), so a sandboxed run's feed shows a marked skip, never a hole or a silent success.
- `external_write` is a **code-owned, per-node-type registry flag**
  (`registry.py:63,70` — `NodeSpec.external_write: bool = False`, comment at `:59-61`: "never
  tenant-configurable"), not something a tenant's definition can turn on or off.
- **What it covers today: nothing yet, because the registry is empty of real node types.**
  `NODE_REGISTRY` (`registry.py:76-79`) holds only `noop` and `passthrough` — both
  `external_write=False` by default and built for this ticket's own tests
  (`registry.py:10-11` docstring: "This ticket ships only the `noop`/`passthrough` entries this
  package's own tests need"). `TASK-720` (`palette-summarization`) is the ticket that populates
  the registry with real, `external_write`-flagged node types (notes, storage writes, webhooks —
  the things design.md's "never writes external artifacts" sentence is actually about), and
  **TASK-720's status is Pending** (`docs/implementation/TASK-720-Palette-Summarization/README.md:4`).
  So the sandbox-suppression *mechanism* is real and tested
  (`apps/harness/src/harness/tests/unit/temporal/interpreter/test_sandbox.py`, per TASK-718
  README Task 11), but there is currently no concrete write it actually suppresses in this repo.
- What it deliberately does not cover: node types with `external_write=False` still execute in
  sandbox mode (e.g. a future read-only NLP/classification node) — sandbox suppresses writes, not
  computation.

## 3. How a sandbox run is identifiable after the fact

**Not identifiable from any persisted row today — confirmed gap, matches this ticket's own R3.**

- `InterpreterInput.sandbox` (`models.py:97`) is a field on the **workflow's own input**, readable
  only via Temporal's own APIs (e.g. re-reading workflow input, which the dispatcher does not
  expose) for the lifetime of that specific run.
- The per-node trajectory context threaded into each activity, `TrajectoryContext`
  (`apps/harness/src/harness/temporal/models.py:174` on), carries `tenant_id`, `seq`,
  `workflow_version_id`, `stage_id`, `node_id`, `node_type` (per the TASK-718 Task 7 additive
  fields, docstring `:191-194`) — **no `sandbox` field**. Confirmed by grep: no occurrence of
  `sandbox` anywhere in `interpreter/activities.py` or in the `TrajectoryContext` construction at
  `workflow.py:161-168`.
  So `AgentTrajectoryStep` rows (`packages/database/src/prisma/db_main/agent-trajectory.prisma:62`,
  read via `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts`, §2.5 of this
  ticket's README) carry **no sandbox marker** — a real-data trajectory browser cannot filter
  sandbox steps out today.
- The dispatcher's own status read, `GET /workflow-runs/{run_id}`
  (`interpreter.py:138-172`), returns `{ runId, status, stages, startedAt, endedAt }` — **no
  `sandbox` field in the response either** (`:166-172`).
- **There is no persisted "run" row at all yet.** TASK-718 ships no `WorkflowRun`-shaped table;
  the run's only durable state is inside Temporal itself. The run read model this ticket's Task 9
  needs a filter point on (`isSandbox`) is explicitly **TASK-723**'s (`runs-observability`)
  deliverable — confirmed Pending (`docs/implementation/TASK-723-Runs-Observability/README.md:4`).
  This matches R3 exactly: *"If TASK-723 has not landed, raise the field as a requirement in its
  ticket; do not add a second sandbox marker."* Recorded, not worked around — see §6 of the
  ticket README.

  **Update, mid-session (sibling agents share this tree, per orchestrator instructions):**
  `packages/database/src/prisma/db_main/workflow-run.prisma` appeared in the working tree while
  this doc was being written — TASK-723 is actively landing a `WorkflowRun` read model with
  exactly the needed field: `isSandbox Boolean @default(false)` (`workflow-run.prisma:96`,
  comment: *"TASK-721's single filter point for excluding sandbox runs from tenant-facing reads"*).
  This is **encouraging but not yet a stable contract to build against**: it is uncommitted,
  mid-flight sibling work (not in `git log`), and its own file header states the write path is
  unwired — *"recordRunStarted/recordRunFinished are the write contract TASK-718's dispatcher — or
  a future gateway controller — calls; see the ticket's R2 ... for the current wiring gap"*
  (`workflow-run.prisma:33-36`). No domain/service/controller layer for `WorkflowRun` exists yet
  (only the Prisma model + generated `WorkflowRunModel.ts`/`WorkflowRunStatus` enum). Task 9 of
  this ticket therefore still cannot wire a real exclusion filter this session — it depends on
  TASK-723 finishing and committing Tasks 2+ (domain layer, service, the runs-list query itself).
  Recorded as a coordination point, not implemented against a moving target.

## 4. The live progress stream

**Does not exist. Only polling.**

- The dispatcher exposes exactly one status surface, `GET /workflow-runs/{run_id}`
  (`interpreter.py:138-172`), which calls Temporal `handle.describe()` and the `state` query
  (`InterpreterStateQueryResult`, `models.py:114-121`) — a point-in-time snapshot, not a stream.
  There is no SSE endpoint, no `EventSource`-compatible route, and no `@StreamScope` declaration
  anywhere in the interpreter package or `interpreter.py` (grepped: zero occurrences of
  `sse`/`stream`/`Stream` in `apps/harness/src/harness/temporal/interpreter/*.py` and
  `interpreter.py` outside comments about the Temporal SDK's own workflow *sandbox*, an unrelated
  meaning of the word).
- `docs/implementation/TASK-722-Exposure-V1/README.md`'s own title is **"Exposure Plane v1 (REST
  invoke + status + SSE)"** — the SSE channel is explicitly that ticket's deliverable, and it is
  Pending. This ticket's own scope table already anticipated this ("Exposing sandbox runs over the
  REST/SSE channel plane | TASK-722").
- Consequence for this ticket's §1 item 2 ("Live progress via SSE while the run executes"): there
  is no `path`/`scope`/event-name contract to wire `useEventStream` against. The precedent this
  ticket's README §2.4 points at (`trajectoryStreamPath`/`trajectoryStreamScope`,
  `features/ai-operations-runs/api/client.ts`) streams **consultation** trajectory
  (`consultations/{id}/trajectory/stream`), keyed by `consultationId` — a WorkflowInterpreter
  sandbox run has neither a `consultationId` nor an equivalent stream route.
- **Replay semantics: cannot be determined — there is nothing to reconnect to.** Pitfall 3
  ("never auto-reconnect a replaying stream") cannot be evaluated because no stream exists to
  characterize.

## 5. Single-node execution

**Not supported.** `NodeSpec` (`registry.py:51-74`) has no field expressing "independently
runnable", and `_dispatch_node` (`workflow.py:132-157`) is only ever called from `_run_stage`
(`:122-130`), itself only reachable from the top-level `@workflow.run` walking the compiled
graph's stages (`workflow.py` — the full stage loop, not reproduced here). There is no entry point
that executes one node in isolation, no "isolated node" activity variant, and no registry field
resembling `entitlement_key`'s "optional field from day 1" pattern (`registry.py:73`,
`README.md:46` R-6) for standalone-runnability. TASK-720 (which will add real node types) does not
change this — it is an interpreter/registry-shape question, not a palette-content one.

**Resolution per R2 (this ticket's own risk table): the isolated-node panel (§1 item 4, Task 8's
"Isolated node test") is a documented gap, not built.** Building a client-side simulation of
single-node execution would (per this ticket's own §3.3 pitfall 5 spirit and R2's explicit
instruction) "produce results the interpreter would not."

## 6. The synthetic-input payload shape

**Narrower than assumed at ticket-authoring time.** `InterpreterInput` (`models.py:82-98`) takes
`session_id: str` — a reference to an already-existing session — **not** an inline synthetic
payload. There is no field on `StartWorkflowRunRequest` or `InterpreterInput` that accepts
arbitrary JSON test input; the interpreter expects the caller to have already materialized
whatever a "session" is (its shape is not defined anywhere in TASK-718's delivered code — grep for
a `Session`/`SandboxSession` model in `apps/harness/src/harness/temporal/interpreter/` returns
nothing) and pass only its id.

Consequence for Task 4 (the `WorkflowTestFixture.input` column): the fixture's synthetic JSON
cannot be handed to the interpreter directly today — some unbuilt step must first turn fixture
`input` into a `sessionId` the interpreter can consume. That step is not specified by TASK-715,
716, 717, or 718. `WorkflowTestFixture.input` is still built as planned (Task 4) because fixture
*storage/CRUD* (§1 item 5) is independently useful and entirely within this ticket's own remit,
but the field is **not wired to a working run today** — recorded, not worked around.

## Summary — what this means for this ticket's Phase C

| §1 requirement | Status after this contract check |
|---|---|
| 1. Run a definition in sandbox mode | **Blocked.** No gateway route (TASK-722 Pending); no way to mint a `configRef`; no way to turn fixture `input` into a `sessionId` |
| 2. Live progress via SSE | **Blocked.** No stream exists anywhere in the stack (TASK-722 Pending) |
| 3. Per-node inspection | **Blocked** on 1/2 having a real run to inspect; the trajectory read plane (§2.5) exists but has nothing sandbox-run-shaped to show yet |
| 4. Isolated node test | **Not supported by the interpreter (R2).** Documented gap, not built |
| 5. Fixture management | **Buildable now.** Self-contained CRUD (Prisma model → domain → service → gateway → console UI); this ticket delivers it |
| 6. Sandbox containment guardrail | **Blocked** on TASK-723's run read model (`isSandbox` field, R3) and on there being any real sandbox run to contain |

This is not a design choice made by this ticket — it is what TASK-718/722/723 have and have not
delivered, verified above. Per rule 01 Phase 2 and this ticket's own R2/R3 handling, the correct
response to a missing foundational capability is to record it as a blocker and build only what
does not depend on it, not to simulate the missing layer client-side. See README §6/§7 for how
this changes the execution plan.
