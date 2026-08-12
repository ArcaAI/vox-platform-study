# TASK-664 — Reasoning primary and specialists

**Status:** Review

**Wave:** W4 · **Tier:** opus-5 / high · **Type:** feature · **Depends on:** TASK-662 (merged)

**Base commit:** `5a675d3d5` on `dev-2.1` (`docs(TASK-654): harness baseline depends on .env.dev presence`).
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

**Environment: this worktree has NO `.env.dev`** (gitignored, main-tree only). Per
execution-plan §1.1a that means the expected failure count is **0**, not the 4 that the main
tree shows (`test_otel_tracing_task636` ×3 + `test_qdrant_api_key` ×1, all asserting a
variable is unset that `.env.dev` sets).

**Own measured baseline on `5a675d3d5`, before any edit, with that prefix:**

```
================= 1081 passed, 4 skipped, 1 warning in 32.76s ==================
```

(The 4 skips are the pre-existing `test_phi_redactor.py` cases needing the `en_core_web_lg`
spaCy model.) This matches TASK-662's post-merge figure exactly. Every later number in this
document is compared against **that** figure.

---

## 1. Prerequisite measurement — the lexical-sensor penalty on adjudication

**Required by the spec before the primary ships**, and done first.

### 1.1 What was measured and how

`entity_faithfulness` and `coverage_omission`
(`apps/harness/src/harness/sensors/computational/`) are **lexical**. Both reduce to a
normalized substring/set membership test:

```python
# entity_faithfulness.py:60-62
grounded = entity.normalized in transcript_entity_texts or (entity.normalized in transcript_norm)
# coverage_omission.py:42
present = entity.normalized in note_entity_texts or entity.normalized in haystack
```

Adjudication is **clinical inference**: the primary reconciling two specialists' findings
routinely *renames* what it records. Six paired cases were constructed, each covering one
real abstraction class, and run through the **real sensors** at their **production default
thresholds** (faithfulness 1.00, coverage 0.80 — nothing was re-tuned for the measurement):

| Arm | Note |
|---|---|
| **PARROTED** | Clinically correct AND lexically faithful — reuses the transcript's exact surface forms. The control; this is what the sensors are tuned for. |
| **ADJUDICATED** | Clinically correct and *better* — standard clinical abstraction plus a reconciliation of the specialists' disagreement, often into a term neither used literally. |

Both arms are clinically acceptable in every case; the adjudicated one is the note a
clinician would prefer. Entity lists model what the NLP NER pass returns (the surface forms
actually present in each text) — exactly how `run_sensors` builds its `SensorContext` in
production, so the divergence measured is the divergence the gate would see.

Source and reproduction:
`apps/harness/src/harness/tests/unit/sensors/test_adjudication_penalty_task664.py`
→ `PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test -k adjudication_penalty -s`

### 1.2 Result — actual output

```
case                         faith(par) faith(adj)  cov(par)  cov(adj)
--------------------------------------------------------------------------------------------
lay-to-clinical                    1.00       0.00      1.00      0.00
brand-to-generic                   1.00       0.00      1.00      0.00
findings-to-diagnosis              1.00       0.00      1.00      0.00
disagreement-adjudicated           1.00       0.00      1.00      0.00
measurement-normalised             1.00       0.00      1.00      0.00
temporal-abstraction               1.00       0.33      1.00      0.33
--------------------------------------------------------------------------------------------
MEAN                              1.000      0.056     1.000     0.056

  entity_faithfulness penalty : 0.944 absolute (94.4% relative)
  coverage_omission   penalty : 0.944 absolute (94.4% relative)
  adjudicated notes passing entity_faithfulness : 0/6
  adjudicated notes passing coverage_omission   : 0/6
```

Representative flags raised **against clinically correct notes**:

```
    brand-to-generic: 'fabricated' -> ['paracetamol', 'salbutamol']
    brand-to-generic: 'omitted'    -> ['Tylenol', 'Ventolin']
    disagreement-adjudicated: 'fabricated' -> ['lower respiratory tract infection',
                                               'focal right basal signs', 'pneumonia', 'bronchitis']
    disagreement-adjudicated: 'omitted'    -> ['cough', 'green phlegm', 'temperature 38.4', 'crackles']
```

### 1.3 The number, and what it means

