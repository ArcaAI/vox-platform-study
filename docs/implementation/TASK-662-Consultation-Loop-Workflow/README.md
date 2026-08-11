# TASK-662 — `ConsultationLoopWorkflow`

**Status:** Review

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

### 4.1 The workflow

`ConsultationLoopWorkflow` (`temporal/workflows.py`, appended below the frozen
`HarnessDocWorkflow`). Id `consultation-loop-{consultationId}` from the pure helper
`consultation_loop_workflow_id`.

| Concern | How |
|---|---|
| **Config pinning** | `fetch_loop_config` runs on the FIRST execution only. The resolved `ConsultationLoopConfig` is then carried in `ConsultationLoopWorkflowInput.pinned_config` through every `continue_as_new`, so a continued execution short-circuits `_pin_config` entirely. The pin therefore holds for the whole consultation, not merely until the first checkpoint. |
| **Signals** | `contextAdded`, `consultationEnding`, `cancel` — all `async`, all taking one `asyncio.Lock`, none calling an activity. `@workflow.init` feeds `__init__` the run arguments so a signal delivered WITH the start mutates a fully-constructed instance. |
| **Query** | `state()` → `ConsultationLoopState`. |
| **De-duplication** | Keyed `{contextItemId}:{occurredAt}` — the same identity `LoopContextSignalService` already uses gateway-side, so a re-emit with a fresh timestamp (OCR enrichment) is correctly a NEW event. Bounded at 2,000 keys, oldest evicted, carried across checkpoints. |
| **Cascade termination** | `depth >= budget.max_depth` ⇒ one `action.skipped` / `depth_cap` per capped item. |
| **Budget** | `actions_dispatched >= budget.max_actions` ⇒ `degraded = True` and `action.skipped` / `budget_exhausted`; the run keeps going and keeps accepting events. Lifecycle actions are counted but never blocked — stopping LiveDoc and finalizing must happen even on a run that overspent. |
| **Checkpointing** | `_should_checkpoint()` fires only at a quiet moment (nothing pending, not ending/cancelled, no child in flight) on either `checkpoint_signal_threshold` (default 500 accepted events per execution) or `is_continue_as_new_suggested()` / `checkpoint_history_events` (default 10,000). Both sit well under Temporal's 51,200-event / 50 MB ceilings, so a checkpoint is always planned rather than forced. |
| **Claim check** | `ContextAddedSignal.text_ref` and `LoopFinalizeRequest.transcript_ref` are additive-optional `ClaimCheckRef`s on the existing generic machinery in `claim_check.py`; nothing new was added there. |

### 4.2 Action registry

`LOOP_ACTION_REGISTRY: dict[str, LoopActionSpec]` covers all seven canonical keys —
the registry is validated in test against TASK-659's `AGENT_ACTION_KEYS`, because an
agent's `alwaysActions` may name any of them.

| Key | Backed by | Status |
|---|---|---|
| `livedoc.start` | `livedoc_start` activity → `POST internal/harness/consultations/:id/live-documentation/start` → `LiveDocumentationService.start` | ✅ |
| `livedoc.stop` | `livedoc_stop` activity → `.../live-documentation/stop` → `LiveDocumentationService.stop` | ✅ |
| `client.emit` | `emit_loop_event` activity → TASK-660's `POST .../loop-event` → `consultation:loop:{id}` SSE | ✅ |
| `harness.finalize` | `HarnessDocWorkflow` as an unmodified CHILD | ✅ |
| `vision.extract_text` | — | declared, `implemented=False` |
| `document.extract_text` | — | declared, `implemented=False` |
| `nlp.extract_entities` | — | declared, `implemented=False` |

`implemented` is part of the registry rather than expressed by omission on purpose: an
unbacked key dispatches as an OBSERVABLE `action.skipped` / `unsupported_action`, never a
silent no-op — which on a client feed is indistinguishable from success. The three
unbacked keys are TASK-664's deliberative lane; this ticket is the mechanical one.

**LiveDoc's internals are untouched.** The two new gateway routes call its existing
public `start()`/`stop()` only. Nothing about the flush rate, the
generation-counter/`AbortController` supersede machinery, or the prompt-byte sha256
test was read or altered.

