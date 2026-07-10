# TASK-487 — Streaming Quality Scorecard: Threshold Recalibration + A1 Churn-Metric Decision

- **Status**: Pending
- **Type**: decision + calibration (streaming eval harness) — **product-owner-gated** (not a straight bugfix)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · SOTA enhancement track
- **Origin**: [TASK-470 — Streaming Quality Eval Harness](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (owns `streaming_thresholds.json`) + [TASK-471 — Tentative-Tail Render](../TASK-471-Tentative-Tail-Render/README.md) (AC-4 before/after latency gate). Surfaced 2026-07-10 the moment the [TASK-484](../TASK-484-Streaming-Audio-Read-Timeout/README.md) empty-final fix (`fix/2605-review` @ `0040fe3e`) unblocked the live scorecard: it now produces REAL finals, and its committed regression gate went red on two **non-quality** guardrails that reflect TASK-471's designed cadence trade-off, not a defect.
- **Finding + severity**: **MEDIUM** — blocks the TASK-470/471 pass/fail gate from going green. The empty-final blocker is fixed and every QUALITY guardrail passes (WER ≪ ceiling, recall ≥ floor, coverage ≥ baseline, seq_gap 0); the gate is red only on `partial_revision_rate` and `commit_latency_p50`, which are (a) the tentative tail behaving as designed and (b) single-box inference contention. Needs a PO decision + a clean-host recapture before the gate is meaningful — NOT a threshold that should be silently loosened to force green.
- **Size**: M
- **Suggested agent**: general backend / eval-harness (Python) — apply after the PO decision; a metric refinement in `streaming_quality.py` + a clean-host recapture run.

## Requirement Analysis

Now that finals commit (TASK-484), the TASK-470 regression gate must be made **meaningful** for the TASK-471 tentative-tail cadence rather than left calibrated against a pre-tentative-tail, pre-finals baseline. Three coupled decisions, all currently RED or unset:

1. **A1 churn guardrail — `partial_revision_rate`.** Observed **0.77–0.80** vs committed `baseline 0.0 + epsilon 0.02` (the A1 guardrail: "a tentative tail must NOT increase caption churn", from TASK-455 when the tail was inactive). The metric (`tests/integration/test_streaming_loss_harness.py::partial_revision_rate`) counts a *revision* whenever partial[n] does **not** `startswith` partial[n-1] — over the **full caption text**, unaware of the LocalAgreement-2 `stable_chars` boundary. But the tentative tail is *designed* to revise; only the **committed prefix** must stay stable. So the metric measures the wrong surface for the tentative-tail model, and 0.8 is expected churn of the 1.0→0.4 s cadence, not caption flicker the user actually sees (the UI renders the committed prefix stable + the tail ghosted).
2. **`commit_latency_p50/p99`.** Observed **7383 / 7759 ms** vs `6023.2 / 7624.2` baseline (ratio gate ±15% → p50 ceiling 6926.7). Inference-dominated (whisper-large-v3-turbo on MPS) and captured under **single-box contention** (STT-v2 + gateway + `say`-TTS on one host during the TASK-484 validation). p99 already passes; p50 is marginal and host-bound.
3. **Quality baselines** (`medical_wer`, `keyterm_recall`, `keyphrase_recall`) are `null` with bootstrap ceilings/floors that pass. TASK-470's `streaming_thresholds.json` `_comment` says to tighten them to the captured value once the live scorecard lands — which it now has — but the first capture used `say`-TTS (unrealistically clean: WER 0.03–0.07), so baselines must be captured from **real scripted clinical reads on a clean host**, not the synthetic fixtures.

### Acceptance criteria

- [ ] **AC-1 (A1 metric decision + optional refinement)**: PO decides between (a) redefine `partial_revision_rate` to be `stable_chars`-aware — measure revision of the **committed region** only (which LA-2 keeps ≈ 0), (b) keep the full-caption metric but re-base the A1 baseline for the tentative-tail cadence with a documented epsilon, or (c) both. If (a)/(c): implement in `streaming_quality.py` (+ the harness metric), keeping the current full-caption number reported as an informational field.
- [ ] **AC-2 (latency re-base)**: recapture `commit_latency` on a **non-contended host** (STT-v2 and gateway not competing for the same cores) for whisper-large-v3-turbo; decide whether the TASK-455 baseline (`6023/7624`) still holds or must be re-based for the target hardware. Record the ratio-gate verdict.
- [ ] **AC-3 (quality baseline capture)**: capture `medical_wer`/`keyterm_recall`/`keyphrase_recall` baselines from real scripted clinical reads (NOT `say`-TTS) on a clean host; tighten the `null` baselines to captured + documented epsilon. Confirm the guardrail ceilings/floors still hold.
- [ ] **AC-4 (TASK-471 before/after, now unblocked)**: run the TASK-471 AC-4 cadence comparison `STREAMING_PARTIAL_INTERVAL_S=1.0` vs `0.4` on the working scorecard and record tentative-visible-latency improvement against the (refined) churn + latency deltas — the actual A1 trade-off evidence.
- [ ] **AC-5 (gate green, honestly)**: with the above decisions applied, the scorecard regression gate passes on a clean-host run WITHOUT loosening a guardrail to accommodate a real regression. Paste the scorecard JSON.

## Current State Evaluation

- **Empty-final blocker fixed** (TASK-484, `0040fe3e`): the gateway result-stream bridge no longer treats `status:"finalizing"` as terminal, so the tail final is relayed; the redis read-timeout was a red herring (env-injected `socket_timeout < BLOCK`, now tolerated). Scorecard through the WS gateway is unblocked.
- **`apps/stt-v2/tests/integration/streaming_thresholds.json`** (TASK-470, source of truth): quality baselines `null` (bootstrap `medical_wer ceiling 0.35`, `recall floor 0.70`); `partial_revision_rate baseline 0.0 / epsilon 0.02`; `commit_latency_ms p50 6023.2 / p99 7624.2 / epsilon_ratio 0.15`; `audio_coverage_ratio baseline 0.996 / epsilon 0.005`; `seq_gap_count max 0`.
- **Live 2026-07-10 first real scorecard** (say-TTS clinical fixtures, single host, whisper-large-v3-turbo, pipeline `…402`/`best-practice-realtime`, both carry `commit_policy: local_agreement_2`):

  | metric | cardiology_01 | discharge_01 | medication_01 | gate |
  |---|---|---|---|---|
  | medical_wer | 0.033 | 0.065 | 0.066 | PASS (≪ 0.35) |
  | keyterm_recall | 1.00 | 1.00 | 1.00 | PASS (≥ 0.70) |
  | keyphrase_recall | 1.00 | 0.75 | 1.00 | PASS (≥ 0.70) |
  | audio_coverage_ratio | 0.994 | 0.994 | 0.997 | PASS (≥ 0.991) |
  | seq_gap_count | 0 | 0 | 0 | PASS |
  | partial_revision_rate | ~0.77–0.80 | ~0.77–0.80 | ~0.77–0.80 | **FAIL** (vs 0.02) |
  | commit_latency_p50 | — | — | 7382.9 | **FAIL** (vs 6926.7) |
  | commit_latency_p99 | — | — | 7758.8 | PASS (vs 8767.8) |

## Implementation Plan

Decision-gated; no code until AC-1/AC-2/AC-3 are resolved by the PO. Then (if AC-1 chooses a refinement): TDD the `stable_chars`-aware revision metric in `streaming_quality.py`, thread the committed-region churn through the scorecard, keep the legacy full-caption value as an informational field, update `streaming_thresholds.json` baselines from the clean-host capture (documented epsilons), and re-run the scorecard to a green gate. Cross-fold the captured baseline back into TASK-470 and the TASK-471 AC-4 record.

## Implementation Summary

_(pending — decision + clean-host recapture not yet performed.)_

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Scaffolded. Opened as a follow-up when the TASK-484 empty-final fix (`0040fe3e`) unblocked the TASK-470 scorecard live: quality guardrails pass, but the regression gate is red on `partial_revision_rate` (0.8 vs the A1 0.0+ε=0.02 — the designed churn of TASK-471's 1.0→0.4 s tentative-tail cadence, measured on full-caption text rather than the LA-2 committed prefix) and `commit_latency_p50` (single-box inference contention). Thresholds deliberately NOT gamed during the TASK-484 fix; this ticket carries the product-owner decision (refine the A1 metric to the committed region / re-base latency on a clean host / capture the null quality baselines) + the now-unblocked TASK-471 AC-4 before/after cadence run. |