> **The penalty is 0.944 absolute / 94.4% relative on BOTH sensors. 0 of 6 clinically
> correct adjudicated notes pass either sensor; 6 of 6 parroted ones pass both.**

This is far past "material". It is close to total: at these thresholds the two lexical
sensors do not merely under-reward adjudication, they **invert** the ranking — the note a
clinician would reject (a transcript parroted back) scores perfectly, and the note a
clinician would accept scores zero. Writing a generic drug name is recorded as a
*fabrication*; recording the brand name it replaced is recorded as an *omission*. The single
worst-scoring case is `disagreement-adjudicated` — precisely the case that exists *because*
reasoning was needed.

The direction matches arXiv 2604.14829 (lexical evaluation reporting ~35% hallucination
where inference-aware evaluation gives ~9%); the magnitude here is larger because these two
sensors are pure string matching with no lexical-variant allowance at all, and because the
cases were built to isolate abstraction rather than to mix it with verbatim content.

### 1.4 Recommendation

**Do not loosen the thresholds. Do not weaken the matchers. Raise it as its own ticket.**

Loosening either sensor to admit `paracetamol` where the transcript said `Tylenol` means
loosening it by *exactly* the amount that also admits a genuinely fabricated drug name — the
sensors cannot tell those two apart, because telling them apart is a clinical-knowledge
judgement and these sensors have no clinical knowledge. That is the failure mode this
measurement exists to prevent, and it is why the measurement was demanded before the primary
shipped rather than after.

The follow-up ticket should evaluate adjudicated output with the **inferential** lane that
already exists (`harness/sensors/inferential/` — `entailment_batch`, `groundedness`,
`atomic_fact`), which asks "is this entailed by the transcript" rather than "does this string
appear in the transcript", and which would answer *yes* for every one of the six cases above.
That is a change to the gate's sensor selection and calibration, with its own eval-corpus
work; it is not a line-edit and it is not this ticket.

### 1.5 The consequence this ticket DOES absorb

Because the penalty is real and unfixed, **TASK-664 does not route adjudicated prose into
the computational gate**, and it does not make the reasoning layer a second note author.
The design below keeps that property structurally rather than by convention:

- Specialists emit **findings** (structured claims + confidence), never note prose.
- The primary emits an **adjudication record** — the decision, the rejected view, and the
  basis — which is *inspectable evidence*, not note text.
- The note is still generated by the frozen `HarnessDocWorkflow` from the transcript, via
  the existing `harness.finalize` child. The primary remains the only writer of note and
  gate, and the gate keeps seeing a transcript-derived note, which is what its sensors are
  calibrated for.

`test_adjudication_penalty_task664.py` asserts the penalty **exists** — it is a regression
lock, not an aspiration. If a later change makes an adjudicated note score like a parroted
one, that file must be the thing that fails.

---

## 2. Requirement Analysis

**Type:** feature. **Objective:** the deliberative lane on top of TASK-662's mechanical
loop — an LLM planner recorded in history, specialists isolated as child workflows, scoped
reads, enforced write scope, and inspectable adjudication, with the primary the sole writer
of the note and gate.

Scope, per execution-plan §"TASK-664":

1. LLM planner as a Temporal **activity** (C1, D3) — never planned inside the workflow body.
2. Replan at **checkpoints**, not per event; the checkpoint policy explicit and configurable.
3. Specialists as **child workflows** with `ParentClosePolicy.REQUEST_CANCEL` **plus**
   `ChildWorkflowCancellationType.TRY_CANCEL`.
4. Scoped reads (subscribed kinds only) and enforced `writeScope`.
5. Primary adjudicates, clinician finalises; the disagreement and its basis inspectable (E12).
6. Back TASK-662's three unbacked action keys so the cascade actually runs.
7. Depth counter, per-consultation budget, `(agent, kind)` cycle detection.
8. Reasoning to planning and verification, **never** the note-generation call.

### 2.1 Must not change

- `HarnessDocWorkflow`'s body (C2 — ~11 live `workflow.patched` eras + replay fixtures).
- `LiveDocumentationService` internals.
- `packages/agentic-sdk-v2/**` (TASK-665), `apps/admin-console/**` (TASK-666/667).
- No Prisma migration.
- The 21 existing replay fixtures must pass unchanged.

