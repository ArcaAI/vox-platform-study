# TASK-473 — Semantic Endpointing (Theme A3 · SOTA S1-ENDPOINT · finals cut at meaning, not a fixed timer)

- **Status**: Pending
- **Type**: feature (streaming end-of-utterance detection) — replaces the fixed Silero VAD silence offset with content-driven endpointing on the realtime hot path
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **A3** (Streaming ASR modernization — semantic endpointing)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md#s1--streaming-asr-ambient-clinical-documentation-latency) §SOTA **S1** — "End-of-turn / final: **semantic endpoint, 160–500 ms** | HOPE: **Silero VAD fixed silence offset only** | Gap: **no semantic endpointing**" (sources: AssemblyAI; LiveKit v1; Kyutai VAD); one-line verdict "Semantic endpointing / streaming diarization: **behind** (absent)".
- **Sibling (Theme A)**: [TASK-471](../TASK-471-Tentative-Tail-Render/README.md) (A1 — tentative-tail render) · [TASK-472](../TASK-472-Streaming-Native-Transducer-Pilot/README.md) (A2 — transducer pilot). **A3 is independent of A2** — it runs on **either** ASR backend (it governs the utterance-boundary decision that feeds the segmenter, not the decoder).
- **Theme**: A3 · **Size**: **L** · **Value**: Med–High · **Risk**: **Med** (a model in the hot endpoint decision · false-early cuts truncate clinical utterances · must degrade to the fixed offset)
- **Depends on**: [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (measure-first — the scorecard + committed `streaming_thresholds.json` are the acceptance gate). **Independent of A2** (either backend).
- **Suggested agent**: general-purpose (Python STT-v2 VAD/preprocessor endpoint path + a small self-hosted turn/utterance-boundary model; run the STT-v2 gates)
- **Hard guardrail (track-level)**: **self-hosted models only — no cloud PHI.** The semantic endpointer (a lightweight on-prem turn/EOU model — LiveKit-style turn detector or a Kyutai-style semantic VAD class) must run on-prem; do **not** send clinical audio/transcript to a cloud endpointing/VAD vendor.

## File-ownership manifest (best-effort exclusive — binding)

The end-of-utterance decision today is a **fixed silence-frame timer** inside the streaming preprocessor. This ticket makes that decision **content-driven** (semantic), keeping Silero VAD as the acoustic onset/gating layer and the fixed silence offset as the **fallback/backstop**. Flag-gated; default falls back to today's behavior until measured.

| Path | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/streaming/semantic_endpointer.py` (new) | The self-hosted end-of-utterance detector: consumes the running partial hypothesis (+ optional acoustic/VAD features / trailing-silence duration) and returns an end-of-turn decision with a confidence, targeting the 160–500 ms band. Lazy model import (mirror `faster_whisper_loader`'s lazy pattern) so units import without the runtime. Deterministic + unit-testable offline. |
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | At the silence→final cut (`_min_silence_frames` gate, **`:404-410`**), consult the semantic endpointer **when enabled**: cut the final when the endpointer signals a complete turn (earlier than the fixed silence timer, or capturing a tail the timer would strand), else fall through to the existing `silence_frames >= _min_silence_frames` backstop and the `force_emit_after_ms` cap (`:377-403`). The Silero VAD **onset** path (`:314-363`, TASK-451 C2-06/I-1) is untouched. |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py` | A semantic-endpoint block — either fields on `VadConfig` (`:443-457`) or a new `EndpointConfig` — `enabled` (default off), the fixed `min_silence_duration_ms` retained as fallback, target min/max EOU latency, and confidence threshold. |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | Global endpointer knobs (model id / enable / warmup) as **bare uppercased env names** — the `Settings` class has **no** `env_prefix` (`settings.py:15-23`, `:530`), so e.g. `SEMANTIC_ENDPOINT_ENABLED`, **not** `STT_V2_…`. New runtime env vars → `turbo.json#globalEnv` + `.env.example` (rules 00/13). |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Thread the endpoint config into the preprocessor via `_build_preprocessor_vad_kwargs` (`:214-249`, where `min_silence_duration_ms` is already resolved from the four sources); build/attach the endpointer per session (mirror the `_make_commit_policy` gating at `:251-263`). |
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Enable semantic endpointing on the realtime pipeline seed(s) (the opt-in surface) once measured — mirror TASK-471's `streaming:` seed edit. Default seeds stay on the fixed offset until AC-4 passes. |
| `apps/stt-v2/tests/unit/streaming/**` + `tests/unit/test_streaming_preprocessor.py` (extend/new) | RED-first: endpointer cuts a complete turn earlier than the fixed timer; a mid-utterance pause does **not** trigger an early cut (no truncation); disabled/absent endpointer falls back to `_min_silence_frames`; the `force_emit_after_ms` cap still fires. |
| `uv.lock` (root) | Only if the endpointer runtime is a new dep — edit `apps/stt-v2/pyproject.toml`, then `uv lock` at root (rule 06). |

**Read-only reference (do NOT modify)**: `apps/stt-v2/src/stt_v2/vad/silero_service.py` (`SileroVADService.process_chunk:169` — the acoustic VAD stays the onset/gating layer feeding the endpointer; semantic endpointing **augments**, it does not remove Silero), `apps/stt-v2/src/stt_v2/streaming/commit_policy.py` (LA-2 — commit is orthogonal to endpointing), `apps/stt-v2/src/stt_v2/streaming/faster_whisper_asr.py` (the ASR backend — A3 is backend-agnostic), `apps/stt-v2/tests/integration/streaming_quality.py` + `streaming_thresholds.json` (TASK-470's scorer — **re-run**, never edit).

**Manifest-growth guard (STOP-and-report)**: (a) do **not** remove Silero VAD or its onset hardening (TASK-451 C2-06/I-1) — only the **end-of-turn cut** becomes semantic; VAD onset + `force_emit_after_ms` cap stay. (b) The finalize inference-drain (C2-05 / [TASK-456](../TASK-456-STT-Finalize-Reaper-Durability/README.md), `session_manager.py` drain fallback) stays — semantic endpointing **reduces reliance** on the defensive drain but does not replace that safety net; touching it is out of scope. (c) Don't touch `commit_policy.py`, the batch/Dramatiq path (`worker.py`, `transcription/**`), or diarization (Theme B). (d) If semantic endpointing is found to need a new wire field (e.g. an end-of-turn confidence surfaced to the client), that touches `schemas.py` + SDK/UI — STOP and report (scope expansion). Anything outside the manifest → STOP.

## Requirement Analysis

Today the live loop declares end-of-turn with a **fixed silence timer**: the Silero VAD preprocessor emits a `is_final=True` utterance once trailing silence exceeds `min_silence_duration_ms` (a fixed number of below-threshold frames). TASK-448 §S1 puts the SOTA end-of-turn at a **semantic endpoint, 160–500 ms** (content-driven), and marks HOPE "behind (absent)". A fixed timer has two failure modes a semantic endpointer fixes:

1. **Latency** — the timer must wait out a full silence window on **every** turn, even when the content already signals a complete utterance ("…and stop the metformin." is a finished thought the instant it lands). Semantic endpointing can cut at the meaning boundary in the 160–500 ms band instead of waiting the fixed silence out — lower finalization latency, which cascades (the live note + NER both consume finals).
2. **Tail-utterance capture** — the fixed timer is exactly the mechanism that strands the closing utterance when the silence is late, absent, or the finalize path is under load. That is the failure **TASK-456 hardened defensively** (C2-05 — the finalize inference-drain inline fallback): a bounded drain so the tail isn't dropped on GPU backlog. Semantic endpointing improves tail capture at the source — it cuts the closing utterance at its content boundary rather than relying on a trailing-silence timer that may never come — reducing reliance on the C2-05 backstop.

This ticket replaces the fixed silence offset with a **self-hosted semantic endpointer** (content-driven turn/utterance-boundary detection), keeping Silero VAD as the acoustic onset/gating layer and the fixed offset as a **fallback**. Per the measure-first governing principle it lands **after** TASK-470 so the latency win and the no-truncation guardrail are scored, not asserted. It is **independent of A2** — it governs the utterance-boundary decision feeding the segmenter, so it runs on faster-whisper today and on any A2 transducer later (a streaming-native transducer may bring its own semantic VAD, in which case A3's endpointer is the faster-whisper-path counterpart — noted, not a dependency).

### Ticket-reference reconciliation (read before writing Current State)

The track prose cites "the C2-05 defensive hardening" and the scaffolding brief cites "the Silero VAD silence offset from TASK-451 C2-05". Code-verified, these are **two different findings** and must be cited correctly:
- **The Silero VAD onset hardening is TASK-451 C2-06/I-1** (onset-dip tolerance, `preprocessor.py:37-43,350-363`) + **C2-01** (commit rollback) — the VAD-touching TASK-451 work.
- **C2-05 is the finalize inference-drain** (TASK-456 family — `session_manager.py` drain inline fallback), the **tail-utterance** safety net, **not** a VAD offset.
This ticket replaces the **fixed silence-offset end-of-turn cut** (`preprocessor.py:404-410`, resolved from `VadConfig.min_silence_duration_ms` et al. — see Current State), and its tail-capture benefit is what **reduces reliance on the C2-05/TASK-456 drain** — the accurate reading of "the C2-05 defensive hardening" in the track prose.

### Acceptance criteria (gated on TASK-470)

- [ ] **AC-1 (semantic endpointer, hermetic RED→GREEN)** — `semantic_endpointer.py` returns an end-of-turn decision (+ confidence) from the running hypothesis, deterministic and unit-testable **offline** (lazy model import; no network — self-hosted guardrail). RED: module absent.
- [ ] **AC-2 (early cut on complete turns; no early cut on mid-turn pauses)** — a completed clinical utterance triggers a final **earlier** than the fixed `_min_silence_frames` timer; a mid-utterance disfluency/pause (e.g. "the patient is … uh … allergic to penicillin") does **not** trigger an early cut (no truncation). Both unit-proven against `preprocessor.py:404-410`.
- [ ] **AC-3 (fallback + safety cap preserved)** — with the endpointer disabled or unavailable, the preprocessor falls back to the exact current behavior (`silence_frames >= _min_silence_frames`); the `force_emit_after_ms=25000` oversize cap (`dto.py:455`, `preprocessor.py:377-403`) still fires. Unit-proven.
- [ ] **AC-4 (scored on TASK-470 — the gate)** — re-run TASK-470's `test_streaming_quality_scorecard` on the **same** clinical fixtures + `frame_ms` for the endpointed pipeline vs the fixed-offset baseline, and pass `assert_no_regression`:
  - **TARGET (must improve)** — end-of-turn/finalization latency **lower** (the named A3 latency metric — the audio→final component of `commit_latency_ms`, cut toward the 160–500 ms band) **and/or** improved tail-utterance capture (`audio_coverage_ratio` / keyterm recall on tail-heavy clips).
  - **GUARDRAIL (must NOT regress)** — `medical_wer` and `keyterm_recall` (early cuts must not truncate clinical content), `partial_revision.rate`, `commit_latency_ms` P50/P99 not worse overall, `seq.gap_count` == 0. Both scorecards + the verdict pasted into §Implementation Summary.
- [ ] **AC-5 (gates, self-hosted)** — `pnpm py:stt-v2:test` (+ `:test:unit`), `py:stt-v2:lint`, `py:stt-v2:typecheck` green; `uv lock` re-run if a dep was added; new env vars in `turbo.json#globalEnv` + `.env.example`; **no cloud endpointing dependency**. Output pasted.

### Non-goals

- **Removing Silero VAD** — the acoustic VAD stays the onset/gating layer; only the **end-of-turn cut** becomes semantic. VAD onset hardening (TASK-451 C2-06/I-1) is untouched.
- **Replacing the finalize inference-drain (C2-05 / TASK-456)** — that safety net stays; A3 reduces reliance on it, it does not remove it.
- **The ASR model/backend** — A3 is backend-agnostic; the transducer pilot is [TASK-472](../TASK-472-Streaming-Native-Transducer-Pilot/README.md) (A2). A3 does **not** depend on A2.
- **The A1 render/emit policy** (partial cadence, tentative tail) — [TASK-471](../TASK-471-Tentative-Tail-Render/README.md).
- **LocalAgreement-2 / commit policy** — orthogonal; `commit_policy.py` read-only.
- **Streaming diarization / speaker labels** — Theme B ([TASK-474/475](../SOTA-Track/README.md)).
- **The batch/Dramatiq file-transcription path** — untouched; realtime hot path only.
- **Cloud endpointing/VAD vendors** — self-hosted only.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `87199e33`)

**End-of-turn is a fixed silence-frame timer in the streaming preprocessor — there is no semantic endpointing.** The streaming hot path (`apps/stt-v2/src/stt_v2/streaming/`) is separate from the batch/Dramatiq path (`worker.py`, `transcription/**`) — A3 scopes to streaming only.

- **The silence→final cut** — `streaming/preprocessor.py` `StreamingPreprocessor.feed()` (`:251`) state machine, at **`:404-410`**: `elif not is_speech: state.silence_frames += 1; if state.silence_frames >= self._min_silence_frames: utt = self._emit_utterance(is_final=True)`. `_min_silence_frames = int(min_silence_duration_ms / frame_duration_ms)` (`:166-169`). The module docstring states the rule verbatim: "Speech offset: `probability < threshold` for `min_silence_duration_ms`" (`:10-11`). Oversize backstop `force_emit_after_ms=25000` → `_max_utterance_frames` (`:44`, `:377-403`).
- **Silero VAD is the acoustic layer** — `vad/silero_service.py` `SileroVADService.process_chunk` (`:169`) returns a per-frame speech probability (Silero v5 ONNX, 512-sample frames `:27`); the preprocessor holds its own `VADSessionState` (`:185`) and drives onset/offset. VAD **onset** carries the TASK-451 C2-06/I-1 hardening (`_ONSET_HANGOVER_FRAMES=1` `:43`, applied `:350-363`; clinical `min_speech_duration_ms=250` `:123`).
- **The fixed silence offset resolves from FOUR sources** (the config surface A3 must respect and can override) — decided in `session_manager._build_preprocessor_vad_kwargs` (`:214-249`):

  | Source | Value | Location | When it wins |
  |---|---|---|---|
  | Pipeline YAML `VadConfig.min_silence_duration_ms` | **100 ms** | `pipeline/dto.py:452` | streaming, pipeline VAD enabled → `session_manager.py:238` |
  | `ExecutionProfile.vad_silence_threshold_ms` | **500 ms** (all 5 profiles) | `streaming/execution_profile.py` | streaming, no pipeline VAD config → `session_manager.py:248` |
  | `StreamingPreprocessor(min_silence_duration_ms=…)` ctor default | **700 ms** | `preprocessor.py:124` | fallback only (neither above passed) |
  | `Settings.vad_min_silence_duration_ms` | **500 ms** | `core/config/settings.py:207` | **batch only** (`silero_service.detect_speech`) — **NOT streaming** |

  So the "fixed Silero VAD silence offset" A3 replaces is `VadConfig.min_silence_duration_ms` (pipeline) / `ExecutionProfile.vad_silence_threshold_ms` (profile) — a fixed silence-duration timer either way. There is **no** content/semantic signal in the end-of-turn decision anywhere.
- **Config has NO `env_prefix`** — the `Settings` class sets only `case_sensitive=False, extra="ignore"` (`settings.py:15-23`); env vars are the **bare uppercased field name** (`settings.py:530` states this verbatim), e.g. `VAD_MIN_SILENCE_DURATION_MS`. Any new endpoint setting follows the bare-name convention (**not** `STT_V2_…`).
- **C2-05 vs C2-06 (reconciled)** — in code, `C2-05` is the finalize inference-drain inline fallback (`session_manager.py`, TASK-456 family) — the **tail-utterance** safety net, not a VAD offset; the VAD offset/onset hardening is **TASK-451 C2-06/I-1**. Semantic endpointing lowers finalization latency **and** improves tail capture, which is what reduces reliance on the C2-05/TASK-456 drain (the "C2-05 defensive hardening" the track prose refers to).
- **Tests that frame the change**: endpointing is exercised inside the preprocessor tests — `tests/unit/test_streaming_preprocessor.py`, `tests/unit/streaming/test_preprocessor_vad_denoise.py`, `test_preprocessor_wiring_kwargs.py`; VAD in `tests/unit/test_vad_silero.py`, `test_preprocessing_vad.py` (no standalone "endpointing" test file exists yet).

**Net**: the end-of-turn decision is a fixed silence-frame timer resolved from four config sources and applied at `preprocessor.py:404-410`; Silero VAD provides only acoustic probabilities; there is no content-driven endpointing; and the tail-utterance risk this timer creates is what TASK-456's C2-05 drain hardens defensively. A3 inserts a self-hosted semantic endpointer at that cut, flag-gated, with the fixed offset as fallback, measured on TASK-470.

## Implementation Plan (TDD — strict order; run AFTER TASK-470 lands)

> Context pack for the implementing agent: this README · TASK-470 README (the scorecard + `streaming_thresholds.json` this is gated on — the A3 gate-contract row) · TASK-448 §SOTA S1 (semantic endpoint 160–500 ms; sources AssemblyAI/LiveKit v1/Kyutai VAD; self-hosted) · TASK-451 README (C2-06/I-1 VAD onset hardening — do not disturb) · TASK-456 README (C2-05 finalize-drain — the tail safety net stays) · SOTA-Track §Theme A + §Governing principle (measure first) + §Hard guardrails (self-hosted) · `.claude/rules/06-python-services.md` (pydantic-settings **no env_prefix**, `uv lock`, ruff/mypy, pytest) · `.claude/rules/02-database-prisma.md` (seed pipeline YAML for the opt-in enable).

1. **RED→GREEN (endpointer, hermetic)** — write `semantic_endpointer.py` with a deterministic end-of-turn decision from the running hypothesis (+ optional trailing-silence/acoustic features); unit-test complete-turn → cut and mid-turn-pause → no-cut first (RED = module absent). Lazy model import so units run without the runtime.
2. **RED→GREEN (preprocessor integration)** — at `preprocessor.py:404-410`, consult the endpointer when enabled (earlier/semantic cut), else fall through to `_min_silence_frames`. Assert: complete turn cuts earlier than the fixed timer; a mid-utterance pause does not (no truncation); disabled → exact current behavior; `force_emit_after_ms` cap still fires.
3. **Config + wiring** — add the endpoint block to `VadConfig`/`EndpointConfig` (`dto.py`) + global settings (bare env name); thread it through `_build_preprocessor_vad_kwargs` (`:214-249`) and build the endpointer per session (mirror `_make_commit_policy:251-263` gating).
4. **Seed (opt-in)** — enable semantic endpointing on the realtime pipeline seed once AC-4 passes (mirror TASK-471's seed edit); default seeds stay on the fixed offset.
5. **Measure on TASK-470 (AC-4)** — run the scorecard for the endpointed pipeline vs the fixed-offset baseline on the same fixtures/`frame_ms`; capture the finalization-latency win and/or tail-capture gain with **no** medical-WER/keyterm-recall regression (no truncation); paste both scorecards + `assert_no_regression`. If early cuts truncate content (WER/keyterm regress), raise the endpoint confidence threshold and re-measure (the setting exists to tune this) — measure-first.
6. **Env registration + gates** — `turbo.json#globalEnv` + `.env.example`; `uv lock` if a dep was added; run the STT-v2 gates.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm py:stt-v2:test:unit           # endpointer + preprocessor-integration units (hermetic, lazy import)
pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
# then the measured gate (needs the endpointer runtime + a running stack + TASK-470 scorer):
pnpm py:stt-v2:test:integration    # TASK-470 scorecard: endpointed vs fixed-offset, before/after
```

Adversarial review focus: (a) does an early semantic cut ever **truncate** a clinical utterance (a real safety risk) — proven safe by the mid-turn-pause no-cut test + the TASK-470 medical-WER/keyterm guardrail, not asserted? (b) does the disabled/absent path fall back to **exactly** today's fixed-offset behavior (byte-for-byte), and does the `force_emit_after_ms` cap still fire? (c) is the endpointer self-hosted + deterministic (no network, no cloud)? (d) is the finalization-latency win real on TASK-470 without a revision-rate or commit-latency regression? (e) Silero VAD onset (C2-06/I-1) and the C2-05 drain untouched; commit policy + batch path untouched; zero diff outside the manifest.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Detail-scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme **A3** — semantic endpointing) into an execution-ready TDD ticket. **Re-sized M → L** at scaffold time: the end-of-turn decision is threaded through **four** config sources (`VadConfig.min_silence_duration_ms` `dto.py:452` / `ExecutionProfile.vad_silence_threshold_ms` / preprocessor ctor `:124` / batch-only `Settings.vad_min_silence_duration_ms` `:207`) + the preprocessor state machine + a new self-hosted semantic model + its wiring + measurement — more than a pure-config M. Current state code-verified against `fix/2605-review` @ `87199e33`: the end-of-turn cut is a **fixed silence-frame timer** at `preprocessor.py:404-410` (`silence_frames >= _min_silence_frames`), Silero VAD (`silero_service.process_chunk:169`) supplies only acoustic probabilities, there is **no** content/semantic signal in the finalization decision, and config has **no `env_prefix`** (bare uppercased env names, `settings.py:530`). Reconciled the brief's "TASK-451 C2-05" reference: in code C2-05 is the **finalize inference-drain** (TASK-456 — the tail-utterance safety net), while the VAD onset hardening is **TASK-451 C2-06/I-1** — semantic endpointing lowers finalization latency **and** improves tail capture, reducing reliance on the C2-05/TASK-456 drain. Framed as a flag-gated self-hosted semantic endpointer at the silence→final cut with the fixed offset retained as fallback (Silero onset + `force_emit_after_ms` cap untouched), **independent of A2** (runs on either backend), gated on TASK-470's finalization-latency/tail metrics with medical-WER + keyterm-recall (no-truncation) guardrails. Self-hosted only (no cloud PHI). No implementation; documentation only. |
