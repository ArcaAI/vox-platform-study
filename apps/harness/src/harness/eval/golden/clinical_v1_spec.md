# Clinical Golden Set (`clinical_v1`) — Specification & Labeling Protocol

**Ticket:** TASK-330 (Phase-0 exit prerequisite)
**Status:** In Progress — scaffold + protocol landed; **real SME-authored cases still required**
**Owner (engineering scaffold):** harness/eval
**Owner (clinical content):** _unassigned — requires a clinical SME lead (see §11)_
**Scope of this doc:** the spec, schema, and multi-rater labeling protocol for the **real clinician-authored** golden set that replaces the synthetic fixtures before any clinically-validated calibration claim.

> **Integrity boundary.** This document and the shipped scaffold (`clinical_v1.schema.json`, `clinical_v1.template.json`) contain **no real clinical cases and no real clinician ratings**. Every example value in the template is a `[[PLACEHOLDER]]`. Nothing here may be cited as a calibration result. The deliverable is the *machinery to let SMEs author a real set*, not invented clinical data.

---

## 1. Why this set is needed (the gap)

Today's release gate (`harness.eval.config.EvalConfig`) requires:

| Gate | Threshold | Source |
|---|---|---|
| Judge↔clinician agreement | **ICC(2,1) ≥ 0.80** | `calibration/reliability.py` |
| Faithfulness | ≥ 0.85 | `metrics/faithfulness.py` |
| PDSQI accurate / thorough / mean | ≥ 4.0 each | `ci.py::apply_gate` |

The currently-reported **ICC ≈ 0.821 is not a clinical validation**. It is:

- **judge-vs-rubric**, not judge-vs-clinician — the `clinician_pdsqi` labels in `fixtures/curated_v1.json` are explicitly `"label_provenance": "curated-rubric-derived"` (authored from the Epic PDSQI-9 grade descriptors), **not** real clinician ratings;
- **single-reference** — exactly one label per case, so there is **no human inter-rater reliability** establishing that the reference is itself trustworthy;
- **tiny** — only the **n = 6 calibration-lane** cases carry range-spanning labels, far below the precision a release-blocking ICC needs.

This spec defines the set that closes that gap.

## 2. How a case flows into the calibration gate (verified data path)

```
clinical_v1.json  (rich, multi-rater; this schema)
        │
        │  ClinicalGoldenSetSource.load()            [golden/sources.py]
        │   • integrity guard: refuse template/placeholder unless allow_template=True
        │   • project_clinical_case(): consensus → GoldenCase.clinician_pdsqi
        │                              raters/adjudication/claims/safety/deid/provenance → GoldenCase.metadata
        ▼
GoldenSet → GoldenCase[]                              [eval/models.py — UNCHANGED]
        │
        │  GoldenSetRunner.run()                      [golden/runner.py]
        │   • PDSQI-9 judge scores every case → judge PDSQIScore
        │   • faithfulness scored on quality-lane cases only
        ▼
judge_clinician_icc(golden_set, run)                 [eval/ci.py]
        │   • pairs judge PDSQIScore vs case.clinician_pdsqi (the consensus)
        │   • pdsqi_likert_pairs() pools present 1–5 dims → calibration_report()
        ▼
apply_gate() → ICC(2,1) ≥ 0.80 release gate          [eval/ci.py]
```

**Key engineering consequence:** the existing gate pairs the judge against **one** reference per case — `GoldenCase.clinician_pdsqi`. So the **adjudicated consensus** of the multi-rater labels is what occupies that field. The **raw per-rater labels** travel in `metadata` and feed a **separate human inter-rater-reliability (IRR) analysis** (§8) that is the precondition for trusting the consensus at all. This keeps `models.py` and `calibration/` untouched while making the claim defensible.

### Fields each case must provide for the gate

| Consumed by | Field | Notes |
|---|---|---|
| PDSQI judge prompt | `source_documents`, `generated_note`, `target_specialty` | the transcript→note pair under eval |
| ICC pairing | `clinician_pdsqi` (consensus) | the human reference; must be 1–5 Likert + 0/1 flags matching `PDSQIScore` |
| Lane separation | `role` (`quality` \| `calibration`) | quality feeds quality+faithfulness gates; calibration feeds ICC only |
| Faithfulness (quality lane) | `source_documents` (or `contexts`) | entailment premise |
| Human IRR (offline) | `pdsqi_raters[]` (≥3) + `adjudication` | establishes the consensus is reliable |
| Groundedness/safety truth | `claims[].groundedness_truth`, `safety_truth` | scores the inferential sensors against truth |
| Governance | `deidentification`, `provenance` | release/audit preconditions |

