# TASK-671 — Inference-aware gate sensors (entity faithfulness + coverage)

**Status:** Pending

**Type:** feature · **Depends on:** TASK-664 (merged into `dev-2.1` at `0f81e333f`)

**Origin:** TASK-664 §1 measured a hard limitation in the clinical documentation harness
gate and recommended it be fixed as its own ticket. This is that ticket.

**Base commit:** `0f81e333f` on `dev-2.1` (`merge(TASK-664): reasoning primary, specialists,
and derived-context cascade`).

---

## 0. Measurement contract (read before any gate claim)

`arcaenv` installs `harness` as an editable package pinned to an absolute path in the
**main checkout**. Work done in a worktree must prefix every Python gate:

```
PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
```

Otherwise the run collects the worktree's tests and imports the main tree's source — a
ticket can report GREEN having executed none of its own code.

Reproduce the inherited finding (verified on `0f81e333f`, main checkout, `5 passed`):

```bash
pnpm harness:test -k adjudication_penalty -s
```

---

## 1. Requirement Analysis

### 1.1 The inherited finding

`apps/harness/src/harness/sensors/computational/entity_faithfulness.py` and
`.../coverage_omission.py` are **pure lexical matchers**. Both reduce to a normalized
substring / set-membership test on `NEREntity.normalized` — case-folded, `▁`-stripped,
whitespace-collapsed surface text, compared with `in`.

Measured over six paired clinical cases at production defaults (faithfulness `1.00`,
coverage `0.80`):

| arm | mean faithfulness | mean coverage | passing |
|---|---|---|---|
| clinically correct, **abstracted** | 0.056 | 0.056 | 0/6 |
| clinically correct, **parroted** (transcript surface forms reused verbatim) | 1.000 | 1.000 | 6/6 |

**Penalty: 0.944 absolute / 94.4% relative, on both sensors.**

Concretely: writing `paracetamol` where the transcript said `Tylenol` is flagged as a
FABRICATION, and the disappearance of `Tylenol` from the note is *separately* flagged as an
OMISSION. Reconciling two specialists' competing diagnoses into
`lower respiratory tract infection` is flagged as fabricating four entities.

The ranking is not merely under-rewarding abstraction — it is **inverted**. The note a
clinician would prefer scores worse than the one that parrots the transcript.

### 1.2 The hard constraint (carried from TASK-664, non-negotiable)

> **Do not lower the lexical thresholds. Do not fuzz the matchers.**

Loosening either sensor enough to admit a legitimate generic-drug substitution loosens it by
*exactly* the amount that also admits a hallucinated drug name. `paracetamol`-for-`Tylenol`
and `warfarin`-for-nothing are lexically indistinguishable; telling them apart is a
clinical-knowledge judgement, and these sensors have no clinical knowledge. Any proposal
that reduces to edit distance, embedding cosine over surface forms, or a lowered threshold
is out of scope by construction.

The regression lock `apps/harness/src/harness/tests/unit/sensors/test_adjudication_penalty_task664.py`
asserts the penalty **still exists**. It must be **updated deliberately** if the gate's
behaviour changes — never deleted, never weakened to make a new implementation pass.

### 1.3 Scope

1. Route inference-bearing notes through inferential scoring — "is this entailed by the
   transcript" rather than "does this string appear in the transcript". All six measured
   cases are entailed.
2. Decide the **selection rule**: when the gate uses lexical vs inferential scoring, and
   whether the lexical sensor stays as a cheap pre-filter.
3. **Recalibrate against a real eval corpus**, reusing `harness/eval/` and the
   `inferential_judge_parity.py` methodology.

### 1.4 Out of scope

- Changing `HIGHEST_HARM_SENSORS` / `REGEN_FIXABLE_SENSORS` membership in the aggregator.
- Changing `numeric_dose`, `schema_validity`, `citation_presence`, or `safety`.
- Any admin-console surface for the new knobs (a follow-up once the shape is settled).
- Provisioning new cloud model capacity. Everything here must stay self-hosted — clinical
  text does not leave the host (`ensure_inferential_egress_safe` is the standing guard).

---

## 2. Current State Evaluation

Five findings from reading the code at `0f81e333f`. Findings 2.1–2.3 mean **scope item 1 is
not a wiring change** — the components the recommendation names do not, as they stand, do
the job asked of them. Finding 2.4 is the most promising lead and was not visible from the
TASK-664 measurement alone.

### 2.1 The inferential lane is precision-only. There is no inferential recall sensor.

