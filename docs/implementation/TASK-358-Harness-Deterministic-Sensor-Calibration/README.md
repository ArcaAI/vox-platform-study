# TASK-358 — Calibrate the Harness Deterministic Sensors (stop FLAG-ing every run)

| | |
|---|---|
| **Ticket** | TASK-358 |
| **Title** | Schema alignment, NER token cleanup, and threshold calibration for the harness gate |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-14 |
| **Status** | **Pending** — planning doc; awaiting plan approval (Phase-3 gate) before any code |
| **Type** | quality / calibration |
| **Affected areas** | `apps/harness` deterministic sensors (`sensors/computational/*`, `sensors/aggregator.py`, `sensors/config.py`, `sensors/base.py`), the sensor runner + provenance (`services/sensor_runner.py`, `services/provenance.py`), prompt/output schema contract (assemble path), NER input quality |
| **Spawned from** | TASK-355 §8 observation #2 + [TASK-355 Appendix 04 §3](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) (measured-run gate instantiation) |
| **Related** | TASK-356 (admin-managed prompt templates / thresholds — see §3) |

> Planning document. **No code is changed by this ticket yet.** It documents the calibration
> problem, grounds it in the live code, and proposes a TDD implementation plan for approval.
> Status stays **Pending** until the plan is approved.

---

## 1. Requirement Analysis

### 1.1 Description

On the measured TASK-355 run, the harness gate **FLAGs essentially every consultation**, for
reasons that are mechanical rather than clinical:

- **`schema_validity = 0.0`** — the generation model emits a **markdown** SOAP note, but the
  schema sensor validates against the **JSON schema** the prompt activated. A markdown note never
  conforms → always 0.0.
- **`entity_faithfulness = 0.474` vs a zero-tolerance threshold of `1.0`** — combined with NER
  noise, more than half of "note entities" appear ungrounded.
- **NER artifacts counted as clinical entities** — the live NER returns SentencePiece-tokenized
  surfaces (e.g. `▁One` from a "one, two, three" mic-check) and BIO-tagged subword tokens; these
  reach the entity-level sensors as if they were real clinical entities.

**Net effect:** `entity_faithfulness < 1.0` is a HIGHEST-HARM failure → the aggregator **FLAGs**,
outranking the (REGEN-fixable) schema failure. Human review is therefore **always** forced, the
regen budget is **never** used, and the gate scores carry **little discriminative signal** — a good
note and a bad note both FLAG.

This ticket recalibrates the deterministic gate so it **discriminates** good vs bad notes, across
three workstreams: **(a) schema alignment**, **(b) NER token cleanup**, **(c) threshold
calibration** — while **preserving every conservative-safety direction**.

### 1.2 Business context

- A gate that FLAGs everything is equivalent to **no gate** for triage purposes: it adds latency and
  reviewer fatigue without separating safe drafts from unsafe ones, and it **defeats** the
  optimistic-delivery / regen design that TASK-355 Phase B/D built (the regen budget is dead code in
  practice).
- It also **masks** real failures: when everything FLAGs, a genuinely unfaithful or unsafe note is
  indistinguishable from a mic-check artifact.
- Latency relevance (the TASK-355 lens): fixing calibration changes **which paths actually fire**
  (e.g. whether the REGEN tail ever runs), so it is a prerequisite to trusting the gate's behaviour
  under the new optimistic-delivery lifecycle.

### 1.3 Acceptance criteria

- **AC-1 (discrimination)** — On a small **labeled fixture set** (good notes vs notes seeded with a
  fabrication / omission / wrong dose / schema break), the gate produces **PASS for good** and the
  correct **FLAG/REGEN for bad** — it is **not** FLAG-always.
- **AC-2 (schema)** — `schema_validity` reflects the **actual** activated output contract: either
  the note is generated/parsed in the schema the validator checks, or the validator checks the
  format the note is actually in. A correctly-structured note scores `1.0`.
- **AC-3 (NER cleanup)** — SentencePiece (`▁`/U+2581) markers and BIO subword fragmentation are
  stripped/merged on the **entity-level sensor** matching path (not only the claims path), and
  obvious non-clinical noise (mic-check counting, empty/stopword tokens) does not count as a
  clinical entity.
