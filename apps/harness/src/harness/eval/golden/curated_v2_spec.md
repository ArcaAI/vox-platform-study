# `curated-v2.0.0` — golden-set design specification

> **Status: AI-authored, PENDING CLINICIAN REVIEW.**
> Every `clinician_pdsqi` value in `fixtures/curated_v2.json` is an **AI-authored,
> rubric-literal reference rating**, not a clinician rating. It is labelled as such in
> each case's `metadata.label_provenance` (`ai-authored-rubric-literal`) and
> `metadata.clinician_review_status` (`pending`). Nothing in this set may be presented
> as a clinician's judgement until the review workflow in §7 has run.

This document is the *why*. The set itself is `fixtures/curated_v2.json`; the reviewable
artifact for clinicians is `review/curated_v2_review.md`.

---

## 1. What this set is for, and what it replaced

The eval gate scores a pinned golden set with an LLM-as-judge (PDSQI-9) and gates the
release on four quality aggregates plus **ICC(2,1) ≥ 0.80** between the judge and the
set's reference ratings.

`curated-v1.0.0` failed that gate at `icc = 0.6568`, and the recorded lane decomposition
showed why: the judge returned a literal `5` on all 8 Likert dimensions of all 12
`quality` cases — **judge SD exactly 0.000**. ICC(2,1) is a variance ratio, so a lane on
which the rater never varies contributes exactly nothing, however well it agrees.

The structural cause is in the *reference set*, not the statistic: v1's quality lane was
12 good notes and 6 flawed ones. A judge that says "good" to good notes is not visibly
wrong, so the set could not distinguish a discriminating judge from an indiscriminate one.

`curated-v2.0.0` fixes that by **designing the spread in**: the reference ratings
themselves span 1–5 by construction (reference SD 1.313 over 288 ratings, versus a lane
that was effectively constant), so between-case true-score variance — the numerator of
ICC — is large by design rather than by luck.

## 2. Structure — 12 sources × a 5-level gradient

Twelve synthetic source consultations. Each yields **one L5 gold-standard note** plus
**two deliberately degraded variants**, for **36 cases / 288 paired Likert ratings**.

| Level | Meaning | Cases | Anchor exemplar |
|---|---|---|---|
| **L5** | Merits 5 on every dimension by a literal reading of the rubric: complete, fully `<Note ID:#>`-cited, concise, well-grouped, plain, and integrative in the Assessment | 12 | `cv2-s01-L5-gold` |
| **L4** | **The presentation-only band.** Content correct and complete (`accurate` = 5, `thorough` ≥ 4); one *presentation* defect — partial citation, verbosity, under-synthesis — or one *potentially pertinent* omission | 5 | `cv2-s03-L4-verbose` |
| **L3** | One *wrong-context* misalignment (temporal, mis-attribution, minor false negation) or exactly one *pertinent* omission | 6 | `cv2-s07-L3-omission` |
| **L2** | One overt, major, single-class seeded error (fabrication, dose, laterality, false negation, temporal status reversal) or >1 pertinent omission | 9 | `cv2-s04-L2-laterality` |
| **L1** | Multiple major errors *plus* structural collapse: uncited, out of order, plan contradicting the source | 4 | `cv2-s11-L1-severe` |

**The levels encode CLINICAL severity, not the arithmetic PDSQI mean, and L4 is
deliberately outside the mean ordering.** PDSQI docks `succinct` to 2 for a note with
redundancy in more than one assertion, so a verbose but perfectly accurate note takes a
heavier arithmetic penalty (mean 4.25) than a note with a genuine pertinent omission
(mean 4.63). That is a property of the instrument, not a defect in the gradient: a
verbose note is clinically harmless and an omitted allergy is not. The clinical chain
**L5 > L3 > L2 > L1** is monotone in the mean (5.00 → 4.58 → 4.32 → 1.75) and is locked by
`test_designed_quality_gradient_spans_the_scale`; L4's separate contract — clinically
clean, presentation defect only — is locked by `test_L4_is_the_presentation_only_band`.

Lane assignment follows the existing `GoldenCase.role` contract:

- **`role="quality"`** — the 12 L5 gold notes. These feed the PDSQI quality aggregates
  (`pdsqi_accurate`, `pdsqi_thorough`, `pdsqi_mean`) and the faithfulness gate. A release
  gate must not be graded on sabotaged inputs, so **only** L5 notes are in this lane.
- **`role="calibration"`** — the 24 degraded variants. These feed judge↔reference
  agreement (ICC / Gwet AC2) only.

## 3. Labelling rules (applied mechanically, not case by case)

Reference ratings are derived from the Epic PDSQI-9 grade descriptors by these rules.
They are stated here so a reviewer can check the *rule*, not 288 individual numbers, and
so any future revision is applied uniformly rather than to convenient cases.