## 3. Current State Evaluation

Verified against `dev-2.1` @ `5a675d3d5`.

### 3.1 What TASK-662 left for this ticket

`LOOP_ACTION_REGISTRY` (`workflows.py:1637`) declares seven canonical keys; three carry
`implemented=False` and dispatch as observable `action.skipped` / `unsupported_action`:
`vision.extract_text`, `document.extract_text`, `nlp.extract_entities`. TASK-662 §5 names
backing them as this ticket's job.

`ConsultationLoopConfig` (`models.py:1094`) carries subscriptions, a budget, and
start/ending actions — but no agent roster, no roles, no `writeScope`. The reasoning layer
needs all three, so the pinned config gains them additively.

### 3.2 Substrate this ticket reuses rather than rebuilds

- `claim_check.py` — complete and generic; specialist payloads ride it.
- `_loop_stubs.py` / `test_consultation_loop_workflow.py` — the loop's test harness.
- `_capture_replay_fixture.py` — fixture capture, already parameterised by scenario.
- `sensors/inferential/` — the lane the follow-up ticket from §1.4 should use.

## 4. Implementation Plan

### 4.1 TDD list → the property each test locks

| # | Property |
|---|---|
| 1 | Planner decision replays from history without re-invoking the model |
| 2 | A specialist cannot write outside its `writeScope` |
| 3 | A specialist reads only its subscribed kinds |
| 4 | Specialist failure degrades the run rather than aborting it |
| 5 | Contradictory findings surface rather than merge silently |
| 6 | Cycle detection terminates a cascade |
| 7 | Budget cuts off a runaway specialist without harming the run |
| 8 | The primary remains the only writer of the note and gate |
| 9 | Existing replay fixtures pass unchanged |

### 4.2 File order

1. `temporal/models.py` — reasoning payloads (additive only).
2. `temporal/activities.py` — planner + derived-context activities; `REASONING_ACTIVITIES`.
3. `services/api_client.py` — the derived-context / adjudication gateway calls.
4. `temporal/workflows.py` — `SpecialistWorkflow` appended; loop extended, `HarnessDocWorkflow` untouched.
5. `temporal/worker.py` — registration.
6. Tests + replay fixture.

## 5. Implementation Summary

### 5.0 The constraint that shaped the design — the loop is no longer patch-free

TASK-662 could add `ConsultationLoopWorkflow` with **no** `workflow.patched` era,
because a brand-new workflow type has no recorded history to stay compatible with. Its
own README says so explicitly.

**That is no longer true, and it is the single most consequential finding of this ticket.**
TASK-662 also froze a fixture of that type (`consultation_loop_task662_history.json`,
asserted in `test_replay_compat.py`). Every new command this ticket makes the loop
issue — the planner activity, the specialist children, the adjudication publish, the
three derived-context activities — would have broken that replay if issued
unconditionally, wedging any consultation in flight at deploy time.

Two things keep it green, and **both** are required:

1. `reasoning_enabled` defaults to `False` on `ConsultationLoopConfig`, so a config
   recorded before this ticket deserialises with the lane OFF.
2. Every gate is written `config.reasoning_enabled and workflow.patched(_PATCH_REASONING)`
   — **the flag operand first**. On the old history the flag is `False`, so
   `workflow.patched` is never even *called*, no marker is sought, and the recorded
   command sequence is reproduced exactly.

Reversing those two operands would still be correct for a fresh run and would still fail
the frozen replay. `test_pre_reasoning_loop_history_replays_after_task664` exists to fail
if anyone does.

### 5.1 The reasoning lane