## 3. Target N and sample-size justification

**Target: N ≥ 132 cases** (engineering scaffold validates any N ≥ 1; the **Phase-0 exit gate requires N ≥ 132**).

The release gate is **ICC(2,1)** — two raters (judge vs. consensus), absolute agreement. Sizing uses **Bonett (2002)** for the number of subjects `n` giving a 95% CI of total width `w` at an anticipated ICC `ρ` with `k` raters:

```
n = 8·z²·(1−ρ)²·(1+(k−1)·ρ)² / (w²·k·(k−1)) + 1
```

With `z = 1.96`, `k = 2`:

| Anticipated ICC ρ | CI half-width | Required n (cases) | Note |
|---|---|---|---|
| **0.75 (conservative)** | **±0.075** | **132** | **← spec target (both levers conservative)** |
| 0.80 | ±0.075 | 90 | single-lever conservative (tight CI only) |
| 0.75 (conservative) | ±0.10 | 75 | single-lever conservative (low ρ only) |
| 0.80 | ±0.10 | 51 | prior non-conservative default |
| 0.80 | ±0.125 | 33 | |
| 0.80 | ±0.15 | 24 | |

**Why 132 is the floor (conservative target).** The target deliberately stacks **both** conservative levers: a **planning value ρ = 0.75, below the 0.80 release gate** (so N stays adequate even if real-rater agreement lands under the gate), **and** a tight **±0.075** CI half-width. At ρ = 0.75, k = 2, total width w = 0.15, Bonett gives n = 131.72 → **132**. A 95% CI half-width of ≈ ±0.075 puts the lower bound of a measured ICC near 0.80 at ≈ 0.725 — clear of the 0.70 "good-agreement" boundary. Relaxing **either** lever drops the floor into the 75–90 range (table above); the prior non-conservative default (ρ = 0.80, ±0.10) gave only 51. Below ~30 cases the CI is so wide (±0.15+) that a 0.82 point estimate is statistically indistinguishable from 0.65 — exactly the weakness of today's n = 6. N ≥ 132 also subsumes the HLD's documented "≥ 50 cases scored" exit gate, and provides ~132 paired observations **per dimension** for the per-dimension ICCs (§8).

> **Per-dimension framing.** N is counted in **cases**, so that **each PDSQI dimension** accrues ~N judge-vs-consensus paired observations. This is the defensible unit (see the §8 pooling caveat). N ≥ 132 ⇒ each dimension's ICC has ~132 observations.

## 4. Composition & stratification (the 132+)

Variance is mandatory: an ICC over cases that all score 5/5 is undefined. Mirror the proven two-lane design of `curated_v1` but at scale and with real labels. Lane counts scale with the 3:2 quality:calibration split.

| Dimension | Target | Rationale |
|---|---|---|
| **Lane** | ~79 `quality` + ~53 `calibration` (3:2; = 132) | quality drives the PDSQI/faithfulness gates; calibration spans the score range for ICC |
| **Specialty** | ≥ 8 specialties, ≤ ~20% any one | generalization across clinical domains |
| **Score range (calibration)** | full 1–5 on each Likert dim across the set | ICC needs between-case variance |
| **Flaw coverage (calibration)** | fabrication, falsification, harmful omission, dose error, wrong laterality, missed contraindication, verbosity, disorganization, missing citations, stigmatizing language | the safety/quality failure modes the gate must detect |
| **Note length / complexity** | short follow-ups → complex multi-problem visits | avoid length confound |

Each calibration case should inject **one clearly-scoped flaw** and apply the **independent-dimension principle** (a flaw in one dimension must not bleed into unrelated dimensions) — the same principle documented in `curated_v1`'s `label_rationale` fields.

## 5. Case schema

The authored format is the JSON Schema at **`fixtures/clinical_v1.schema.json`** (Draft 2020-12). It is a **superset** of the runtime `GoldenCase`; the loader projects it down (§2). Field summary:

### Runtime-native (project 1:1 to `GoldenCase`)
- `case_id` — unique lowercase-kebab id.
- `role` — `quality` | `calibration`.
- `target_specialty` — drives stratification.
- `source_documents[]` — **de-identified** transcript turns + prior notes (the grounding premise).
- `generated_note` — the draft note under eval; inline `<Note ID:N>` cites `source_documents[N-1]`.
- `reference_note` — gold exemplar or a description of the high-quality target.
- `contexts[]` *(optional)* — explicit faithfulness contexts (defaults to `source_documents`).
- `clinician_pdsqi` — the **adjudicated consensus** PDSQI (the calibration reference). Exact `PDSQIScore` shape: seven 1–5 Likert (`citation, accurate, thorough, useful, organized, comprehensible, succinct`), an NA-able 1–5 `synthesized`, and three 0/1 flags (`abstraction, voice_summ, voice_note`).

