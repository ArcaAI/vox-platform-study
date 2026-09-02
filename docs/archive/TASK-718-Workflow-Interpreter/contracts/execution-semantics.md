# TASK-718 — Interpreter execution semantics (Task 1)

**Status:** DRAFT, single-pass author review only (no second T4 agent was available in this
session — see the ticket README §7 for the honesty note). Mechanism-level, not a clinical-safety
review; the rule *content* it depends on (`DRAFT_SUMMARIZATION_RULE_SET`) is separately gated in
TASK-716's `rule-model.md`.

## 0. Reconciliation notice (R-7 resolved)

This ticket's own risk register (README §6, R-7) anticipated a race: "if TASK-716 has already
shipped a different shape when this starts, Task 1 becomes a reconciliation, not an invention —
check first." That is exactly what happened. **TASK-716 already shipped a complete, tested
`compiledConfig` contract**:

- Schema: `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/compiled-config.schema.json`
  (JSON Schema draft 2020-12, `$id`
  `https://arcaai.dev/hope/workflow-compiled-config.schema.json`).
- Normative rules: `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/README.md`.
- Producer: `packages/workflow-contract/src/compiler.ts` (`compile()`), tested and green
  (125 tests, per that ticket's README §7).

**This document does not re-invent that schema or copy it into a second file.** A third copy is
exactly the failure mode TASK-716's own README warns about ("if [the parity test] is ever
skipped, the format has three implementations again"). Instead, this document is the Python
interpreter's reading of that one schema, plus everything the schema does NOT say (Python-side
node lifecycle, dispatch, degrade semantics, caps posture, signal/query surface, sandbox
contract) — the union of the two documents is Task 1's actual deliverable.

Two corrections this reconciliation makes to the ticket's own Task 1 prose (§4), because the
real, shipped artifact differs from what was guessed before TASK-716 landed:

1. **There is no `edges` array in `compiledConfig`, and there was never going to be one** — but
   the real shape is *closer* to a graph than the ticket's guessed
   `{ id, nodes: [{ id, type, config, timeoutSeconds?, maxAttempts? }] }` sketch: nodes carry a
   pre-resolved `activity` string, a full `retry` policy, `inputs` (edge-derived bindings from the
   graph, informational for v1 — see §3), and `onError`. `gates[]` is a **separate, lifted-out**
   array, not embedded in stages.
2. **Caps are materialized at COMPILE time, not read by the interpreter at run start.** The
   ticket's §4 Task 4 and R-5 describe a `GlobalSetting`-backed `caps.py` the interpreter reads at
   run start. The shipped schema's own normative rule 4 (`contracts/README.md`) is explicit:
   *"Platform ceilings materialized at compile time … applied HERE, not read again at runtime."*
   `compiledConfig.stages[].nodes[].timeoutSeconds` and `.retry` are **already clamped**.
   `compiledConfig.caps` (`maxTotalSeconds`, `maxNodeSeconds`, `maxAttempts`) is the record of
   what ceiling was used, not a value the interpreter re-applies. The interpreter still owns a
   `caps.py` (§4 below) but its job changes: it is a **defense-in-depth re-clamp** against a
   corrupted/tampered/stale compiled config, not the primary enforcement site. This is strictly
   safer than the original plan (one fewer runtime dependency, one more independent check) and is
   adopted here without a design regression.

## 1. `compiledConfig` — how the interpreter reads it

Canonical shape: see the TASK-716 schema linked above. Summary relevant to dispatch:

```
{
  formatVersion: 1,                 // interpreter refuses any other value (§2)
  definitionId, slug, versionNumber, tenantId, paletteKey,
  compiledAt, compilerVersion, registryChecksum, ruleSetVersion,
  stages: [ { stageIndex, nodes: [ NODE, ... ] }, ... ],   // topological LEVELS
  gates: [ GATE, ... ],              // v1: MUST be empty — see §3
  policyBindings: { guardrailProfile, redactionRuleSetId, promptTemplateRefs,
                     contextSchemaVersionId, entitlementKeys },
  caps: { maxTotalSeconds, maxNodeSeconds, maxAttempts },   // record, not input (§0.2)
  checksum,                          // sha256 over canonicalJson of everything above
}

NODE = { nodeId, type, activity, config, timeoutSeconds, retry, inputs, onError, emitsTrajectory }
```

## 2. Config admission (the load-config activity, Task 5)

`interpreter.load_config` (an activity, never the workflow body — S-2) performs, IN ORDER, and
fails LOUD (raises) on any violation — a corrupt/invalid config must fail the run, never execute a
partial graph (ticket §4 Task 5):

1. Dereference the `ClaimCheckRef` via the existing `claim_check.py` (`load_blob`) — integrity
   failure (`ClaimCheckIntegrityError`) or missing blob (`ClaimCheckNotFound`) propagate as-is.