| Concern | How |
|---|---|
| **Planner** | `plan_reasoning` is a Temporal **activity**. Its `PlanDecision` lands in history, so a replay reuses the recorded decision and never re-invokes the model (C1 / D3). It only ever schedules an agent that EXISTS and that actually subscribes to the kind — a hallucinated agent id or a widened read scope is dropped at parse time, and again by the orchestrator. |
| **Fail-safe planning** | A planner that cannot answer returns `degraded=True` with an **empty** dispatch. It never guesses a roster: a guessed set of clinical reviewers is worse than none. |
| **Replan cadence** | A **planning checkpoint** every `replan_interval_events` (default 25), evaluated per item but firing only on the interval, plus a forced checkpoint at the end of the consultation so the tail is never unreviewed. This is a *different, tighter* knob than the two `continue_as_new` thresholds — replanning every 500 events would be no planning at all. |
| **Specialists** | `SpecialistWorkflow` children, `ParentClosePolicy.REQUEST_CANCEL` + `ChildWorkflowCancellationType.TRY_CANCEL`. One attempt, no retry: a specialist that failed is *information*, and retrying it silently would hide a persistently broken agent behind a longer consultation. |
| **Scoped reads** | The parent filters `_context_log` to the agent's `subscribed_kinds` before starting the child. A specialist cannot read what it was never handed. |
| **Write scope** | Enforced in the **orchestrator** (`_adjudicate`), outside agent code — the AWS AgentCore placement §4.6 adopts. The child re-checks too, so a refusal is visible in its own result, but the parent's check is the boundary. |
| **Primary-only floor** | `PRIMARY_ONLY_OUTPUT_KINDS = {note, gate}` is refused for any specialist **whatever its configured `writeScope` says**. A tenant cannot misconfigure away the primary's exclusive ownership (D7). `SpecialistResult` also has no field capable of carrying note text or a gate decision — the exclusivity is structural, not a convention. |
| **Cycle detection** | `(agent_id, kind_key)` pairs, carried across checkpoints. Dropping that memory at a continuation would let every pair run again — precisely the cycle the detector exists to stop. |
| **Specialist budget** | `budget.max_specialist_runs` (default 20). Exhaustion **degrades**: the consultation keeps running and keeps accepting context; only further review is withheld, visibly. |

### 5.2 Adjudication — inspectable, and pure

`adjudicate()` (`temporal/models.py`) is a **pure function**, and that is not a style
preference: it runs inside the workflow body, where any non-determinism breaks replay.
Its rules are therefore total and data-only — group by `output_kind`; identical
statements are an AGREEMENT; differing statements are a CONFLICT whose highest-confidence
view is accepted, ties broken lexicographically on `agent_id`, with **every** rejected
view retained alongside it and the basis recorded.

Nothing is merged away silently. The clinician finalises, so the clinician must be able
to see what was overruled and on what grounds. The record is published on TASK-660's
existing loop-event plane (ids, output kinds, short statements — never note or transcript
text) rather than through a second transport.

### 5.3 The three keys TASK-662 left unbacked

| Key | Backed by | Cascade |
|---|---|---|
| `vision.extract_text` | `vision_extract_text` → SMR vision (TASK-657) | output re-enters as `<kind>_text`, depth + 1 |
| `document.extract_text` | `document_extract_text` → **new** gateway read of `ContextItem.metaData.extractedText` | ″ |
| `nlp.extract_entities` | `nlp_extract_entities` → the same `classify_tokens` call the document workflow uses (one NER path, not two) | output re-enters as `<kind>_entities`, depth + 1 |

The derived item goes through the **identical** intake path as a gateway-delivered one —
same de-duplication, same depth cap, same budget — which is what stops the cascade being
unbounded. Its dedupe key is derived from the parent's own identity, so a re-delivery of
the parent cannot double-derive. `derived=False` (nothing extractable, or the downstream
service was unavailable) simply ends that branch; it is not an error and does not degrade
the run.

`document.extract_text` deliberately **reads** rather than extracts. The gateway already
owns extraction (`OcrEnrichmentProcessor` → NLP `/extract`); a second path would mean a
second set of storage credentials, a second PHI egress surface, and two implementations
that can disagree about what a document says.

### 5.4 Gateway side

`LoopConfigResponse` gains `agents[]` + `reasoningEnabled`, both additive with
TASK-662-equivalent defaults. Reasoning turns on **only** when there is something to
deliberate — a PRIMARY *and* at least one SPECIALIST — so a single-agent department keeps
exactly TASK-662's behaviour. The primary falls back to the department default agent when
no agent carries the PRIMARY role, because a department configured before TASK-659 has a
default but no roles and the loop must still have exactly one note owner.

A structurally malformed `writeScope` resolves to **nothing** granted, never everything;
a malformed `goal` envelope resolves to `null` rather than leaking `[object Object]` into
a planner prompt.