### 4.3 Child finalize — two policies, both explicit, one of them a correction

```python
handle = await workflow.start_child_workflow(
    HarnessDocWorkflow.run, child_input, id=f"harness-doc-{consultation_id}",
    parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
    cancellation_type=workflow.ChildWorkflowCancellationType.TRY_CANCEL,
)
```

- **`ParentClosePolicy`** — the spec says the default is `ABANDON` and would orphan the
  child. Measured against temporalio 1.30.0 the default is **`TERMINATE`**, i.e. the
  opposite hazard: a parent that completes or is cancelled would hard-kill an in-flight
  document workflow, possibly mid-`persist_draft`. `REQUEST_CANCEL` propagates a
  cancellation the child can wind down from.
- **`ChildWorkflowCancellationType`** — not in the spec, and it turned out to matter more
  than the close policy. The default `WAIT_CANCELLATION_COMPLETED` (and also
  `WAIT_CANCELLATION_REQUESTED`) left the parent **RUNNING indefinitely** after
  `cancel()`, even though its history showed the child's cancel both initiated
  (`REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED`) and delivered
  (`EXTERNAL_WORKFLOW_EXECUTION_CANCEL_REQUESTED`). `TRY_CANCEL` issues the same request
  and resolves the await immediately.
- **The loop AWAITS the child.** That couples the lifetimes, which is what makes
  `REQUEST_CANCEL` safe: a completed loop implies a completed finalize. Starting the
  child and returning would make the close policy actively harmful — the loop's own
  normal completion would cancel the note it had just asked for.
- A child that was **cancelled** is re-raised as cancellation so the loop ends `CANCELED`
  rather than hiding the abort behind a `COMPLETED` status; a child that genuinely
  **failed** only degrades the loop, because a failed document workflow is its own
  recorded outcome with its own remediation.

### 4.4 Signal receivers (`api/endpoints/internal.py`)

TASK-660 §7 recorded that the receiver for its outbound signal did not exist and was this
ticket's job.

| Route | Shape |
|---|---|
| `POST /workflows/{id}/signal/context-added` | **Signal-with-start** — the first context item brings the loop into existence; a second call signals the running loop rather than racing a duplicate. Requires `tenantId`. Degrades to a memo-only start when the `HarnessTenantId` search attribute is unregistered, exactly as `start_document` does. |
| `POST /workflows/{id}/signal/consultation-ending` | Plain signal; carries the `LoopFinalizeRequest` the child is started from. |
| `POST /workflows/{id}/signal/loop-cancel` | Plain signal. Named `loop-cancel`, not `cancel`, so it is never confused with Temporal cancellation — the workflow COMPLETES, it does not fail. |

**A wire-contract defect found and fixed while doing this.** `HarnessGatewayService`
sends `{tenantId, contextItemId, contextType, subType?, contentPreview?}` — no `kindKey`,
no `occurredAt`, no `depth`. The receiver therefore treats all three as
additive-optional and resolves `kindKey` as `kindKey → subType → contextType`, so an
un-upgraded gateway still routes against something instead of matching no subscription
at all. Separately, the loop-event publish body had to be reshaped to exactly TASK-660's
`HarnessLoopEventRequest` (`tenantId`/`runId`/`kind`/`label`/`data`): the gateway's global
pipe runs `forbidNonWhitelisted`, so the loop's own fields ride the declared `data`
envelope. Sent as top-level keys they would have 400'd every publish in production.

### 4.5 Gateway side

`LoopConfigService` (`packages/applications/src/services/consultation/loop/`) resolves the
pinnable config: consultation → department → default `DepartmentAgent` → latest
`DepartmentAgentVersion` → servable `ConsultationContextSchemaVersion` (DEPARTMENT-then-
TENANT cascade, servable only when pinned and `PUBLISHED`/`APPROVED`), then per-kind
primitive→action mapping with the `alwaysActions` / `neverActions` envelope. Every branch
degrades to a disabled config and nothing throws, so a consultation with no loop
configured behaves exactly as it does today (TASK-654 K7). It reads domain repositories
directly and does **not** touch `departmentAgent/**`, which TASK-663 owns.

