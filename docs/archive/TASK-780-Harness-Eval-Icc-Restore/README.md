# TASK-780 — Restore the Harness Eval Gate's ICC Release Bar to 0.80

| | |
|---|---|
| **Status** | Pending |
| **Wave** | — · **Size** | M (depends on which lever is chosen — see §3) |
| **Epic slug** | `harness-eval-gate` |
| **Depends on** | TASK-713 (closed the gate at a lowered, honestly-measured baseline; this ticket restores the original bar) |
| **Design refs** | None — this is a quality/measurement ticket, not a design fork |
| **Findings closed** | None yet — opened directly from TASK-713's Change History (2026-08-20) as recorded debt, not from a numbered audit finding |

## 1. Requirement Analysis

TASK-713 made the `harness-eval-gate` CI/internal-endpoint release gate real: a working
PDSQI-9 judge, a rebuilt 36-case clinician-provenance-tracked golden set
(`curated-v2.0.0`, 288 paired ratings), DB-resident fail-closed judge selection, and a
genuine, reproduced measurement of judge↔clinician agreement — **`icc = 0.7306`**
(Gwet AC2 0.9196, n = 288) — against the PDSQI-9-literature-derived release target of
**ICC(2,1) ≥ 0.80**.

Six implementation sessions confirmed this is a real, moderate reliability reading, not
an artifact of a broken measurement (the two hypotheses that would have explained it away
— context-length truncation, and a judge-selection bug — were both tested and falsified
or fixed). The residual disagreement is concentrated and specific: `comprehensible` has
**zero judge-side variance** (a literal 5 on all 36 cases — a ceiling effect) and
`succinct` has low variance (SD 0.401); de-biasing the judge's leniency only lifts ICC to
0.7350 (Pearson r 0.7387), so this is genuine rank disagreement between judge and
reference labels, not a correctable scoring offset.

Rather than hold TASK-713 open indefinitely against that gap, the owner ruled
(2026-08-20) to lower the enforced `icc_threshold` to the measured baseline (**0.73**)
and close that ticket, with the 0.80 restoration explicitly tracked here as debt. **This
ticket is that restoration.** It does not start over — it picks up exactly where
TASK-713 left the diagnosis and executes ONE (or both) of the two remedies TASK-713
identified but did not attempt, because both are real, multi-week efforts outside an
engineering session's scope:

