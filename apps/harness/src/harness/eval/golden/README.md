# `golden/` — golden sets and calibration sources for the harness eval gate

The golden set is the pinned corpus `harness.eval.ci` scores. It is read through a small
`GoldenSetSource` interface so the source is swappable (`sources.py`), and scored by
`GoldenSetRunner` (`runner.py`). Threshold gating lives in `harness.eval.ci` — see
[`apps/harness/eval/README.md`](../../../../eval/README.md) for the release-gate commands and
current live-gate results.

## Layout

| File | Provenance | Use |
|---|---|---|
| `fixtures/synthetic_v0.json` | synthetic | hermetic CI smoke (default source, 5 cases) |
| `fixtures/concept_harm_v0.json` | synthetic, non-clinical | wiring-only fixture for the concept-F1 + harm-weight CI test (`test_e3_eval_wiring.py`); must be replaced by real clinician-authored references before gating any clinical claim |
| `fixtures/curated_v2.json` | AI-authored, rubric-literal, `clinician_review_status: pending` | **the set the release gate runs** (36 cases / 288 ratings, designed 5-level gradient) |
| `fixtures/curated_v1.json` | curated, rubric-derived (not real clinician labels) | superseded by v2; retained unmutated so historical runs stay interpretable |
| `curated_v2_spec.md` | — | v2 design: gradient, labelling rules, taxonomy, stratification, split, PHI posture |
| `review/curated_v2_review.md` | generated from the fixture | the artifact a clinician reviews (case, note, defect, proposed rating, rationale) |
| `review/curated_v2_amendments.json` | empty template | where a reviewer records disagreements |
| `review/render_review.py` | — | regenerates the review artifact from a fixture |
| `review/apply_amendments.py` | — | applies amendments and ships a new version (never mutates in place) |
| `fixtures/clinical_v1.schema.json` | — | JSON Schema (Draft 2020-12) contract for the real multi-rater set |
| `fixtures/clinical_v1.template.json` | template / placeholder | copy-me starting point for SMEs; refused by the loader |
| `fixtures/clinical_v1.json` | real (clinician-authored, multi-rater) | does not exist yet — the open prerequisite for a clinically-validated ICC claim |
| `clinical_v1_spec.md` | — | spec + multi-rater labeling protocol + ICC plan |

Three distinct provenance tiers, and they are not interchangeable. `curated_v2` ratings are
AI-authored and marked `clinician_review_status: pending` — good enough to make the gate a
meaningful signal, never good enough to call a clinical validation. Clinician sign-off through
`review/` upgrades them to `clinician-reviewed` and ships `curated-v2.1.0`. A
clinically-validated calibration claim still requires `clinical_v1.json` (N >= 132, >= 3 blinded
raters/case, human ICC >= 0.75 as a precondition) — see `clinical_v1_spec.md`. The historical
ICC ~= 0.821 recorded against `curated_v1` was judge-vs-rubric over n = 6 and is not a clinical
validation.

## Commands

```bash
cd apps/harness

# 1. (re)generate the artifact a clinician reads
PYTHONPATH=src conda run -n arcaenv python -m harness.eval.golden.review.render_review \
  --golden-set src/harness/eval/golden/fixtures/curated_v2.json \
  --output     src/harness/eval/golden/review/curated_v2_review.md

# 2. clinician fills in review/curated_v2_amendments.json (reviewer + date are mandatory)

# 3. apply -> a NEW version; the reviewed file is never edited in place
PYTHONPATH=src conda run -n arcaenv python -m harness.eval.golden.review.apply_amendments \
  --golden-set src/harness/eval/golden/fixtures/curated_v2.json \
  --amendments src/harness/eval/golden/review/curated_v2_amendments.json \
  --version    curated-v2.1.0 \
  --output     src/harness/eval/golden/fixtures/curated_v2_1.json
```

Running calibration once real cases land (`apps/harness/eval/README.md` covers the local
release-gate path in full):

