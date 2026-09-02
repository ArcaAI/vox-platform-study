# Summarization palette — node registry contract (TASK-720 Task 1)

Cross-references TASK-718's `contracts/execution-semantics.md` (interpreter dispatch/lifecycle) and
TASK-716's `contracts/compiled-config.schema.json` + `contracts/README.md` (the compiled artifact
these nodes compile into). This document is the registration table Studio (TASK-719) and the
harness node registry (TASK-718's `registry.py`, populated by this ticket's Task 5) both read from.

## Node table

| # | Node type key | Safety class | `critical` | `external_write` | Activity (Temporal-registered name) | Config schema |
|---|---|---|---|---|---|---|
| N-1 | `input.context_binding` | `mandatory` | `true` | `false` | `interpreter.context_binding` | `nodes/input.context_binding.schema.json` |
| N-2 | `prompt.template_ref` | `optional` | `false` | `false` | `interpreter.template_ref` | `nodes/prompt.template_ref.schema.json` |
| N-3 | `generate.text` | `mandatory` | `true` | `false` | `interpreter.text_generate` | `nodes/generate.text.schema.json` |
| N-4 | `guardrail.check` | `mandatory`, **non-removable** | `false` | `false` | `interpreter.guardrail_check` | `nodes/guardrail.check.schema.json` |
| N-5 | `output.deliver` | `mandatory` | `true` | **`true`** | `interpreter.deliver` | `nodes/output.deliver.schema.json` |

Activity naming follows the precedent already shipped in
`apps/harness/src/harness/temporal/interpreter/activities.py` (`interpreter.noop`,
`interpreter.passthrough` — explicit `@activity.defn(name="interpreter.<key>")`), **not** the
ticket brief's original guess of a bare, unnamed `@activity.defn` (that convention belongs to the
*outer* `harness/temporal/activities.py`'s 27 pre-interpreter activities, a different module). This
is the R-1 reconciliation the ticket README anticipated: TASK-718's own contract shipped after the
ticket was authored, so its actual shape wins. `NodeSpec.activity_name` is derived automatically
from this registered name (`registry.py:_registered_activity_name`); the seeded `compiledConfig`
(Task 6) must stamp the identical string into each `CompiledNode.activity`, or the interpreter's
S-4 consistency check (execution-semantics.md §10 step 3) will `SKIPPED(reason="activity_mismatch")`
every node.

## `critical` rationale (execution-semantics.md §5 — code-owned, never tenant-configurable)

- **N-3 (`generate.text`) is critical.** No generation output means nothing downstream has
  anything to review, guard, or deliver — this mirrors the existing harness posture that SMR
  generation failure propagates and fails the run (orchestration.md §Divergences, cited in the
  ticket README §4 Task 5).
- **N-1 (`input.context_binding`) and N-5 (`output.deliver`) are critical.** A run that cannot bind
  its declared input, or cannot shape its declared output, has produced nothing usable; letting the
  run report `DEGRADED` (as a non-critical failure would) mischaracterizes total failure as partial
  success. This is a decision made in this ticket, not inherited from a prior one — flagged here so
  a reviewer can override it explicitly if the design intent differs.
- **N-4 (`guardrail.check`) is NOT critical.** Per README §2/§4 Task 5: a degraded verdict marks the
  artifact as unverified — it does not by itself kill the run. `onFail: 'abort'` in the node's own
  config is how a tenant makes a *specific run's* guardrail failure fatal; that is a per-run config
  choice layered on top of the code-owned `critical=False`, not a change to it.