### Extended (preserved under `GoldenCase.metadata`)
- `pdsqi_raters[]` — **≥3** independent, **blinded** clinician ratings: `{rater_id (pseudonym), rater_role, rated_at, blinded, ratings (PDSQIScore), notes}`.
- `adjudication` — `{method, adjudicator_id?, adjudicated_dimensions[], notes}`; method ∈ `mean_round_half_up | median | panel_adjudicated | senior_override`.
- `claims[]` — claim-level groundedness **ground truth**: `{id, text, section (S/O/A/P), evidence[{quote, source_index}], groundedness_truth ∈ supported|partially_supported|unsupported|contradicted}`. Mirrors the production NER `citationsMap` shape (`inferential_corpus_eval.derive_citations_map`) so sensors can be scored against truth.
- `safety_truth` — `{unsafe (bool), categories[], rationale}`.
- `deidentification` — `{phi_free (must be true), method, verified_by, verified_at}` (§9).
- `provenance` — `{source_type, dataset?, license?, consent{...}, author_id, authored_at}` (§10).
- `metadata` — free-form; for calibration cases document `flaw` + `label_rationale`. `label_provenance: "TEMPLATE-PLACEHOLDER"` marks a non-clinical placeholder (loader-refused).

## 6. SME authoring protocol

1. **Source acquisition.** Obtain transcript→note material from a *consented/licensed* origin (§10): de-identified real encounters under IRB/DUA, clinician-simulated cases, or a license-permitting public set (e.g. MTS-Dialog / ACI-Bench).
2. **De-identify (§9).** Remove all 18 HIPAA identifiers; a second clinician verifies; record the `deidentification` block.
3. **Curate the draft note.** For `quality` cases, the `generated_note` is a high-quality reference exemplar. For `calibration` cases, inject exactly one scoped flaw and record it.
4. **Author claim/safety truth.** Decompose `generated_note` into atomic `claims[]` and adjudicate each `groundedness_truth`; set `safety_truth`.
5. **Multi-rater labeling (§7).**
6. **Adjudicate → consensus (§7).**
7. **Submit** as one case object conforming to `clinical_v1.schema.json`.

## 7. Multi-rater labeling protocol

- **Raters:** **≥3** independent clinicians per case (qualified in or adjacent to `target_specialty`). Three is the minimum that supports both consensus-by-majority and detection of a single outlier rater; two cannot be adjudicated.
- **Blinding:** each rater scores **independently**, blind to the other raters **and** to any model output. `rater.blinded` must be `true` to count toward IRR.
- **Instrument:** the verbatim Epic **PDSQI-9** grade descriptors; apply the **independent-dimension principle**.
- **Disagreement rule:** for any dimension where raters span **≥ 2 Likert points**, escalate to **adjudication** by a senior clinician (or panel). Record the resolved dimensions in `adjudication.adjudicated_dimensions` and set `method = panel_adjudicated | senior_override`.
- **Consensus formation:** when raters agree within 1 point, the consensus is the **mean (round-half-up)** of the rater scores (`method = mean_round_half_up`); otherwise it is the **adjudicated** value. The consensus is written to `clinician_pdsqi`. **The consensus is never authored directly** — it is always derived from `pdsqi_raters`.

## 8. Multi-rater ICC plan (the actual estimation)

Two distinct statistics — **both** must be reported. The first is the precondition; the second is the gate.

### (A) Human inter-rater reliability — *is the reference trustworthy?*
- **Statistic:** `ICC(2,k)` (or `ICC(2,1)`), two-way random, absolute agreement, computed **per PDSQI dimension** over the `(n_cases × k_raters)` matrix built from `pdsqi_raters`.
- **Target:** **ICC_human ≥ 0.75** ("good", Koo & Li 2016) **before** the set is used as a calibration reference. If clinicians cannot agree on a dimension, that dimension is ill-defined and **no judge can be meaningfully calibrated to it**.
- **Tooling — already supported, no new code:** `harness.eval.calibration.intraclass_correlation()` accepts an arbitrary `(n_targets, k_raters)` matrix. Feed it the per-dimension human rating matrix directly. (This analysis is run offline from `metadata.pdsqi_raters`; it does not change the gate.)

