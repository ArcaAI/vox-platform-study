# TASK-470 — Streaming Quality Eval Harness (Theme F · SOTA S1-EVAL · **the measurement gate**)

- **Status**: Review (pure scoring metrics + regression gate + de-identified clinical fixtures delivered as NEW test code only, zero product diff; hermetic unit gate GREEN. The live-stack scorecard capture — a real WER/recall run through STT-v2 — is the orchestrator's step, exactly like TASK-455's live baseline.)
- **Type**: infrastructure (test coverage + measurement) — **gating dependency for every ASR/NER quality ticket in the SOTA track**
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **F** (the gate — lands FIRST)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA S1 (streaming ASR ~5–7× behind; no quality eval to prove any improvement)
- **Extends (do NOT fork)**: [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md) — its loss/latency harness already emits partial-revision-rate, commit-latency P50/P99, and seq/coverage loss; this ticket layers the **quality** metrics (medical WER + clinical keyterm/keyphrase recall) and a **pass/fail regression gate** on top of the same plumbing.
- **Theme**: F · **Size**: M · **Value**: High (unblocks all of A/C) · **Risk**: Low
- **Depends on**: TASK-455 (imports its harness). **Gates**: TASK-471 (A1), TASK-472 (A2), TASK-473 (A3), TASK-475 (B2), TASK-476/477 (C).
- **Suggested agent**: tester (pytest + Redis + WS; reuses the TASK-455 fixtures/bootstrap)

## File-ownership manifest (best-effort exclusive — binding — NEW files only)

| Path | Contents |
|---|---|
| `apps/stt-v2/tests/integration/streaming_quality.py` (new) | **Pure** metric functions — `medical_wer(ref, hyp)`, `keyterm_recall(keyterms, hyp)`, `keyphrase_recall(...)`, `build_scorecard(...)`, `assert_no_regression(scorecard, thresholds)`. Deterministic, dependency-light (self-contained word-level edit distance mirroring `apps/ui-playground/e2e/helpers/wer.ts`), unit-testable with **no services up**. |
| `apps/stt-v2/tests/integration/test_streaming_quality_scorecard.py` (new) | The scorecard test: reuses TASK-455's session bootstrap + through-the-gateway run, captures finals, computes the full scorecard, writes the JSON artifact, and **asserts the regression thresholds** (the pass/fail gate TASK-455 deliberately deferred). Plus a pure-CPU `test_quality_metric_functions_are_correct` self-check. |
| `apps/stt-v2/tests/e2e/fixtures/clinical/` (new) | A small **self-hosted / synthetic, de-identified** clinical fixture set: `*.wav` (16 kHz mono) + `*.gt.txt` (ground-truth reference) + `*.keyterms.json` (curated clinical keyterms/keyphrases per clip). **No real PHI** — scripted clinical reads only (self-hosted posture). |
| `apps/stt-v2/tests/integration/streaming_thresholds.json` (new) | The committed regression thresholds (baseline ± ε per metric) the scorecard gates on — the single source of truth A1/A2/A3/B/C are judged against. |

**Read-only reference (import, do NOT modify)**: `apps/stt-v2/tests/integration/test_streaming_loss_harness.py` (import its `_run_one_session`, `load_replay_audio`, `compute_metrics`, `_stats`, `partial_revision_rate`, `seq_loss`, `FrameRecord`, `MessageRecord` — all module-level, importable), `apps/stt-v2/tests/integration/test_streaming_latency_harness.py`, `tests/helpers/streaming.helper.ts` (TS side; the TS WER helpers `apps/ui-playground/e2e/helpers/wer.ts` are an **algorithm reference only** — the Python harness reimplements a small deterministic WER to stay hermetic).

**Manifest-growth guard (STOP-and-report)**: the Python underscore helpers in the loss harness are convention-private but importable, so this ticket needs **zero edit** to TASK-455's files. If a shared helper genuinely needs to become a real export (e.g. a signature change), STOP and report before touching `test_streaming_loss_harness.py` — that is TASK-455's owned file. No product-code counters are added (same posture as TASK-455 §Metric-counter question — metrics are computed in-test).