| # | Rule |
|---|---|
| **R1** | **Dimensions are scored independently.** A defect moves the dimension(s) the rubric attaches it to and no others. |
| **R2** | The seeded error moves `accurate`: **2** for an overt falsification/fabrication of a *major* assertion (diagnosis, dose, laterality, a documented status); **3** for a wrong-context misalignment (timing, evidential attribution, a *minor* symptom negation); **1** only when there are *multiple* major errors. |
| **R3** | **A content error does NOT move `citation`.** `citation` grades whether assertions carry correctly *paired* `<Note ID:#>` markers. `citation` moves only for missing citations (**3**), one wrong/grouped citation (**2**), or none at all (**1**). *(This reverses a v1 labelling habit — see §5.)* |
| **R4** | `thorough` moves only for omissions, counted exactly as the rubric counts them: 0 → **5**; potentially-pertinent only → **4**; exactly one pertinent → **3**; one pertinent + multiple potentially-pertinent → **2**; more than one pertinent → **1**. |
| **R5** | `synthesized` drops to **2** when the seeded error *is* the diagnostic conclusion or the reasoning that drives the plan; to **3** when a clear opportunity to group/abstract was missed; to **4** when the Assessment merely restates rather than reasons; **1** only when reasoning across assertions is outright wrong. |
| **R6** | `organized`, `comprehensible`, `succinct`, `useful` move only for structural, linguistic, redundancy and detail-level defects respectively — never as a side effect of an accuracy defect. |
| **R7** | A consequence of a seeded error is **not** double-counted as an independent defect. (e.g. `cv2-s05-L2-false-negation` drops the indicated anti-D *because* rhesus status was falsified; that is scored under `accurate`, and `thorough` stays 5.) |

## 4. Stratification

Verified against the shipped fixture (`pytest .../test_curated_v2_golden_set.py`):

| Axis | Distribution |
|---|---|
| Specialty | 12 distinct — Family Medicine, Internal Medicine, Cardiology, Pediatrics, Obstetrics and Gynecology, Psychiatry, Pulmonology, Gastroenterology, Endocrinology, Orthopedics, Nephrology, Emergency Medicine |
| Consultation length | short 12 · medium 15 · long 9 |
| Complexity | low 12 · moderate 15 · high 9 |
| Lane | quality 12 · calibration 24 |
| Level | L5 12 · L4 5 · L3 6 · L2 9 · L1 4 |
| Split | dev 24 · holdout 12 |

## 5. Seeded error taxonomy

One error class per L2/L3/L4 variant, so a judge failure is **attributable** to a class.
L1 variants deliberately carry several, because "multiple major errors" is the L1 anchor.

| Class | Meaning | Occurrences |
|---|---|---|
| `omission_material` | A clinically material fact is absent | 7 |
| `fabrication` | An assertion with no support anywhere in the sources | 6 |
| `dose_error` | Wrong dose, strength, or frequency | 4 |
| `temporal_error` | A past/resolved state asserted as current (or vice versa) | 4 |
| `laterality_error` | Wrong side | 3 |
| `misattribution` | Patient-reported content presented as clinician-observed | 3 |
| `false_negation` | A documented positive asserted as absent | 3 |
| `verbosity` | Redundant syntax/semantics (presentation only) | 2 |
| `uncited_assertion` | Correct content carrying no citation | 1 |
| `under_synthesis` | Correct content, no grouping or reasoning | 1 |
| `omission_potentially_pertinent` | Relevant but not decision-bearing | 1 |

**§5 note — the one labelling rule that changed from v1, and why it matters.**
v1 lowered `citation` to 2 whenever a *false* assertion carried a `<Note ID:#>` marker,
on the reading that a citation pointing at a note which does not support the assertion is
"incorrect". v2 does not (rule **R3**). Three reasons, in order of weight:

1. **The instrument's own independence principle.** v1's recorded defect was exactly
   cross-dimension bleed; the repo's `ANCHOR_BLOCK` calibration text already instructs
   the judge to score each dimension independently.
2. **The rubric text for `citation` is about pairing**, not truth: its grades enumerate
   missing, grouped, and mis-paired citations. Truth is `accurate`'s job (R2).
3. It is **also** what the judge does, measured on three separate probe runs.

Reason 3 is deliberately listed last: agreement with the judge is *evidence that the rule
is readable*, not the justification for it. **This is the single highest-impact item for
clinician review** — it moves 8 cases by 3 points on one dimension. If the reviewing
clinicians take the opposite view, R3 flips for all 8 uniformly and the set re-ships as
`curated-v2.1.0`.

## 6. Sample size and statistical power

