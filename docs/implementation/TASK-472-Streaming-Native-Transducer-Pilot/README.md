# TASK-472 — Streaming-Native Transducer Pilot (Theme A2 · SOTA S1-ASR · **the 5–8× stable-latency lever**)

- **Status**: Pending
- **Type**: feature (streaming-native ASR backend) — **pilot / spike → phased flag-gated adoption**; no removal of the incumbent backend
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **A2** (Streaming ASR modernization — the model-level latency cut)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md#s1--streaming-asr-ambient-clinical-documentation-latency) §SOTA **S1** — "Streaming ASR commit latency: **significantly behind** (2023 policy; ~5–7×)"; stable/non-revisable word is ~1–2 s vs SOTA ~300 ms; verdict "augment now / **plan to replace** — pilot a self-hostable streaming-native transducer (Kyutai STT open-weights, or Parakeet-TDT via Riva/NeMo)".
- **Sibling (Theme A)**: [TASK-471](../TASK-471-Tentative-Tail-Render/README.md) (A1 — tentative-tail render + partial cadence; the *emit/render* win, must land first) · [TASK-473](../TASK-473-Semantic-Endpointing/README.md) (A3 — semantic endpointing; **independent**, runs on either backend).
- **Theme**: A2 · **Size**: XL · **Value**: Very high (5–8× stable latency) · **Risk**: **High** (GPU footprint · model-ops · clinical-audio accuracy parity · hot inference path — see §Risk)
- **Depends on**: [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (measure-first — the scorecard + committed `streaming_thresholds.json` are the acceptance gate: **commit-latency P50/P99 must drop with medical-WER + keyterm-recall held**) · [TASK-471](../TASK-471-Tentative-Tail-Render/README.md) (A1 — the settled-prefix + tentative-tail render must already be active so the transducer's incremental stable tokens surface correctly).
- **Suggested agent**: **Phase 0 spike** — researcher / scout-external (offline candidate bench: Kyutai STT vs Parakeet-TDT on TASK-470 fixtures; GPU/licensing/multilingual assessment). **Phase 1 adoption** — general-purpose (Python STT-v2 streaming inference path + model-ops; ML lens; run the STT-v2 gates). Two phases, hard gate between them.
- **Hard guardrail (track-level)**: **self-hosted models only — no cloud PHI.** Both candidates (Kyutai STT open-weights; NVIDIA Parakeet-TDT via self-hosted Riva or NeMo) were chosen because they run on-prem. Do **not** introduce a cloud ASR vendor (Deepgram, AssemblyAI, Azure Speech cloud, etc.) that receives clinical audio — even though their latency numbers are the SOTA reference in TASK-448 §S1.

## File-ownership manifest (best-effort exclusive — binding — phase-structured)

A streaming-native transducer is a **stateful, incremental decoder** — it does **not** fit the incumbent's "transcribe a whole utterance → text" callable contract (`inference.py::_run_inference:528`, which calls `self._asr_pipeline(samples, sample_rate, *, prompt)` once per VAD-segmented utterance). So this is **not** a drop-in `asr_pipeline` swap: A2 introduces a parallel **streaming inference mode** behind a flag, leaving the faster-whisper utterance path fully intact as the default and fallback. The manifest is therefore split into a throwaway Phase-0 spike and a flag-gated Phase-1 adoption whose exact edit shapes are **confirmed by the spike** (marked ⟐).

### Phase 0 — spike (offline, throwaway-OK; zero product wiring)

| Path | Contents |
|---|---|
| `apps/stt-v2/scripts/bench/transducer_pilot/` (new, throwaway) | Offline harness that runs Kyutai STT **and** Parakeet-TDT over TASK-470's `apps/stt-v2/tests/e2e/fixtures/clinical/*.wav` + the multilingual `…_ml.wav`/`…_en.wav` fixtures, emitting per-candidate medical-WER + first-stable-token latency (reuse TASK-470's `streaming_quality.medical_wer` where importable). **Not shipped** — its output is the numbers pasted into §Phase 0 findings; delete or archive before Phase 1. |
| *(this README)* §Phase 0 findings | The candidate-selection decision record (WER/latency table, GPU footprint measured, licensing + multilingual verdict). **The Phase-0 → Phase-1 gate.** |

### Phase 1 — flag-gated adoption (confirmed by the spike; default OFF)

| Path | Change | ⟐ |
|---|---|---|
| `apps/stt-v2/src/stt_v2/streaming/<transducer>_asr.py` (new) | The streaming transducer adapter — mirrors the module role of `faster_whisper_asr.py` but exposes a **streaming/stateful** decode surface (feed frames → yield stable + tentative tokens), not the one-shot utterance callable. Engine name confirmed by the spike (`kyutai` or `parakeet_tdt`). | ⟐ engine |
| `apps/stt-v2/src/stt_v2/models/<transducer>_loader.py` (new) | Weight loader mirroring `models/faster_whisper_loader.py` (lazy import of the runtime — NeMo/Riva client or the Kyutai/Moshi stack — so unit tests import without the package). | ⟐ runtime |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Extend `_make_asr_callable` (def `:990`) / `_load_asr_pipeline` (`:862`) engine dispatch — the registry **already** branches faster-whisper (`:1040-1061`), **NeMo** (`:1010`, `models/nemo_adapter.py`, unit-tested), and Azure (`:1063`), so it is the extension point (Parakeet-TDT is NeMo → the NeMo branch is a direct foothold). Add the streaming-mode branch that, when the pipeline selects the transducer engine, builds the streaming worker path instead of the utterance `StreamingInferenceWorker`. **Flag-gated**; faster-whisper stays the default dispatch. | ⟐ dispatch |
| `apps/stt-v2/src/stt_v2/streaming/inference.py` | A streaming-mode inference path (new method or a sibling worker) that consumes the transducer's incremental stable/tentative tokens and publishes `SegmentResult` with `stable_chars` set **natively** (the transducer *is* the commit policy — no `LocalAgreementPolicy` for this engine). The utterance `process_utterance`/`process_partial` path is unchanged. | ⟐ shape |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py` | `AiModelFormat` / engine enum gains the transducer engine value; `InferenceConfig`/`StreamingConfig` gain any transducer-specific knobs (chunk/step size, beam, delay) confirmed by the spike. Existing `commit_policy` (`:589`) semantics untouched. | ⟐ knobs |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | Any global transducer setting (model id / Riva endpoint / warmup toggle) as a **bare uppercased env name** — the `Settings` class has **no** `env_prefix` (`settings.py:15-23`, `:530`), so it is e.g. `TRANSDUCER_MODEL_ID`, **not** `STT_V2_…`. New runtime env vars → `turbo.json#globalEnv` + `.env.example` (rules 00/13). | ⟐ |
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | A **new, opt-in** pilot pipeline row (e.g. `pilot-transducer-realtime`) selecting the transducer engine — the shadow/opt-in surface. The shipped `best-practice-realtime` / `turbo` rows stay on faster-whisper until Phase-1 close promotes the winner. | ⟐ slug |
| `apps/stt-v2/tests/unit/streaming/**` (extend/new) | RED-first: engine dispatch selects the streaming path for the transducer slug; the adapter yields stable+tentative tokens; `stable_chars` populated natively; faster-whisper dispatch unchanged; loader lazy-imports. | — |
| `uv.lock` (root) | Add the transducer runtime to `apps/stt-v2/pyproject.toml`, then `uv lock` at root (rule 06). Kyutai (moshi/mimi) or NeMo/Riva client — confirmed by the spike. | ⟐ dep |

**Read-only reference (do NOT modify)**: `apps/stt-v2/src/stt_v2/streaming/faster_whisper_asr.py` (`FasterWhisperAsrAdapter` — the incumbent default/fallback, stays), `apps/stt-v2/src/stt_v2/streaming/commit_policy.py` (`LocalAgreementPolicy` — LA-2 stays the commit policy for the **whisper** path; the transducer bypasses it), `apps/stt-v2/tests/integration/streaming_quality.py` + `streaming_thresholds.json` (TASK-470's owned scorer — **re-run** it, never edit it), `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` + `packages/ui/src/components/live-transcript/transcript-segment.tsx` (the A1 render — the transducer reuses `stable_chars`; no client change).

**Manifest-growth guard (STOP-and-report)**: (a) if the spike concludes the transducer cannot reuse the `stable_chars` wire contract and needs a new `tentative_text`/token-timing field, that touches `schemas.py` + the SDK + UI — STOP; it is a scope expansion beyond the pilot and should be its own ticket (same posture as TASK-471's guard). (b) Removing or demoting faster-whisper as the default is **explicitly out of scope** — Phase-1 close ships the transducer as an **opt-in pipeline**, not the default. (c) The batch/Dramatiq path (`worker.py`, `transcription/workers/`) is untouched — this ticket is streaming-hot-path only. (d) Diarization internals (`stt_v2/diarization/*`) are Theme B (TASK-474/475), not here. Anything outside the manifest → STOP.

## Requirement Analysis

The single biggest realtime latency lever is the ASR **commit** — TASK-448 §S1 measured a stable/non-revisable word at ~1–2 s vs a SOTA ~300 ms, "~5–7× slower", and judged HOPE's streaming ASR "significantly behind". TASK-471 (A1) already takes the *free* render win (drop the 1 s partial cadence, light up the tentative tail) **without** touching the model. This ticket takes the **model-level** win that A1 cannot: replace the utterance-chunked faster-whisper + LocalAgreement-2 commit with a **streaming-native transducer** that emits stable words as it decodes — targeting the ~5–8× stable-latency cut, **self-hosted, no cloud PHI**.

### Why a streaming-native transducer (not more tuning of the incumbent)

The incumbent is **structurally** a batch-of-one design (code-verified below): the Silero VAD preprocessor segments audio into utterances, and `StreamingInferenceWorker` **re-transcribes the whole growing utterance buffer** on each partial (`inference.py:528` runs the full ASR callable per utterance); `LocalAgreementPolicy` then declares a word "stable" only once it survives the longest-common-prefix of **two consecutive whole-utterance re-transcriptions** (`commit_policy.py:77-116`). That double cost — repeated full decodes **plus** a 2-hypothesis agreement wait — is the ~1–2 s stable latency, and it is inherent to the architecture, not a tunable constant.

A streaming-native **transducer** (RNN-T / **TDT = Token-and-Duration Transducer**) decodes **incrementally**: each audio frame advances a stateful decoder that emits tokens as they become linguistically determined, so a word is stable ~1 chunk after it is spoken with **no re-transcribe and no agreement wait**. The transducer *is* the commit policy — there is no LocalAgreement step for it. This is the mechanism behind the SOTA ~300 ms stable-word numbers.

### Candidates (self-hosted; the spike picks one)

| Candidate | Stack | Why | Watch-outs |
|---|---|---|---|
| **Kyutai STT** (open-weights, ~500 ms) | Delayed-streams / Moshi–Mimi; permissive open weights | Genuinely streaming-native, on-prem, community weights (no vendor server) | English + French focus → **multilingual parity** for HOPE's Malayalam/mixed-script content (below) |
| **NVIDIA Parakeet-TDT** (via Riva or NeMo) | NeMo TDT checkpoint; served by Riva or a NeMo runtime | Top-tier English WER + duration-token efficiency; **the repo already has a NeMo `_make_asr_callable` seam** | Riva server infra + NVIDIA licensing; Parakeet is largely English → same multilingual watch-out |

Both are pluggable into the **existing engine registry** (`session_manager._make_asr_callable`), which already dispatches faster-whisper, Azure, and a NeMo path — so the seam exists; the work is the **streaming decode mode**, not a new registry.

### Framing — pilot/spike → phased flag-gated adoption

Per the track's measure-first governing principle and the "over-scaffolding speculative research is premature" note, A2 runs as: **Phase 0 spike** (offline bench of both candidates on TASK-470's clinical + multilingual fixtures — WER, first-stable-token latency, GPU footprint, licensing, multilingual verdict; **no product wiring**) → hard gate (§Phase 0 findings) → **Phase 1 flag-gated adoption** (the winner behind an opt-in pilot pipeline, default OFF, scored on TASK-470 with a shadow → opt-in → promote rollout and flag-flip rollback). Nothing about the shipped `best-practice-realtime` default changes until the pilot proves the scorecard.

### Acceptance criteria

**Phase 0 (spike — the gate to Phase 1):**
- [ ] **AC-0.1 (candidate bench, self-hosted)** — both Kyutai STT and Parakeet-TDT are run **offline, on-prem** over TASK-470's `fixtures/clinical/*.wav` **and** the multilingual `…_ml.wav`/`…_en.wav` fixtures; a table records per-candidate **medical-WER** (via TASK-470's `medical_wer`) and **first-stable-token latency**. No cloud call.
- [ ] **AC-0.2 (footprint + ops measured)** — per-candidate **GPU footprint** (VRAM per concurrent stream, steady-state + peak), **licensing** verdict (Kyutai open-weights terms vs NVIDIA Riva/NeMo + any Riva-server requirement), and **multilingual parity** verdict (does the candidate handle HOPE's Malayalam / mixed-script / gloss content, or is it English-only?) are recorded in §Phase 0 findings.
- [ ] **AC-0.3 (go/no-go decision record)** — §Phase 0 findings names the selected engine (or a **no-go** with rationale — e.g. neither clears the multilingual guardrail on clinical audio) **before** any Phase-1 product file is touched.

**Phase 1 (adoption — gated on TASK-470):**
- [ ] **AC-1.1 (streaming decode path, flag-gated)** — the selected transducer runs as a **streaming** engine behind a pilot pipeline slug, default OFF; faster-whisper remains the default dispatch and fallback. Unit-proven: selecting the transducer slug builds the streaming worker path; selecting any other engine is unchanged.
- [ ] **AC-1.2 (native stable/tentative emit)** — the adapter yields incremental **stable + tentative** tokens and publishes `SegmentResult` with `stable_chars` set **natively** (no `LocalAgreementPolicy` for this engine); the A1 render (TASK-471) surfaces it with **no** SDK/UI change (cite the existing render tests).
- [ ] **AC-1.3 (scored on TASK-470 — the gate)** — re-run TASK-470's `test_streaming_quality_scorecard` on the **same** clinical fixtures + `frame_ms` for the transducer pilot pipeline vs the faster-whisper baseline, and pass `assert_no_regression`:
  - **TARGET (must improve)** — `commit_latency_ms` **P50/P99 materially lower** (the 5–8× stable-latency win; the A2 row of TASK-470's gate contract).
  - **GUARDRAIL (must NOT regress)** — `medical_wer`, `keyterm_recall` (accuracy parity on clinical audio), `seq.gap_count` == 0, `audio_coverage_ratio` ≥ baseline. Multilingual fixtures scored separately and reported (parity is a guardrail, not a footnote).
  - Both scorecards + the verdict pasted into §Implementation Summary.
- [ ] **AC-1.4 (rollback + shadow)** — the pilot ships as an opt-in pipeline with a documented **flag-flip rollback** to faster-whisper; a shadow/opt-in rollout note is recorded. No shipped default pipeline is repointed in this ticket.
- [ ] **AC-1.5 (gates, self-hosted)** — `pnpm py:stt-v2:test` (+ `:test:unit`), `py:stt-v2:lint`, `py:stt-v2:typecheck` green; `uv lock` re-run; new env vars in `turbo.json#globalEnv` + `.env.example`; **no cloud ASR dependency** introduced. Output pasted.

### Non-goals

- **Removing or demoting faster-whisper as the default** — it stays the default and fallback; the transducer ships opt-in. A later ticket promotes it only after the pilot proves out.
- **Cloud ASR vendors** (Deepgram / AssemblyAI / Azure Speech cloud / …) — self-hosted only, even though they are the §S1 latency reference.
- **The A1 render/emit policy** (partial cadence, tentative-tail render) — that is [TASK-471](../TASK-471-Tentative-Tail-Render/README.md); this ticket consumes it, it does not re-implement it.
- **Semantic endpointing / VAD offset** — [TASK-473](../TASK-473-Semantic-Endpointing/README.md) (A3); the transducer runs on either endpointing scheme.
- **Streaming diarization / speaker labels** — Theme B ([TASK-474/475](../SOTA-Track/README.md)).
- **Changing `LocalAgreementPolicy`** — LA-2 stays exactly as-is for the faster-whisper path (`commit_policy.py` read-only); the transducer simply bypasses it.
- **The batch/Dramatiq file-transcription path** (`worker.py`, `transcription/workers/`) — untouched; realtime hot path only.
- **Building the TASK-470 scorer** — it exists; this ticket re-runs it.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `87199e33`)

**The realtime ASR is utterance-chunked faster-whisper, not streaming-native.** The streaming hot path (`apps/stt-v2/src/stt_v2/streaming/`) is cleanly separate from the batch/Dramatiq file path (`src/stt_v2/worker.py`, `src/stt_v2/transcription/workers/`) — A2 scopes to streaming only.

- **Backend adapter** — `streaming/faster_whisper_asr.py` `FasterWhisperAsrAdapter` (`:137`, TASK-351 P1-2) wraps `faster_whisper.WhisperModel` + `BatchedInferencePipeline` and exposes the callable contract `(samples, sample_rate, *, prompt) -> {text, language, word_timestamps, segments}`; `__call__` (`:233`) runs `self._batched.transcribe(...)` (`:257`, fallback `self._model.transcribe` `:259`) and is invoked via `asyncio.to_thread` **once per utterance**. The runtime is imported **lazily** via `models/faster_whisper_loader.py` `FasterWhisperLoader.load` (`:38`; `WhisperModel(...)` `:73`, `BatchedInferencePipeline` `:79`). Compute is CTranslate2 (`_CT2_COMPUTE_TYPES` `:57`); `InferenceConfig` defaults `compute_type="auto"` (`dto.py:523`), `device="auto"` (`:524`), `beam_size=5` (`:526`); engine + weights selected per pipeline via `AiModelFormat`/`ModelRef` + `ExecutionProfile.asr_{device,compute_type,max_batch_size}` (hardware profile).
- **The worker is batch-of-one** — `streaming/inference.py` `StreamingInferenceWorker` (`:111`); `_run_inference` (`:528`) calls the **generic** `self._asr_pipeline(...)` **once per utterance** — the docstring even states the pipeline "is kept generic to allow plugging in different ASR backends" (`:119-122`). Each partial re-decodes the tail-windowed buffer (`process_partial:890`); finals re-decode the full buffer (`process_utterance:280`). There is no incremental/stateful decode surface.
- **Commit is LocalAgreement-2** — `streaming/commit_policy.py` `LocalAgreementPolicy.update` (`:61`) commits the longest-common-prefix of the **last two** whole-utterance hypotheses (`:77-116`), publishing `stable_chars = len(committed)` (applied per partial in `session_manager._fire_partial:1600-1605`). It is off by default (`StreamingConfig.commit_policy = "none"`, `dto.py:589`; valid values `:576`) and built only when a pipeline selects `local_agreement_2` (`session_manager._make_commit_policy:251-263`). (TASK-471/A1 activates it on the realtime pipeline; A2 makes it **irrelevant** for the transducer engine, which commits natively.)
- **The engine registry already dispatches multiple backends** — `session_manager._load_asr_pipeline` (`:862`) → `_make_asr_callable` (**def `:990`**); branches dispatch **faster-whisper** (`:1040-1061`, `run_faster_whisper_inference` → `FasterWhisperAsrAdapter`), **NeMo** (`:1010`, `models/nemo_adapter.py` — already unit-tested: `tests/unit/streaming/test_session_manager_make_asr_callable_nemo.py`), and **Azure** (`:1063`, `streaming/azure_asr.py`), selected by `LoadedModel.format`. So adding a transducer engine extends an existing dispatch seam rather than inventing one — and **Parakeet-TDT is a NeMo model, so the NeMo seam is a direct foothold** — **but** every current engine satisfies the *one-shot utterance callable*; none is a streaming/stateful decoder, which is the new shape A2 must add.
- **Multilingual surface is real** — `inference.py` carries Malayalam filler/disfluency handling (`_MALAYALAM_FILLER_FORMS:60-74`) and a post-final English **gloss/translate** pass (P2-3), and TASK-455/470's fixtures include `…_ml.wav` (Malayalam). Whisper-large-v3 is multilingual; the transducer candidates are English-leaning — so **accuracy parity must be evaluated multilingually**, not just on English clinical reads (a first-class §Risk item, not an edge case).
- **Wire + render are ready for incremental tokens** — the client already renders a settled-prefix + tentative-tail from `stable_chars` (SDK `SttV2WebSocketClient.ts` + UI `transcript-segment.tsx`, activated by TASK-471). A transducer that populates `stable_chars` natively reuses this with **no** client change.
- **Tests that frame the change**: `tests/unit/streaming/test_commit_policy.py`, `test_faster_whisper_asr.py`, `test_session_manager_asr_callable.py`, `test_session_manager_make_asr_callable_nemo.py`, `test_streaming_inference.py`, `tests/unit/test_streaming_session_manager.py`.

**Net**: the incumbent's ~1–2 s stable latency is architectural (re-transcribe + 2-hypothesis wait), not tunable; the engine-dispatch seam exists (faster-whisper / Azure / NeMo) but all engines are one-shot-utterance callables; the render already handles native `stable_chars`; and multilingual parity is the sharpest accuracy risk. A2 adds a streaming-decode mode for a self-hosted transducer behind that seam, flag-gated, measured on TASK-470.

## Implementation Plan (spike → adopt — strict phase gate)

> Context pack for the implementing agent(s): this README · TASK-470 README (the scorecard + `streaming_thresholds.json` this is gated on, esp. the **A2 gate-contract row**) · TASK-471 README (the A1 render this consumes — do not re-build it) · TASK-448 §SOTA S1 (candidate rationale, self-hosted, the multilingual caveat) · SOTA-Track §Theme A + §Governing principle (measure first) + §Hard guardrails (self-hosted only) · `.claude/rules/06-python-services.md` (pydantic-settings, `uv lock`, ruff/mypy, pytest, hermetic tests, `X-Service-Token`) · `.claude/rules/02-database-prisma.md` (seed pipeline YAML conventions).

### Phase 0 — spike (offline; the go/no-go)

1. Stand up **both** candidates on-prem (Kyutai STT open weights; Parakeet-TDT via a local Riva/NeMo runtime) in `scripts/bench/transducer_pilot/` — no product wiring, no cloud.
2. Run each over TASK-470's clinical fixtures **and** the multilingual `…_ml.wav`/`…_en.wav`; compute **medical-WER** (import TASK-470's `medical_wer`) and **first-stable-token latency**; measure **GPU VRAM** per concurrent stream.
3. Record §Phase 0 findings: WER/latency table, footprint, licensing, **multilingual parity verdict**, and the **selected engine or a no-go** (AC-0.*). **Do not proceed to Phase 1 without this record.**

### Phase 1 — flag-gated adoption (TDD where the shape is known)

4. **RED→GREEN (dispatch)** — a unit test asserts the pilot pipeline slug dispatches to the streaming path and every other engine is unchanged; then add the engine value + `session_manager` dispatch branch.
5. **RED→GREEN (adapter + loader)** — the `<transducer>_asr.py` streaming adapter (feed frames → yield stable/tentative tokens) + lazy `<transducer>_loader.py`; unit-test the token stream and lazy import.
6. **RED→GREEN (native emit)** — the streaming inference path publishes `SegmentResult` with `stable_chars` set from the transducer's own stable boundary (no `LocalAgreementPolicy`); assert `stable_chars ∈ [0, len(text)]` and the existing A1 render tests still pass unchanged.
7. **Seed + config** — add the opt-in `pilot-transducer-realtime` seed row; register any new setting in `turbo.json#globalEnv` + `.env.example`; `uv lock` the runtime dep.
8. **Measure on TASK-470 (AC-1.3)** — run the scorecard for the pilot vs the faster-whisper baseline on the same fixtures/`frame_ms`; capture commit-latency P50/P99 ↓ with medical-WER + keyterm-recall held (English **and** multilingual); paste both scorecards + `assert_no_regression`. If accuracy regresses, the pilot does **not** promote — record and stop (measure-first).

### Verification gate (paste output into §Implementation Summary)

```bash
# hermetic units (lazy import — no GPU/model needed)
pnpm py:stt-v2:test:unit
pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
# the measured gate (needs the transducer runtime + a running stack + TASK-470 scorer):
pnpm py:stt-v2:test:integration    # TASK-470 scorecard: pilot vs faster-whisper, before/after
```

Adversarial review focus: (a) is faster-whisper genuinely still the default + fallback (dispatch proven, no shipped-default repoint)? (b) does the transducer commit **natively** (no `LocalAgreementPolicy` in its path) and populate `stable_chars` correctly? (c) is the commit-latency win real on TASK-470 **without** a medical-WER/keyterm regression — including the **multilingual** fixtures, not just English? (d) is everything self-hosted (no cloud ASR dep in `uv.lock` / no network in the adapter)? (e) is the batch/Dramatiq path and `commit_policy.py` untouched? (f) zero diff outside the manifest; the Phase-0 bench is throwaway (not shipped).

## Risk (High — the reason this is XL and gated)

| Risk | Detail | Mitigation |
|---|---|---|
| **GPU footprint** | A streaming transducer holds a **persistent, stateful decoder per concurrent stream** — unlike Whisper's batched, per-utterance decode, it cannot amortize across a batch the same way, so VRAM and scheduling scale with **concurrent sessions**, not utterance count. Riva adds a server process; Kyutai/Moshi holds model + KV state per stream. | Phase-0 measures VRAM/stream + peak concurrency; Phase-1 ships opt-in (bounded blast radius); `streaming_max_concurrent`/`streaming_multi_gpu_strategy` (settings) govern capacity; do not promote to default until footprint at target concurrency is proven. |
| **Model-ops** | Weights hosting + versioning (Kyutai open weights vs an NVIDIA Riva/NeMo artifact + possible Riva-server infra), **licensing** (open-weights terms vs NVIDIA license), cold-start **warmup**, and CT2-style conversion/quantization all differ from the incumbent's `hf_model_id` flow. | Lazy loader mirrors `faster_whisper_loader` (tests import without the runtime); licensing verdict is an AC-0.2 gate; warmup + version pinning documented; **no `latest` tags** (rule 09). |
| **Clinical-audio accuracy parity** | Both candidates are English-leaning, but HOPE handles **Malayalam / mixed-script / gloss** clinical audio (`inference.py:60-74`, `…_ml.wav` fixtures). A transducer that wins on English commit-latency but **regresses clinical WER** — especially multilingually — is a **net safety loss** (dropped drug/dose/finding). Accents, cross-talk, and medical terminology add further parity risk. | medical-WER + keyterm-recall are **guardrails** in TASK-470's A2 gate contract; multilingual fixtures scored **separately** and reported; a WER/keyterm regression blocks promotion regardless of the latency win (AC-1.3). A no-go on multilingual grounds is an acceptable Phase-0 outcome. |
| **Hot inference path** | This is the **live, clinician-facing** transcription path. A regression (latency spike, decoder stall, wrong-language output, memory leak under long encounters) degrades the realtime surface in production. | Default OFF + opt-in pipeline + flag-flip rollback to faster-whisper (AC-1.4); measurement-gated on TASK-470 (no assertion ships unmeasured); shadow/opt-in rollout before any consideration of default promotion; the durable HARNESS stays the clinical authority (live surface is best-effort — track guardrail). |

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Detail-scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme **A2** — the streaming-native transducer pilot) into an execution-ready pilot/spike → phased-adoption ticket. Current state code-verified against `fix/2605-review` @ `87199e33`: the realtime ASR is **utterance-chunked faster-whisper** (`faster_whisper_asr.py` `FasterWhisperAsrAdapter`; `inference.py::StreamingInferenceWorker` re-transcribes the whole utterance per partial via the generic `_asr_pipeline:528`) with a **LocalAgreement-2** 2-hypothesis commit (`commit_policy.py:61-116`, `stable_chars`) — architecturally the ~1–2 s / ~5–7× stable latency, not a tunable constant; the **engine-dispatch seam already exists** (`session_manager._make_asr_callable:906` dispatches faster-whisper `:1042`, plus tested NeMo + Azure paths) but every engine is a one-shot-utterance callable, so A2 must add a **streaming-decode mode**; the A1 render already consumes native `stable_chars` (no client change); and the **multilingual** surface (`inference.py:60-74` Malayalam + gloss; `…_ml.wav` fixtures) makes clinical-audio accuracy parity the sharpest risk. Framed as Phase-0 offline spike (Kyutai STT vs Parakeet-TDT — WER/latency/GPU/licensing/multilingual, no wiring) → hard go/no-go → Phase-1 flag-gated adoption (opt-in pilot pipeline, faster-whisper stays default + fallback), all **self-hosted (no cloud PHI)** and gated on TASK-470's commit-latency target with medical-WER/keyterm-recall guardrails. Depends on TASK-470 (scoring) + TASK-471 (A1 render). No implementation; documentation only. |