2. Parse as JSON. Malformed JSON → `InterpreterConfigError("malformed_json")`.
3. `formatVersion` must equal `1`. Any other value (including absent) →
   `InterpreterConfigError("unsupported_format_version")` — never a best-effort parse
   (TASK-716 `contracts/README.md` normative rule 3).
4. Recompute `checksum` = sha256 over canonical JSON (RFC 8785-style key-sorted,
   array-order-preserved — the same algorithm as `packages/workflow-contract/src/canonical-json.ts`,
   reimplemented in Python without a third canonical-json library dependency, matching the pattern
   `packages/workflow-contract` itself uses for its own duplication of `canonicalJson` — see that
   package's `src/canonical-json.ts` module docstring) over every field except `checksum` itself.
   Mismatch → `InterpreterConfigError("checksum_mismatch")` (TASK-716 normative rule 4 — "not a
   warning to log and continue").
5. `gates` must be `[]`. A non-empty `gates` array names a palette this interpreter version
   cannot run (HITL gate execution is out of scope — §1 "Out of scope" of the ticket README, owned
   by TASK-731) → `InterpreterConfigError("gates_not_supported_v1")`.
6. Structural bounds from `caps.py` (`MAX_STAGES`, `MAX_NODES_PER_STAGE`, `MAX_TOTAL_NODES`) are
   checked against the parsed config. A config that exceeds them is REJECTED (fail loud), not
   silently truncated — same posture as every other admission check here.

Only a config that survives all six checks is returned to the workflow body.

## 3. `inputs` in v1 — recorded, not wired

`NODE.inputs` (the edge-derived `fromNodeId`/`fromPort`/`toPort` bindings) is present in the
compiled artifact because the compiler derives it from the authored graph unconditionally — it is
not palette-specific. **The v1 interpreter does not thread node outputs through `inputs` bindings.**
Every activity that needs a prior node's output receives it because `config` already carries
whatever the compiler baked in (literal values, prior-step references resolved by the tenant's
palette authoring flow) — the same posture `HarnessDocWorkflow` uses today (each activity's input
dataclass is fully populated by the workflow body from state it already tracks, not by walking an
edge list at dispatch time). Wiring `inputs` into a general data-flow graph is exactly the
speculative generality the ticket's §1 "Out of scope" list forbids for v1 (no dynamic sub-graphs).
`inputs` is retained on the compiled artifact for the Studio's run-trace overlay (design.md
§Observability: "the canvas replays a run as an overlay on the authored graph") — a read-model
concern, not a dispatch concern.

## 4. Node lifecycle

```
PENDING --(dispatch)--> RUNNING --+--> SUCCEEDED   (activity returned without raising)
                                   +--> DEGRADED     (activity raised / timed out / max
                                   |                  attempts exhausted, onError != "fail")
                                   +--> SKIPPED       (unknown/unimplemented type, activity
                                   |                  cross-check mismatch, or sandboxed
                                   |                  external_write node)
                                   +--> FAILED        (activity raised, onError == "fail",
                                                        node.critical == true — see §5)
```

Terminal states are `SUCCEEDED`, `DEGRADED`, `SKIPPED`, `FAILED`. `FAILED` is per-node bookkeeping
only for a critical node — it is what promotes the RUN's terminal state (§5); it is not a fifth
generally-reachable state for a non-critical node (a non-critical node's exhausted-retry raise
becomes `DEGRADED`, never `FAILED`, regardless of `onError`).

**Every terminal state produces a trajectory row (Task 7).** `SKIPPED` and `DEGRADED` both carry a
non-null `reason`. This is design.md's "a node that produces nothing produces a *marked*
nothing," restated per-state:

| State | Trajectory `status` | `reason` values |
|---|---|---|
| `SUCCEEDED` | `OK` | — |
| `DEGRADED` | `ERROR` | `activity_error`, `timeout`, `attempts_exhausted` |
| `SKIPPED` | `SKIPPED` | `unsupported_node_type`, `activity_mismatch`, `sandbox` |
| `FAILED` (critical only) | `ERROR` | same as `DEGRADED`, plus the run-level effect (§5) |

## 5. Stage join semantics

- A stage is the set of nodes at one `stageIndex`. Stages execute **in ascending `stageIndex`
  order**; nodes within one stage are dispatched **concurrently** (`asyncio.gather`) and the stage
  is complete when **every** node has reached a terminal state (all-settled — R-3 requires this be
  proven under `Replayer`, not just fresh execution; see Task 9).
- **A stage where every node is non-critical and degrades still ADVANCES.** The run keeps walking
  subsequent stages. The registry declares `critical: bool` per node **type** (a platform decision,
  never tenant-configurable — S-5's "tenant may tighten, never exceed" logic applies to
  timeout/attempts, not to criticality, which is a code-owned safety property like S-4's routing).
- **A `critical` node that reaches `DEGRADED` is promoted to `FAILED`** and short-circuits the run:
  the current stage's remaining nodes are allowed to finish settling (no orphaned activities — an
  in-flight sibling activity is not cancelled mid-flight, since it may already be writing an
  artifact this run's own trajectory feed will need to explain), but **no further stage is
  started**. The run's terminal result is `FAILED`.
- **Worked example (the ticket's own acceptance-test prompt): "what happens when node 2 of a
  3-node stage times out?"**
  1. Node 2's activity is dispatched with `timeoutSeconds`/`retry` from the compiled config
     (already clamped at compile time — §0.2), re-clamped defensively by `caps.py`.
  2. `workflow.execute_activity` raises `ActivityError` (start-to-close timeout) once its
     `RetryPolicy.maximum_attempts` is exhausted.
  3. The interpreter's per-node wrapper catches this. If node 2's registry entry is
     **non-critical**: node 2 → `DEGRADED(reason="timeout")`. Nodes 1 and 3 are unaffected — they
     were already running concurrently (`asyncio.gather(..., return_exceptions=True)`) and
     complete on their own terms (`SUCCEEDED` or their own independent `DEGRADED`).
  4. The stage completes once all three have a terminal state. The run's terminal result stays
     whatever it already was (`RUNNING` → continues to the next stage), because "every node
     non-critical-degraded" does not fail the run — the run terminal for a stage with degraded
     nodes but no critical failure is **not** `FAILED`; it is recorded as `DEGRADED` on the overall
     `InterpreterResult` if ANY node in ANY stage degraded, else `SUCCEEDED`.
  5. If node 2's registry entry is instead **critical**: node 2 → `FAILED(reason="timeout")`, the
     run's terminal becomes `FAILED`, and stage walking stops after this stage settles.

## 6. Run terminal states

```
InterpreterResult.status ∈ { SUCCEEDED, DEGRADED, FAILED, CANCELLED }
```

- `SUCCEEDED` — every node in every stage reached `SUCCEEDED`.
- `DEGRADED` — at least one node reached `DEGRADED` or `SKIPPED`, no `critical` node `FAILED`, and
  the run was not cancelled. All stages ran to completion.
- `FAILED` — at least one `critical` node reached `FAILED`. Stage walking stopped after the stage
  containing that node settled.
- `CANCELLED` — the `cancel` signal (§8) was received and honored. Cancellation is checked at
  stage boundaries (never mid-activity — an in-flight activity is allowed to settle, same
  reasoning as §5's critical-failure short-circuit: no orphaned side effects with no trajectory
  row to explain them).

There is **no `PENDING`/`RUNNING` value on `InterpreterResult`** — those are node-level and
transient workflow-query states (`state` query surface, §8), not values the workflow *returns*.

## 7. Platform caps (defense-in-depth, per §0.2)

Module constants in `apps/harness/src/harness/temporal/interpreter/caps.py` — conservative,
revisited after TASK-720's first real palette run (R-4):

| Constant | Value | Rationale |
|---|---|---|
| `MAX_NODE_TIMEOUT_SECONDS` | `900` (15 min) | Matches the harness's own existing outlier budget (`_INFERENTIAL_TIMEOUT`, `workflows.py`) — no interpreter node should need longer than the platform's own most expensive existing activity. |
| `MAX_NODE_ATTEMPTS` | `5` | Above the harness's existing per-activity maxima (2–3); generous headroom without being unbounded. |
| `MAX_TOTAL_SECONDS` | `3600` (1 h) | A generation run that cannot finish in an hour is not a case v1 targets (STT/long-running palettes are later tickets — R-2). |
| `MAX_STAGES` | `50` | Structural bound — a config this deep is almost certainly a validator escape, not a real palette. |
| `MAX_NODES_PER_STAGE` | `32` | Bounds fan-out concurrency (worker `max_concurrent_activities=8` already caps effective parallelism platform-wide — see `worker.py`; this is a config-admission bound, not a scheduling one). |
| `MAX_TOTAL_NODES` | `500` | `MAX_STAGES * MAX_NODES_PER_STAGE` would allow 1,600 — this is a tighter, independent ceiling so the two bounds are not redundant. |

`clamp_timeout(requested: int) -> int` / `clamp_attempts(requested: int) -> int` are pure,
tighten-only (`min(requested, cap)`), and used both by the config-loader activity (§2 step 6,
against the whole-config structural bounds) and by the workflow body immediately before each
`execute_activity` call (against the per-node numeric caps) — belt and braces, matching the
worker's own `_assert_claim_check_store_is_deployable` "independent defence" pattern
(`worker.py`). **No `GlobalSetting` read anywhere in this ticket's code** — that mechanism now
lives entirely on the TypeScript compiler side (§0.2); Python module constants are the whole
implementation. Revisiting this to make the Python-side ceiling itself operator-tunable is future
work, not a v1 gap, since the compile-time clamp is already the enforcing layer.

## 8. Signal / query surface (v1)

- **Signal allow-list: `cancel` only.** `@workflow.signal(name="cancel")`. No parameters accepted
  beyond an optional free-text `reason` (never a `signalName`/payload pass-through — F-09,
  orchestration.md, is the anti-pattern this must not repeat). Any other signal name is simply not
  registered — Temporal itself rejects a signal to an unregistered handler; there is no allow-list
  *logic* to bypass because there is no second handler to bypass it with.
- **Query: `state` only.** `@workflow.query(name="state")` returns
  `{ runId, status, stages: [{ stageIndex, nodes: [{ nodeId, status }] }] }` — the live version of
  what Task 10's `GET /workflow-runs/{run_id}` also exposes via `describe()` + this query
  (TASK-721's Workbench needs the live query; the HTTP status route can use either).

## 9. Sandbox contract (S-8)

- `InterpreterInput.sandbox: bool`, pinned at start, **never re-read mid-run** (R-5's determinism
  requirement extends to this flag too — it is exactly the same class of "read once at start,
  carry in workflow state" value as caps).
- `NodeSpec.external_write: bool` is a **Python registry** property (not present on the wire
  `compiledConfig` node shape — §1) — a platform code-ownership decision about what a node type
  DOES, independent of any tenant config.
- When `sandbox=True`: any node whose registry entry has `external_write=True` dispatches as
  `SKIPPED(reason="sandbox")` **instead of** being executed — never a real call with a
  suppressed side effect (which would still cost latency/budget and could still leak through a
  poorly-isolated activity; skipping at the dispatch decision point, before
  `execute_activity` is ever called, is the only version of "sandbox" that is structurally
  guaranteed to write nothing).
- A sandboxed run still emits a trajectory row for every skipped node (visible in the Workbench
  feed) and still counts toward the run's `DEGRADED`/`SUCCEEDED` terminal per §6 (a
  sandbox-skipped node is treated exactly like an `unsupported_node_type` skip for terminal-state
  purposes — "marked nothing," not silently absent).

## 10. Node → activity dispatch — the S-4 enforcement mechanism, precisely

This is the one place this document diverges from a literal reading of `compiledConfig.activity`,
and the divergence is deliberate and safety-load-bearing:

1. Look up `NODE_REGISTRY.get(node.type)` (registry.py, Task 4), keyed by the wire `type` string.
2. **Missing, or `implemented=False`** → `SKIPPED(reason="unsupported_node_type")`. Never raise,
   never silently pass — this is the "observable skip" LOOP_ACTION_REGISTRY already established
   (`workflows.py:1632-1638`).
3. **Present** → assert `node.activity == registry_entry.activity.__name__`. This is a
   **consistency check against a compromised or stale compiled config**, not a routing decision —
   the callable that actually gets invoked always comes from `registry_entry.activity` (a Python
   function reference imported under `workflow.unsafe.imports_passed_through()`), **never** a
   string looked up by `node.activity` at runtime (that would let a corrupted/tampered
   `compiledConfig` — one that somehow passed the checksum check with an attacker-controlled
   `activity` string — name an arbitrary registered activity). On mismatch:
   `SKIPPED(reason="activity_mismatch")` — fail loud/observable, never execute.
4. Dispatch `workflow.execute_activity(registry_entry.activity, node_input, start_to_close_timeout=
   clamp_timeout(node.timeoutSeconds), retry_policy=RetryPolicy(maximum_attempts=
   clamp_attempts(node.retry.maximumAttempts), ...))`.

This is what makes S-6 (no reachable `SIGNED` write) a **three-layer structural property**: (a)
the registry has no entry whose `activity` calls `approveSummary`; (b) step 2 refuses anything not
in the registry; (c) step 3 refuses to trust the wire string over the registry's own reference. A
test (Task 4) asserts fact (a) by inspecting every `NodeSpec.activity.__module__`/`__qualname__`
in `NODE_REGISTRY` and failing if any resolves into
`packages.applications...summary.service` / any name containing `approveSummary` — this is a
Python-side string/introspection check standing in for the fact that the actual TypeScript
`approveSummary` is not even importable from Python, which is the real, load-bearing guarantee;
the test exists so a FUTURE registry entry that tries to call out to it (e.g. via an HTTP
activity hard-coding the approve route) is caught by name inspection of the route/URL string the
activity is documented to hit, not by import-time impossibility alone.
