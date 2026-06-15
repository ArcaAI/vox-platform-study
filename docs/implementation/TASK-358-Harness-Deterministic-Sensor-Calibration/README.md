# TASK-358 — Calibrate the Harness Deterministic Sensors (stop FLAG-ing every run)

| | |
|---|---|
| **Ticket** | TASK-358 |
| **Title** | Schema alignment, NER token cleanup, and threshold calibration for the harness gate |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-15 |
| **Status** | **Completed** — implemented + production-hardened (TDD); user sign-off 2026-06-15 |
| **Type** | quality / calibration |
| **Affected areas** | `apps/harness` deterministic sensors (`sensors/computational/*`, `sensors/aggregator.py`, `sensors/config.py`, `sensors/base.py`), the sensor runner + provenance (`services/sensor_runner.py`, `services/provenance.py`), prompt/output schema contract (assemble path), NER input quality |
| **Spawned from** | TASK-355 §8 observation #2 + [TASK-355 Appendix 04 §3](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) (measured-run gate instantiation) |
| **Related** | TASK-356 (admin-managed prompt templates / SMR provider+model selection — see §3); TASK-330 Phase 6 (admin-editable harness gating thresholds — already live end-to-end) |

> The plan (§4) was **approved** and **implemented** under TDD on 2026-06-15. The calibration
> problem and current-state grounding (§1–§2) are retained for context; the as-built result is in
> **§7 Implementation Summary**. Status is **Completed** (user sign-off 2026-06-15).

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
  → `soap_sections={}`.
- **Correction (how it actually failed, by resolved template):** a markdown note does **not** always
  fail as "`0.0` invalid". It depends on what the prompt resolved:
  - **`responseFormat == null`** — the **common department / `CATCHALL_SOAP` path** (those templates
    carry **no** `outputSchema`). With `soap_sections = {}` and no schema, `schema_validity` hits the
    missing-schema branch → **DEGRADED** (`score 0.0`, `degraded=True`). Degraded outranks REGEN in the
    aggregator, so even a *complete* markdown note was penalised as un-verifiable.
  - **`responseFormat` is a `json_schema`** — only a schema-bearing template (e.g. `SOAP_SUMMARY`)
    reaches the validator with `{}`, producing the **"`0.0` invalid"** (required-property) failure.
  Either way a correctly-structured markdown note never scored `1.0`. TASK-358 fixes **both** (see §7).

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
manages **prompt templates** (tenant→department→doctor, §4.6) and adds **SMR provider/model
selection** on the `HarnessPolicy` table; it treats **gating/thresholds** as **"already works /
unchanged"** (§4.2 "Gating / thresholds / regen" stays in `HarnessPolicy`, tenant+global). The
admin-editable threshold chain itself was **already delivered by TASK-330 Phase 6**, not TASK-356
(see the calibration bullet below). Two intersections:

- **Schema alignment ↔ prompt templates:** the note's output **format** (markdown vs JSON SOAP) is
  governed by the activated prompt template / `responseFormat` that TASK-356 lets admins manage.
  TASK-358 must align the **validator** with the **actual** activated contract; it should **not**
  build the admin template-management surface (that is TASK-356).
- **Threshold calibration ↔ admin-editable thresholds:** TASK-358 sets **defensible default
  values** (and cleans the inputs). Making those thresholds **admin-editable was already delivered
  end-to-end by [TASK-330 Phase 6](../TASK-330-Clinical-Documentation-Harness/README.md)**, not
  TASK-356. The full chain is live for **all five** thresholds (`entityFaithfulness`, `coverage`,
  `citationPresence`, `numericDose`, `groundedness`): `HarnessPolicy` columns
  (`packages/database/.../harness.prisma`), the domain entity/factory/repo + WORM
  `HarnessPolicyChange`, `harness-policy.service.ts` (`HarnessPolicyKnobs`, OCC CAS), the
  update/response DTOs, the `GET/PATCH /admin/harness/policy` (+ `/policy/global`) API, the admin UI
  `policy-editor.tsx` (`THRESHOLD_FIELDS`, safety-weakening confirm), and the harness consumer
  `temporal/models.py` `to_sensor_thresholds()` threaded at `temporal/workflows.py` into
  `run_sensors`. TASK-356 only added **SMR provider/model selection** on the same table and
  explicitly marks gating/thresholds as **"already works / unchanged"**. No overlap: **TASK-358 =
  correct the defaults + fix the bugs; admin control already exists (TASK-330 Phase 6).**

