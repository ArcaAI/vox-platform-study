# TASK-521 — Clinician golden set program

**Status:** Documented (program action — owner-run; no CI hard-fail flip in this ticket)
**Type:** program
**Parent program:** TASK-508 Phase 6 (Accuracy wave)

## Requirement Analysis

Execute `clinical_v1_spec.md`: assign a clinical SME owner, collect **N ≥ 132**
de-identified cases, have **3 blinded raters** score them to a human **ICC ≥ 0.75**,
then flip the Phase 0 `harness-eval-gate` CI job to **hard-fail** and re-baseline
PDSQI / faithfulness / MiniCheck (AC-6) on real rated data.

## Current State Evaluation (what already shipped)

- `harness-eval-gate` CI job **exists** in `.gitlab/ci/test.yml` — runs
  `python -m harness.eval.ci` (PDSQI-9 + faithfulness + ICC) over the `curated_v1`
  golden set (18 cases) **and** the offline promptfoo output-contract gate.
- It is deliberately **`allow_failure: true`** (diagnostic/wiring-only) because:
  1. no CI-reachable judge backend is wired yet (`HARNESS_JUDGE_*`), and
  2. the real clinician-rated golden set does not exist yet.

## Owner action (must NOT be automated here)

- Assign the **clinical SME owner** (the single non-engineering long pole — start now).
- Collect **N ≥ 132** de-identified cases; run **3 blinded raters**; achieve **ICC ≥ 0.75**.
- Stand up a **CI-reachable judge backend** (`HARNESS_JUDGE_*`: LM Studio / vLLM / Azure /
  Bedrock).

## Exact CI change to make **once the rated data + judge backend land**

**Do not apply now** — this requires real rated data. In `.gitlab/ci/test.yml`, on the
`harness-eval-gate` job:

```yaml
harness-eval-gate:
  stage: test
  image: python:3.11-slim
  tags: [test]
  allow_failure: false          # ← flip from true (was diagnostic/wiring-only)
  # …
  script:
    - cd apps/harness
    - pip install --quiet --retries 5 --timeout 120 ".[test,eval]"
    # point the gate at the clinician-rated golden set (replaces curated_v1):
    - python -m harness.eval.ci --golden-set src/harness/eval/golden/fixtures/clinical_v1.json --output ../../eval-report.json
    # promptfoo output-contract gate stays as-is
```

Also required alongside the flip:
- Provide the judge backend env (`HARNESS_JUDGE_*`) to the runner so step 1/2 can reach a
  live, model-agnostic judge.
- Add `clinical_v1.json` (the rated golden set) under
  `apps/harness/src/harness/eval/golden/fixtures/`.
- Re-baseline the PDSQI / faithfulness / MiniCheck (AC-6) thresholds in `harness.eval.ci`
  against the real distribution.

> This ticket intentionally leaves `allow_failure: true` untouched — flipping it without
> real rated data would hard-block MRs on a gate that fails closed (no judge backend).

## Change History

- 2026-07-19 — Program doc: documented the SME/data-collection owner action and the exact
  `harness-eval-gate` CI change to make once the clinician golden set + judge backend land.
  No CI edit performed (per ticket constraint).
