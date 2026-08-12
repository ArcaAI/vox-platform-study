# TASK-664 — Reasoning primary and specialists

**Status:** In Progress

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

_(filled in as the work lands)_

## Change History

- 2026-08-12 — Ticket opened. Prerequisite sensor-penalty measurement executed FIRST and
  recorded (§1): **0.944 absolute / 94.4% relative penalty on both lexical sensors, 0/6
  adjudicated notes passing**. Recommendation: do not loosen thresholds; raise the
  inferential-evaluation change as its own ticket.