- **AC-4 (thresholds)** — Brittle zero-tolerance thresholds are calibrated to defensible values
  (or the inputs feeding them are cleaned so 1.0 is achievable for a faithful note), **without
  loosening the safety direction**: fabrication and numeric/dose remain the strictest checks.
- **AC-5 (invariants preserved)** — Degraded/missing inputs still FLAG (never auto-PASS); unsafe
  content is never auto-regenerated; conservative-failure directions (unparseable/ambiguous →
  stricter) are maintained (TASK-355 §7).

---

## 2. Current State Evaluation (grounded in live code)

### 2.1 Schema validity is JSON-only; the model emits markdown

- `apps/harness/src/harness/sensors/computational/schema_validity.py:38` — `SchemaValiditySensor`
  is a **binary** gate: `1.0` valid / `0.0` invalid (`:39`), validates `ctx.soap_sections` against
  the activated JSON schema via `Draft202012Validator` (`:54-55`); a missing schema is `degraded`
  (`:44-51`).
- `apps/harness/src/harness/services/sensor_runner.py:51` — `_parse_soap()` parses the note as
  **JSON only** (`json.loads`), returning `{}` for a non-JSON (markdown) note. `:94`
  `soap_sections = _parse_soap(note_text)` feeds the `SensorContext` (`:113-115`).
- `sensor_runner.py:60` — `_parse_soap_markdown()` exists, **but** its result is used **only** for
  provenance/citation attribution (`:102` `provenance_sections = soap_sections or _parse_soap_markdown(...)`),
  and the code comment (`:96-101`) is explicit: *"The SensorContext keeps the strict JSON parse, so
  schema_validity … is unchanged — a markdown note still fails the schema gate."* → a markdown note
  → `soap_sections={}` → schema validation → `0.0`.

### 2.2 Entity-faithfulness is zero-tolerance and sees raw NER

- `apps/harness/src/harness/sensors/computational/entity_faithfulness.py:25` — default
  `threshold=1.0` (zero-tolerance); `:64` `score = len(supported) / total`; `:69`
  `passed = score >= threshold`; grounding test `:57-61` uses `entity.normalized in transcript_norm`.
- `apps/harness/src/harness/sensors/config.py:22` — `entity_faithfulness_threshold = 1.0` (and
  `numeric_dose_threshold = 1.0` at `:28`, `coverage_threshold = 0.8` at `:24`,
  `groundedness_threshold = 0.8` at `:32`). The docstring (`:1-8`) frames the zero-tolerance values
  as deliberately conservative for the highest-harm checks.

### 2.3 The NER-cleanup asymmetry (the crux of the noise)

The `▁`/BIO cleanup **is** implemented — but **only on the claims/provenance path**, not on the
entity-level sensors:

- **Cleaned (claims path):** `apps/harness/src/harness/services/provenance.py:46` `_clean_claim_text`
  (strips `▁`), `:58` `_match_norm` (▁-insensitive matching key), `:75` `_aggregate_subword_entities`
  (merges BIO `B-`/`I-` subword tokens into phrase-entities), `:38` `_SUBWORD_MARKER = "\u2581"`.
  These feed `build_citations_map` (`:186`), i.e. the **claims** used by groundedness / citation /
  citation_presence.
- **NOT cleaned (entity-level sensors):** `apps/harness/src/harness/sensors/base.py:28`
  `normalize_text()` only case-folds + collapses whitespace — it does **not** strip `▁`; `:55-57`
  `NEREntity.normalized` uses it. `services/sensor_runner.py:117-118` builds the `SensorContext`
  with the **raw** `note_entities` / `transcript_entities`. So `entity_faithfulness` and
  `coverage_omission` compare `▁`-bearing, BIO-fragmented surfaces (e.g. `▁One`, `B-MEDICATION`
  tokens) against the plain transcript → spurious mismatches drive the score down.