### (B) Judge ↔ consensus — *the release gate (ICC ≥ 0.80)*
- **Statistic:** `ICC(2,1)`, judge vs. the adjudicated `clinician_pdsqi` consensus.
- **Report both:**
  - **Per-dimension ICC** (n ≈ N observations each) — the **defensible** unit; report each with its 95% CI.
  - **Pooled ICC** — what `pairs.pdsqi_likert_pairs` + `judge_clinician_icc` compute today (all dimensions flattened). Keep for back-compat with the gate, but **interpret with caution** (see caveat).
- **Gwet's AC2** (`gwet_ac2`, quadratic ordinal weights) reported alongside ICC — robust to the prevalence paradoxes that distort κ on skewed Likert marginals.

> **⚠ Pooling caveat (methodological).** The existing `pdsqi_likert_pairs` **pools every (case, dimension) pair into one flat ICC**, treating each as an independent "target." Dimensions within a case are **not** independent and measure different constructs, so the pooled ICC can **overstate precision** (inflated effective n) and **conflate** between-dimension with between-case variance. For the real claim, **per-dimension ICC with CIs is primary**; the pooled value is secondary. This is a known limitation to flag to the clinical/stats reviewer; changing the pooling lives outside this scaffold's scope (it touches `calibration/`).

## 9. PHI de-identification requirements

- **Standard:** HIPAA **Safe Harbor** (45 CFR §164.514(b)(2)) — strip all **18 identifiers** (names, geographic subdivisions < state, all date elements except year, phone/fax, email, SSN, MRN, health-plan/account/license numbers, vehicle/device identifiers, URLs, IPs, biometric identifiers, full-face photos, any other unique identifier) — **or** documented **Expert Determination** (§164.514(b)(1)). Purely simulated content uses `method: synthetic_no_phi`.
- **Two-person rule:** the de-identifier and a second verifier are distinct; record `verified_by` (pseudonym) + `verified_at`.
- **`phi_free` must be `true`** for a case to enter the repository. **No raw PHI is ever committed**, even transiently.
- **Pseudonyms only** for `rater_id` / `author_id` / `adjudicator_id` / `verified_by`; the pseudonym→identity map is held **off-repo** by the clinical lead.

## 10. Provenance & consent

Every case records `provenance`:
- `source_type`: `real_encounter_deidentified` | `simulated_by_clinician` | `public_dataset`.
- `consent.status`: `irb_approved` (+`irb_protocol`) | `data_use_agreement` (+`dua_reference`) | `patient_consent` | `not_applicable_synthetic` | `public_license`.
- `dataset` + `license` are **required** for `public_dataset` (verify the license permits derivative eval use and redistribution).
- `author_id`, `authored_at` for audit.

## 11. Exit criteria (Phase-0 gate)

The set may replace the synthetic fixtures for a clinical calibration claim only when **all** hold:

- [ ] **N ≥ 132** cases, validating against `clinical_v1.schema.json`, `template: false`.
- [ ] Stratified per §4 (lanes, ≥8 specialties, score-range + flaw coverage).
- [ ] **≥3 blinded raters** per case; `pdsqi_raters` complete.
- [ ] **Human IRR (A) ≥ 0.75** per gated dimension, reported with CIs.
- [ ] Consensus `clinician_pdsqi` adjudicated per §7 for every case.
- [ ] **Judge↔consensus ICC(2,1) ≥ 0.80** (per-dimension primary + pooled), with Gwet AC2 reported.
- [ ] `deidentification.phi_free = true` and `provenance.consent` valid for every case.
- [ ] Saved as `fixtures/clinical_v1.json`; CI pins `HARNESS_EVAL_GOLDEN_SET_VERSION` + `--golden-set` to it.

## 12. References

- Bonett DG (2002). *Sample size requirements for estimating intraclass correlations with desired precision.* Statistics in Medicine 21(9):1331–1335.
- Shrout PE, Fleiss JL (1979). *Intraclass correlations: uses in assessing rater reliability.* Psychological Bulletin 86(2):420–428. (ICC(2,1))
- Koo TK, Li MY (2016). *A guideline of selecting and reporting intraclass correlation coefficients for reliability research.* J Chiropr Med 15(2):155–163.
- Gwet KL (2014). *Handbook of Inter-Rater Reliability* (4th ed.). (AC1/AC2)
- Epic PDSQI-9 open-source clinical-summary quality instrument (the verbatim instrument used by the judge).