| sensor | direction | unit |
|---|---|---|
| `groundedness` | note → transcript | `citationsMap` claims |
| `atomic_fact` | note → transcript | sentence-decomposed note claims |
| `citation_verify` | note → cited chunks | cited claims |
| **`coverage_omission`** | **transcript → note** | **transcript entities** |

Every existing inferential sensor asks *"is what the note says supported?"*. Omission is the
opposite question — *"is what the transcript said still represented?"* — and **nothing in
`sensors/inferential/` answers it**. Scope item 1 is therefore only half-satisfiable by
existing components: the faithfulness direction has a lane to route into; the coverage
direction needs a new sensor built.

This matters because the two sensors fail on the *same* six cases for *opposite* reasons,
and only one of them can be fixed by reusing what exists.

### 2.2 Granularity mismatch: the lanes disagree about what a unit is.

The inferential lane operates on **claims** — `ctx.claims()` from the provenance
`citationsMap`, or sentence-level fragments from `decompose_claims`. The two lexical sensors
operate on **entities** — NER spans from `ctx.note_entities` / `ctx.transcript_entities`.

There is no adapter between them. "Route the note through `groundedness`" does not produce
an entity-level verdict, and an entity (`bilateral peripheral oedema`) is not a well-formed
entailment hypothesis on its own — it is a noun phrase, not a proposition. A new entity-level
entailment sensor needs an explicit entity→hypothesis framing step, and that framing is a
design decision with a measurable effect on verdicts.

### 2.3 `atomic_fact`'s default entailer is itself lexical, and it is OFF by default.

`DeterministicOverlapEntailer(min_overlap=1.0)` — the default `NliEntailer` — entails a
hypothesis iff **every** salient (≥3-char, non-stopword) token appears in the premise. That
is the same lexical test the sensors under repair already apply, just tokenized. Routing
adjudicated notes through `atomic_fact` on the default entailer **reproduces the identical
penalty**.

Genuine inference arrives only via `minicheck_entailer.py` (MiniCheck-Flan-T5 GGUF under
llama.cpp, self-hosted). Three facts about that path constrain the design:

- `atomic_fact` is behind a kill-switch that **defaults OFF**
  (`HARNESS_ATOMIC_FACT_ENABLED`, policy override wins when non-null).
- `_atomic_fact_entailer` treats a MiniCheck build/calibration failure as a config error and
  **falls back to `DeterministicOverlapEntailer`** — i.e. silently back to lexical.
- The load-time calibration gate (`verify_calibration`) is the only thing standing between a
  mis-wired logit read and a confidently wrong entailment verdict.

So "the inferential lane already exists" is true of the *interface*, not of a running,
enabled, calibrated inference backend. Provisioning and proving MiniCheck is a work item of
this ticket, not an assumption of it.

### 2.4 Clinical knowledge is already in the context object — and both sensors ignore it.

`NEREntity` (`sensors/base.py:60`) carries `umls_cui`, `snomed_code`, `rxnorm_code`,
`icd_code`, `loinc_code`, populated by the NLP pass (`services/nlp_client.py:68`), persisted
and re-read (`services/api_client.py:203`), and already consumed elsewhere in the harness —
`_terminology_args` (`temporal/workflows.py:211`) ships them to a FHIR terminology server,
and `_has_ontology_code` (`temporal/activities.py:660`) gates coded-prior reuse.

**Both lexical sensors compare `.normalized` surface text only.** The codes are right there
in the objects they are handed, and neither reads them.

This is the discriminator TASK-664 said the sensors lack. `Tylenol` and `paracetamol` share
an RxNorm ingredient identity; a hallucinated drug name resolves to no code, or to a
different one. Code-identity matching is **deterministic, model-free, self-hosted, and does
not widen the string match by one character** — so it does not run into the §1.2 constraint
at all. It is a different axis, not a looser threshold.

