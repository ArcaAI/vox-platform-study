# TASK-451 — STT Commit-Surface Freeze + VAD Onset Safety (C2-01 · C2-06)

- **Status**: Completed — all 9 ACs met + adversarially reviewed + gates green; only the owner's own push/PR to main remains (per owner directive, they land it). **Residual (post-closure, 2026-07-12):** the now-unblocked live scorecard measured an intermittent raw-gateway committed-text churn that slips the C2-01 freeze (case-fold / boundary re-slice of already-committed text) — masked from the UI by TASK-471, owner-decision-gated; see the 2026-07-12 Change-History entry.
- **Type**: bugfix (patient-safety — clinical caption integrity)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0)
- **Findings**: C2-01 (High, CONFIRMED ✓C) · C2-06 (High — originally PLAUSIBLE; the scout's close read says the claim **holds**, re-verify as task 0)
- **Branch**: `fix/task-451-stt-commit-vad-safety` (cut from `main`)
- **Size**: M
- **Suggested agent**: debugger (Python / streaming ASR)

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/commit_policy.py` | Freeze committed surface (C2-01) |
| `apps/stt/src/stt/streaming/preprocessor.py` | VAD onset hangover / min-duration for short utterances (C2-06) |
| `apps/stt/src/stt/pipeline/dto.py` | `VadConfig` defaults ONLY, if the fix tunes them (C2-06) |
| `apps/stt/tests/unit/streaming/test_commit_policy.py` | Re-key the buggy-behavior assertions |
| `apps/stt/tests/unit/test_streaming_preprocessor.py` | Add the sub-onset-burst drop test |
| `apps/stt/tests/unit/streaming/test_preprocessor_vad_denoise.py` | Extend onset coverage if needed |

**Do NOT touch** `session_manager.py` (owned by TASK-456 in Wave 2), `schemas.py`, or any TS consumer of `stable_chars`. The wire contract `(text, stable_chars)` is fixed — see §Downstream contract. `core/config/settings.py` is a **different** VAD surface (offline/batch), not the streaming one — leave it alone. Anything outside the manifest → STOP and report.

## Requirement Analysis

Two independent streaming-ASR defects, both in the realtime loop's clinician-facing caption path.

### C2-01 — committed "stable" surface silently changes meaning

`LocalAgreementPolicy.update()` ([commit_policy.py:56-82](apps/stt/src/stt/streaming/commit_policy.py)) keeps the committed token **count** monotonic (`_committed_count` only grows) but rebuilds the committed **surface** by slicing `tokens[:visible]` out of the *latest* hypothesis (line 80). When a later partial revises an early word, the count stays high and the "stable" prefix is re-sliced from the revised text — so a settled `"no known allergies"` can flip to `"known allergies"` on screen. The published `stable_chars` is a monotonic **index** into the latest `text`; the UI renders `text.slice(0, stableChars)` as settled, which is exactly why the meaning-flip is visible. The module docstring even admits the invariant it protects is "`stable_chars` stays a valid index" — not "committed text is immutable". That gap is the bug.

### C2-06 — short isolated utterances dropped entirely

`StreamingPreprocessor` requires `min_speech_frames` **consecutive** speech frames to confirm VAD onset ([preprocessor.py:293-336](apps/stt/src/stt/streaming/preprocessor.py)); at the streaming default `min_speech_duration_ms=350` / 16 kHz / 512-sample frames that is **10 frames (~320 ms)**. A burst shorter than that — or with any single sub-threshold dip (line 330-331 resets the onset counter) — never sets `in_speech`, so its frames live only in the bounded `pre_speech_ring` and are discarded. `_maybe_emit_partial` gates on `in_speech` (line 499) and `flush()` gates on `in_speech` (line 418) — so there is **no escape hatch**, even at end-of-session. A crisp one-word answer ("No." to "Any allergies?") is lost from both captions and the durable transcript. The scout re-traced this and concluded the claim holds.

### Acceptance criteria

**C2-01**
- [ ] **AC-1 (re-key the buggy assertions to red)**: the two tests that pin re-slice-from-revised-latest — `test_disagreement_keeps_previous_commit_count` ([test_commit_policy.py:46-56](apps/stt/tests/unit/streaming/test_commit_policy.py)) and `test_committed_surface_comes_from_latest_hypothesis` (:71-76) — are rewritten to assert the CORRECT invariant (committed prefix text never changes meaning once agreed). Capture the red run.
- [ ] **AC-2**: once a token position is committed, its **surface text is frozen** — a later hypothesis that disagrees on a committed token either keeps the frozen text or explicitly rolls back the committed count/`stable_chars`; it never silently substitutes a different word at a committed position.
- [ ] **AC-3 (the clinical case)**: a test replays `"no known allergies"` → revised partial dropping "no"; assert the committed/`stable_chars` region can never present `"known allergies"` as settled (either frozen to "no known…" or rolled back to un-settled).
- [ ] **AC-4 (contract preserved)**: `stable_chars` remains a valid non-negative index into the published `text`, monotonic **only while it stays truthful**; finals still carry `stable_chars = None` and never run through the policy. No change to `SegmentResult` wire shape.

**C2-06**
- [ ] **AC-5 (re-verify first)**: task 0 is a written confirmation (in §Implementation Summary) that the drop reproduces — feed a `1 < K < min_speech_frames` speech burst and assert current code emits nothing. If it does NOT reproduce, stop and downgrade the finding with evidence instead of fixing.
- [ ] **AC-6 (red)**: a test feeds an isolated short utterance (e.g. 6 speech frames at the streaming default) and asserts it is currently dropped (no partial, no final, nothing from `flush()`), then that the fix emits it.
- [ ] **AC-7**: the fix lets brief crisp utterances confirm — via a lower clinical `min_speech_duration_ms` and/or a 1-frame onset hangover (tolerate a single sub-threshold dip) — WITHOUT regressing steady-state onset (no spurious utterances from pure silence/noise; `test_no_speech_no_utterance` still passes).
- [ ] **AC-8**: any default change is made in `VadConfig` ([dto.py:442-454](apps/stt/src/stt/pipeline/dto.py)), not `Settings`; the value is justified in the ticket (clinical short-answer recall vs. false-onset rate).

**Both**
- [ ] **AC-9**: verification gate green, output pasted into §Implementation Summary.

### Non-goals

- Replacing LocalAgreement-2 with a streaming-native transducer (SOTA S1-ASR — strategic ticket).
- Dropping the 1 s partial cadence / tentative-tail rendering (S1 latency — separate).
- Semantic endpointing, diarization (S1-ENDPOINT/DIAR — strategic).
- Anything in `session_manager.py` (finalize drain C2-05, reaper C2-02 → TASK-456).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**C2-01 re-slice** ([commit_policy.py:79-80](apps/stt/src/stt/streaming/commit_policy.py)):

```python
visible = min(self._committed_count, len(tokens))
self._committed_text = " ".join(tokens[:visible])   # ← sliced from the LATEST hypothesis
```

Count monotonic at lines 74-75 (`if agreement > self._committed_count: self._committed_count = agreement`). Policy is applied **only to partials** ([session_manager.py:1489-1493] — do not edit, reference only): the published `result.text` is the full latest hypothesis, and the policy contributes only `result.stable_chars = len(committed)`. Finals reset the policy and carry `stable_chars = None`.

**Downstream contract (must not break)** — `SegmentResult.stable_chars` (schemas.py:144-166, serialized :192-193); consumed by [SttWebSocketClient.ts:650-652](packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts), [streamingAudioBridge.service.ts:349-391](packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts), and the UI [transcript-segment.tsx:177-182](packages/ui/src/components/live-transcript/transcript-segment.tsx) which renders `text.slice(0, stableChars)` as settled. **The fix keeps `(text, stable_chars)` shape**; it changes only how `stable_chars`/committed surface is computed so the settled prefix can never misrepresent an agreed word.

**C2-06 onset math** ([preprocessor.py:143-146](apps/stt/src/stt/streaming/preprocessor.py)): `_min_speech_frames = max(1, int(min_speech_duration_ms / _frame_duration_ms))` = `int(350/32) = 10`. Discard path 325-336 (unconfirmed frames → capped `pre_speech_ring`); single dip resets counter (330-331); partial gate line 499; flush gate 418-421. Streaming default `VadConfig.min_speech_duration_ms=350` ([dto.py:448]); wired via `session_manager._build_preprocessor_vad_kwargs` (189-201). `Settings.vad_min_speech_duration_ms=250` (settings.py:203) is a **separate** surface, not used here.

**Test gaps**: `test_streaming_preprocessor.py` sets `min_speech_duration_ms=32` almost everywhere (onset on frame 1), so the sub-onset-burst case is never exercised; no test pins C2-06 in either direction.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (this is the **realtime best-effort caption path**; but C2-06 also loses audio from the **durable transcript**, so it is not purely cosmetic) · `.claude/rules/06-python-services.md`.

1. **C2-06 task 0 — re-verify** (AC-5): reproduce the drop, write the confirmation into §Implementation Summary. If not reproduced → downgrade + stop this half.
2. **RED C2-01** (AC-1/AC-3): rewrite the two pinning tests + add the allergy-negation case. Confirm red. Commit.
3. **GREEN C2-01** (AC-2/AC-4): freeze the committed surface — store agreed tokens and append-only, or on contradiction hold the frozen text / roll back `_committed_count`. Preserve the wire shape. Green. Commit.
4. **RED C2-06** (AC-6): add the short-burst drop test. Confirm red. Commit.
5. **GREEN C2-06** (AC-7/AC-8): onset hangover and/or clinical `min_speech_duration_ms` in `VadConfig`; justify the value. Ensure silence/noise still produces no utterance. Green. Commit.
6. **Refactor**: none beyond the two functions.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm py:stt:test:unit
pnpm py:stt:lint && pnpm py:stt:typecheck
```

Adversarial review focus (reviewer agent): (a) C2-01 — after the fix, is there ANY sequence where a committed character index maps to a different word than when it was first settled? (b) does `stable_chars` stay a valid index (never > `len(text)`, never negative)? (c) C2-06 — does the onset change admit false utterances from breath/noise (check `test_no_speech_no_utterance` and a noise fixture)? (d) is the finals path still policy-free? (e) zero diff outside the manifest — especially no `session_manager.py` edit.

## Implementation Summary

**Branch**: `fix/task-451-stt-commit-vad-safety` (3 commits: `cc5a3618` fix, `184705c9` collateral, `772f99b3` I-1) — merged into `fix/task-449-wave1`.

**C2-01 — committed-surface freeze/rollback** (`commit_policy.py`): the committed prefix is stored as frozen normalized tokens; each update measures how much of that prefix the latest hypothesis still matches and rolls back the committed count on contradiction (else extends via LocalAgreement-2). The `"no known allergies"` → revised replay now settles to `"patient has"` and can never present `"known allergies"` as stable. `stable_chars` stays a valid `0 ≤ n ≤ len(text)` index; finals remain policy-free (`stable_chars=None`). The wire contract is unchanged.

**C2-06 — short-utterance recovery** (`preprocessor.py`, `pipeline/dto.py`): **reproduced first** (isolated bursts below `min_speech_frames`, and single-dip bursts, emitted nothing). Fix: a bounded onset-dip budget + lowered clinical `VadConfig.min_speech_duration_ms` 350→250 (aligns with the offline settings surface). Pure silence/noise and lone transients still yield no utterance.

**Gates**: gate suite 82 passed; broader `stt tests/unit` **2085 passed / 0 failed**; `ruff` clean; `mypy` clean (103 files). RED captured for the C2-01 rollback tests, the C2-06 short-burst test, and the I-1 alternating-pattern test.

**Adversarial review**: no Critical. The headline risk — `stable_chars` can now DECREASE — was proven **safe**: the reviewer read all four consumers (SDK client, applications bridge, UI slice, deprecated ui-playground) and each treats it as a fresh per-message index, so a decrease just renders less bold (the intended retraction). Important **I-1**: the onset hangover tolerated *unbounded* isolated dips (periodic near-threshold noise could fake an onset → hallucinated-caption risk) — bounded to a cumulative budget; the alternating `0.9 0.1…` pattern is now rejected. M-2: documented the `stable_chars`↔`_sanitize_text` coupling.

**Collateral (authorized)**: `test_pipeline_dto.py:322` default assertion realigned 350→250.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | **Cross-track residual surfaced by the live scorecard (post-closure; owner-decision-gated) — refines the C2-01 guarantee.** The TASK-484 empty-final fix unblocked the TASK-470/487 live scorecard, which added a committed-region churn metric (`committed_revision_rate` over the LA-2 prefix `text[:stable_chars]`). On the non-deterministic `…402` turbo-whisper CPU pipeline it swings 0.0↔~0.18 (2026-07-12 regen, sessions `019f5575…`/`019f5576…`: cardiology 0.0909 / medication 0.1538 FAIL, discharge 0.0 PASS vs the 0.02 gate) — genuine settled-text churn, not tentative-tail volatility. **Mechanism (a residual of C2-01):** LA-2 rolls back only on a token *contradiction*, but the committed prefix is still re-sliced as `text[:stable_chars]` from the latest FULL hypothesis every frame (`session_manager.py:1593-1596`; `commit_policy.py:61-116`), so a same-position **case-fold** or a late `stableChars` boundary correction of already-committed opening-segment text mutates the committed string without tripping a rollback. **Impact:** currently MASKED from the UI by TASK-471's LA-2 append-only render (clinicians don't see it) and invariant to TASK-471; the 9 original ACs stay met — this is a newly-measured refinement, not a regression. **Owner decision needed:** extend the freeze to pin/normalize already-committed characters (case + boundary) vs. spin a follow-up ticket. Logged here because TASK-470/471/487 escalate the finding to this ticket as the commit-surface owner. |
| 2026-07-11 | **Closed (Status → Completed).** Closure-review pass (owner directive "close if finished completely and properly"): all 9 ACs met with recorded evidence, adversarial review applied (Important I-1 bounded, M-2 documented), gates green (82 passed / stt 2085 unit / ruff + mypy clean), C2-06 reproduced RED-first. No external work remains — only the owner's git push/PR to main. |
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C2-01/C2-06; algorithm, onset math, downstream `stable_chars` contract, and test gaps re-verified against code by read-only scout (scout upgraded C2-06 from PLAUSIBLE to "claim holds"). No implementation started. |
| 2026-07-09 | Implemented (TDD; C2-06 reproduced) + adversarially reviewed. Non-monotonic `stable_chars` proven safe across all consumers; Important I-1 (unbounded onset dips) bounded. Collateral DTO assertion realigned. Merged to `fix/task-449-wave1` (integration build green). |