`LoopContextTextService` + `GET internal/harness/consultations/:id/context-items/:itemId/extracted-text`
back `document.extract_text`. Scoped by tenant **and** consultation: the tenant-scope
extension hides a cross-tenant row, but an id from a different consultation of the same
tenant would otherwise leak one consultation's document text into another's loop. Answers
`{ text: '' }` rather than 404, so the loop reads it as "nothing derived".

### 5.5 Files changed

**Harness** — `temporal/models.py`, `temporal/activities.py`, `temporal/workflows.py`,
`temporal/worker.py`, `services/api_client.py`; tests
`tests/unit/sensors/test_adjudication_penalty_task664.py` (new, 5 cases),
`tests/unit/temporal/test_reasoning_loop_workflow.py` (new, 36 cases),
`tests/unit/temporal/test_loop_config_roster_mapping.py` (new, 5 cases),
`tests/unit/temporal/_loop_stubs.py`, `tests/unit/temporal/_capture_replay_fixture.py`
(new `--reasoning` scenario), `tests/unit/temporal/test_replay_compat.py` (2 new cases),
`tests/unit/temporal/test_consultation_loop_workflow.py` (2 assertions updated, 1 added),
`tests/unit/temporal/fixtures/consultation_loop_task664_reasoning_history.json` (new).

**Gateway** — `services/consultation/loop/{dto/loop-config.response.ts,
loop-config.service.ts, ILoopContextTextService.ts, loop-context-text.service.ts,
loop-context-text.service.module.ts, index.ts,
__tests__/loop-config.service.test.ts, __tests__/loop-context-text.service.test.ts}`;
`apps/api/src/modules/consultation/{harness-internal.controller.ts, consultation.module.ts}`.

No Prisma migration. No change to `HarnessDocWorkflow`, `LiveDocumentationService`,
`packages/agentic-sdk-v2/**` or `apps/admin-console/**`.

### 5.6 Gate evidence (actual output)

Every Python gate carries the mandatory `PYTHONPATH` prefix (§0).

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
================= 1130 passed, 4 skipped, 1 warning in 34.48s ==================
```

Own measured baseline before any edit: **1081 passed, 4 skipped** (§0). Net **+49**
= 5 (sensor-penalty measurement) + 36 (reasoning lane) + 5 (roster wire contract)
+ 2 (replay era) + 1 (mechanical-four derives check).

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test -k replay
=============== 24 passed, 1105 deselected, 3 warnings in 4.75s ================
```

Baseline was **21**. The 21 pre-existing cases pass **unchanged** — verified by name, not
by count; `test_loop_history_replays_on_current_definition` (the frozen TASK-662 loop
fixture) is among them. The +3 are
`test_the_recorded_decision_replays_without_re_invoking_the_model` (matched by `-k` on
"replays"), `test_pre_reasoning_loop_history_replays_after_task664` and
`test_reasoning_history_replays_on_current_definition`.

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:lint
All checks passed!

$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:typecheck
Success: no issues found in 96 source files
```

TypeScript gates. The worktree has no `.env.dev`, so `db:generate` runs with placeholder
`DATABASE_URL`/`DIRECT_URL` (the TASK-660 §5 workaround — schema-only, no live
connection), and `pnpm install` was needed first per execution-plan §1.1b.

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc          (exit 0)

$ pnpm --filter @arcaai/applications test
 Test Files  470 passed | 1 skipped (471)
      Tests  8857 passed | 4 skipped (8861)

$ pnpm api:build
 Tasks:    9 successful, 9 total

$ pnpm lint
@arcaai/vox:lint:          ✖ 3 problems (0 errors, 3 warnings)
@arcaai/domains:lint:      ✖ 13 problems (0 errors, 13 warnings)
@arcaai/applications:lint: ✖ 191 problems (0 errors, 191 warnings)
@arcaai/api:lint:          ✖ 65 problems (0 errors, 65 warnings)
 Tasks:    31 successful, 31 total
```