`HarnessInternalController` gains `GET loop-config` plus the two live-documentation
dispatch routes, all re-establishing the CLS tenant before any tenant-scoped read (the
`getEffectivePolicy` precedent — a known recurrence class in this repo).

### 4.6 Files changed

**Harness** — `temporal/models.py`, `temporal/activities.py`, `temporal/workflows.py`,
`temporal/worker.py`, `services/api_client.py`, `api/endpoints/internal.py`;
tests `tests/unit/temporal/_loop_stubs.py` (new),
`tests/unit/temporal/test_consultation_loop_workflow.py` (new, 18 cases),
`tests/unit/api/test_loop_signal_endpoints.py` (new, 10 cases),
`tests/unit/temporal/_capture_replay_fixture.py` (new `--loop` scenario),
`tests/unit/temporal/test_replay_compat.py` (new case),
`tests/unit/temporal/fixtures/consultation_loop_task662_history.json` (new fixture).

**Gateway** — `services/consultation/loop/{ILoopConfigService.ts, loop-config.service.ts,
loop-config.service.module.ts, dto/loop-config.response.ts,
dto/live-documentation-internal.dto.ts, dto/index.ts, index.ts,
__tests__/loop-config.service.test.ts}`;
`apps/api/src/modules/consultation/{harness-internal.controller.ts, consultation.module.ts,
__tests__/harness-internal.controller.test.ts}`.

No Prisma migration. No change to `HarnessDocWorkflow`, `LiveDocumentationService`,
`compat.ts` or `src/compat/**`.

### 4.7 Gate evidence (actual output)

Every Python gate carries the mandatory `PYTHONPATH` prefix (§0).

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
================= 1081 passed, 4 skipped, 1 warning in 27.34s ==================
```

Own measured baseline before any edit: **1052 passed, 4 skipped**. Net **+29**
(18 workflow + 10 endpoint + 1 replay).

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test -k replay
=============== 21 passed, 1064 deselected, 3 warnings in 7.48s ================
```

Baseline on `39f210ab7` was **20 passed** (12 frozen `HarnessDocWorkflow` fixtures in
`test_replay_compat.py` + 8 in `test_gating_consolidation_replay.py`). This run is 21 —
the 20 pre-existing cases pass **unchanged** and the new
`consultation_loop_task662_history` case is the +1. Note that `pnpm harness:test -- -k replay`
does NOT work (pnpm forwards `--` literally, and pytest then treats `-k` as a path);
the working form is `pnpm harness:test -k replay`.

```
$ pnpm harness:lint
All checks passed!

$ pnpm harness:typecheck
Success: no issues found in 96 source files
```

TypeScript gates. The worktree has no `.env.dev` (gitignored, main-tree only), so
`db:generate` needs placeholder `DATABASE_URL`/`DIRECT_URL` — the TASK-660 §5 workaround,
schema-only, no live connection.

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc         (exit 0)

$ pnpm --filter @arcaai/applications test
 Test Files  467 passed | 1 skipped (468)
      Tests  8791 passed | 4 skipped (8795)

$ pnpm api:build
 Tasks:    9 successful, 9 total

$ pnpm lint
@arcaai/vox:lint:          ✖ 3 problems (0 errors, 3 warnings)
@arcaai/domains:lint:      ✖ 13 problems (0 errors, 13 warnings)
@arcaai/applications:lint: ✖ 191 problems (0 errors, 191 warnings)
@arcaai/api:lint:          ✖ 65 problems (0 errors, 65 warnings)
 Tasks:    31 successful, 31 total