- **n = 288 paired ratings** (36 cases × 8 Likert dimensions), up from 144 in v1.
- ICC(2,1) is computed over pooled `(case, dimension)` pairs, matching v1 so the two runs
  stay comparable.
- **Power.** For ICC(2,1) with k = 2 raters, the width of a 95 % CI around ρ ≈ 0.8 is
  roughly ±0.05 at n = 288, versus ±0.08 at n = 144. The gate's 0.80 bar is therefore
  resolved about 1.6× more sharply than in v1, and a pass/fail near the bar is much less
  likely to be a sampling artifact.
- **Caveat that does not go away with n.** The 288 ratings are not independent: they come
  from 36 notes over 12 source consultations, so the *effective* sample is nearer 36. n is
  the right number to report, but it should never be read as 288 independent observations.

## 7. Provenance, review, and how amendments become authoritative

- Every case carries `metadata.label_provenance = "ai-authored-rubric-literal"` and
  `metadata.clinician_review_status = "pending"`, and every rating carries a written
  `metadata.label_rationale` naming the rule that produced it.
- The reviewable artifact is **`review/curated_v2_review.md`**, generated from the fixture
  by `review/render_review.py`. One section per case: the source documents, the note under
  review, the seeded error, the proposed rating, and the rationale — with an
  accept/amend block a clinician fills in.
- Amendments are recorded in **`review/curated_v2_amendments.json`** and applied by
  `review/apply_amendments.py`, which writes a **new version** (`curated-v2.1.0`) and flips
  the amended cases to `clinician_review_status: "reviewed"`. The v2.0.0 file is never
  mutated in place, so a historical run stays interpretable against the exact set it scored.

## 8. Held-out split

`metadata.split` is `dev` (24 cases) or `holdout` (12), stratified across lane, level and
specialty. The holdout exists so a threshold or a labelling rule can never be tuned on the
same cases used to validate it.

**Current status: the holdout is clean.** No threshold was changed in this work — the
gate's bars come from the PDSQI-9 literature, not from this set. Rule **R3** (§5) was
decided from the rubric text *before* the set was scored, and applied uniformly to all 8
affected cases across both splits. The gate scores the full set; the per-split ICC is
reported separately by `harness.eval.calibration.breakdown` so a reader can check whether
a rule generalises rather than taking it on trust.

## 9. PHI posture

PHI-free by construction, not by redaction. The consultations were authored synthetically:

- No names, dates of birth, addresses, contact details, or facility identifiers.
- Subjects are described generically ("adult", "school-age child", "primigravida").
- The only identifiers present are obviously-synthetic record tags, `SYN-0001` … `SYN-0012`.
- All clinical values are invented and internally consistent; none is derived from a real
  encounter, and there is no real production data on the platform to derive one from.

## 10. Best practices applied — and consciously skipped

| Practice | Status |
|---|---|
| Designed quality gradient with an anchor exemplar per score point | **Applied** (§2) |
| Seeded error taxonomy, one class per variant, failure attributable | **Applied** (§5) |
| Stratification across specialty / length / complexity, documented | **Applied** (§4) |
| Reference ratings with explicit provenance, never presented as clinician output | **Applied** (§7) |
| Sufficient n, with the power consequence stated | **Applied** (§6) |
| Held-out split, never used for tuning | **Applied** (§8) |
| Versioned; amendments ship as a new version | **Applied** (§7) |
| PHI-free by construction with obviously-synthetic identifiers | **Applied** (§9) |
| Clinician review workflow with a documented amendment path | **Applied** (§7) |
| **Multiple independent human raters per case + adjudication + human ICC** | **SKIPPED — deliberately.** This is the `clinical_v1` protocol (`clinical_v1_spec.md`: N ≥ 132, ≥ 3 blinded raters/case, human ICC ≥ 0.75 as a precondition). It cannot be AI-generated: its whole content is *inter-human* disagreement. v2 is the best set obtainable without a clinician panel, and is explicitly the input to one — not a substitute. `clinical_v1.json` remains the open prerequisite for any clinically-validated calibration claim. |
| **Real (de-identified) consultation transcripts** | **SKIPPED — not available.** Owner decision D-A: there is no production data. Synthetic sources are the only option, and they are also the only PHI-safe one. |
| **Blinding the reference labels from the note author** | **SKIPPED — not meaningful here.** Author and labeller are the same AI process, so blinding would be theatre. It becomes meaningful, and required, at the clinician-panel stage. |
| **Judge-model diversity / multi-judge consensus** | **SKIPPED — out of scope by owner decision.** The owner directed keeping `gemma-4-e4b-it-qat` for local development; the set is judge-agnostic and can be re-scored by any judge without change. |