```bash
conda run -n arcaenv env \
  HARNESS_EVAL_GOLDEN_SET_VERSION=clinical-v1.0.0 \
  python -m harness.eval.ci \
    --golden-set apps/harness/src/harness/eval/golden/fixtures/clinical_v1.json \
    --output clinical-eval-report.json
```

The report includes `aggregates.icc` (judge<->consensus, gate >= 0.80) and
`aggregates.gwet_ac2`. The human inter-rater reliability (precondition, ICC_human >= 0.75) is a
separate offline analysis over `metadata.pdsqi_raters` using
`harness.eval.calibration.intraclass_correlation` — see `clinical_v1_spec.md` section 8.

## How it works

### Sources (`sources.py`)

- `JSONFileGoldenSetSource(path)` — loads a flat `GoldenSet` JSON (the synthetic/curated
  fixtures).
- `ClinicalGoldenSetSource(path, *, allow_template=False)` — loads the rich multi-rater
  `clinical_v1` format and projects it onto `GoldenCase` (`project_clinical_case`): adjudicated
  consensus -> `clinician_pdsqi`; raters / adjudication / claims / safety / de-id / provenance ->
  `metadata`. Drop-in for the runner and the `judge_clinician_icc` gate — no `models.py` change.
- `clinical_golden_set_source(*, allow_template=False)` — convenience pointing at
  `clinical_v1.json` (raises `FileNotFoundError` until SMEs author it — no synthetic fallback).

### Integrity guard (why a placeholder can't gate a claim)

`ClinicalGoldenSetSource.load()` refuses any document flagged `"template": true`, or whose case
`metadata.label_provenance` is `"TEMPLATE-PLACEHOLDER"`, raising `ValueError`, **unless**
`allow_template=True` is passed (reserved for schema/CI smoke tests):

```python
from harness.eval.golden import ClinicalGoldenSetSource, CLINICAL_TEMPLATE_FIXTURE

ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE).load()                      # ValueError (refused)
ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE, allow_template=True).load()  # ok (smoke only)
```

### Authoring the real set

1. `cp fixtures/clinical_v1.template.json fixtures/clinical_v1.json`
2. Replace every `[[PLACEHOLDER]]` with real, de-identified, multi-rater-labeled content per
   `clinical_v1_spec.md` (sections 5-10). Set `"template": false`.
3. Validate against the schema:
   ```bash
   conda run -n arcaenv python -c "import json; from jsonschema import Draft202012Validator; \
   from harness.eval.golden import CLINICAL_FIXTURE, CLINICAL_SCHEMA; \
   Draft202012Validator(json.loads(CLINICAL_SCHEMA.read_text())).validate(json.loads(CLINICAL_FIXTURE.read_text())); \
   print('clinical_v1.json: schema-valid')"
   ```
4. Confirm it loads (and is no longer a template):
   ```bash
   conda run -n arcaenv python -c "from harness.eval.golden import clinical_golden_set_source as s; \
   gs=s().load(); print(gs.version, len(gs.cases), 'cases')"
   ```

### Tests

`src/harness/tests/unit/eval/test_clinical_golden_source.py` covers schema validity, the
integrity guard, projection, and the wiring into `judge_clinician_icc` (offline; no LLM).
`src/harness/tests/unit/eval/test_e3_eval_wiring.py` covers `concept_harm_v0.json`.

## Gotchas

- **`clinical_v1.json` intentionally does not exist yet.** It is the open Phase-0 prerequisite
  for a clinically-validated ICC claim, not a missing file to reconstruct from the template.
- **The template can never silently become a calibration result** — the integrity guard above
  raises rather than degrading, and `allow_template=True` is reserved for smoke tests only.
- **`curated_v1.json` is retained unmutated.** Do not edit it even to "fix" a labelling issue —
  historical runs (recorded in `apps/harness/eval/README.md`) are only interpretable against the
  exact set they scored. Ship a new version instead (as `curated_v2` did).

## Related

- [`../../../../eval/README.md`](../../../../eval/README.md) — the eval gate this golden set
  feeds, judge selection, and live gate results