```

`apps/api` matches the stated 65-warning baseline exactly. `@arcaai/applications` reads
191 against a quoted figure of 187, but **zero** of those warnings sit in any file this
ticket added or modified (verified by grepping the lint output for `loop/`); since our
files contribute 0, the true baseline on this commit is 191. One prettier warning that
this ticket DID introduce (`loop-config.service.ts:164`) was fixed rather than accepted,
per rule 01's "treat only-warn as errors".

### 4.8 TDD outcomes

| # | Property | Result |
|---|---|---|
| 1 | Config pinned; mid-run edit invisible | ✅ the stub is reprogrammed mid-run and the run keeps dispatching against its pin; `fetch_loop_config` called exactly once |
| 2 | Duplicate `contextAdded` idempotent | ✅ 3 identical deliveries ⇒ 1 processed, 2 ignored, 1 emit |
| 3 | Cascade terminates at the depth cap | ✅ depths 0–3 with `max_depth=2` ⇒ 2 dispatched, 2 skipped `depth_cap` |
| 4 | Budget exhaustion degrades, not aborts | ✅ workflow COMPLETES, consumes all 5 events, `degraded=True`, 2 dispatched, 3 skipped `budget_exhausted` |
| 5 | `continue_as_new` preserves state | ✅ counters, pinned config AND de-dup memory survive; a duplicate first seen before the checkpoint is still refused; config never re-fetched |
| 6 | Cancel stops child workflows | ✅ real `HarnessDocWorkflow` child; parent ends `CANCELED` and the cancel request is recorded in the child's own history — see the caveat below |
| 7 | Signal during a long activity cannot corrupt state | ✅ 10 distinct + 10 duplicate signals fired concurrently while every dispatch sleeps ⇒ exactly 10/10/10 |
| 8 | **Existing `HarnessDocWorkflow` replay fixtures pass unchanged** | ✅ all 12, untouched |
| 9 | New workflow replays from its own fixture | ✅ |

**Caveat on TDD-6, stated rather than papered over.** The test asserts the parent reaches
`CANCELED` and that `WORKFLOW_EXECUTION_CANCEL_REQUESTED` is recorded on the **child's**
history — not that the child reaches a terminal `CANCELED` status. `HarnessDocWorkflow`
wraps several awaits in `except ActivityError`, which is also how an activity cancellation
surfaces, so it can absorb a cancellation at those points and run on to its next
cancellable await. That is a property of the frozen child (C2 forbids changing it), not of
this loop. What the loop owes is the request, and the request is provably issued and
delivered.

## 5. Incomplete / Deferred

- **Three registry keys are declared but unbacked** — `vision.extract_text`,
  `document.extract_text`, `nlp.extract_entities`. Dispatching one is an observable
  `unsupported_action` skip. Wiring the derived-context cascade through them belongs with
  TASK-664's reasoning lane; doing it here would have invented half a cascade with no
  planner to drive it.
- **The gateway does not yet send `kindKey` / `occurredAt` / `depth`** on
  `signalContextAdded`. The receiver tolerates this (fallback chain above), but until
  `HarnessGatewayService` and `LoopContextSignalService` are extended, subscriptions match
  on `subType`/`contextType` rather than the tenant-declared kind key, and de-duplication
  is per-item rather than per-emission. Left alone deliberately: those files sit beside
  TASK-663's parallel worktree and the change is additive on both sides.
- **No caller for `consultation-ending` / `loop-cancel` yet.** Both receivers exist and are
  tested; the gateway methods that would call them are not part of this ticket's scope.
- **`pnpm test:e2e` not run** — not one of this ticket's gates, and no live Postgres/Redis
  stack was available in this worktree.
- **The gateway-side unit tests were not written RED-first.** That half was delegated to a
  parallel agent which wrote its 12 cases immediately after the implementation and
  reported them green on the first run. The harness half — the substance of this ticket —
  was strictly RED-first (the first run failed on `ImportError: cannot import name
  'LOOP_ACTION_REGISTRY'`, and two later cases failed and were fixed).

## Change History

- 2026-08-12 — Ticket opened; README authored as the first action per execution-plan §1.3.
- 2026-08-12 — Implemented across three commits. Corrected two premises from the spec
  (the `ParentClosePolicy` default is `TERMINATE`, not `ABANDON`; and the child
  cancellation TYPE, unmentioned in the spec, was what actually hung the parent). Found
  and fixed a wire-contract defect that would have 400'd every loop-event publish.