1. **A reasoning-capable judge** with usable dynamic range on `comprehensible` and
   `succinct` — the current judge (`gemma-4-e4b-it-qat`, DB-resident via
   `harness.judge`'s `AiTaskDefault`) was selected for CI-reachable local latency, not
   maximal judge↔clinician agreement.
2. **A clinician-reviewed reference set** — `curated-v2.0.0`'s labels are AI-authored,
   rubric-literal, and every case carries `clinician_review_status: pending`. The review
   workflow (`apps/harness/src/harness/eval/golden/review/curated_v2_review.md`,
   `apply_amendments.py`) already exists and is waiting for an actual clinician pass.

**Explicitly out of scope (until a further decision):**
- Re-litigating the 2026-08-20 decision to lower `icc_threshold` to 0.73 — that is
  TASK-713's closed, owner-approved outcome. This ticket's job is to earn the bar back
  up, not to argue the lowering was wrong.
- Building a THIRD golden-set version or a new metric family — the existing
  `curated-v2.0.0` cases and PDSQI-9 dimensions are the substrate; this ticket either
  gets them reviewed by a clinician or gets a better judge to score them, not a redesign.
- Choosing the judge/clinician-review path unilaterally — §6 requires an owner decision
  on which remedy (or both) to pursue before implementation starts, per the same
  HUMAN-GATED posture TASK-713 used for its judge-backend decision.

## 2. Current State Evaluation

_To be filled in by the session that picks this ticket up — re-verify against the live
tree before planning, since TASK-713's sixth/seventh sessions may not be the last to
touch `apps/harness/src/harness/eval/`._ Starting points, current as of TASK-713's
closure (2026-08-20):

- **Threshold**: `EvalConfig.icc_threshold = 0.73` (`apps/harness/src/harness/eval/config.py`),
  env-overridable via `HARNESS_EVAL_ICC_THRESHOLD`. The literature target (0.80) is
  still documented as the aspirational bar in `apps/harness/src/harness/eval/golden/clinical_v1_spec.md`,
  `curated_v2_spec.md`, and `calibration/reliability.py`'s module docstring — those were
  deliberately left saying "0.80" as the target this ticket restores, not rewritten to 0.73.
- **Golden set**: `curated-v2.0.0` (36 cases, 288 paired ratings, `dev`/`holdout` 24/12
  split), fixtures under `apps/harness/src/harness/eval/golden/fixtures/`. Every case's
  `clinician_pdsqi` label carries `clinician_review_status: pending` and a per-case
  `label_rationale` — the review artifact (`review/curated_v2_review.md`) and amendment
  tool (`apply_amendments.py`) are built but no amendments have been applied.
  `apply_amendments.py` refuses an unattributed amendment, applies only named
  dimensions, flips provenance to `clinician-reviewed`, and ships a NEW golden-set
  version rather than mutating `curated-v2.0.0` in place.
- **Judge**: `gemma-4-e4b-it-qat`, resolved DB-resident via the SYSTEM `AiTaskDefault` →
  `AiModel` for the `harness.judge` task (`harness/eval/judge/selection.py`), fail-closed,
  tenant → SYSTEM cascade, no env fallback.
- **The specific residual** (TASK-713 §7.6.6, unchanged): `comprehensible` judge SD =
  0.000 (ceiling effect); `succinct` judge SD = 0.401; L1-band systematic leniency
  (judge mean 2.719 vs reference 1.750); de-biased ICC caps at 0.7350.

## 3. Implementation Plan

_Owner decision required before this section is filled in — see §6._ Once the remedy
(or remedies) are chosen, this section should lay out, TDD-first per
`01-development-workflow.md`:

- If **clinician review**: who reviews, what the amendment turnaround looks like, how
  `apply_amendments.py`'s output version (`curated-v2.1.0`?) gets wired into
  `run-gate.sh`/`ci.py` in place of `curated-v2.0.0`, and a re-run of the full gate
  against the amended set with the measured ICC recorded exactly like TASK-713's own
  sessions did (real numbers, no rounding up, report failures honestly if the bar still
  isn't met).
- If **a new judge**: which model/provider, how it's provisioned in the SYSTEM
  `AiTaskDefault` for `harness.judge` (this is DB-resident config already — TASK-713
  §7.6.3 — so no new env var should be needed), a repeat of the context-length /
  ceiling-effect checks TASK-713 already built tooling for, and a fresh measured run.
- Either path ends the same way: if the remeasured ICC clears 0.80, raise
  `EvalConfig.icc_threshold` back to 0.80 (removing the 2026-08-20 baseline-and-provenance
  comment, or updating it to record the restoration), add/update the discriminating test
  pinned at the new number, and close this ticket referencing the fresh measurement. If
  it clears some intermediate value above 0.73 but below 0.80, that is a NEW baseline
  decision for the owner, not an automatic threshold bump — do not silently split the
  difference.

## 4. Implementation Summary

_Not started._

## 5. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-20 | Ticket opened as tracked debt from TASK-713's closure (owner ruling: `icc_threshold` lowered 0.80→0.73 against the measured `curated-v2.0.0` baseline, `icc=0.7306`/n=288; this ticket tracks earning the 0.80 bar back). No implementation started. | Claude (opened alongside TASK-713 closure) |

## 6. Risks & Open Questions

- **Owner decision required before implementation**: which remedy — reasoning-capable
  judge, clinician review, or both — and in what order. Both are real efforts (a judge
  swap needs re-validation against the same context-length/ceiling-effect pitfalls
  TASK-713 diagnosed; clinician review needs an actual clinician's time against a
  1600+-line review document). Neither should be started speculatively.
- **Risk of re-measuring worse, not better.** A new judge could disagree with the
  reference set differently, not necessarily more favorably; a clinician review could
  also *lower* some reference labels (e.g., if `comprehensible`'s flat-5 judge reading
  turns out to be closer to right than the rubric-derived reference). Either outcome is a
  legitimate finding to report, not a result to discard in favor of trying again.
- **This ticket must not "re-baseline" `icc_threshold` upward without a genuine
  re-measurement** — the 0.73 floor stays until a REAL run against real data clears
  whatever the next number is, exactly as TASK-713 refused to relax the bar without
  evidence.