- Existing test evidence of the live shape: `tests/unit/services/test_sensor_runner.py:94`
  ("▁-bearing, BIO-tokenized entities the live NLP returns"); `tests/unit/services/test_provenance.py:87`
  ("strip SentencePiece word-boundary markers"). NER source:
  `temporal/activities.py:196` `extract_entities` → `services/nlp_client.py` `classify_tokens`.

### 2.4 Why the gate FLAGs everything (aggregator order)

- `apps/harness/src/harness/sensors/aggregator.py:55` — `HIGHEST_HARM_SENSORS = (entity_faithfulness,
  numeric_dose, "safety")`; `:112-119` any highest-harm failure → **FLAG** (returns before the
  REGEN-fixable check at `:121-138`). So with `entity_faithfulness < 1.0`, the gate FLAGs and the
  schema/coverage REGEN path never gets a say.
- Measured-run instantiation (Appendix 04 §3, `04-gating-inventory.md:89`): groundedness failed
  (REGEN-label) **but** `entity_faithfulness` (0.474) and `numeric_dose` (0.6) also failed → FLAG
  outranked REGEN → loop exited, regen budget untouched.

### 2.5 Dependencies & impact areas

- **Upstream NER quality** (mic-check noise) originates in the NLP service
  (`apps/nlp` via `services/nlp_client.py`); cleanup can be done harness-side (filter/normalize) and/or
  by improving the NLP contract. Harness-side cleanup is the lower-risk first step.