**Scope guard:** TASK-358 changes *calibration logic + values + NER/schema correctness*. *Who can
configure the thresholds* is **already delivered** (admin-editable via **TASK-330 Phase 6**); only
*the template-authoring UI* belongs to TASK-356. Cross-reference once numbers are known (this ticket
does not edit TASK-330's or TASK-356's docs).

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

## 6. Implementation Summary (as-built — 2026-06-15)

Implemented under TDD (RED→GREEN→refactor) in the `arcaenv` conda env. Decisions **D-A = Option 1**
(validate the markdown/JSON structure **harness-side**, no prompt/template edits) and **D-B**
(clean inputs so a faithful note legitimately reaches 1.0; **do not** loosen thresholds) were
followed exactly.

### 6.1 What was built (three workstreams)

- **(a) Schema alignment** — `schema_validity` now validates the **actual** activated contract.
  `sensor_runner` derives `soap_sections` from `_parse_soap(note) or _parse_soap_markdown(note)`, so a
  markdown SOAP note (the common path) produces real sections. The sensor scores **1.0** for a complete
  S/O/A/P note in **both** cases: `responseFormat == null` → validate the **default S/O/A/P structural
  contract** (all four present + non-empty); `responseFormat` is a `json_schema` → validate the parsed
  structure against the schema's `required` + jsonschema type/`additionalProperties` constraints. A
  section that is **missing/empty** is a regen-fixable break (`0.0`, the S/O/A/P code reported); a
  **truly empty/unparseable** note (no sections at all) stays **degraded** (never auto-PASS).
- **(b) NER token cleanup** — `normalize_text` (`base.py`) now strips the SentencePiece `▁` (U+2581)
  marker, so `NEREntity.normalized` matches the plain transcript/section text (consistent with the
  claims path). When building the `SensorContext`, `sensor_runner` runs the note/transcript entities
  through the **single** shared helper `provenance.clean_entities_for_sensors`, which **reuses** the
  existing `_aggregate_subword_entities` + `_clean_claim_text` logic (merge `B-`/`I-` BIO subwords,
  strip `▁`) and then drops non-clinical noise (mic-check counting words `one/two/three…`, bare
  stopwords, empty tokens). The same cleaned entities feed the `citationsMap` — no divergent second
  cleanup implementation.
- **(c) Threshold calibration** — **no values changed** (D-B). The labeled fixture set proves the
  existing defaults (`entity_faithfulness=1.0`, `numeric_dose=1.0`, `coverage=0.8`, `groundedness=0.8`)
  discriminate once the inputs are clean. Rationale documented in `sensors/config.py`’s docstring.

### 6.2 Files changed

| File | Purpose of change |
|---|---|
| `apps/harness/src/harness/sensors/base.py` | `normalize_text` strips `▁`; new module-level `SUBWORD_MARKER` (single source of the marker). |
| `apps/harness/src/harness/services/provenance.py` | Single-source `SUBWORD_MARKER` from `base`; add public `clean_entities_for_sensors` (reuses subword aggregation; adds non-clinical-noise filter). |
| `apps/harness/src/harness/services/sensor_runner.py` | `soap_sections` = JSON-or-markdown parse for the `SensorContext`; clean entities once for **both** `citationsMap` + context. |
| `apps/harness/src/harness/sensors/computational/schema_validity.py` | Validate the actual contract (schema `required` when present; default S/O/A/P when null); degraded only for truly empty/unparseable. |
| `apps/harness/src/harness/sensors/config.py` | Docstring rationale for the D-B validation (no value change). |
| `…/tests/unit/sensors/test_sensor_calibration.py` *(new)* | Labeled fixture set + T1–T9 discrimination over a shared transcript. |
| `…/tests/unit/sensors/test_schema_validity.py` | D-A structural-contract cases (complete-without-schema → 1.0; incomplete → REGEN-fixable; empty → degraded). |
| `…/tests/unit/sensors/test_base.py` | `normalize_text` `▁`-stripping cases. |
| `…/tests/unit/services/test_sensor_runner.py` | Unparseable note now degrades schema_validity → FLAG. |
| `…/tests/unit/services/test_provenance.py` | Unit tests for `clean_entities_for_sensors` (merge / mic-check / stopword / phrase-survives). |

### 6.3 Discrimination evidence (AC-1)

Confusion summary over the labeled set on the **common `responseFormat=null` path** (the case that
previously degraded). Before the change, every row FLAGged (schema degraded for all). After:

