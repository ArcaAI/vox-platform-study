# TASK-685 — `ConsultationLoopWorkflow` lifecycle bounds

| | |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix |
| **Branch base** | `dev-2.1` @ `40c935cb6` |
| **Owns** | `apps/harness/**`, one additive settings descriptor + its gateway resolution |
| **Prerequisite for** | TASK-686 (which flips `config.enabled` true for the first time and exposes this defect) |

---

## 1. Requirement Analysis

`ConsultationLoopWorkflow.run` parks on an **unbounded** `wait_condition`:

```python
while True:
    await workflow.wait_condition(
        lambda: bool(self._pending) or self._ending or self._cancelled
    )
```

There is no timeout. A consultation that never sends `consultation-ending` or
`loop-cancel` leaves this workflow RUNNING forever. It is not a hypothetical
second exit either: `signalLoopCancel` has **no production caller** — TASK-683
concluded that wiring it to `close()` is unsafe, because a `_cancelled`-before-
`_ending` race would skip finalize and lose the clinical note. So today, once
started, the only reliable way this workflow ends is an explicit
`consultation-ending`.

Two things sharpen the defect.

**The file already demonstrates the correct pattern.** `HarnessDocWorkflow`'s
clinician gate (`workflows.py:1530-1554`) bounds its own wait with
`timeout=timedelta(seconds=deadline)`, catches `TimeoutError`, escalates, and
terminates at a declared bound — all behind the `task-458-gate-terminal-abandon`
patch era. That is the shape to follow.

**The DISABLED branch's own comment states the intent this ticket restores.**
`workflows.py:2015-2020`:

> ```
> # TASK-654 K7: a consultation with no loop configured (or whose
> # config could not be resolved) behaves EXACTLY as it does today.
> # Completing immediately is the correct expression of that: an idle
> # workflow parked forever would be a resource leak that changes
> # nothing about the consultation.
> ```

The DISABLED branch refuses to park forever *on those exact grounds*. The
ENABLED path then does precisely what that comment warns against. This is the
clearest statement of intent available and it is already in the codebase.

Today the defect is masked because `config.enabled` is false in every
environment. TASK-686 removes the mask.

### Acceptance criteria

1. An idle loop terminates at a bound rather than parking.
2. The terminal state is queryable and distinguishable from `CANCELLED` and from
   normal completion.
3. A loop that keeps receiving events before the bound does **not** terminate.
4. The bound is read from the **pinned** config (`fetch_loop_config`), never
   mid-run; a settings change during a consultation does not affect it (C1).
5. The timeout emits an observable signal exactly once.
6. All 24 existing replay tests pass unchanged; the change sits behind a new
   `workflow.patched` era with its own frozen fixture.

---

## 2. Current State Evaluation

| Concern | Today |
|---|---|
| Loop exit paths | `consultation-ending` (→ `DONE`) · `loop-cancel` (→ `CANCELLED`, no production caller) · `enabled=false` (→ `DISABLED`, immediate) |
| Wait | `workflow.wait_condition(...)` — no `timeout` |
| Terminal phases | `DISABLED`, `CANCELLED`, `DONE` |
| Config plane | `ConsultationLoopConfig`, pinned once by `_pin_config`, carried through every `continue_as_new` in `ConsultationLoopWorkflowInput.pinned_config` |
| Loop kill-switch | `harness.loop.enabled`, tier `global-kv` (TASK-679) — env config for this plane was deliberately removed |
| Replay guard | 2 frozen fixtures of this type (`consultation_loop_task662_history`, `consultation_loop_task664_reasoning_history`) inside a 24-test replay suite |
| Live patch eras on this type | `task-664-reasoning` |

TASK-664 established the rule that governs this ticket: *"a new workflow type
needs no `workflow.patched` era"* **stopped being true the moment a fixture of
that type was frozen** (`workflows.py:1716-1738`). Any behaviour change here
must be patch-gated.

---

## 3. Timeout semantics — the decision and the argument

Two candidate semantics:

**(a) Abandonment** — terminal, ending actions are NOT run.
**(b) Degraded end-of-consultation** — run `config.ending_actions` as if
`consultation-ending` had arrived.