- **Impact areas:** the computational sensors + their thresholds; the sensor runner / context
  construction; possibly the assemble/prompt output-format contract (schema alignment intersects
  TASK-356's prompt templates — see §3). **No DB schema change**; thresholds already live in
  `sensors/config.py` (env `HARNESS_SENSOR_*`) and in `HarnessPolicy` for the policy-driven ones.
- **No UI change** required for the calibration itself.

---

## 3. Relationship to TASK-356

[TASK-356 — Admin-Managed Models & Workflows](../TASK-356-Admin-Managed-Models-Workflows/README.md)
manages **prompt templates** (tenant→department→doctor, §4.6) and surfaces **gating/thresholds** as
admin-configurable policy (§2.4, §4.2 "Gating / thresholds / regen" stays in `HarnessPolicy`,
tenant+global). Two intersections:

- **Schema alignment ↔ prompt templates:** the note's output **format** (markdown vs JSON SOAP) is
  governed by the activated prompt template / `responseFormat` that TASK-356 lets admins manage.
  TASK-358 must align the **validator** with the **actual** activated contract; it should **not**
  build the admin template-management surface (that is TASK-356).
- **Threshold calibration ↔ admin-configurable thresholds:** TASK-358 sets **defensible default
  values** (and cleans the inputs). Making those thresholds **admin-editable** is **TASK-356's**
  scope (`HarnessPolicy` thresholds). No overlap: **TASK-358 = correct the defaults + fix the
  bugs; TASK-356 = expose them for admin control.**

**Scope guard:** TASK-358 changes *calibration logic + values + NER/schema correctness*; it defers
*who can configure them* and *the template-authoring UI* to TASK-356. Cross-reference both ways once
numbers are known (this ticket does not edit TASK-356's doc).

---

## 4. Implementation Plan (proposed — **await approval before coding**, Phase-3 gate)

> TDD Red-Green-Refactor; harness Python/pytest under the `arcaenv` conda env. **A labeled fixture
> set is the centerpiece** — the gate must be proven to discriminate, per the project's
> goal-driven / verification-before-completion practice.

### 4.0 Decision gates to confirm before coding

- **D-A (schema direction):** make generation **emit/parse JSON SOAP** that the validator checks,
  **or** make `schema_validity` validate the **markdown** structure the model actually produces
  (reusing `_parse_soap_markdown`). Recommend: validate against the **activated contract** —
  if the template requests JSON, fix generation/parse; if markdown is the intended product, validate
  markdown structure. Must be decided with the TASK-356 template direction.
- **D-B (threshold philosophy):** prefer **cleaning inputs so a faithful note legitimately reaches
  1.0** over simply lowering the fabrication threshold. Only relax a threshold where the check is
  inherently graded (and never relax the safety direction).

### 4.1 Workstream (a) — schema alignment

- Align `schema_validity` (`schema_validity.py`) / `_parse_soap` (`sensor_runner.py:51`) with the
  activated output format so a correctly-structured note scores `1.0`. Per D-A, either parse the
  model's actual format or constrain generation to the validated schema.

### 4.2 Workstream (b) — NER token cleanup

- Apply the **existing** `▁`/BIO cleanup to the **entity-level** path: either strip `▁` in
  `normalize_text` (`base.py:28`) / `NEREntity.normalized`, or feed the sensors the
  `_aggregate_subword_entities` + `_clean_claim_text` output (reuse `provenance.py:46/75`) when
  building the `SensorContext` (`sensor_runner.py:113-118`). Keep one source of truth for cleanup.
- Filter obvious non-clinical noise (mic-check counting words / empty / stopword tokens) so they do
  not count as clinical entities — harness-side filter first; optionally tighten the NLP contract.

### 4.3 Workstream (c) — threshold calibration

- Re-derive `HARNESS_SENSOR_*` defaults (`sensors/config.py`) against the labeled fixture set;
  keep fabrication/numeric-dose conservative (per D-B, prefer clean-inputs-to-1.0). Document the
  rationale for each value.

### 4.4 TDD test list (write first; must see RED)

| # | Test (pytest) | Asserts |
|---|---|---|
| T1 | a well-formed good note (clean entities, faithful) → gate **PASS** | AC-1, AC-2, AC-4 |
| T2 | note with a fabricated entity → **FLAG** (entity_faithfulness) | AC-1, AC-5 |
| T3 | note with a wrong dose → **FLAG** (numeric_dose) | AC-1, AC-5 |
| T4 | note missing transcript coverage / a schema break → **REGEN** (regen-fixable, budget remaining) | AC-1 |
| T5 | correctly-structured note → `schema_validity == 1.0` (markdown OR JSON per D-A) | AC-2 |
| T6 | `▁One` / BIO subword note entities are cleaned/merged on the **entity_faithfulness** path; no longer spuriously unsupported | AC-3 |
| T7 | mic-check counting tokens do not count as clinical entities | AC-3 |
| T8 | degraded inputs (no transcript) still FLAG (never auto-PASS) | AC-5 |
| T9 | calibrated thresholds: faithful note reaches/passes; unfaithful note fails — on the labeled set | AC-4 |

### 4.5 Verification criteria

- The labeled fixture set demonstrates **discrimination** (a confusion-style summary: good→PASS,
  each bad class→correct FLAG/REGEN), captured as evidence.
- New + existing harness suites green; `ruff`/mypy clean on changed files.
- Spot-check against the original TASK-355 measured consultation (`019eb9ee…`) shape to confirm the
  mic-check artifacts no longer drive the score, **without** loosening safety.

---

## 5. Risks & invariants

- **Risk of loosening:** the central danger is "fixing FLAG-always" by simply weakening safety. The
  plan mitigates via **clean-inputs-to-1.0** (D-B) and a labeled fixture gate; **fabrication /
  numeric-dose / safety directions stay conservative** (TASK-355 §7).
- **Schema decision coupling:** D-A is coupled to TASK-356's template/output-format direction; align
  before implementing to avoid rework.
- **NER cleanup single-source:** avoid two divergent cleanup implementations (claims vs entities) —
  consolidate on the `provenance.py` helpers.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Planning ticket created (no code). Spawned from TASK-355 §8 observation #2 + Appendix 04 §3; grounded in live code (`sensors/computational/schema_validity.py`, `entity_faithfulness.py`, `sensors/config.py`, `sensors/aggregator.py`, `sensors/base.py`, `services/sensor_runner.py`, `services/provenance.py`); three workstreams (schema / NER cleanup / thresholds) defined; TASK-356 intersections (prompt templates, admin-configurable thresholds) scoped to avoid overlap. Status = Pending, awaiting plan approval. | `docs/implementation/TASK-358-Harness-Deterministic-Sensor-Calibration/README.md` |
