# TASK-662 — `ConsultationLoopWorkflow`

**Status:** In Progress

**Wave:** W3 · **Tier:** opus-5 / high · **Type:** feature · **Depends on:** TASK-658 (merged `55fa735c5`), TASK-659 (merged), TASK-660 (merged)

**Base commit:** `39f210ab7` on `dev-2.1` (`docs(TASK-654): Wave 2 merged, Wave 3 started`).
This worktree spawned from `dev` (`180d09d6a`) — the known repo default — and was
`git reset --hard dev-2.1` before any work, per execution-plan §1.1.

## 0. Measurement contract (read before any gate claim)

Per execution-plan §1.1a, `arcaenv` installs `harness` as an editable package pinned to an
absolute path in the **main checkout**. Running `pnpm harness:test` from this worktree
collects *this worktree's tests* but imports the *main tree's source*. Every Python gate in
this ticket is therefore prefixed:

```
PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
```

**Own measured baseline on `39f210ab7`, before any edit, with that prefix:**

```
================= 1052 passed, 4 skipped, 1 warning in 28.62s ==================
```

(The 4 skips are the pre-existing `test_phi_redactor.py` cases that need the
`en_core_web_lg` spaCy model.) Every later number in this document is compared against
**that** figure, not against any count quoted elsewhere in the programme docs.

## 1. Requirement Analysis

**Type:** feature. **Objective:** a durable, per-consultation orchestrator —
`ConsultationLoopWorkflow` — implementing **deterministic subscriptions only**. The
reasoning layer (LLM planner, specialists, adjudication) is TASK-664 and is deliberately
**not** built here.

Scope, per execution-plan §"TASK-662":

1. New workflow type in `apps/harness/src/harness/temporal/workflows.py`, id
   `consultation-loop-{consultationId}`, idempotent-on-start.
2. `fetch_loop_config` activity pins `(contextSchemaVersionId, agentConfigVersionId)` at
   start. **Never re-read mid-run** (C1).
3. Signals `contextAdded`, `consultationEnding`, `cancel`; query `state()`.
4. An **action registry** including `livedoc.start` / `livedoc.stop` →
   `LiveDocumentationService.start/stop` as **activities**.
5. `harness.finalize` starts `HarnessDocWorkflow` as an **unmodified child** with an
   explicit `ParentClosePolicy`.
6. Planned `continue_as_new` checkpoints; `ClaimCheckRef` for payloads.
7. Signal safety: `asyncio.Lock`, `@workflow.init`, never an activity from a handler.
8. Register in `worker.py`.
9. New replay fixture captured via `_capture_replay_fixture.py`, asserted in
   `test_replay_compat.py`.

### 1.1 Must not change

- `HarnessDocWorkflow`'s body (C2 — ~10 live `workflow.patched` eras + 12 replay fixtures).
- `LiveDocumentationService` internals (§3.4 / §4.4 of the parent).
- `packages/agentic-sdk-v2/src/compat.ts`, `src/compat/**`.
- No Prisma migration — TASK-658 and TASK-659 already shipped every model needed.

### 1.2 Concurrency boundary

TASK-663 (agent promotion) runs in a parallel worktree and owns
`packages/applications/src/services/departmentAgent/**` plus new promotion models. This
ticket does not touch that folder: the gateway-side loop-config resolver lives in
`packages/applications/src/services/consultation/loop/` (the folder TASK-660 created) and
reads `DepartmentAgent*` state through **domain repositories**, never through
`DepartmentAgentService`.

## 2. Current State Evaluation

Verified against `dev-2.1` @ `39f210ab7`.

### 2.1 What TASK-660 already built (the seam this ticket plugs into)

| Direction | Surface | Status |
|---|---|---|
| gateway → harness | `POST {HARNESS_URL}/api/v1/internal/workflows/:id/signal/context-added` | Caller shipped (`HarnessGatewayService.signalContextAdded`); **receiver did not exist** — TASK-660 §7 names it as this ticket's job |
| harness → gateway | `POST /api/v1/internal/harness/consultations/:id/loop-event` | Both sides shipped; the `client.emit` action's target |
| client | `GET /api/v1/consultations/:id/loop/stream` (SSE, `consultation:loop:{id}`) | Shipped |
| flag | `HARNESS_LOOP_ENABLED` (plain `ConfigService` read, default OFF) | Shipped; gates the outbound signal |