## Requirement Analysis

TASK-455 built the streaming e2e + **loss/latency** harness and captured the plain-transport baseline (commit-latency P50 ≈ 6.0 s / P99 ≈ 7.6 s, `seq.gap_count = 0`, coverage 0.996). It measured **transport health** (loss, latency, revision churn) but explicitly **not clinical transcript quality** — its own Non-goals say "Full clinical WER/quality scoring … is not the goal — latency/loss is", and AC-6 asserts **no pass/fail threshold** (baseline only). The SOTA track's ASR/NER tickets (A1/A2/A3/B/C) each claim a *quality* or *latency* improvement, and the governing principle is **measure first** — no latency/quality claim ships as an assertion. There is today **no repeatable scorecard** that says "this ASR change improved X without regressing Y", and **no committed thresholds** to gate on.

This ticket delivers exactly that: a **quality scorecard** — medical WER, clinical keyterm/keyphrase recall, partial-revision rate, and commit-latency P50/P99 (audio→visible-stable-word) — plus **committed regression thresholds** and a **gate contract** that A1/A2/A3/B/C must pass. It is the Theme-F counterpart of how TASK-455 gated the TASK-457 consumer-groups migration ("no regression vs baseline"), now generalized from transport-health to clinical quality.

**Metric definitions (the scorecard contract):**

| Metric | Definition | Source | Direction under an ASR change |
|---|---|---|---|
| **Medical WER** | word error rate of the concatenated time-ordered **finals** vs the fixture ground-truth (`*.gt.txt`), normalized (case/punct-folded, medical-term–aware). | NEW (`medical_wer`) | lower = better; **guardrail** (must not regress) |
| **Keyterm / keyphrase recall** | fraction of the clip's curated clinical keyterms (`*.keyterms.json`) present in the normalized hypothesis (multi-word phrases matched as spans). | NEW (`keyterm_recall`) | higher = better; **guardrail** (must not regress) — the "did we drop the drug/dose/finding" catcher |
| **Partial-revision rate** | fraction of partials whose text is not a forward-extension (`startswith`) of the prior partial — flicker/churn signal. | REUSE `partial_revision_rate` (loss harness :340) | lower = better; **the A1 guardrail** (tentative tail must not increase churn) |
| **Tentative-visible latency** | `first_partial_ms` / `ttfw_ms` — audio→first (any / first-worded) caption visible. | REUSE `compute_metrics` (loss harness :397-400) | lower = better; **the A1 target** (tentative tail should improve this) |
| **Commit latency P50/P99** | per-final receive − send of the frame holding the segment `endTime` — audio→**stable** word visible. | REUSE `commit_latency_ms` via `_stats` (loss harness :326-337, :402-417) | lower = better; **guardrail for A1** (conservative commit must not regress), **target for A2** |
| **Loss** | `seq.gap_count` (dropped captions) + `audio_coverage_ratio`. | REUSE `seq_loss` / coverage (loss harness :360-373, :419-435) | zero loss / ≥ coverage; **guardrail** |

The crux that makes F the A1 gate: the scorecard **separates tentative-visible latency (should drop under A1) from commit/stable latency (must NOT drop — commit policy stays conservative) and partial-revision rate (must NOT rise).** A1 "wins" iff tentative latency improves while those two guardrails hold.

### Acceptance criteria