- **N-2 (`prompt.template_ref`) is NOT critical when absent** (it is `optional` — a workflow may
  carry its prompt inline in N-3's config instead), but when the node IS present and its
  `promptTemplateId` fails to resolve to an approved version, that failure IS critical in effect
  because N-3 then has no prompt to generate from. Implemented as: N-2's own registry entry carries
  `critical=False` (matching its optional safety class), and a resolution failure surfaces to N-3 as
  a missing/invalid input, which N-3's own critical path then fails on. This keeps "criticality" a
  property of what a node's absence-of-output means for the run, not a duplicate flag on two nodes
  for the same underlying cause.

## `emitsTrajectory` / `onError`

Every node here emits exactly one `NODE` trajectory step via `_TrajectoryBatch` (Task 5's re-use of
`activities.py`'s existing batch emitter — see the ticket README §4 Task 5). `generate.text`'s
config schema carries an optional `onError: 'fail' | 'degrade'`, consumed by
`packages/workflow-contract/src/compiler.ts#compileNode` (`config.onError === 'degrade' ? 'degrade'
: 'fail'`) when building `CompiledNode.onError` — this is a compiler-level fallback field, not a
duplicate of the `critical` registry property: `onError` says how the *compiled node* is marked on
failure before `critical` promotion; `critical` says whether that marking can promote to
`FAILED`/fail the run.

## Mandatory-subgraph rule set (Task 3 — see `packages/workflow-contract/src/rule-catalogue.ts`)

Six new `structural`, `paletteKey: 'summarization'` rule instances (`WF-SUMM-001..006`), additive to
`DRAFT_SUMMARIZATION_RULE_SET`, alongside the DRAFT `WF-S-*`/`WF-I-*` rules TASK-716 already shipped.
These are new, palette-specific structural checks over this palette's *actual* node types
(`input.context_binding`/`generate.text`/`guardrail.check`/`output.deliver`) — they do not modify or
duplicate TASK-716's existing generic `WF-S-002/003/004/007` (which assume literal `core.start`/
`core.end` node types a future, still-undesigned convention would provide; this palette's own entry
and terminal node types are different literal strings, so those generic rules do not evaluate this
palette's graphs today — noted, not fixed here, since fixing that convention mismatch is TASK-716's
scope, not this ticket's).

| Rule ID | Predicate | What it enforces | Failing fixture |
|---|---|---|---|
| `WF-SUMM-001` | `SINGLE_ENTRY` (`entryType: input.context_binding`) | Exactly one `input.context_binding` node | two `input.context_binding` nodes |
| `WF-SUMM-002` | `SINGLE_ENTRY` (`entryType: output.deliver`) | Exactly one `output.deliver` node | two `output.deliver` nodes |
| `WF-SUMM-003` | `REQUIRED_NODE_TYPE` (`nodeType: generate.text`, `minCount: 1`) | A generation node is present | graph with no `generate.text` node |
| `WF-SUMM-004` | `REQUIRED_NODE_TYPE` (`nodeType: guardrail.check`, `minCount: 1`) | `guardrail.check` is present — this is also the structural expression of "non-removable": absence is exactly what the fail fixture (a graph that deleted it) looks like | graph with `guardrail.check` dropped |
| `WF-SUMM-005` | `ORDERED_BEFORE` (`beforeType: generate.text`, `afterType: guardrail.check`) | Generation is never downstream of the guardrail check (order not inverted) | `guardrail.check` wired upstream of `generate.text` |
| `WF-SUMM-006` | `REQUIRED_PATH_THROUGH` (`fromType: generate.text`, `toType: output.deliver`, `throughType: guardrail.check`) | Nothing routes generated text to the output without passing through the guardrail | `output.deliver` fed directly from `generate.text`, bypassing `guardrail.check` |

`SINGLE_ENTRY`'s predicate implementation (`packages/workflow-contract/src/predicates/structural.ts`)
is a pure `count(type) !== 1` check with no semantic dependence on "entry" — reused here for N-5's
exact-one-output requirement as well as N-1's exact-one-input requirement, rather than inventing a
near-duplicate `SINGLE_NODE_OF_TYPE` predicate kind for the same shape (the predicate catalogue is
closed by design — TASK-716 `predicates/index.ts` docstring).

**Deliberately NOT built here (gated, honestly):** the sixth row from the ticket README §4 Task 2's
table — "N-2's `promptTemplateId` resolves within the tenant or SYSTEM shared-read (cross-tenant id
fails)". This is a `schema`-class rule needing repository I/O (cross-tenant lookup), which
`rule-catalogue.ts`'s own module docstring explicitly scopes OUT of the pure package: it requires
the impure `WorkflowValidatorService` (TASK-716 Task 8), which is gated on TASK-715's node registry
(Phases B–F), neither of which exists in this session. Tracked as an explicit gap here rather than
silently dropped.

## Compiler interoperability (Task 6/7 contract)

`packages/workflow-contract/src/compiler.ts#compile()` needs a `CompilerContext.nodeInfo(type)` that
resolves each of the five type keys above to `{ activity, classes }`. The `activity` string MUST be
byte-identical to the Python registry's Temporal-registered name (this table's fourth column) — the
S-4 dispatch check in `execution-semantics.md` §10 depends on it. `classes` here only needs to
include `'gate'` for any node the compiler should lift out of `stages` into the separate `gates[]`
array (`contracts/compiled-config.schema.json` normative rule — `gates` MUST be `[]` in v1 per
execution-semantics.md §2 step 5); none of this palette's five nodes are HITL gates, so none carry
the `'gate'` class and `gates` stays empty, matching what the v1 interpreter's config-admission step
requires.