`apps/api` matches the stated 65-warning baseline exactly (one prettier error this ticket
DID introduce was fixed rather than accepted, per rule 01's "treat only-warn as errors").
`@arcaai/applications` reads 191, the same figure TASK-662 measured on its base commit;
**zero** of those warnings sit in any file this ticket added or modified (verified by
grepping the lint output for `loop/`).

Applications tests: this ticket adds **15** (6 roster resolution + 9 extracted-text),
which reconciles the pre-change 8,842 passing to 8,857. The 8,845 figure quoted in the
brief did not match what the tree actually reported on this commit; the measured
pre-change number is used instead, as §0 requires.

### 5.7 TDD outcomes

RED was seen first: the initial run of `test_reasoning_loop_workflow.py` failed with
`ImportError: cannot import name 'LOOP_SKIP_CYCLE_DETECTED'`, and the suite was driven to
green from there.

| # | Property | Result |
|---|---|---|
| 1 | Planner decision replays from history without re-invoking the model | ✅ activity call count is unchanged across a `Replayer` run of the produced history; plus a frozen fixture |
| 2 | A specialist cannot write outside its `writeScope` | ✅ out-of-scope finding never reaches the record and the drop IS reported; a rogue agent whose scope names `note`/`gate` is refused anyway |
| 3 | A specialist reads only its subscribed kinds | ✅ each child's `context` contains only its own kinds |
| 4 | Specialist failure degrades the run rather than aborting it | ✅ `degraded=True`, `specialist_failures≥1`, all events still consumed, healthy specialists still contribute |
| 5 | Contradictory findings surface rather than merge silently | ✅ conflict retains every rejected view + basis; agreement is recorded as agreement; deterministic and tie-broken on `agent_id` |
| 6 | Cycle detection terminates a cascade | ✅ 4 transcript items ⇒ the cardiology specialist runs ONCE; suppression visible on the client feed |
| 7 | Budget cuts off a runaway specialist without harming the run | ✅ capped at 1 run, degraded, all events consumed, not cancelled, reason emitted |
| 8 | The primary remains the only writer of the note and gate | ✅ real `HarnessDocWorkflow` child started by the loop's ending action alone; `persist_draft` exactly once; `SpecialistResult` has no note/gate field |
| 9 | Existing replay fixtures pass unchanged | ✅ all 21, verified by name |

## 6. Incomplete / Deferred

- **The lexical-sensor penalty is unfixed by design** (§1.4). Raised as its own ticket;
  the regression lock in `test_adjudication_penalty_task664.py` asserts the penalty still
  exists so it cannot be "fixed" by quietly loosening a threshold.
- **`ContextAddedSignal.text` is still empty in production.** TASK-662 recorded that the
  gateway sends `{tenantId, contextItemId, contextType, subType?, contentPreview?}` — no
  text, no `kindKey`, no `occurredAt`, no `depth`. Until `HarnessGatewayService` /
  `LoopContextSignalService` are extended, specialists receive context items with ids and
  kinds but empty bodies, and `vision.extract_text` / `nlp.extract_entities` have nothing
  inline to work from (`document.extract_text` is unaffected — it reads from the gateway).
  Left alone deliberately: TASK-662 already deferred that signal-payload change, it is
  additive on both sides, and the files sit beside other tickets' worktrees.
- **`plan_reasoning` and `run_specialist` are not exercised against a live SMR.** Their
  JSON parsing, scope filtering and fail-safe branches are unit-tested; the model call
  itself is not, and no LM Studio/SMR stack was available in this worktree.
- **`pnpm test:e2e` not run** — not one of this ticket's gates, and no live
  Postgres/Redis stack was available.
- **No admin-console surface for the roster or the adjudication record.** TASK-666/667
  own `apps/admin-console/**`; the record is published on the existing SSE plane and is
  ready for a consumer.

## Change History

- 2026-08-12 — Ticket opened. Prerequisite sensor-penalty measurement executed FIRST and
  recorded (§1): **0.944 absolute / 94.4% relative penalty on both lexical sensors, 0/6
  adjudicated notes passing**. Recommendation: do not loosen thresholds; raise the
  inferential-evaluation change as its own ticket.
- 2026-08-12 — Implemented across four commits. **Corrected the premise this ticket
  inherited**: TASK-662's "a new workflow type needs no `workflow.patched` era" stopped
  being true the moment TASK-662 froze a fixture of that type, so every command added
  here is gated — with the config-flag operand ordered *before* `workflow.patched` so an
  old history never calls it (§5.0). Also found that `DepartmentAgent.goal` is a JSONB
  envelope rather than a string, which would have put `[object Object]` into every
  planner prompt.