| Labeled note | Decision | Driving sensor (score) |
|---|---|---|
| good (JSON) | **PASS** | all sensors 1.0 |
| good (markdown `**Subjective:**`) | **PASS** | all sensors 1.0 (schema_validity 1.0) |
| good (markdown `**SUBJECTIVE (S)**`) | **PASS** | all sensors 1.0 (schema_validity 1.0) |
| fabrication (note entity absent from transcript) | **FLAG** | entity_faithfulness 0.8 |
| wrong dose (note 20 mg vs tx 10 mg) | **FLAG** | numeric_dose 0.833 |
| omission (covered entity dropped) | **REGEN** | coverage_omission 0.5 |
| schema-break (markdown missing Plan) | **REGEN** | schema_validity 0.0 → regen `P` |
| degraded (no transcript) | **FLAG** | entity_faithfulness 0.0 (degraded) |

The gate now emits all three decisions (PASS / REGEN / FLAG) — it is no longer FLAG-always.

### 6.4 Verification

- **RED → GREEN:** the new/updated tests failed first for the right reasons (schema degraded on the
  null path; `▁` not stripped; entities not cleaned; unparseable note not degraded), then passed.
- **Suites green:** full harness unit suite **615 passed** under `arcaenv` (`-m "not e2e and not
  integration"`); the targeted sensors + sensor_runner + provenance subset **61 passed**.
- **Lint/type:** `ruff` and `mypy` **clean** on all changed source files; `black`-formatted.

### 6.5 Invariants preserved (AC-5) & deviations

- **Invariants:** `entity_faithfulness`/`numeric_dose` stay **zero-tolerance** (1.0); degraded/missing
  inputs still **FLAG** (never auto-PASS); the aggregator (`aggregator.py`) and the regen/order logic
  were **not** touched (TASK-359 lane).
- **Deviation (documented):** a **truly unparseable** note (no JSON, no SOAP headers → no sections)
  now **degrades** `schema_validity` → **FLAG**, where it previously produced a required-property
  `0.0` → REGEN under a schema-bearing template. This matches the approved "keep degraded for truly
  empty/unparseable notes" direction and AC-5 (don't spend the regen budget on an empty shell). A note
  with **partial** structure (e.g. missing only Plan) remains **REGEN**. `test_sensor_runner` and the
  `schema_validity` degraded cases were updated to pin this.

### 6.6 TASK-356 coordination items

- **No threshold default was changed** (D-B held): the fixtures proved the defaults are correct once
  inputs are cleaned, so **no `HarnessPolicy` migration / 4-location default mirror is required** from
  TASK-358. Effective thresholds still resolve from the `HarnessPolicy` DB row; making them
  admin-editable was **already delivered by TASK-330 Phase 6** (live end-to-end — see §3), not
  TASK-356.
- **Schema validation is harness-side only** (D-A Option 1) — no `prompt-assembly`, `outputSchema`,
  template, or `responseFormat` edits. The default contract is the four S/O/A/P sections; a
  schema-bearing template's `required` is already honoured, so a future TASK-356 template that changes
  the SOAP structure is automatically validated against its own schema (no TASK-358 change needed).

### 6.7 Production-readiness hardening (review pass — 2026-06-15)

A fresh-eyes review across three lenses (accuracy, performance, best-practices). **Three
surgical fixes** were made; everything else was confirmed already production-ready and left
unchanged.

- **(accuracy) An empty markdown section is no longer masked as present.** The colon-bold
  header form `**Plan:**` left the *closing* `**` in the section body (`_SOAP_HEADER_RE`
  matched at the colon, before the closing emphasis). A genuinely **empty** section
  (`**Plan:**\n\n`) therefore parsed as body `"**"` — *non-empty* — so it falsely satisfied the
  structural contract (`schema_validity` 1.0 instead of flagging the gap). The header regex now
  consumes a closing emphasis marker that is directly attached to the colon/EOL
  (`(?::|$)[*_]{0,2}`), so an empty section parses `""` → `schema_validity` reports the missing
  section → **REGEN** (no false PASS). It is anchored to the colon (no intervening space) so
  spaced inline bold content (`**Plan:** **Important** …`) and next-line bullets are preserved.
  (`services/sensor_runner.py`)
- **(defense-in-depth) `schema_validity` fails *closed* on a malformed schema.**
  `Draft202012Validator(schema).iter_errors(...)` **raises** on an unprocessable schema (verified
  `UnknownType`/`TypeError`). With TASK-356 making schemas admin-managed, that was an
  uncaught-exception / fail-open path. The jsonschema pass is now wrapped: any error →
  **degraded** (never auto-PASS, never crash the sensor run); the exception type (no PHI) is
  recorded in `details`. (`sensors/computational/schema_validity.py`)