Caveat to measure before relying on it: coverage of the code fields on live NER output is
unknown. `_load_coded_priors` already hedges ("returns priors only when at least one carries
an ontology code — so the reuse is a no-op until the codes are populated"), which suggests
population is not assumed. **Measuring actual code population on real consultations is the
first work item** (P0 below); the rest of the design branches on the answer.

### 2.5 Severity asymmetry and the degrade contract pin the selection rule.

- `entity_faithfulness` is in `HIGHEST_HARM_SENSORS` → failure is a terminal **FLAG**, no
  regen, straight to a clinician. `coverage_omission` is in `REGEN_FIXABLE_SENSORS` → burns
  regen budget, then FLAGs. A false positive on faithfulness is therefore strictly more
  expensive than one on coverage, and needs the stricter parity bar.
- Every inferential sensor **degrades to `passed=False`** on backend outage, and the
  aggregator turns any degraded/missing expected sensor into a blanket FLAG. So if the
  faithfulness verdict *depends* on an inferential backend, a MiniCheck outage becomes a
  FLAG-everything event on the highest-harm sensor.

Together these say: **inference may not become load-bearing for producing a flag.** It can
only be consulted to *withdraw* one. That is the design in §3.1.

---

### 2.6 P0 RESULT — code population is 14.3%, and the effective bridge rate is zero

**Executed 2026-08-12** against the real, production `OntologyLinker`
(`apps/nlp/src/nlp/services/ontology_linker.py`) over the exact entity surface forms of the
six TASK-664 cases, both arms. The linker is deterministic and offline, so this is an exact
measurement, not a sample.

First, the linker **is** live: `linker_enabled` defaults to `True`
(`apps/nlp/src/nlp/core/config.py:300`), it is wired into token classification
(`token_classifier.py:227`), and the confidence floor is `0.0`. So codes are populated in
production wherever the vocabulary hits. The mechanism is real. The coverage is not.

| measure | result |
|---|---|
| vocabulary size | 67 normalized aliases (43 curated entries), **exact-match** dict lookup |
| **code population** | **7 / 49 entity surface forms (14.3%)** receive any ontology code |
| **bridge rate, faithfulness** | **1 / 17 (5.9%)** adjudicated entities share a code with a transcript entity |
| **bridge rate, coverage** | **1 / 16 (6.2%)** transcript entities reachable from the note by code |
| **bridge rate on *genuine* abstraction** | **0 / 16 (0.0%)** |

The single "bridge" is `chest pain` → `chest pain` in `temporal-abstraction` — an entity that
was **already lexically identical** and which the incumbent lexical sensor grounds without
help. Code identity rescues **zero** genuinely abstracted entities.

Two structural reasons, both visible in the linker:

- **Exact-match on the whole span.** `dyspnoea` is in the vocabulary; `exertional dyspnoea`
  is not, and `_normalize` does no head-term extraction, so the abstracted multi-word form
  misses. Same for `bilateral peripheral oedema`, `capillary blood glucose`.
- **The flagship case has no codes on either side.** `Tylenol`, `paracetamol`, and
  `acetaminophen` are **all absent from the vocabulary**. The brand→generic example TASK-664
  leads with cannot be bridged by codes, in either direction. (`albuterol`/`salbutamol` *is*
  a coded synonym pair — but the transcript says `Ventolin`, which is also absent.)

One result in the correct direction, worth recording: `pneumonia` codes on the adjudicated
side and is **not** bridged, because the transcript never mentions it. The safety direction
behaves as designed — codes did not manufacture a false grounding.

**Decision — P2 is DEFERRED, per the gate this ticket set for itself in §3.2.** The §2.4
lead was a good hypothesis and the measurement refuted it as a *primary* mechanism. Building
it anyway would mean shipping a path that fires on 0% of the cases it was justified by.

The mechanism is not wrong — the *vocabulary* is a 67-alias curated subset with no partial
matching. Making it load-bearing would require a real self-hosted UMLS/MedCAT install and a
head-term matching strategy, which is unbounded work with its own safety surface (a partial
match is a looser match, and §1.2 applies to it). That is a separate ticket, not a work item
here. **Extending the vocabulary inside this ticket to make the number look better is
explicitly rejected** — it would be tuning the instrument to fit the hypothesis.

**Consequence: P3 (entity-level entailment) is now the sole load-bearing mechanism**, and
carries the full 16-entity faithfulness residue and 15-entity coverage residue.

### 2.7 P3 backend availability (checked 2026-08-12)

- MiniCheck weights are **not staged** on this host (`/models/harness-cache` does not exist),
  and `HARNESS_ATOMIC_FACT_ENABLED=false` in `.env.dev`. The deterministic NLI cannot be
  end-to-end calibrated here without provisioning weights.
- The **LM Studio judge is live** (`localhost:1234`) with the configured
  `HARNESS_JUDGE_MODEL=google/gemma-4-e4b-qat` — the same backend `groundedness` uses in
  production today.

So P3 is built **backend-agnostic**: the sensor takes an injected entailment backend, is
unit-tested with deterministic fakes, and the real P5 calibration runs against the available
LM Studio judge. MiniCheck remains the intended deterministic upgrade behind the same
interface once weights are staged — it is not a blocker.

---

## 3. Implementation Plan

### 3.1 The selection rule (scope item 2) — escalation, not replacement

**Recommended: lexical stays as the floor and the pre-filter; inference is an
adjudication step applied only to the lexically-flagged residue, and can only overturn a
flag to pass — never create one.**

```
entity/transcript entities
        │
        ▼
  lexical sensor (unchanged)      ← cheap, deterministic, runs always
        │
        ├─ matched ─────────────────────────────────► grounded / covered
        │
        └─ unmatched (the "residue")
                 │
                 ▼
        entity-level entailment (injected backend)
                 ├─ entailed ──────────────────────► grounded / covered
                 ├─ not entailed ──────────────────► FLAG (as today)
                 └─ degraded / disabled ───────────► FLAG (as today)
```

_(The code-identity step originally planned between these two was **removed** after the P0
measurement returned a 0% effective bridge rate — see §2.6.)_

Why this shape:

- **Fail-safe is preserved unchanged.** Every path where inference is unavailable, disabled,
  or uncertain lands on today's verdict. An outage costs recovered abstraction, never added
  safety. This is the only shape that satisfies §2.5's second bullet.
- **The dangerous direction is structurally closed.** Inference is never asked to *create* a
  flag, so an over-permissive entailer cannot manufacture a false FLAG, and a hallucinated
  entity still has to survive three independent checks to reach PASS.
- **Cost stays bounded.** The residue on a parroted note is empty, so the common case costs
  nothing. Only genuinely divergent notes pay for inference.
- **It is directly measurable with the existing instrument.** Every change the gate can make
  is a single flip type — `flagged → passed` — which is exactly the unit
  `inferential_judge_parity.diff_verdicts` already counts and exports for adjudication.

**Rejected alternative — replace the lexical sensors with inferential ones.** It makes an
inferential backend load-bearing on the highest-harm sensor (§2.5), converts every backend
outage into a FLAG-everything event, and discards a cheap deterministic signal that is
correct on the majority arm. It would also delete rather than update the §1.2 regression lock.

**Consequence for the regression lock.** `test_adjudication_penalty_task664.py` measures the
*sensors in isolation* and must keep passing unchanged — the lexical sensors are not being
modified. The recovery is a property of the **gate**, so it is asserted by a new sibling
test at the gate level. The lock's docstring gets one added paragraph pointing at TASK-671
and stating that the isolated-sensor penalty is now expected-and-compensated rather than
expected-and-unaddressed. That is the "deliberate update" §1.2 requires.

### 3.2 Work items

| # | Item | Gate |
|---|---|---|
| **P0** | ✅ **DONE** — measured ontology-code population (§2.6). | Result: 14.3% population, **0% effective bridge rate**. Gate applied as written: **P2 deferred**. |
| **P1** | **Build the two-arm eval corpus** (§3.3). | Both arms present; the fabrication arm independently reviewed as genuinely fabricated. |
| ~~P2~~ | ~~Code-identity grounding path~~ — **DEFERRED by the P0 result** (§2.6). Not implemented. | n/a |
| **P3** | **Entity-level entailment sensor** — the missing adapter (§2.2). Frames an entity as a proposition against the transcript premise and reuses the `NliEntailer` protocol so MiniCheck and the overlap entailer both slot in. Covers **both** directions, closing the §2.1 recall gap. | Deterministic verdicts; degrade-on-outage proven by test; **never** returns a pass on the `DeterministicOverlapEntailer` fallback that the lexical sensor did not already return (else the fallback silently re-lexicalizes). |
| **P4** | **Wire the escalation** (§3.1) into `run_sensors` / the aggregator path, behind a kill-switch defaulting OFF. Thresholds untouched. | Full harness suite green; replay-compat tests green (`workflows.py` must not gain a new command — resolve at activity level, as `atomic_fact` already does). |
| **P5** | **Two-arm calibration + parity report** (§3.3). | The joint criterion below. Publish the report; a partial pass is a partial pass. |
| **P6** | Update the §1.2 regression lock docstring; add the gate-level recovery test; update this README's Implementation Summary. | Documented evidence, actual output pasted. |

`atomic_fact`/MiniCheck provisioning (§2.3) is a prerequisite of P3 — if MiniCheck cannot be
made to pass its own calibration gate on this host, P3 stops there and says so.

### 3.3 Recalibration (scope item 3) — the corpus must have two arms

The TASK-664 corpus has only a **should-pass** arm (six clinically correct abstracted notes).
Calibrating against it alone is trivially gameable: any change that passes everything scores
100%. The corpus therefore needs a paired **should-flag** arm — the same transcripts with
*injected* fabrications of the same lexical shape as the legitimate abstractions:

| legitimate (must recover) | injected fabrication (must still flag) |
|---|---|
| `Tylenol` → `paracetamol` (same ingredient) | `Tylenol` → `tramadol` (different drug, plausible surface) |
| findings → `hyperglycaemia` (entailed) | findings → `diabetic ketoacidosis` (not entailed) |
| two views → `lower respiratory tract infection` (superordinate) | two views → `pulmonary embolism` (neither view, not entailed) |
| `140/90` normalized units | `150/90` — a numeric change wearing an abstraction's clothes |

**Pass criterion is joint, and both halves are required:**

- **Recovery** — of the abstraction arm's currently-flagged entities, a target fraction is
  recovered to PASS. Target set from the P5 measurement, not asserted in advance.
- **Retention** — of the fabrication arm, **100%** stay flagged. Zero unsafe flips. This
  inherits the `inferential_judge_parity` R-8 bar verbatim: an unsafe flip
  (flagged → grounded on genuinely fabricated content) is a **stop**, not a tuning input.

Reuse `inferential_judge_parity.diff_verdicts` / `summarize_parity` — the directional
confusion, the unsafe/safe flip split, and the per-disagreement export for human
adjudication are exactly the instrument this needs. A new module
(`harness/eval/entity_grounding_parity.py`) with the incumbent = today's lexical sensors and
the candidate = the escalation chain.

Every unsafe flip is **exported for clinician adjudication before any threshold moves**. A
disagreement is evidence to be read, not a number to be optimized against.

**Thresholds are expected not to change.** The escalation changes *what counts as grounded*,
not *how much grounding is required*. If the P5 report concludes a threshold must move, that
is a separate decision requiring its own justification against §1.2 — not a calibration edit
folded into this ticket.

### 3.4 TDD order

1. P0 measurement script + recorded output (no production code).
2. P1 corpus fixture; a test asserting today's gate fails the fabrication arm (**RED must be
   observed** — if it already passes, the arm is not adversarial enough).
