# TASK-848 — Interpreter Loop Support & IR Versioning

| Field | Value |
|---|---|
| **Status** | `In Progress` — components landed inert (`cdd17b99d`); wiring + tests outstanding |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / **xhigh** (consider `fable` for the determinism/versioning design stage) |
| **Depends on** | TASK-843 ✅, TASK-844 ✅, TASK-847 ✅ — **all landed; this is unblocked** |
| **Owns** | `apps/harness/src/harness/temporal/interpreter/`, worker deployment config |

## 1. Requirement Analysis

The Loop node runs an agentic loop: a master/orchestrator agent plus sub-agents under its instruction,
bounded on three axes. TASK-847 shipped the CONTRACT; this ticket ships the BODY.

**The contract you are implementing against (already merged, do not redesign it):**
`agentic.loop` requires `bounds` and `orchestratorNodeId`, and carries `subAgentNodeIds`, a
truthiness-keyed early exit, and four bounds — `maxIterations`, `maxDurationSeconds`, `maxTotalTokens`,
`noProgressIterations`. `orchestratorNodeId` and `subAgentNodeIds` are **node REFERENCES**, consistent with
the reference-only rule.

**Architecture — SETTLED. Do not re-litigate.** One generic versioned interpreter workflow type per IR major
version, receiving a compiled immutable graph IR as workflow input; interpreter *code* changes handled by
Worker Versioning `Pinned`; child workflows only for LOOP sub-agents.

The determinism argument: Temporal's constraint is on workflow **code**, not **data**. Passing the graph as
input puts it in `WorkflowExecutionStarted` — in history — so replay feeds back the identical graph plus
identical recorded activity results and emits the identical command sequence. This is a first-party pattern
(`temporalio/samples-python/dsl`). **A tenant edit becomes a data change, not a code change**; every
alternative turns a tenant edit into a deploy.

**"The graph cannot change mid-run" is a FEATURE — hold that line.** For clinical work an auditable frozen
pipeline is correct; a run that silently changed mid-flight is a compliance problem.

## 2. Current State Evaluation

`WorkflowInterpreter` (`interpreter/workflow.py:87`) is bounded by its own docstring:
*"Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)."*
Task queue `harness-task-queue`; replay-compat fixtures at `tests/unit/temporal/test_replay_compat.py`.

**What TASK-847 left explicitly for this ticket**, marked in `interpreter/nodes/agentic.py`:
- `:22` — *"`agentic.loop` OBSERVABLE non-execution. TASK-848 owns the loop body."*
- `:70` — *"the bounds enforced against a workflow TIMER rather than wall-clock — is TASK-848."*
- `:99` — *"on the compiled config for the boundary check TASK-848 wires."*
- `agentic.loop` currently returns `DEGRADED` and a test (`test_neither_ever_claims_to_have_produced_anything`)
  pins that it never claims to have produced anything. **That test must be updated deliberately, not deleted.**

**Tier 3 (runtime boundary validation) is declared, not enforced.** `ioSchema` / `onSchemaViolation` are
carried on the compiled config (`node-config-schemas.ts:1299-1319`) and the activity does not evaluate them.
TASK-847 stated this belongs here.

**The established pattern for extending both runtimes together** is TASK-852 items 3–4: a config-driven skip
branch in `_dispatch_node` with a `mandatory`-class exclusion and a registry-derived drift gate. Follow it.

## 2b. Design finding carried forward from the first attempt (2026-09-01)

The first attempt stalled, but committed 171 lines of loop payload models first and recorded a finding worth
keeping:

> **The loop workflow runs exactly ONE iteration per generation, so its entire memory must be carried as
> input. `maxDurationSeconds` is the one bound that CANNOT be: a workflow timer does not survive
> `continue_as_new`, and "carrying" one would mean reading a clock inside `@workflow.defn`. That bound
> belongs to the PARENT.**

That is a real constraint on step 7 and it shapes the design: three of the four bounds travel in the
carried state; the duration bound is enforced by the parent workflow that owns the un-reset timer.
Commit `e0c666e93` on branch `worktree-agent-a223376f1cd9b5bb4`; a 76-line test stub is preserved in the
session scratchpad.

## 2c. Scope split (2026-09-01) — three consecutive agents stalled on the 9-step scope

Three agents in this program hit the 600s stream watchdog. The two that carried no incremental commits lost
everything; this ticket's first attempt kept 171 lines because it committed as it went. The response is to
make the unit smaller, not to retry the same size:

| Pass | Steps | Status |
|---|---|---|
| **848 — loop body** | 1, 2, 3, 7 — iteration + `continue_as_new`, orchestrator-workers only, sub-agents as child workflows, the four bounds | in progress |
| **848b — durability & versioning** | 4, 5, 6, 9 — `irVersion` dispatch, Worker Versioning `Pinned`, claim-check to MinIO, real-graph replay fixtures | follow-up |
| **848c — tier 3** | 8 — `ioSchema` / `onSchemaViolation` boundary evaluation | follow-up, may fold into TASK-849 |

The steps below are unchanged; only their assignment to passes is new.

## 3. Implementation Plan

1. **Extend the interpreter past the v1 bound** — iteration, with a `continue_as_new` boundary at each loop
   iteration so history does not grow without limit. Update the class docstring; it is currently a promise
   the code will no longer keep.
2. **Ship orchestrator-workers ONLY.** Most named agentic patterns are already graph shapes — chaining is
   nodes in series, routing is conditional edges, sectioning/voting is fan-out + fan-in, ReAct is the Agent
   node's tools. The Loop node earns its existence only for **runtime-unknown step counts**.
   Evaluator-optimizer is phase 2: same skeleton, different termination predicate. **Do not build it here.**