- [ ] **AC-1 (pure metrics, hermetic)** — `streaming_quality.py` exposes `medical_wer`, `keyterm_recall`, `keyphrase_recall`, `build_scorecard`, `assert_no_regression` as pure functions, covered by `test_quality_metric_functions_are_correct` that runs with **no services up** (mirrors the loss harness's `test_metric_functions_are_correct`). Medical WER is a self-contained deterministic word-level edit distance (no new runtime dep; if `jiwer` is ever preferred it goes through `uv lock` as a test-only dep — out of scope here).
- [ ] **AC-2 (scorecard through the gateway)** — `test_streaming_quality_scorecard.py` runs a real session **through the WS gateway** by reusing TASK-455's `_run_one_session` + `load_replay_audio` (NOT straight-to-Redis; NOT a re-implemented client), captures finals, and emits ONE JSON scorecard combining all six rows above (quality + reused transport metrics) via `test.info`/a report path (default `./stt-quality-scorecard.json`).
- [ ] **AC-3 (clinical fixtures + ground truth + keyterms)** — a small self-hosted/synthetic **de-identified** clinical fixture set exists under `apps/stt-v2/tests/e2e/fixtures/clinical/` with per-clip `*.gt.txt` and `*.keyterms.json`. **No real PHI.** The scorecard asserts/skips cleanly if a fixture or its ground-truth is absent.
- [ ] **AC-4 (regression thresholds — the gate TASK-455 deferred)** — `streaming_thresholds.json` holds committed thresholds; `assert_no_regression` FAILS the run when: `medical_wer > baseline + ε`, `keyterm_recall < baseline − ε`, `partial_revision.rate > baseline + ε`, `commit_latency_ms.p50|.p99 > baseline × (1 + ε)`, `seq.gap_count > 0`, or `audio_coverage_ratio < baseline`. ε values are documented and justified. This is the concrete pass/fail scorecard gate (vs TASK-455's baseline-only).
- [ ] **AC-5 (gate contract for A1/A2/A3/B/C)** — §Implementation Summary states the exact "no-regression / must-improve" contract each downstream ASR/NER ticket re-runs this scorecard against (same fixtures + pipeline + frame_ms), naming the **target** metric that must improve and the **guardrail** metrics that must not — mirroring TASK-455's "No regression contract handed to TASK-457".
- [ ] **AC-6 (baseline scorecard captured)** — a baseline run on the current LocalAgreement-2 transport is recorded in §Implementation Summary (the numbers A1 et al. are compared to), captured as a JSON artifact in this ticket folder.
- [ ] **AC-7 (runnable + documented)** — prereqs documented (`pnpm docker:test:up` + `pnpm test:api:up` + `pnpm test:stt-v2:up` + a seeded owned ASR pipeline, default `turbo-whisper-large-v3` `81000000-…-402` per TASK-455); clean self-skip when STT-v2/login/session/model unreachable; invocation via the existing `pnpm py:stt-v2:test:integration` (no new alias — same as TASK-455).
- [ ] **AC-8 (conventions)** — `test_*.py` under `tests/integration/`, `pytest.mark.integration`, `asyncio_mode=auto`; ruff + mypy clean; the pure self-check needs no infra.

### Non-goals

- Implementing any ASR/NER change (A1 TASK-471, A2 TASK-472, A3 TASK-473, B TASK-474/475, C TASK-476/477) — this only **measures and gates** them.
- Adding Prometheus commit-latency/partial-revision counters to product code (same deferral as TASK-455 — a separate ticket if scrapable counters are wanted).
- Real-PHI clinical audio (self-hosted, synthetic/de-identified fixtures only — SOTA track guardrail).
- Full MEDCON/UMLS concept-F1 over persisted `NamedEntity` codes — that is TASK-482 (E3) and depends on TASK-476 populating codes; this ticket's "keyterm recall" is the lightweight surface-form proxy, not concept-linking.
- Diarization/speaker-attribution scoring (Theme B; TASK-474/475).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ 87b33f57)

**TASK-455 harness is present and merged** (all five manifest files exist on-disk):
- `apps/stt-v2/tests/integration/test_streaming_loss_harness.py` — routes audio **through the WS gateway** (`/ws/stt-v2/stream`) and already computes, on one monotonic client clock: `first_partial_ms`/`ttfw_ms` (tentative-visible latency), `commit_latency_ms` P50/P99 via `_stats` (:326-337, per-final :402-417), `partial_revision_rate` (:340-357), `seq_loss` (:360-373), coverage (:419-435), aggregated in `compute_metrics` (:376-444) and emitted as a JSON report with a `definitions` block and a `baseline_contract_for_TASK_457` block (:622-662). Session bootstrap/run = `_run_one_session` / `load_replay_audio`; a pure-CPU self-check `test_metric_functions_are_correct` (:553-575) proves the metric math with no stack.
- `tests/helpers/streaming.helper.ts` — the TS session-mint + WS + frame-feeder helper (used by the Playwright e2e specs).
- Fixtures: `apps/stt-v2/tests/e2e/fixtures/` has `…_ml.wav`, `…_en.wav`, `2p_argument.mp3` — **but NO ground-truth `.txt`** for the stt-v2 fixtures. Ground-truth references DO exist for the ui-playground fixtures (`apps/ui-playground/e2e/fixtures/asr_en.txt`, `asr_ml.txt`, `fr.txt`, `asr-en-vi.txt`) — non-clinical content (movie-plot dialogue, IT-professional intro).

**What is missing (this ticket adds):**
1. **Quality metrics.** The loss harness has NO WER and NO keyterm recall (its Non-goals excluded them). WER machinery exists only on the TS side: `apps/ui-playground/e2e/helpers/wer.ts` (`computeWer`, `computeCer`, `normalizeText`, `formatWerReport`) + `segment-metrics.ts` (`simpleWordWer`, per-segment WER, SER). The Python harness has none — it must gain a small deterministic WER (algorithm mirrored from `wer.ts`) to stay hermetic and Python-native.
2. **Clinical ground-truth + keyterm fixtures.** No `*.gt.txt` for stt-v2 fixtures; **no clinical keyterm/keyphrase list anywhere in the repo** (grep for `keyterm|key.phrase|clinical.term` found only unrelated Storybook bundles + a DNA-writing-style seed). Both are new.
3. **A pass/fail threshold gate.** TASK-455 AC-6 is explicitly baseline-only ("No target thresholds are asserted as pass/fail yet"); the report JSON's `baseline_contract_for_TASK_457` is prose, not an assertion. This ticket adds `streaming_thresholds.json` + `assert_no_regression`.

**Invocation surface**: `pnpm py:stt-v2:test:integration` runs everything under `apps/stt-v2/tests/integration/` (`package.json:118`) — the new scorecard test lands there and needs no new alias.

## Implementation Plan (TDD sketch — strict order)

> Context pack for the implementing agent: this README · TASK-455 README (the harness it extends, esp. §CAPTURED BASELINE + the "no regression contract") · SOTA-Track §Theme F + §Governing principle (measure first) · `.claude/rules/06-python-services.md` (pytest ≥ 9, `asyncio_mode=auto`, ruff/mypy, hermetic-CI posture) · `.claude/rules/09-infrastructure-devops.md` (isolated test infra + ports).

1. **RED (pure metrics)** — write `test_quality_metric_functions_are_correct` first: known `(ref, hyp)` pairs with hand-computed WER; a keyterm list with a known present/absent split → expected recall; a partial-revision case reusing the imported `partial_revision_rate`. Watch it fail (functions absent).
2. **GREEN (pure metrics)** — implement `medical_wer`, `keyterm_recall`, `keyphrase_recall`, `build_scorecard`, `assert_no_regression` in `streaming_quality.py`. `medical_wer`: normalize (fold case/punct; optional medical-synonym map is a documented stub, not required for v1) → word-level Levenshtein → WER. `build_scorecard` composes the reused `compute_metrics` output + the new quality fields into one dict.
3. **Fixtures** — add the small de-identified clinical fixture set (`*.wav` + `*.gt.txt` + `*.keyterms.json`). Keep clips short (≈15–30 s) and scripted; document provenance (synthetic/self-hosted, no PHI).
4. **GREEN (scorecard through the gateway)** — write `test_streaming_quality_scorecard.py`: import `_run_one_session`/`load_replay_audio`/`compute_metrics` from the loss harness, run each clinical fixture through the gateway, `build_scorecard`, write the JSON artifact. Reachability gates → clean skips (copy the loss harness's skip pattern).
5. **Baseline + thresholds** — capture the baseline scorecard (AC-6), write `streaming_thresholds.json` from it (baseline ± documented ε), then wire `assert_no_regression` so the test FAILS on regression (AC-4). Record the baseline JSON in this folder and the numbers in §Implementation Summary.
6. **Gate contract** — write the A1/A2/A3/B/C "target vs guardrail" contract into §Implementation Summary (AC-5).

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm docker:test:up
pnpm test:api:up        # terminal 1
pnpm test:stt-v2:up     # terminal 2
# pure self-check runs even with nothing up:
pnpm py:stt-v2:test:integration   # runs test_streaming_quality_scorecard.py + the pure self-check
pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
```

Adversarial review focus (reviewer agent): (a) does the scorecard truly **reuse** the TASK-455 harness (imports `_run_one_session`/`compute_metrics`) rather than forking a second client + second metric implementation? (b) is `medical_wer` deterministic and correct on the hand-checked self-check (no hidden randomness, stable normalization)? (c) are the thresholds justified (ε defensible) and does `assert_no_regression` actually FAIL on a synthetic regressed scorecard — proven by a test, not asserted? (d) do the fixtures contain zero real PHI? (e) clean self-skip when STT-v2 is down (no false failures)? (f) new files only — zero diff to TASK-455's files and to product code.

## Implementation Summary

Delivered as **NEW test code + fixtures only — zero product diff, zero edit to TASK-455's files** (the loss-harness underscore helpers are convention-private but importable, so no export change was needed — no manifest-growth STOP triggered). Built strict TDD (RED → GREEN). The pure scoring/gate math is unit-tested **hermetically** (nothing up); the live through-the-gateway scorecard capture is the orchestrator's full-stack step (self-skips off-stack — never a false failure), exactly as TASK-455 scoped its own live baseline.

### Files added (manifest honored)

| Path | Purpose |
|---|---|
| `apps/stt-v2/tests/integration/streaming_quality.py` | **Pure, stdlib-only** metric functions (no numpy, no services): `normalize_text`, `medical_wer`, `keyterm_recall`, `keyphrase_recall`, `build_scorecard`, `regression_report`, `assert_no_regression`, `MEDICAL_SYNONYMS`. WER algorithm (word-level Levenshtein + backtrace, same normalization + tie-break order) mirrored from the TS gate `apps/ui-playground/e2e/helpers/wer.ts` so Python and TS agree. |
| `apps/stt-v2/tests/integration/test_streaming_quality_scorecard.py` | The scorecard test module. `test_quality_metric_functions_are_correct` (pure self-check — the unit gate this ticket owns), `test_clinical_fixtures_are_wellformed` (pure fixture-integrity + PHI-red-flag scan), `test_streaming_quality_scorecard` (LIVE run: **reuses** TASK-455's `_run_one_session`/`load_replay_audio`/`compute_metrics` — imported, not forked — builds the scorecard, writes `./stt-quality-scorecard.json`, asserts the thresholds). Overrides the integration conftest's docker gate (like the loss harness) so the pure checks run with nothing up. |
| `apps/stt-v2/tests/integration/streaming_thresholds.json` | Committed regression thresholds (the A1/A2/A3/B/C gate). Transport rows = TASK-455's captured baseline; quality rows = documented bootstrap ceiling/floor (baseline `null` until the live capture). |
| `apps/stt-v2/tests/e2e/fixtures/clinical/{medication_review_01,cardiology_consult_01,discharge_summary_01}.{gt.txt,keyterms.json}` | Small **synthetic, de-identified** clinical reference + curated keyterm/keyphrase set. **No real PHI** (see provenance below). |

### Metric semantics (the scorecard contract)

- **`medical_wer(ref, hyp, synonyms=…)`** — `(S+D+I)/N` over medical-term-aware normalized words. Normalization folds case/punctuation and collapses whitespace (verbatim mirror of `wer.ts`: `B.P.`→`bp`, `120/80`→`12080`); the optional `MEDICAL_SYNONYMS` map folds benign clinical variation (`5 milligrams` == `5 mg`). Surface-form only — **not** UMLS/MEDCON concept-linking (that is TASK-482/E3).
- **`keyterm_recall`** — fraction of curated keyterms present as a **contiguous span** (strict, verbatim) — the "did we drop the drug/dose/finding" catcher.
- **`keyphrase_recall`** — fraction present as an **ordered subsequence** (gaps allowed) — looser recall for longer descriptive phrases so an inserted filler word doesn't zero the phrase. (The self-check proves `keyterm` fails but `keyphrase` passes on `"shortness of breath on exertion"` when `"mild"` splits `on … exertion`.)
- **`build_scorecard`** composes the three quality fields + the six reused transport fields (`first_partial_ms`, `ttfw_ms`, `commit_latency_ms` P50/P99, `partial_revision_rate`, `seq_gap_count`, `audio_coverage_ratio`) into one dict.
- **`assert_no_regression`** raises `AssertionError` on ANY breach (`regression_report` is the pure never-raises verdict for the artifact) — the concrete pass/fail gate TASK-455 deferred.

### RED → GREEN evidence (strict TDD)

```
# RED — scorer absent, test written first:
$ pytest …/test_streaming_quality_scorecard.py -k functions_are_correct
E   ModuleNotFoundError: No module named 'tests.integration.streaming_quality'
=============================== 1 error in 0.11s ===============================

# GREEN — after implementing streaming_quality.py + streaming_thresholds.json:
$ pytest …/test_streaming_quality_scorecard.py -k functions_are_correct -v
tests/integration/test_streaming_quality_scorecard.py::test_quality_metric_functions_are_correct PASSED
======================= 1 passed, 2 deselected in 0.01s ========================
```

The self-check hand-verifies: identical→WER 0; a del+sub pair→WER 0.4; two insertions→WER 2/3; empty-ref edges; the synonym map folding `milligrams`→`mg`; keyterm 0.75 with `["insulin"]` missing; keyphrase 2/3; a clean scorecard PASSING the committed thresholds; and **four synthetic regressions each FAILING** (`assert_no_regression` raises) — WER over ceiling, a `seq_gap_count` of 2, a blown commit-latency P99, and a keyterm-recall below floor. `build_scorecard`/`regression_report`/`assert_no_regression` are all exercised.

### Verification gate output (AC-8)

Sandbox note: the `conda` wrapper is blocked here, so gates were run via the `arcaenv` env binaries directly (`/…/envs/arcaenv/bin/{pytest,ruff,mypy}`) — functionally identical to each `pnpm py:stt-v2:*` alias's `conda run -n arcaenv <tool>`.

```
# pnpm py:stt-v2:lint    (ruff check apps/stt-v2/src/ apps/stt-v2/tests/)
All checks passed!

# pnpm py:stt-v2:typecheck  (mypy --config-file apps/stt-v2/pyproject.toml apps/stt-v2/src/)
Success: no issues found in 103 source files

# pnpm py:stt-v2:test  (full suite: pytest apps/stt-v2/tests/) — collects clean (2387 tests, 0 errors):
2345 passed, 37 skipped, 3 xfailed, 2 failed in 33.99s
#   this ticket's tests within the suite:
tests/integration/test_streaming_quality_scorecard.py::test_quality_metric_functions_are_correct PASSED
tests/integration/test_streaming_quality_scorecard.py::test_clinical_fixtures_are_wellformed     PASSED
tests/integration/test_streaming_quality_scorecard.py::test_streaming_quality_scorecard           SKIPPED (API unreachable — off-stack)
tests/integration/test_streaming_loss_harness.py::test_metric_functions_are_correct              PASSED (unaffected)
# integration dir off-stack: 39 passed, 3 skipped (the 3 live-stack streaming harnesses skip cleanly)
```

**The 2 failures are PRE-EXISTING and unrelated to TASK-470** — `test_streaming_recording.py::TestTranscriptOutbox::{test_outbox_permanent_failure_drops_and_alerts, test_outbox_exhausted_drops_and_alerts}`, a flaky structlog/`caplog` cross-test logging-capture pollution (a `caplog` assertion for the `outbox_exhausted_drop` event returns `False` when another test reconfigured structlog earlier in the run). Proven independent of this ticket: both PASS in isolation and when `tests/unit/` runs alone (**2106 passed, 0 failed**); and re-running the full suite with THIS ticket's test file `--ignore`d reproduces the **identical** 2 failures (`2 failed, 2343 passed`). This ticket adds only new files, not imported by that unit test. The 37 skips are the live-stack/ML e2e tests + streaming harnesses (API :8868 / STT-v2 :8861 / cached whisper model — the orchestrator's environment). `pnpm py:stt-v2:test:integration` is the standard invocation (no new alias — same as TASK-455).

### Baseline + thresholds (AC-4/AC-6)

`streaming_thresholds.json` is the committed source of truth:

- **Transport guardrails** carry TASK-455's captured LocalAgreement-2 baseline (from its `stt-loss-report.json`): commit-latency **P50 6023.2 / P99 7624.2 ms** (gated on a **15 % ratio** delta, since latency is inference-dominated on the offline whisper-turbo host — transport must not add > 15 %), `partial_revision.rate` **0.0** (+0.02 ε), `seq.gap_count` **0** (zero-tolerance), `audio_coverage_ratio` **0.996** (−0.005 ε).
- **Quality guardrails** have `baseline: null` (not yet measured) plus an **absolute bootstrap** ceiling/floor that gates today: `medical_wer ≤ 0.35`, `keyterm_recall ≥ 0.70`, `keyphrase_recall ≥ 0.70`. Every ε is documented inline in the JSON. **AC-6 action for the orchestrator:** run `test_streaming_quality_scorecard` on the live stack with a self-hosted clinical read, record `./stt-quality-scorecard.json` in this folder, then tighten each quality `baseline` from `null` to the captured value (keeping the ε). Until then the bootstrap ceilings/floors are the interim gate.

### Gate contract handed to A1/A2/A3/B/C (AC-5)

Every downstream ASR/NER ticket re-runs THIS scorecard on the **same clinical fixtures + pipeline (`…402`) + `frame_ms`**, and must show its **target** improve while **none** of the guardrails regress past `streaming_thresholds.json`:

| Ticket | Target (must improve) | Guardrails (must NOT regress) |
|---|---|---|
| **A1** (TASK-471, tentative tail) | `first_partial_ms` / `ttfw_ms` (tentative-visible latency ↓) | `partial_revision_rate` (no more churn), `commit_latency_ms` P50/P99 (commit stays conservative), `medical_wer`, `keyterm_recall` |
| **A2** (TASK-472, commit latency) | `commit_latency_ms` P50/P99 ↓ | `medical_wer`, `keyterm_recall`, `seq_gap_count`=0, `audio_coverage_ratio` |
| **A3** (TASK-473) | its named latency/quality metric | all others held at baseline±ε |
| **B2** (TASK-475) / **C** (TASK-476/477) | `medical_wer` ↓ and/or `keyterm_recall`/`keyphrase_recall` ↑ | `commit_latency_ms`, `partial_revision_rate`, `seq_gap_count`, `audio_coverage_ratio` |

The crux F makes gateable: the scorecard **separates tentative-visible latency (should drop under A1) from commit/stable latency and partial-revision rate (must NOT rise)** — A1 "wins" iff tentative latency improves while those two guardrails hold.

### Clinical fixture provenance (AC-3 — no PHI)

The three clips under `apps/stt-v2/tests/e2e/fixtures/clinical/` are **100 % synthetic, self-hosted, de-identified** scripted clinical reads (medication reconciliation, a cardiology consult, a discharge summary). They contain **no real patient identifiers** — no names, MRNs, SSNs, dates of birth, or addresses; only generic role references ("the patient") and generic clinical content. `test_clinical_fixtures_are_wellformed` enforces this hermetically (scans for SSN/MRN red-flag markers and asserts every curated keyterm actually appears in its reference). Each `*.keyterms.json` carries an inline `description` documenting its synthetic provenance.

**Adding the matching audio (orchestrator's live step):** a `*.wav` per clip is intentionally **not committed** (a real spoken recording is what produces a meaningful WER, and only a self-hosted read keeps the PHI-free posture auditable in-repo as plain text). To capture the live scorecard, drop a 16 kHz mono 16-bit PCM `<clip>.wav` — a self-hosted scripted read of the matching `<clip>.gt.txt` (e.g. macOS `say -o clip.aiff -f clip.gt.txt` then `afconvert -f WAVE -d LEI16@16000 -c 1 clip.aiff clip.wav`) — beside its `.gt.txt`. The scorecard test pairs `<stem>.gt.txt` ↔ `<stem>.wav` ↔ `<stem>.keyterms.json` and **skips any clip whose `.wav` is absent** (so the harness is green off-stack and scores whatever reads are provided).

### Deviations / notes

- **No separate fixtures `README.md`** — per the repo's "one document per ticket / no proactive README files" rule, fixture provenance + WAV-generation instructions live here (above) and inline in each `*.keyterms.json`.
- **No product-code counters** added (same posture as TASK-455 — metrics are computed in-test).
- The medical-synonym map is a small documented v1 stub; a fuller UMLS/RxNorm mapping and number-format normalization (word-vs-digit doses) are live-tuning items for the orchestrator's capture, not required for the hermetic gate.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | **Implemented (TDD).** Added the pure `streaming_quality.py` (medical WER mirrored from `wer.ts`, keyterm contiguous-span recall, keyphrase subsequence recall, `build_scorecard`, `regression_report`, `assert_no_regression`), `test_streaming_quality_scorecard.py` (hermetic self-check + fixture-integrity + PHI scan + a live through-the-gateway scorecard that **reuses** TASK-455's `_run_one_session`/`compute_metrics` and self-skips off-stack), `streaming_thresholds.json` (TASK-455 transport baseline + documented quality bootstrap ceilings/floors), and a synthetic de-identified 3-clip clinical fixture set (`*.gt.txt` + `*.keyterms.json`, **no PHI**). RED (scorer absent → `ModuleNotFoundError`) → GREEN (self-check PASSED). Gates: ruff **clean**, mypy **clean** (103 files), full suite **collects clean** (2387 tests, 0 errors) with this ticket's scoring tests GREEN and the loss-harness self-check unaffected. Zero product diff, zero edit to TASK-455's files. Documented the A1/A2/A3/B/C target-vs-guardrail gate contract and the orchestrator's live-stack scorecard/baseline-capture step. Status → Review. |
| 2026-07-10 | Ticket scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme F — the measurement gate). Current state code-verified against `fix/2605-review` @ 87b33f57: TASK-455's loss harness already provides partial-revision-rate, commit-latency P50/P99, tentative-visible latency, and seq/coverage loss (all importable, module-level) — this ticket EXTENDS it with medical-WER + clinical keyterm/keyphrase recall + a committed pass/fail threshold gate (the assertion TASK-455 deferred) + a self-hosted de-identified clinical fixture set, reusing the harness's through-the-gateway bootstrap rather than forking it. Confirmed no WER/keyterm scoring and no clinical keyterm fixtures exist today. Output = a repeatable quality scorecard + regression thresholds that A1/A2/A3/B/C are gated on. No implementation. |
</content>
</invoke>