**Chosen: (a) abandonment.**

### Why not (b)

`ending_actions` is, in every real configuration, `['livedoc.stop',
'harness.finalize']` (`LoopConfigService.deriveStartAndEndingActions`).
`harness.finalize` starts `HarnessDocWorkflow` as a child — which generates a
clinical note from whatever partial context happened to arrive, persists it, and
opens a clinician gate with a 24-hour SLA and a WORM audit record.

So (b) means: *because nobody told us the consultation ended, fabricate a
clinical note from a truncated transcript and put it in a clinician's review
queue.* That is inventing work nobody asked for, and it does it in the one part
of this platform where the artifact is a durable, audited clinical document. A
note that exists is much harder to reason about than a note that does not: it
can be signed, it appears in queues and dashboards, and its provenance ("we
guessed the consultation was over") is not visible on the artifact itself.

### Why (a) does not skip work a clinician is waiting on

The symmetric risk — a timeout silently skipping work someone is waiting on — is
not present here, for three reasons:

1. **The finalize path is a reflex to an explicit signal.** The loop only
   finalizes on `consultation-ending`. If that signal never arrived, nobody
   asked the loop to produce anything. The gateway's own summarization path is
   untouched by all of this; TASK-654 K7 is explicit that a consultation without
   a working loop behaves exactly as it does today.
2. **The bound only fires on TOTAL silence.** Not "no ending signal" — no
   context items either. During a live consultation the STT/LiveDoc lane feeds
   `contextAdded` continuously, and every arrival restarts the bound. Reaching
   it means the session is gone.
3. **It is not silent.** The run ends in an explicit terminal phase, sets a
   dedicated result field, and publishes an event on the client/ops feed
   (§4.3). An operator sees "this loop timed out", not an inferred absence.

### Why abandonment, not cancellation

The existing `cancel` signal already means exactly this — *"Stop WITHOUT running
the ending actions (the consultation was abandoned)"* (`workflows.py:1972`). A
timeout **is** an abandonment; the only difference is that nobody told us, we
inferred it. So the behaviour matches `cancel`, but the two must not be
conflated in the record: one is an operator/gateway decision, the other is a
platform bound firing. Hence a distinct terminal phase `TIMED_OUT` and a
distinct `timed_out` flag, rather than reusing `cancelled`.

### The race, and which way it fails

`wait_condition(..., timeout=T)` can raise `TimeoutError` at the same instant a
signal lands. On `TimeoutError` the loop therefore **re-checks the condition**
before concluding a timeout; if there is pending work, or an ending, or a
cancel, it falls through to the normal path. The failure direction is always
"there is work" and never "abandon" — which is the same asymmetry TASK-683 used
to reject wiring `signalLoopCancel` to `close()`.

### The bound value

Default **14400 s (4 hours)**. Longer than any plausible in-session silence
(a full clinic session with examinations and interruptions), far shorter than
"forever". It is a knob, not a constant, because how long a department's
consultations can legitimately go quiet is a property of the department, not of
this code.

---

## 4. Implementation Plan

### 4.1 Configuration — settings registry, not env (TASK-679 posture)

`harness.loop.idleTimeoutSeconds`, tier **`global-kv`**, `dataType: 'number'`,
`failMode: 'open-to-default'` (a tuning knob, not a selection), `maxScope:
'system'`, `globalOnly: true`. It is **not** a kill-switch, so it does not join
`CONSULTATION_GATE_SETTINGS`; it gets its own two-descriptor-file-sized module
and one registration line.

Reasons this cannot be an env var, restated from
`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers: it is not
required to reach the database or authenticate to Vault (the bootstrap floor),
and §9.2 L1 — env vars are immutable for the process lifetime, so anything an
operator must be able to change without a redeploy is not an env var.

### 4.2 How it reaches the workflow without breaking determinism (C1)

```
GlobalSetting row (global-kv)
  → LoopConfigService.resolveForConsultation  (TenantSettingsService.resolvePlatform)
  → LoopConfigResponse.idleTimeoutSeconds
  → GET /internal/harness/loop-config
  → fetch_loop_config activity                (the ONCE-only pin)
  → ConsultationLoopConfig.idle_timeout_seconds
  → carried in ConsultationLoopWorkflowInput.pinned_config across continue_as_new
```

The workflow body reads `config.idle_timeout_seconds` **once**, before the wait
loop, and never re-reads it. A mid-consultation settings write is therefore
invisible to a running loop — the same guarantee the whole pinned-config design
already provides for subscriptions, budgets and the agent roster.

### 4.3 Workflow change (patch era `task-685-idle-timeout`)

```python
idle_bound: timedelta | None = None
if (
    config.idle_timeout_seconds
    and config.idle_timeout_seconds > 0
    and workflow.patched(_PATCH_IDLE_TIMEOUT)
):
    idle_bound = timedelta(seconds=config.idle_timeout_seconds)
```

Two properties make the frozen fixtures stay green, and both are needed —
exactly the TASK-664 construction:

1. `idle_timeout_seconds` defaults to `None` on `ConsultationLoopConfig`, so a
   config recorded before this ticket deserialises with **no bound**.
2. The config operand comes **FIRST**, so on those histories `workflow.patched`
   is never CALLED, no marker is looked for, and no marker is recorded.

And one property makes the un-patched path command-identical rather than merely
marker-free: `timeout=None` issues **no timer**. Verified in
`temporalio/worker/_workflow_instance.py:1810-1813` — `workflow_wait_condition`
bottoms out in `asyncio.wait_for(fut, timeout)`, and `asyncio.wait_for(fut,
None)` awaits without scheduling anything. So the bounded and unbounded forms
can share ONE call site, and the unbounded one records byte-identical commands.

New terminal phase `TIMED_OUT`; new `timed_out: bool` on both
`ConsultationLoopState` (the `state()` query) and
`ConsultationLoopWorkflowResult`; one `emit_loop_event` publish of the new
`loop.timed_out` kind, emitted immediately before the `break` so it fires
exactly once.

### 4.4 TDD test list

| # | Test | File |
|---|---|---|
| 1 | An idle loop terminates at the bound (`timed_out`, phase `TIMED_OUT`) instead of parking | `test_loop_lifecycle_bounds.py` |
| 2 | The terminal phase is queryable and distinguishable from `CANCELLED` and from normal `DONE` | same |
| 3 | A loop receiving events + an ending before the bound does NOT time out | same |
| 4 | The bound comes from the PINNED config; reprogramming the resolver mid-run changes nothing | same |
| 5 | The `loop.timed_out` event is emitted exactly once | same |
| 6a | The 24 existing replay tests pass unchanged | `test_replay_compat.py` |
| 6b | A new frozen fixture for the patched era replays on the current definition | `test_replay_compat.py` |
| 7 | Abandonment, not degraded-ending: ending actions do NOT run on timeout | `test_loop_lifecycle_bounds.py` |
| 8 | Gateway: the descriptor is registered `global-kv`, resolves from the platform row, and falls back to the code default | `packages/applications` |

### 4.5 File order

1. `apps/harness/src/harness/temporal/models.py` — constant + three additive fields
2. `apps/harness/src/harness/temporal/workflows.py` — patch era + bounded wait
3. `apps/harness/src/harness/temporal/activities.py` — parse `idleTimeoutSeconds`
4. `.../tests/unit/temporal/test_loop_lifecycle_bounds.py` — the RED tests
5. `.../tests/unit/temporal/_capture_replay_fixture.py` + the new fixture
6. `.../tests/unit/temporal/test_replay_compat.py` — the new era's replay test
7. `packages/applications/.../loop/loop-lifecycle.constants.ts` (key + default)
8. `packages/applications/.../settings-registry/descriptors/harness-loop.descriptors.ts` + `registry.ts`
9. `packages/applications/.../loop/dto/loop-config.response.ts` + `loop-config.service.ts` + its module

---

## 5. Implementation Summary

_(filled in below as the work lands)_

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Ticket opened; plan + timeout-semantics argument recorded. |