3. **Sub-agents run as CHILD WORKFLOWS**, giving each its own history and retry envelope.
4. **`irVersion` dispatch** so graph-language changes never require `workflow.patched()`.
5. **Worker Versioning `Pinned`** for interpreter code changes. The legacy Build-ID mechanism is being
   removed from Server around **March 2026** — do not build on it.
6. **Claim-check to MinIO from day 1.** Payload limits are 2 MB/payload and 4 MB/gRPC message; clinical
   transcripts exceed that. Retrofitting rewrites every activity signature.
7. **Enforce all four TASK-847 bounds**, and make each terminate with a DISTINGUISHABLE reason.
   **`maxDurationSeconds` must be a workflow timer, never wall-clock** — a wall-clock read inside
   `@workflow.defn` breaks replay, meaning a clinical run that cannot be reproduced.
8. **Wire tier 3 boundary validation** — evaluate `ioSchema` at node boundaries and honour
   `onSchemaViolation`. If you cannot land an evaluator here, say so and leave the declaration unenforced
   rather than claiming a safety property that does not exist.
9. **Extend `test_replay_compat` with histories generated from REAL tenant graphs**, not synthetic ones.
   Graph-as-data does NOT protect against interpreter *code* changes — this test is that protection.

## 4. Verification Criteria

- Replay-compat green against real-graph histories.
- A loop hitting `maxIterations`, `maxDurationSeconds`, `maxTotalTokens` and `noProgressIterations` each
  terminates cleanly with a **distinguishable** reason.
- `continue_as_new` keeps history bounded across a long loop — **measure it**, do not assert it.
- A determinism poison test: monkeypatch `workflow.now` / `workflow.random` to raise and prove the loop path
  does not touch them.
- `pnpm harness:test`, `pnpm harness:lint`, `pnpm harness:typecheck`.
- `pnpm --filter @arcaai/workflow-contract test` if the contract moves.
- **F-31 applies:** rebuild any package you change before running a downstream gate.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Interpreter code change breaks in-flight runs — graph-as-data does NOT protect this | Worker Versioning `Pinned` + `irVersion` + real-graph replay fixtures (steps 4, 5, 9) |
| History explosion | `continue_as_new` per iteration; assert with a measurement, not a claim |
| Payload limits hit by clinical transcripts | Claim-check from day 1 (step 6), never retrofitted |
| An unbounded loop becomes an unbounded invoice | `maxTotalTokens` is required by the contract; enforce it, do not treat it as advisory |
| Claiming tier-3 validation that is not really evaluated | Step 8's explicit escape hatch — declare unenforced rather than assert a false safety property |

## 6. Implementation Summary

### Landed 2026-09-01 (`cdd17b99d`) — components only, deliberately INERT

| File | Lines | What |
|---|---|---|
| `interpreter/loop_workflow.py` | 381 | `AgenticLoopWorkflow` + `AgenticSubAgentWorkflow` — one iteration per generation, then `continue_as_new` |
| `interpreter/models.py` | +196 | The loop payloads: the state that must survive `continue_as_new` |
| `interpreter/loop_activities.py` | 98 | The per-iteration checkpoint activity |
| `interpreter/workflow.py` | +35 | `_LOOP_PATCH`, `_LOOP_NODE_TYPE`, and the stop-reason taxonomy |

**Inert by construction, and this was verified before merge:** `agentic.loop` still returns `DEGRADED`
(`nodes/agentic.py:296`), `_LOOP_PATCH` and `_LOOP_NODE_TYPE` are declared but never called, and neither
`AgenticLoopWorkflow` nor the checkpoint activity is registered on the worker. Behaviour is unchanged.
Gates at merge: lint EXIT=0, typecheck clean (143 files), 1876 tests passed.

### The stop-reason taxonomy (decided, implemented in comments, not yet reachable)

`termination_key` and `no_progress_iterations` are **SUCCEEDED** — the author's exit fired, or the
orchestrator converged, which is what that bound exists to detect. Every ceiling — iterations, invoice,
clock — **DEGRADES**, because *a truncated clinical deliberation reported as SUCCEEDED is the false-success
claim this substrate exists to avoid.*

### Still outstanding for the next pass

1. The dispatch branch in `_dispatch_node`, guarded by `workflow.patched(_LOOP_PATCH)`.
2. `_index_loop_body` — referenced by the comments, not written.
3. Worker registration for `AgenticLoopWorkflow`, `AgenticSubAgentWorkflow` and the checkpoint activity.
4. Un-`DEGRADE` `agentic.loop`, updating `test_neither_ever_claims_to_have_produced_anything` deliberately.
5. **All tests**: the four bounds each terminating distinguishably, the determinism poison test, and the
   `continue_as_new` history-bound MEASUREMENT.

### Process note

This ticket cost **four dispatch attempts**, three of which hit the 600s stall watchdog. The first kept
171 lines because it committed early; the fourth kept 675 because the instruction had hardened to *commit
stubs, commit RED tests, commit partial implementations*. The orchestrator finished the lint/typecheck
cleanup directly rather than spending a fifth dispatch on it. **The lesson is recorded because it is
reusable: on a long ticket, commit granularity is what converts a stall from a total loss into a resumable
one.**

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket created, aligned to TASK-837 §4. |
| 2026-09-01 | Plan expanded against the contract TASK-847 actually shipped; unblocked and ready to start. |
| 2026-09-01 | Scope split into loop body / durability+versioning / tier 3 after three stalls (§2c). |
| 2026-09-01 | Components merged INERT as `cdd17b99d`. Wiring and tests outstanding; Status → `In Progress`. |