3. P2 code-identity unit tests → implementation.
4. P3 entity-entailment unit tests, incl. degrade + fallback-does-not-loosen → implementation.
5. P4 escalation wiring tests → implementation → full suite + replay-compat.
6. P5 parity run → report → adjudication.
7. P6 docs + lock update.

---

## 4. Verification Criteria

- [ ] `pnpm harness:test` green; no regression against the `0f81e333f` baseline.
- [ ] `pnpm harness:lint` + `pnpm harness:typecheck` green.
- [ ] Replay-compat tests green — `workflows.py` gains no new command.
- [ ] `test_adjudication_penalty_task664.py` still passes, docstring deliberately updated.
- [ ] New gate-level test proves recovery on the abstraction arm.
- [ ] Two-arm parity report published: **zero unsafe flips on the fabrication arm**.
- [ ] Every new path is kill-switched, default OFF, and degrades to today's verdict.
- [ ] P0 code-population number recorded, whatever it says.
- [ ] No clinical text leaves the host on any new path.

---

## 5. Implementation Summary

_(to be completed during implementation)_

---

## 6. Open Questions

1. **Ontology-code population on live NER** — P0 answers this; P2 is contingent on it.
2. **Entity→hypothesis framing** (§2.2) — a noun phrase is not a proposition. Framing choice
   affects verdicts and needs its own small ablation inside P3.
