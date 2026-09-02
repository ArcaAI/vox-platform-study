# TASK-718 — Versioning / patch strategy for interpreter upgrades (Task 2)

**Status:** DRAFT, single-pass author review (no second T4 agent available this session).

## Two independent axes

### Axis 1 — the definition version (data, not code)

Pinned per run (S-3). `InterpreterInput.workflowVersionId` + the `ClaimCheckRef` to its
`compiledConfig` are captured once, at `start_workflow`, and never re-resolved. A tenant
publishing a new version of the same `WorkflowDefinition` has **zero effect** on any run already
in flight — the new version gets a new `workflowVersionId`, and only a *future* `start_workflow`
call can reference it.

**Invariant this axis depends on:** *the number and order of Temporal commands the interpreter
issues is a function of the pinned `compiledConfig` alone, which is immutable once loaded.* This
holds because:

- The workflow body never re-fetches or re-validates `compiledConfig` after the initial
  `interpreter.load_config` activity call (one `execute_activity` command, always).
- Stage/node iteration is a deterministic walk over `compiledConfig.stages` (a plain list) — same
  input, same command sequence, every time, on every replay.
- Nothing in the walk consults wall-clock, randomness, or an environment variable to decide
  whether to dispatch a node (§ Determinism facts, README §2) — the loop's branching is entirely a
  function of `compiledConfig` + the workflow's own accumulated node results (which are themselves
  recorded in history).

So: a different `compiledConfig` is DATA. Two different tenants' runs, or two different versions
of the same tenant's workflow, replay independently and correctly with the SAME interpreter code,
because the command sequence a compiled config of shape X produces is always shape X's sequence —
never a function of interpreter code changing between publish and run.

### Axis 2 — the interpreter code (command-sequence stability)

Changing `workflow.py`'s dispatch loop changes the command sequence for **already-recorded**
histories replaying under the new code. Rules, in order of how invasive the change is:

