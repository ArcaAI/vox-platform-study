# `golden/` — golden sets & calibration sources

The golden set is the pinned corpus the eval gate scores. It is read through a
small `GoldenSetSource` interface so the source is swappable (`sources.py`), and
scored by `GoldenSetRunner` (`runner.py`). Threshold gating lives in
`harness.eval.ci`.

## Contents

| File                                 | Provenance                                              | Use                                                             |
| ------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| `fixtures/synthetic_v0.json`         | synthetic                                               | hermetic CI smoke (default source)                              |
| `fixtures/curated_v1.json`           | **curated, rubric-derived** (NOT real clinician labels) | exercises the harness end-to-end; **not** a clinical validation |
| `fixtures/clinical_v1.schema.json`   | —                                                       | JSON Schema (Draft 2020-12) contract for the **real** set       |
| `fixtures/clinical_v1.template.json` | **TEMPLATE / PLACEHOLDER**                              | copy-me starting point for SMEs; refused by the loader          |
| `fixtures/clinical_v1.json`          | **real (clinician-authored)**                           | _does not exist yet — the open Phase-0 prerequisite_            |
| `clinical_v1_spec.md`                | —                                                       | spec + multi-rater labeling protocol + ICC plan                 |

> The reported **ICC ≈ 0.821 is judge-vs-rubric over n = 6**, not a clinical
> validation. A clinically-validated claim requires the real `clinical_v1.json`
> (N ≥ 132, ≥3 blinded raters/case). See `clinical_v1_spec.md`.

## Sources (`sources.py`)

- `JSONFileGoldenSetSource(path)` — loads a flat `GoldenSet` JSON (the synthetic/curated fixtures).
- `ClinicalGoldenSetSource(path, *, allow_template=False)` — loads the **rich**
  multi-rater `clinical_v1` format and **projects** it onto `GoldenCase`
  (`project_clinical_case`): adjudicated consensus → `clinician_pdsqi`; raters /
  adjudication / claims / safety / de-id / provenance → `metadata`. Drop-in for
  the runner and the `judge_clinician_icc` gate — **no `models.py` change**.
- `clinical_golden_set_source()` — convenience pointing at `clinical_v1.json`
  (raises `FileNotFoundError` until SMEs author it — **no synthetic fallback**).

### Integrity guard (why placeholders can't gate a claim)

`ClinicalGoldenSetSource.load()` **refuses** any document flagged
`"template": true` or whose case `metadata.label_provenance` is
`"TEMPLATE-PLACEHOLDER"`, raising `ValueError`, **unless** `allow_template=True`
is passed (reserved for schema/CI smoke-tests). So the shipped template can never
silently become a calibration result.

```python
from harness.eval.golden import ClinicalGoldenSetSource, CLINICAL_TEMPLATE_FIXTURE

ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE).load()                 # ValueError (refused)
ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE, allow_template=True).load()  # ok (smoke only)
```

## Authoring the real set

1. `cp fixtures/clinical_v1.template.json fixtures/clinical_v1.json`
2. Replace **every** `[[PLACEHOLDER]]` with real, de-identified, multi-rater-labeled
   content per `clinical_v1_spec.md` (§5–§10). Set `"template": false`.
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

## Running calibration once real cases land

The gate is `python -m harness.eval.ci`. Point it at the real set and a live judge
(model-agnostic via `HARNESS_JUDGE_*`). **Heavy/live-model run — do not launch
casually if a sibling agent is using the judge backend.**

```bash
conda run -n arcaenv env \
  HARNESS_EVAL_GOLDEN_SET_VERSION=clinical-v1.0.0 \
  python -m harness.eval.ci \
    --golden-set apps/harness/src/harness/eval/golden/fixtures/clinical_v1.json \
    --output clinical-eval-report.json
```

The report includes `aggregates.icc` (judge↔consensus, gate ≥ 0.80) and
`aggregates.gwet_ac2`. The **human inter-rater reliability** (precondition,
ICC_human ≥ 0.75) is a separate offline analysis over `metadata.pdsqi_raters`
using `harness.eval.calibration.intraclass_correlation` — see spec §8.

## Tests

`src/harness/tests/unit/eval/test_clinical_golden_source.py` covers schema
validity, the integrity guard, projection, and the wiring into
`judge_clinician_icc` (offline; no LLM).