3. **MiniCheck calibration on the target host** (§2.3) — unproven here; a failure caps this
   ticket at P2.
4. **Coverage direction cost** — the recall check is per *transcript* entity, potentially a
   larger residue than the faithfulness direction. May need a separate budget or a cheaper
   first pass; measure in P5 before optimizing.

---

## 7. References

- `docs/implementation/TASK-664-Reasoning-Primary-And-Specialists/README.md` §1 — the full
  measurement, reasoning, and recommendation.
- `apps/harness/src/harness/tests/unit/sensors/test_adjudication_penalty_task664.py` — the
  regression lock.
- `apps/harness/src/harness/eval/inferential_judge_parity.py` — the parity methodology this
  ticket reuses.
- arXiv 2604.14829, *Beyond Literal Summarization* — lexical evaluation reporting ~35%
  hallucination where inference-aware evaluation gives ~9%.

---

## 8. Change History

- **2026-08-12** — Ticket opened from the TASK-664 §1 recommendation, after merging TASK-664
  into `dev-2.1` (`0f81e333f`). Current-state evaluation recorded five findings, three of
  which (§2.1 recall gap, §2.2 granularity mismatch, §2.3 lexical default entailer) mean the
  recommended "route through the existing inferential lane" is not a wiring change; §2.4
  identifies unused ontology codes already present in `SensorContext` as a deterministic
  discriminator that does not violate the §1.2 constraint. Plan status: **Pending user
  approval** — no code written.