1. **New node type, additive only.** Adding an entry to `NODE_REGISTRY` needs no patch gate,
   PROVIDED the new type only ever appears in `compiledConfig`s compiled after the deploy (true by
   construction — the compiler on the TypeScript side cannot emit a `type` its own registry
   doesn't know, and that registry is versioned independently via `registryChecksum`). An
   in-flight run's pinned config was compiled before the new type existed, so it never references
   it, so the new registry entry is never consulted during that run's replay — no command-shape
   change for any history that matters.
2. **A node's `activity` target changes** (the registry entry for an EXISTING `type` now points at
   a different Python callable). This changes the identity of the `execute_activity` command for
   every future dispatch of that node type, but **does not change the recorded history of an
   already-completed dispatch** (the command was already recorded with the OLD activity's name;
   `execute_activity` records the activity type name as part of the command, and a replay compares
   against exactly that recorded name — see the SDK's own history-comparison semantics). The
   danger is a run **paused mid-flight** (parked at... nothing, actually — v1 has no
   `wait_condition`, so there is no "paused" state for this workflow type; every run either
   completes a stage's dispatch or is actively executing it). Given v1's shape (no gates, no
   long-lived waits), an activity-target change is safe UNGATED for any run that has not yet
   reached that node's stage at deploy time, and moot for any run that has already passed it. This
   is a genuine simplification versus `HarnessDocWorkflow` (which DOES have long-lived gate waits,
   hence its eleven patch eras) — the interpreter's own patch burden should stay near zero as long
   as v1's "no gates, no waits" shape holds. **The day gates land (TASK-731), this reasoning
   changes and gate-adjacent activity retargeting will need real patch gates — flag this
   explicitly for that ticket.**
3. **Add a stage-level command** (something dispatched once per stage rather than once per node —
   e.g. a future stage-boundary checkpoint activity). This DOES change the command sequence for
   every history, in-flight or not, the moment it ships ungated. Needs
   `workflow.patched("task-XXX-<slug>")`, following the "cheap operand first" idiom
   (`workflows.py:767-780`): gate it as `<condition> and workflow.patched(...)`, where
   `<condition>` is something that is `False` on every pre-existing recorded history (e.g. a new,
   additive-optional field on `InterpreterInput` defaulting such that old histories always
   evaluate the gate to `False`) — so `workflow.patched` is never even CALLED when replaying an
   old history, exactly the idiom's point.
4. **Change retry defaults** (the module constants in `caps.py`, or the fallback `RetryPolicy` used
   when a node's compiled `retry` is absent). Per the codebase's own stated rule
   (`workflows.py:163-166`): *"adding/changing an activity OPTION does not alter the recorded
   command sequence, so this is replay-safe and needs NO `workflow.patched()` gate."* A
   `RetryPolicy`/timeout value is an activity OPTION, not a command-identity field — **no gate
   needed**, same as the harness's own `_INFERENTIAL_HEARTBEAT_TIMEOUT` precedent.
5. **Change the claim-check hop** (e.g. switch `interpreter.load_config` to also fetch a second
   ancillary blob). Per S-2/claim-check's own replay posture (`claim_check.py` docstring, README
   §2 "Claim-check: verified API"): ref fields are additive-optional and the fetch happens INSIDE
   an existing activity, so — **no new `execute_activity` command, no gate**, UNLESS the change
   adds a whole SECOND `execute_activity` call (a new activity invocation site in the workflow
   body) rather than widening what one existing activity call does internally. Widening
   `interpreter.load_config`'s own internals: no gate. Adding a second, separate
   `execute_activity("interpreter.load_secondary_config", ...)` call: gate required (case 3's
   rule — it is a stage-level-equivalent new command).

## Addendum (2026-08-19) — gates landed; what rule 2 asked to be revisited

Axis 2 rule 2 ends: *"**The day gates land (TASK-731), this reasoning changes and gate-adjacent
activity retargeting will need real patch gates — flag this explicitly for that ticket.**"*
Gates have landed. What actually changed, and what did not:

- **v1's "no long-lived waits" premise is now false for consultation graphs only.** A run parked
  at `consultation.hitlGate` sits in `workflow.wait_condition` for up to the tenant's gate SLA
  (default 24h, then an escalation ladder). Rule 2's argument — "no history is ever mid-dispatch
  of that node across a deploy boundary" — no longer holds for anything the GATE touches.
- **But the wait is not in this workflow type.** It lives in `ConsultationGateWorkflow`, a
  separate `@workflow.defn` started as a child. `WorkflowInterpreter`'s own history records one
  `start_child_workflow` command and then its result — it is not itself parked. So rule 2 stays
  true as written for every node type dispatched as an ACTIVITY, and the new exposure is
  confined to the child's own type.
- **Retargeting `ConsultationGateWorkflow`'s activities DOES need a patch gate.** `fetch_policy`,
  `escalate_gate` and `record_gate_decision` are called across a wait that can span days, so a
  deploy landing mid-wait replays a history recorded under the old code. Treat any change to that
  workflow's command sequence as rule 3, not rule 2 — the same discipline `HarnessDocWorkflow`'s
  eleven patch eras exist for, and the reason its gate loop was mirrored there rather than edited.
- **The interpreter's own new command shipped under rule 3**, marker `task-731-hitl-gate`, gated
  cheap-operand-first as `config.gates and workflow.patched(...)`. The cheap operand is *provably*
  False on every pre-existing history: until Phase B, `parse_and_verify` refused any config whose
  `gates` was not `[]` (`gates_not_supported_v1`), so no admitted run can ever have carried one
  and `workflow.patched` is never called when replaying an old history.

| # | Change class | Patch gate required? | Why |
|---|---|---|---|
| 6 | Change `ConsultationGateWorkflow`'s command sequence (its activities, their order, the ladder shape) | **Yes** | The wait can span days; a deploy lands mid-history. Rule 3 discipline, not rule 2 |
| 7 | Add a second gate kind, or a non-blocking gate | **Yes**, and admission must widen with it | `parse_and_verify` refuses both today (`too_many_gates`, `non_blocking_gate_not_supported`) — a loud refusal, not a silent walk-past |

## Escape hatch — a new workflow type

For a change too invasive to gate cleanly (the interpreter's dispatch shape itself needs to
change — e.g. moving from "linear stages + fan-out" to a general DAG, which R-2 already flags as
plausible pressure from STT/consultation palettes): start `WorkflowInterpreterV2` as a **new**
`@workflow.defn` type, exactly the precedent recorded at `workflows.py:1611-1614` for why
`ConsultationLoopWorkflow` was added as a new type rather than an edit to `HarnessDocWorkflow`. A
type with no recorded histories has no era to stay compatible with. The dispatcher (Task 10)
routes NEW runs to the new type by version-selecting at start time; existing in-flight
`WorkflowInterpreter` (v1) runs are unaffected and continue on the old type until they complete —
this is the same "in-flight runs pin their version" property from Axis 1, applied one level up (to
the interpreter's own type, not just the tenant's config).

## Change-class → gate-required matrix (Task 2's required table)

| # | Change class | Patch gate required? | Why |
|---|---|---|---|
| 1 | Add a new node type to `NODE_REGISTRY` | **No** | Additive; unreferenced by any already-compiled config (Axis 2 rule 1) |
| 2 | Change an existing node type's `activity` target | **No**, for v1's no-gate/no-wait shape (re-evaluate once TASK-731 gates land) | No history is ever mid-dispatch of that node across a deploy boundary (Axis 2 rule 2) |
| 3 | Add a stage-level command (new `execute_activity` call in the shared per-stage loop) | **Yes** — `workflow.patched("task-XXX-<slug>")`, cheap-operand-first | Changes the command sequence for every replaying history (Axis 2 rule 3) |
| 4 | Change retry/timeout defaults (module constants) | **No** | Activity option, not command identity (Axis 2 rule 4, `workflows.py:163-166`) |
| 5 | Change the claim-check hop inside `interpreter.load_config` | **No**, if it stays inside that one activity's internals; **Yes**, if it adds a second `execute_activity` call | Additive-optional field widening vs. a genuinely new command (Axis 2 rule 5) |

## Fixture discipline (Task 9's mandate, restated as policy)

Every gate added under rule 3 above ships with a NEW fixture captured under the new era
(`_capture_replay_fixture.py`'s pattern, adapted for the interpreter — see Task 9). The very
first fixture (`interpreter_v1_history.json`) is captured **before** this ticket ships, not after
the first real change — the whole point named in the ticket's own §1 item 4 ("Replay-compat
discipline from run #1"). A future agent adding a stage-level command without also adding a
fixture is the exact failure this document exists to prevent.