- **(observability) The runner emits structured, PHI-free diagnostics.** `sensor_runner` now
  logs (debug) the parse mode (`json`/`markdown`/`none`), the SOAP section **keys**, and the
  entity **in→kept** counts (how many `▁`/BIO artifacts were merged/dropped), and (info) when a
  note is **unparseable** (the degraded → FLAG trigger) — counts/keys only, never the note text.
  Production can now explain *why* a note degraded and *what* was filtered.
  (`services/sensor_runner.py`)

**Confirmed already production-ready (deliberately left unchanged):**

- The NER non-clinical-noise filter does **not** over-filter: short/ambiguous clinical tokens
  (`B12`, `T3`, `T4`, `A1c`, `HbA1c`, `O2`, `K`, `Na`, bare dose values `5`/`10`/`20`) all
  survive — a span is dropped only when **every** token is mic-check counting/stopword/empty.
- The subword/`▁` merge is the single shared `clean_entities_for_sensors` path; the
  `build_citations_map` internal re-aggregation is **idempotent** (proven: no two output entities
  are an `I-`-contiguous pair) and is intentionally kept so the function stays self-sufficient for
  its direct (eval/test) callers — fixing it would be a riskier refactor for no measurable gain.
- The markdown fallback runs **only** on JSON-parse failure (no double parse); regexes are
  module-level compiled; entity cleanup runs **once per list**; no network/I-O on the hot path.

**New/added tests** (TDD; 2 RED→GREEN, 2 guards): `test_empty_colon_bold_section_is_detected_as_missing`,
`test_markdown_header_variants_parse_to_full_structure` (`test_sensor_runner.py`);
`test_malformed_schema_degrades_fail_closed` (`test_schema_validity.py`);
`test_keeps_short_clinical_lab_markers_no_false_positives` (`test_provenance.py`).

**Evidence:** full harness unit suite **619 passed** under `arcaenv`; `black`/`ruff`/`mypy` clean
on all changed files; micro-benchmark **~0.53 ms/call** (markdown path) / **~0.48 ms** (JSON path)
on a representative 33-entity note, markdown fallback parse **~0.006 ms**; the refreshed confusion
summary still discriminates and the newly-fixed empty-section case now REGENs:

| Labeled note | Decision |
|---|---|
| good (JSON / md `**Subjective:**` / md `**SUBJECTIVE (S)**` / md + json_schema) | **PASS** |
| fabrication (warfarin) · wrong dose (20 vs 10 mg) | **FLAG** |
| omission · schema-break (md missing Plan) · **empty Plan body (md) [newly fixed]** | **REGEN** |
| degraded (no transcript) | **FLAG** |

**Deferred (tracked harness-side follow-up, fail-safe today):** single-letter `S:`/`O:`/`A:`/`P:`
markdown headers are **not** parsed — the seeded prompt requests full-word/`##`/`**` headers
(`07-prompt-template.ts`), the two live formats are `**Subjective:**` and `**SUBJECTIVE (S)**`, and a
single-letter-only note fails **closed** (no sections → degraded → FLAG, never auto-PASS). This is
**not** TASK-356's lane: TASK-356 has since been **implemented & committed (Phases 1–6) without
touching the harness markdown parser** — its scope guards explicitly exclude `apps/harness/**`.
Adding single-letter support (plus an inline single-paragraph fallback) is a small **harness-side
parser** change — extend `_SOAP_HEADER_RE` in `services/sensor_runner.py`. It remains **safe to
defer** (off-contract notes fail closed → degrade → FLAG, never auto-PASS) and is currently
**speculative** — no seeded prompt emits single-letter/inline formats (seeds request full-word +
`##`/`**` headers per `07-prompt-template.ts`). Tracked here as a **harness-side follow-up**, to be
revisited **only if** an off-contract emitter actually appears in production/eval. `_derive_section`
re-normalizes section text per claim (pre-existing, negligible at note scale) — left untouched (not
introduced by TASK-358).

---