### 2.2 Harness Temporal substrate

- `workflows.py` (1,547 lines) holds `HarnessPingWorkflow` and `HarnessDocWorkflow`.
  `HarnessDocWorkflow` carries the patch eras `task-345-harness-progress`,
  `task-348-failure-terminal`, `task-355-optimistic-delivery`,
  `task-355-assurance-signals`, `task-458-gate-terminal-abandon`,
  `task-458-edit-rerun-cap`, `task-481-optimistic-retraction`, `task-516-mcp-tools`,
  `task-551-redaction`, `task-551-redaction-audit`, `task-553-assemble-reuse`.
- `test_replay_compat.py` asserts **12** frozen histories against the current definition.
- `claim_check.py` is complete and generic (`ClaimCheckRef`, `maybe_offload`, `resolve`,
  `should_offload`) — this ticket reuses it rather than adding anything.
- `worker.py:246-247` is the single registration point.
- `internal.py` exposes `document:start`, `signal/approve`, `signal/edit`, all guarded by
  `require_service_token` and all resolving the workflow id from a pure helper
  (`_workflow_id`).

### 2.3 Corrected premise — `ParentClosePolicy`

The spec states the default is `ABANDON` and would orphan the child. Verified against the
installed SDK (`temporalio 1.30.0`):

```
start_child_workflow parent_close_policy default: ParentClosePolicy.TERMINATE (1)
```

So the untouched default is the *opposite* hazard: a parent that finishes or is cancelled
would **hard-terminate** an in-flight `HarnessDocWorkflow`, potentially mid-`persist_draft`.
The remedy is the same and is what this ticket does — set the policy **explicitly** — but
the reason is recorded here rather than propagating the incorrect premise.

### 2.4 Config sources for the pin

- `ConsultationContextSchemaVersion` (TASK-658) — resolved through the DEPARTMENT-then-
  TENANT default cascade, servable only when `pinnedVersionNumber != null` and the schema
  is `PUBLISHED`/`APPROVED`.
- `DepartmentAgentVersion` (TASK-659) — immutable snapshot of the seven loop-config fields
  (`role`, `subscribedKinds`, `writeScope`, `goal`, `guardrailProfile`, `alwaysActions`,
  `neverActions`), written on change; `findLatestForAgent` is the reader.

## 3. Implementation Plan

### 3.1 TDD list → the property each test locks

| # | Property | Test |
|---|---|---|
| 1 | Config pinned at start; a mid-run edit does not affect the running consultation | `test_consultation_loop_workflow.py` |
| 2 | Duplicate `contextAdded` is idempotent | ″ |
| 3 | Cascade terminates at the depth cap | ″ |
| 4 | Budget exhaustion **degrades** rather than aborts | ″ |
| 5 | `continue_as_new` preserves state across the checkpoint | ″ |
| 6 | Cancel stops child workflows (proves `ParentClosePolicy`) | ″ |
| 7 | A signal arriving during a long activity cannot corrupt loop state | ″ |
| 8 | **Existing `HarnessDocWorkflow` replay fixtures pass unchanged** | `test_replay_compat.py` (12 pre-existing cases, untouched) |
| 9 | The new workflow replays from its own fixture | `test_replay_compat.py` (new case) |

### 3.2 File order

1. `apps/harness/src/harness/temporal/models.py` — loop payloads (additive only).
2. `apps/harness/src/harness/temporal/activities.py` — `fetch_loop_config`,
   `livedoc_start`, `livedoc_stop`, `emit_loop_event`; `LOOP_ACTIVITIES`.
3. `apps/harness/src/harness/services/api_client.py` — the three new gateway calls.
4. `apps/harness/src/harness/temporal/workflows.py` — `ConsultationLoopWorkflow` **appended**;
   `HarnessDocWorkflow` untouched.
5. `apps/harness/src/harness/temporal/worker.py` — registration.
6. `apps/harness/src/harness/api/endpoints/internal.py` — the three signal routes.
7. Tests + replay fixture.
8. Gateway side: `LoopConfigService` + two LiveDoc dispatch routes.

## 4. Implementation Summary

_(filled in below as stages land)_

## Change History

- 2026-08-12 — Ticket opened; README authored as the first action per execution-plan §1.3.