## 7. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Planning ticket created (no code). Spawned from TASK-355 §8 observation #2 + Appendix 04 §3; grounded in live code (`sensors/computational/schema_validity.py`, `entity_faithfulness.py`, `sensors/config.py`, `sensors/aggregator.py`, `sensors/base.py`, `services/sensor_runner.py`, `services/provenance.py`); three workstreams (schema / NER cleanup / thresholds) defined; TASK-356 intersections (prompt templates, admin-configurable thresholds) scoped to avoid overlap. Status = Pending, awaiting plan approval. | `docs/implementation/TASK-358-Harness-Deterministic-Sensor-Calibration/README.md` |
| 2026-06-15 | Plan approved & **implemented** under TDD (D-A Option 1 + D-B). (a) `schema_validity` validates the actual contract (schema `required` when present; default S/O/A/P structural contract when `responseFormat` null) → complete note scores 1.0 in both cases; truly empty/unparseable stays degraded. (b) `normalize_text` strips `▁`; `SensorContext` entities cleaned via the single shared `provenance.clean_entities_for_sensors` (reusing subword aggregation + adding mic-check/stopword noise filter). (c) thresholds validated against the labeled fixture set — **no values changed**. Corrected §2.1 (degraded vs 0.0-invalid by resolved template). Full harness unit suite 615 passed; ruff/mypy clean. Status → Review. | `sensors/base.py`, `sensors/computational/schema_validity.py`, `sensors/config.py`, `services/provenance.py`, `services/sensor_runner.py`, `tests/unit/sensors/test_sensor_calibration.py` (new), `tests/unit/sensors/test_schema_validity.py`, `tests/unit/sensors/test_base.py`, `tests/unit/services/test_sensor_runner.py`, `tests/unit/services/test_provenance.py` |
| 2026-06-15 | **Production-readiness hardening** (fresh-eyes review pass; Status stays **Review**; no approved decision relitigated, no threshold changed). Three surgical fixes (§6.7): **(accuracy)** the markdown colon-bold header parse leaked a closing `**` into the section body, which masked a genuinely **empty** section as present (false `schema_validity` 1.0) — the header regex now consumes the colon-attached closing emphasis, so an empty section → **REGEN**; **(defense-in-depth)** `schema_validity` now fails **closed** (degraded) on a malformed/unprocessable activated schema instead of raising an uncaught exception (fail-open) — relevant once TASK-356 makes schemas admin-managed; **(observability)** `sensor_runner` now emits PHI-free structured logs (parse mode, SOAP section keys, entity in→kept counts, and an unparseable-note signal) so production can explain *why* a note degraded / *what* was filtered. Added 4 tests (2 RED→GREEN, 2 false-positive/robustness guards). Confirmed the NER noise filter has **no** clinical false-positives (`B12`/`T3`/`A1c`/`O2`/`K`/`Na`/dose values survive) and the subword→citations path is single-source — both left unchanged. **619** unit tests pass; `black`/`ruff`/`mypy` clean; ~0.5 ms/call; confusion summary still discriminates. | `services/sensor_runner.py`, `sensors/computational/schema_validity.py`, `tests/unit/services/test_sensor_runner.py`, `tests/unit/services/test_provenance.py`, `tests/unit/sensors/test_schema_validity.py` |
| 2026-06-15 | **User sign-off → Status: Completed.** Phase-5 verification gate accepted (619 harness unit tests green under `arcaenv`; `black`/`ruff`/`mypy` clean; ~0.5 ms/call; gate discriminates good→PASS, fabrication/wrong-dose→FLAG, omission/schema-break/empty-section→REGEN, degraded→FLAG). Two enhancements deferred to **TASK-356** (single-letter/inline SOAP-header parsing; admin-editable thresholds): **no obstacle to deferral** — both are TASK-356-lane (prompt contract + `HarnessPolicy`), and the harness behaves **fail-closed** (single-letter-only notes degrade→FLAG, never auto-PASS) without them. | `docs/implementation/TASK-358-Harness-Deterministic-Sensor-Calibration/README.md` |
| 2026-06-15 | **Post-sign-off follow-up audit (read-only).** Enh-2 (admin-editable harness thresholds) confirmed **ALREADY LIVE end-to-end via TASK-330 Phase 6** (`HarnessPolicy` columns + WORM `HarnessPolicyChange` → `harness-policy.service.ts`/OCC → `GET/PATCH /admin/harness/policy[/global]` → admin UI `policy-editor.tsx` `THRESHOLD_FIELDS` → harness `temporal/models.py` `to_sensor_thresholds()` into `run_sensors`); corrected the prior **TASK-356** attribution in §3/§6.6 → **no action**. Enh-1 (single-letter/inline SOAP-header parsing) confirmed genuinely unaddressed; **reclassified** from a "TASK-356 coordination" to a **tracked, deferred, speculative harness-side `_SOAP_HEADER_RE` follow-up** (`services/sensor_runner.py`; fail-closed today — TASK-356 Phases 1–6 shipped without touching `apps/harness/**`). Status remains **Completed**; **no code change**. | `docs/implementation/TASK-358-Harness-Deterministic-Sensor-Calibration/README.md` |
