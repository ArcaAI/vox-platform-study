# TASK-351: Realtime Transcription Performance & Malayalam-English Code-Switch Quality

| Field | Value |
|---|---|
| **Ticket** | TASK-351 |
| **Title** | Realtime transcription pipeline: performance remediation + code-switched Malayalam-English quality levers |
| **Created** | 2026-06-11 |
| **Updated** | 2026-06-11 |
| **Status** | Review (P0 + P1 + P2 implementation complete 2026-06-11; GPU-host validation pending — see §4.5) |
| **Decisions** | D-1: **Option B — faster-whisper/CTranslate2 engine migration** (user-selected). D-2: **Option A — Cadence-Fast direct-load spike first** (user-selected). |
| **Type** | refactor / performance optimization (no schema migrations) |
| **Origin** | Full-pipeline review (client SDK → API gateway → Redis Streams → STT), 2026-06-11; companion canvas `realtime-transcription-review` |
| **Related tickets** | TASK-237, 241, 255, 262, 270, 271, 293, 298, 300, 304, 333, 340, 347, 350 |
| **Out of scope** | Model fine-tuning/training (dedicated repo); batch (non-realtime) transcription path; admin console UI |

---

## 1. Requirement Analysis

### 1.1 Description

A code-level review of the realtime transcription workflow found **20 findings** (5 Critical, 8 High, 7 Medium) across the three tiers of the pipeline. The system is architecturally sound (Redis-Streams decoupling, ticketed WS auth with resume, server-side VAD, prompt carry-forward, hallucination gates) but the latency story is dominated by structural choices, not bugs:

- Finals wait **700 ms of VAD silence** plus a **full-utterance decode**.
- Partials **re-decode the entire growing utterance every 1.0 s** (O(n²) per utterance) with no commit policy.
- The GPU **never batches across sessions** despite `ExecutionProfile.asr_max_batch_size` existing for that purpose.
- The gateway **awaits one Redis XADD per audio frame** while the SDK emits **8 ms frames** (~125 msg/s/session).
- `sr=16000` is **hardcoded** on every forwarded frame, dropping the session-negotiated sample rate (correctness bug).

For code-switched Malayalam-English specifically: `code_switching: true` merely omits the Whisper language token (auto-LID flips script mid-conversation), Indic punctuation is silently disabled (TASK-347 dependency conflict), the English gloss is batch-only, and NeMo (no Malayalam support) is selectable for `ml` pipelines.

This ticket remediates all of the above in three waves (P0 quick wins → P1 structural → P2 quality/scale), strictly at the serving/orchestration layer.

### 1.2 Business Context

Kerala-based doctors dictate consultations in mixed Malayalam-English. Perceived transcription responsiveness (partial cadence, final lag) and mixed-script fidelity directly drive product trust and the Live SOAP workflow (TASK-340). The project brief sets a hard target of **STT latency < 800 ms/chunk**.

### 1.3 Acceptance Criteria (measurable)

| # | Criterion | Pinned by |
|---|---|---|
| AC-1 | Session-negotiated `sampleRate` propagates to every Redis audio frame (no hardcoded 16000) | gateway unit test |
| AC-2 | Client steady-state audio send rate ≤ ~12 WS messages/sec/session (80–100 ms coalesced frames) | worklet unit test |
| AC-3 | Frame ingestion in the gateway does not block on Redis acks; frame ordering preserved | gateway unit test |
| AC-4 | Partial decode input is bounded (≤ configured tail window) regardless of utterance length | preprocessor unit test |
| AC-5 | Server VAD `min_silence_duration_ms` is profile/env-driven (default 500 ms, not hardcoded 700 ms) | preprocessor unit test |
| AC-6 | A model is loaded at most once under concurrent session creation (single-flight cache) | stt unit test |
| AC-7 | (P1) Partials expose a stable confirmed prefix (LocalAgreement-2); no full-text flicker | commit-policy unit tests |
| AC-8 | (P1) Crash recovery resumes from the last processed Redis stream ID (no `0-0` replay); consumed audio is trimmed | stt unit tests |
| AC-9 | (P1) Cross-session GPU batching honors `asr_max_batch_size` / `batch_scheduler_max_wait_ms` (or approved engine migration) | scheduler unit tests |
| AC-10 | (P2) `language: ml` + `code_switching: true` pins the language token; `ml`+NEMO is a hard config error | yaml-parser + kwargs unit tests |
| AC-11 | (P2) Replay harness reports TTFW, partial cadence, and final lag against the 800 ms SLA, before/after evidence captured | harness output in this README |
| AC-12 | All affected suites green; no new lint/typecheck errors; no Prisma migrations introduced | Phase 5 evidence |

### 1.4 Constraints

- Python work runs in the conda env `arcaenv` (`pnpm py:stt:*` scripts already wrap this).
- Wire protocol changes must be backward compatible (additive fields only) — older SDK clients keep working.
- No new heavyweight dependencies without an explicit decision gate (D-1, D-2 below).

---

## 2. Current State Evaluation — Findings Register

### 2.1 Pipeline as built (verified 2026-06-11)

```
Mic → AudioContext 48 kHz (SDK) / 16 kHz (playground)
    → RNNoise WASM worklet @48 kHz (480-sample frames)        [packages/noise-filter]
    → Silero VAD v5 (0.5/0.35, redemption 1400 ms)            [packages/vad]
    → linear resample → Int16 PCM
    → WS binary frames (SDK worklet: 128 samples = 8 ms)      [packages/stt, packages/agentic-sdk-v2]
→ NestJS gateway: ticket auth → await XADD stt:audio:{sid} per frame, sr hardcoded 16000
                                                              [apps/api/src/modules/streaming]
→ STT: XREAD → Silero ONNX VAD (32 ms frames; onset 350 ms; offset 700 ms;
  partial snapshot every 1.0 s, min 0.5 s audio) → per-utterance Whisper generate
  (HF Transformers / ONNX-Optimum / NeMo / Azure, asyncio.to_thread, no batching)
  → sanitize → hallucination gates → (punctuation OFF) → diarization on finals
  → XADD stt:result:{sid}                                     [apps/stt/src/stt/streaming]
→ gateway XREAD (BLOCK 2 s, shared conn) → WS JSON → Zustand/React (300-row list, no virtualization)
```

Key code-defined constants: `_PARTIAL_INTERVAL_S = 1.0`, `_PARTIAL_MIN_AUDIO_S = 0.5` (`preprocessor.py:42-43`); VAD defaults `threshold=0.6`, `min_speech=350 ms`, `min_silence=700 ms` (`preprocessor.py:103-105`); profiles define `vad_silence_threshold_ms=500` and `asr_max_batch_size` 32/8/4/2 (`execution_profile.py`) — the latter unused by the streaming path.

### 2.2 Critical findings

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| **C1** | Gateway awaits a Redis `XADD` per audio frame (binary and JSON paths). With 8 ms SDK frames this is ~125 awaited round-trips/s/session serialized on the event loop. | `apps/api/src/modules/streaming/stt-ws.gateway.ts:246,274` | Event-loop churn scales with sessions × frame rate; throughput ceiling |
| **C2** | Partials snapshot the **full** utterance buffer on a 1.0 s timer and re-decode it from scratch (skip-if-busy). No commit policy — each partial replaces the previous text. | `apps/stt/src/stt/streaming/preprocessor.py:481-516`; `session_manager.py:1263-1309` | O(n²) decode per utterance; partial latency grows with utterance length; UI flicker |
| **C3** | No cross-session GPU batching: `asr_max_batch_size` / `batch_scheduler_max_wait_ms` defined per hardware profile but never consumed; every utterance is a lone `model.generate()` in `asyncio.to_thread`. | `execution_profile.py:52,65` (only echoed at `session_manager.py:2322`) | GPU contention instead of batching; A100 100-stream profile unreachable |
| **C4** | Client emits 8 ms WS frames (one per AudioWorklet quantum, 256-byte payloads). Playground hook bypasses the SDK: deprecated main-thread `createScriptProcessor(4096,1,1)`, fresh `Int16Array` per callback, extra `ArrayBuffer.slice()` copy per frame. | `packages/stt/src/worklets/stt-capture.worklet.ts`; `apps/ui-playground/src/hooks/use-realtime-transcription.ts:330-346`; `packages/stt/src/providers/StreamingBackendSTTProvider.ts:206` | WS framing overhead rivals payload; GC + main-thread glitches |
| **C5** | `sr=16000` hardcoded on every forwarded frame; `body.sampleRate` accepted at session creation but dropped (`SessionInfo` has no field). Non-16 kHz clients are decoded at the wrong rate. | `stt-ws.gateway.ts:246,274` vs `transcription-job.controller.ts:336`; existing tests pin the bug (`__tests__/stt-ws.gateway.test.ts:366-372,432-438`) | Silent quality collapse for 44.1/48 kHz clients |

### 2.3 High findings

| ID | Finding | Evidence | Remediation (work item) |
|---|---|---|---|
| **H1** | ModelCache TOCTOU: `get()` under lock → load **outside** lock → `put()`. Concurrent sessions for one pipeline load the same model N times (VRAM spike, slow start). | `apps/stt/src/stt/models/cache.py:110-171` | P0-3 single-flight |
| **H2** | Crash recovery replays the audio stream from `0-0` — code comment admits seq→stream-ID mapping is missing. | `session_manager.py:2044-2049`; `redis_streams.py:84,94` | P1-3 |
| **H3** | Whole-session audio kept in RAM (`bytearray`, 500 MB cap ≈ 87 min) plus a full WAV copy at finalization. | `session_manager.py` (processed_audio_buffer) | P1-3 (trim) + deferred spill note |
| **H4** | Three disagreeing VAD configs: server default 700 ms offset vs profile 500 ms vs client redemption 1400 ms. 700 ms is a floor on every final. | `preprocessor.py:105`; `execution_profile.py:163`; `packages/vad` defaults | P0-4 |
| **H5** | One shared ioredis reader serializes `XREAD BLOCK 2000` across all sessions; abort flag race up to 2 s on disconnect. | `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:74-83,258-261` | P1-3 |
| **H6** | No WS egress backpressure — slow clients buffer unbounded transcript JSON in gateway memory. | `stt-ws.gateway.ts:163-188` | P1-4 |
| **H7** | Render path: two array copies per partial (`slice` + spread), 300 un-virtualized DOM rows, `setBytesSent` re-render every 250 ms in the same subtree. | `apps/ui-playground/src/features/audio/lib/transcript-state.ts:8-23`; `transcript-panel.tsx:335-352`; `use-realtime-transcription.ts:350-355` | P0-6 |
| **H8** | `np.concatenate` on the accumulated array every 32 ms frame (`drain_processed_samples`), O(N) per call. | `preprocessor.py` | P0-4 |

### 2.4 Medium findings

| ID | Finding | Evidence | Remediation |
|---|---|---|---|
| **M1** | `code_switching: true` omits the language token → Whisper auto-LID picks one language per window → script flips mid-conversation. YAML parser *warns* when `language` + `code_switching` are both set instead of supporting pinning. | `TranscriptionPipeline.ts:603-607`; kwargs builders (see `tests/unit/test_batch_inference_kwargs.py:43-52`); `tests/unit/test_yaml_parser.py:1508` | P2-1 |
| **M2** | Indic punctuation disabled by default: `cadence-punctuation` needs `transformers<5`, ASR pins `5.5.4` (TASK-347). Malayalam output degrades most (Whisper self-punctuates English far better). | `apps/stt/src/stt/punctuation/service.py`; TASK-347 README | P2-2 |
| **M3** | `english_text` gloss produced only by the batch path; streaming consumers (Live SOAP) never receive English. Schema plumbing already exists (`SegmentResult.english_text`). | `streaming/inference.py:253-261` | P2-3 |
| **M4** | Linear-interpolation 48→16 kHz resampler, no anti-aliasing — fricatives alias into the Whisper band; matters for Malayalam dental/retroflex contrasts. Documented as H-3 in TASK-262, never fixed. | `packages/stt/src/utils/audioResampler.ts:24` | P2-4 |
| **M5** | Hallucination filler regex is English-only (`uh|um|ah|hmm…`); Malayalam-script fillers pass through. | `streaming/inference.py:36-39` | P2-1 |
| **M6** | Session lifecycle: 6 serial awaits in `createStreamSession` (steps 1+2 and 5+6 independent); `removeSession` on WS close is fire-and-forget → Python session can leak until the 60 s inactivity reaper. | `transcription-job.controller.ts:312-378`; `stt-ws.gateway.ts:226-233` | P0-2 (parallelize) + P1-3 (removal retry) |
| **M7** | No engine guard: NeMo Parakeet (no Malayalam support) is selectable by a pipeline that requests `ml`. | `pipeline/yaml_parser` (warning only, `test_yaml_parser_nemo.py`) | P2-1 |

### 2.5 Strengths to preserve (do not regress)

1. Redis-Streams decoupling of gateway ↔ ASR workers; session metadata survives restarts.
2. Binary Int16 transport: client queue cap 200, 1 MiB watermark, jittered backoff, ticket rotation, `lastSeq` resume (TASK-298).
3. Server VAD partial gating (finals block partials via asyncio gate; skip-if-busy partial tasks).
4. Prompt carry-forward (`initial_prompt` UUID + last-50-words context) — primary no-training quality lever.
5. Hallucination gates (filler/RMS/words-per-second) and repetition collapse.
6. Hardware-adaptive `ExecutionProfile` with env overrides; OTel + Prometheus instrumentation (TASK-255).

### 2.6 Research basis (2025–26)

| Topic | Source | Key numbers |
|---|---|---|
| Streaming commit policies | Whisper-Streaming / LocalAgreement-2 (Macháček et al., IJCNLP 2023); WhisperPipe (arXiv 2604.25611) | LA-2 ≈ 3.3 s avg latency long-form; WhisperPipe two-tier commit + timestamp trimming: 229 ms mean, −48 % peak GPU memory vs naive overlap-chunking |
| Attention-guided policy | SimulStreaming / AlignAtt (ufal) | ~5× faster than LocalAgreement implementations; requires decoder attention access (hard via ONNX/Optimum) |
| Serving | faster-whisper / CTranslate2 | ~4× vs reference Whisper; `int8_float16` ≈ −65 % memory vs fp32; `BatchedInferencePipeline` 3–5×; dynamic batching: bucket by audio length, ≤ 50 ms accumulation |
| Indic punctuation | ai4bharat Cadence / Cadence-Fast | Cadence-Fast (Gemma-3-270M distill) keeps 93.8 % of Cadence quality; AutoModel-compatible |
| Indic ITN | Kenpath `indic-text-normalization` (WFST/Pynini) | Deterministic Malayalam number/date/dosage verbalization |
| Code-switch decoding | Whisper CS fine-tune practice (HF community) | Pin matrix-language token for CS fine-tunes; auto-LID is the worst strategy for mixed audio |

### 2.7 Traceability matrix

| Work item | Findings addressed |
|---|---|
| P0-1 | C4 (frame cadence), C1 (rate amplification) |
| P0-2 | C1, C5, M6 (parallel awaits) |
| P0-3 | H1 |
| P0-4 | C2 (bounding), H4, H8 |
| P0-5 | C4 (playground path, copies) |
| P0-6 | H7 |
| P1-1 | C2 (commit policy) |
| P1-2 | C3 |
| P1-3 | H2, H3 (trim), H5, M6 (removal retry) |
| P1-4 | H6 |
| P2-1 | M1, M5, M7 |
| P2-2 | M2 |
| P2-3 | M3 |
| P2-4 | M4 |
| P2-5 | AC-11 evidence, regression safety net |

---

## 3. Implementation Plan

> **Gate**: user approval required before any code is written (Phase 3 → Phase 4).
> Every work item follows TDD RED → GREEN → REFACTOR. Layer order respected per item; no DB schema changes anywhere in this ticket.

### 3.0 Phasing, dependencies, decision gates

```
P0-1 ──┐
P0-2 ──┼─ independent, can be parallelized          (~2–4 dev days total)
P0-3 ──┤
P0-4 ──┤
P0-5 ──┘  (P0-5 depends on P0-1 for the worklet frame size)
P0-6 ──── independent

P1-1 depends on P0-4 (bounded partial window feeds the commit policy)
P1-2 depends on decision gate D-1
P1-3, P1-4 independent                               (~1–2 weeks total)

P2-1, P2-3, P2-4 independent
P2-2 depends on decision gate D-2
P2-5 should land FIRST in P2 (provides before/after evidence for the whole wave)
```

**Decision gate D-1 (before P1-2)** — GPU serving strategy:
- **Option A (recommended, default)**: in-place dynamic batch scheduler inside STT, honoring the existing `ExecutionProfile` fields. No new dependencies; works with current HF/ONNX engines.
- **Option B**: new `FASTER_WHISPER` engine (CTranslate2, `int8_float16`, `BatchedInferencePipeline`). Larger single-machine win (~4×) but new dependency + CT2 model conversion for the fine-tuned checkpoint.

**Decision gate D-2 (before P2-2)** — Indic punctuation deployment:
- **Option A (recommended, spike first)**: load `ai4bharat/Cadence-Fast` directly via `AutoModel(trust_remote_code=True)` under `transformers==5.5.4`, bypassing the `cadence-punctuation` wrapper pin. 30-minute spike in `arcaenv` decides feasibility.
- **Option B**: sidecar process with its own venv (`transformers<5`) exposing a localhost punctuation endpoint.
- **Option C**: keep disabled (status quo; Malayalam quality stays degraded).

---

### 3.1 Wave P0 — quick wins

#### P0-1 · Coalesce client audio frames to ~80–100 ms

**Goal**: cut WS message + XADD rate ~10–12× (125/s → ~10–12/s) without adding perceptible latency (80 ms ≪ 1.0 s partial cadence).

**Files**
- Modify: `packages/stt/src/worklets/stt-capture.worklet.ts` (accumulate quanta into a preallocated ring; post at threshold)
- Modify: `packages/stt/src/core/audioCapture.ts` (configurable `frameMs`, default 80; plumb to worklet via `processorOptions`)
- Tests: `packages/stt/src/__tests__/sttCaptureWorklet.test.ts`, `packages/stt/src/__tests__/audioCapture.test.ts`

**TDD tasks**
1. RED — worklet test: feeding 10 × 128-sample quanta (10 × 8 ms) posts **zero** messages; feeding 13 (104 ms ≥ 80 ms threshold) posts **one** message containing all accumulated samples in order.
2. RED — worklet test: on `stop`/`flush` message, the partial remainder (< threshold) is flushed so trailing audio is never lost.
3. RED — capture test: `frameMs` option reaches the worklet `processorOptions`; default is 80.
4. GREEN — implement accumulation with a preallocated `Int16Array` ring (no per-quantum allocation); transfer the buffer on post.
5. REFACTOR — verify no copies added on the hot path; suite green.

**Verification**: `pnpm vitest run src/__tests__/sttCaptureWorklet.test.ts src/__tests__/audioCapture.test.ts` (from `packages/stt`) → all passing. `pnpm build --filter @arcaai/stt`.

**Risk**: trailing-audio loss on stop — covered by task 2. Latency impact bounded by frame size (≤ 100 ms, well inside the 1.0 s partial cadence).

---

#### P0-2 · Gateway hot path: real sampleRate, non-blocking XADD, parallel session creation

**Goal**: fix the C5 correctness bug, remove Redis RTT from the frame path (C1), shave session-creation latency (M6 part 1).

**Files**
- Modify: `apps/api/src/modules/streaming/stt-ws.gateway.ts` (`SessionInfo.sampleRate`; non-awaited forwarding)
- Modify: `apps/api/src/modules/streaming/transcription-job.controller.ts` (persist `sampleRate` into the session binding; `Promise.all` independent steps)
- Modify: `packages/applications/src/services/stt/streaming/` session tenant binding (carry `sampleRate`; exact file: the `streamSessionTenantBinding` service used by the controller)
- Tests: `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts` (existing assertions at lines ~366/~432 currently **pin the bug** — update), `__tests__/transcription-job.controller.test.ts`, `packages/applications/src/services/stt/streaming/__tests__/streamingSession.service.test.ts`

**TDD tasks**
1. RED — gateway test: create a session bound with `sampleRate: 48000`; send a binary frame; expect `writeAudioFrame(sessionId, seq, data, 48000, 'pcm_s16le', false)`. (Update the two existing `16000` assertions to use the bound rate; add a default-16000 case when the client never specified one.)
2. RED — gateway test: with `writeAudioFrame` returning a never-resolving promise, three incoming frames produce three `writeAudioFrame` calls (ingestion not serialized on acks); a rejected write increments a dropped-frame counter and logs, does not crash the socket.
3. GREEN — add `sampleRate` to `SessionInfo` (read from the session binding at handshake); change both forwarding paths to `void this.bridgeService.writeAudioFrame(...).catch(...)`. ioredis preserves per-connection command order, so frame ordering is unchanged.
4. RED — controller test: session create response unchanged in shape; binding now stores `sampleRate` (assert bind called with it).
5. REFACTOR — wrap independent awaits: `Promise.all([assertPipelineOwnership, getBucketByPurpose])` and `Promise.all([bind, issueTicket])`. Existing controller tests must stay green (behavioral parity).

**Verification**: `pnpm vitest run src/modules/streaming/__tests__/stt-ws.gateway.test.ts src/modules/streaming/__tests__/transcription-job.controller.test.ts` (from `apps/api`); `pnpm build:api`.

**Risk**: silently dropping frames on Redis outage — mitigated by the dropped-frame counter + error log + existing client `lastSeq` resume protocol.

---

#### P0-3 · STT: single-flight model cache

**Goal**: a given model slug loads exactly once under concurrent session creation (H1).

**Files**
- Modify: `apps/stt/src/stt/models/cache.py`
- Create: `apps/stt/tests/unit/test_model_cache_singleflight.py`

**TDD tasks**
1. RED — test: `asyncio.gather` of 5 × `get_or_load(same_config)` with a fake loader that sleeps 50 ms and counts invocations → loader called exactly **once**, all 5 callers get the same `LoadedModel`.
2. RED — test: a failed load clears the in-flight entry so the next call retries (no poisoned future).
3. GREEN — add `self._inflight: dict[str, asyncio.Future[LoadedModel]]` guarded by the existing `self._lock`; first caller creates the future and loads outside the lock; followers await the future.

```python
async def get_or_load(self, model_config: AiModelConfig) -> LoadedModel:
    cached = await self.get(model_config.slug)
    if cached is not None:
        return cached
    async with self._lock:
        fut = self._inflight.get(model_config.slug)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            self._inflight[model_config.slug] = fut
            owner = True
        else:
            owner = False
    if not owner:
        return await asyncio.shield(fut)
    try:
        model = await self._load(model_config)      # existing load path
        await self.put(model_config.slug, model)
        fut.set_result(model)
        return model
    except Exception as exc:
        fut.set_exception(exc)
        raise
    finally:
        async with self._lock:
            self._inflight.pop(model_config.slug, None)
```

**Verification**: `pnpm py:stt:test:unit` (scoped: `conda run -n arcaenv pytest apps/stt/tests/unit/test_model_cache_singleflight.py -v`); `pnpm py:stt:lint`, `pnpm py:stt:typecheck`.

---

#### P0-4 · STT: bounded partial window, profile-driven VAD silence, O(1) frame drain

**Goal**: partial decode cost stops growing with utterance length (C2 bounding); finals lose ~200 ms (H4); per-frame drain stops concatenating the whole buffer (H8).

**Files**
- Modify: `apps/stt/src/stt/streaming/preprocessor.py`
  - `_maybe_emit_partial`: snapshot only the **tail** `partial_window_s` (new ctor param, default 8.0 s) — `start_time` adjusted accordingly so timestamps stay session-relative.
  - Ctor default `min_silence_duration_ms`: honor the value passed by the session manager (no behavior change in the class itself beyond the new param).
  - `drain_processed_samples`: replace per-frame `np.concatenate` with a chunk-list drain (concatenate only what is drained, keep the rest as chunks).
- Modify: `apps/stt/src/stt/streaming/session_manager.py`: construct the preprocessor with `min_silence_duration_ms = profile.vad_silence_threshold_ms` (env-overridable via existing `Settings`), and `partial_window_s` from settings (new `STT_STREAMING_PARTIAL_WINDOW_S`, default 8.0).
- Modify: `apps/stt/src/stt/core/config/settings.py`: add `streaming_partial_window_s` setting.
- Tests: extend `apps/stt/tests/unit/streaming/test_preprocessor_vad_denoise.py` (or create `test_preprocessor_partial_window.py`), `test_session_manager_asr_callable.py` for wiring.

**TDD tasks**
1. RED — feed ~20 s of synthetic speech frames (constant tone + VAD stubbed "speech"); captured partial utterance `samples` length ≤ `partial_window_s * sr`; `end_time - start_time ≤ partial_window_s`; the **final** utterance still contains the full buffer.
2. RED — session-manager wiring test: preprocessor receives `min_silence_duration_ms == profile.vad_silence_threshold_ms` (use a fake profile with 500).
3. RED — drain test: after N frames, total drained samples equal total fed samples (no loss), and the internal buffer is a chunk list (assert no quadratic concat — verify via callable that drain returns correct bytes when called every frame).
4. GREEN/REFACTOR — implement; run the full streaming unit suite.

**Verification**: `conda run -n arcaenv pytest apps/stt/tests/unit/streaming/ -v` → green; lint + typecheck clean.

**Risk**: a partial that starts mid-window can clip a word at its left edge — acceptable for partials (finals are unaffected); window default 8 s ≫ typical phrase length. P1-1 replaces this heuristic with committed-prefix trimming.

---

#### P0-5 · Client: playground onto the SDK worklet path; zero-copy frame sends

**Goal**: no main-thread audio processing in the playground; remove 2 of 3 per-frame allocations (C4 client half).

**Files**
- Modify: `apps/ui-playground/src/hooks/use-realtime-transcription.ts` — replace the inline `createScriptProcessor` block (lines ~325-360) with the `@arcaai/stt` capture utility (AudioWorklet, ScriptProcessor only as internal fallback).
- Modify: `packages/stt/src/providers/StreamingBackendSTTProvider.ts:206` — stop `slice()`-copying; pass the `Int16Array` view through.
- Modify: `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts` — `sendAudioFrame(data: ArrayBuffer | ArrayBufferView)`; `ws.send` accepts views natively, internal accounting uses `byteLength`.
- Tests: `apps/ui-playground/src/hooks/__tests__/use-realtime-transcription.test.ts` (exists), `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts`, `packages/agentic-sdk-v2/src/core/__tests__/SttWebSocketClient.test.ts`.

**TDD tasks**
1. RED — SttWebSocketClient test: `sendAudioFrame(new Int16Array(...))` sends without throwing; the mock `ws.send` receives an object whose `byteLength` equals the view's; no `ArrayBuffer.slice` spy hit.
2. RED — StreamingBackendSTTProvider test: `processAudio` forwards a view over the existing buffer (assert same `buffer` reference, correct `byteOffset/byteLength`) — no copy.
3. RED — use-realtime-transcription test: starting a session wires the worklet-based capture (assert the audioCapture util is invoked; no `createScriptProcessor` on the AudioContext mock); Float32→Int16 conversion uses a reused buffer (assert no growth in allocation count via spy on `Int16Array` is impractical — instead pin behavior: same output for same input, and the capture util is the SDK one).
4. GREEN/REFACTOR — implement; keep the 250 ms byte-counter commit (moved in P0-6).

**Verification**: `pnpm vitest run` scoped to the three test files; `pnpm build --filter @arcaai/stt --filter @arcaai/vox`; playground typecheck unchanged vs baseline (TASK-321 note: 662-error baseline — do not add new ones).

---

#### P0-6 · Playground: isolate byte-counter state, virtualize transcript list, memo rows

**Goal**: transcript subtree no longer re-renders 4×/s from `setBytesSent`; 300-row list renders only visible rows (H7).

**Files**
- Modify: `apps/ui-playground/src/hooks/use-realtime-transcription.ts` — expose `bytesSent` via a subscribable ref/store slice (not state co-located with transcripts).
- Modify: `apps/ui-playground/src/features/audio/components/transcript-panel.tsx` — `React.memo` the transcript item; window the list (default: render the last ~60 entries with a "show earlier" expander; if the team prefers, swap for `@tanstack/react-virtual` — **new dependency, flag at review**).
- Modify: `apps/ui-playground/src/features/audio/lib/transcript-state.ts` — single-allocation upsert (mutate-last pattern behind a stable array identity contract, or keep copies but cap work: replace `slice + spread` with one `concat`-free copy only when the trailing entry is replaced).
- Tests: `apps/ui-playground/src/features/audio/lib/__tests__/transcript-state.test.ts` (create if absent), component test alongside existing panel tests.

**TDD tasks**
1. RED — transcript-state test: upserting a trailing partial N times yields ≤ 1 new array allocation per call and preserves entry identity for untouched rows (assert `prev[i] === next[i]` for all but the last).
2. RED — component test: a bytes-counter tick does not re-render a memoized transcript row (render-count probe).
3. RED — component test: with 300 entries, the DOM contains ≤ windowSize rows + expander.
4. GREEN/REFACTOR — implement.

**Verification**: scoped vitest run green; manual smoke in playground (`pnpm dev` stack) with a 5-minute session.

---

### 3.2 Wave P1 — structural

#### P1-1 · LocalAgreement-2 commit policy for partials + committed-prefix trimming

**Goal**: stable confirmed prefixes (no flicker), bounded re-decode anchored at the last committed point (C2 fix proper). AlignAtt is rejected for now: it needs decoder-attention access that ONNX/Optimum does not expose cleanly.

**Files**
- Create: `apps/stt/src/stt/streaming/commit_policy.py` — pure `LocalAgreementPolicy` (n=2): compare consecutive partial hypotheses for the same utterance, emit the longest common prefix (token-level, normalized whitespace); expose `committed_text`, `tentative_text`, `reset()`.
- Modify: `apps/stt/src/stt/streaming/session_manager.py` — per-session policy instance; partial flow becomes decode(tail window) → policy update → publish `{text: committed + tentative, stable_chars: len(committed)}`; on final: `reset()`.
- Modify: `apps/stt/src/stt/streaming/schemas.py` — `SegmentResult.stable_chars: int | None` (additive).
- Modify: `apps/api` WS relay passes `stableChars` through (additive field on `WsTranscriptResult`).
- Modify: `packages/agentic-sdk-v2` types + `apps/ui-playground` transcript rendering — tentative tail rendered dimmed.
- Tests: create `apps/stt/tests/unit/streaming/test_commit_policy.py`; extend session-manager partial tests; SDK type test; UI rendering test.

**TDD task list (abbreviated)**
1. RED — policy unit tests: agreement on growing hypotheses commits the common prefix; disagreement keeps the previous commit; punctuation/whitespace normalization; reset on final.
2. RED — session-manager test: two consecutive partial decodes "hello wor" / "hello world how" publish `stable_chars == len("hello wor…")` per LA-2 semantics; final resets.
3. RED — wire test: gateway forwards `stableChars` when present; absent for engines/sessions without the policy (backward compatible).
4. GREEN/REFACTOR; UI dimming behind the existing transcript item component.

**Verification**: stt unit suite + `apps/api` streaming tests + SDK tests green.

#### P1-2 · GPU serving: faster-whisper/CTranslate2 engine migration (D-1 resolved: Option B)

**Goal**: consume the hardware batch capacity (C3) via a new `FASTER_WHISPER` engine type backed by CTranslate2 (`int8_float16` on CUDA), using `BatchedInferencePipeline` for batched decode. Reported ~4× decode throughput and ~−65 % memory vs fp32 reference.

**Scope**
- Create: `apps/stt/src/stt/streaming/faster_whisper_asr.py` — engine adapter exposing the same ASR-callable contract as the existing engines (samples, sample_rate, prompt → text/word_timestamps/language), honoring `code_switching`/`language` semantics (P2-1 contract) and `ExecutionProfile.asr_compute_type`.
- Modify: `pipeline/yaml_parser.py` + DTOs — new `engine: FASTER_WHISPER` value; `hf_model_id` interpreted as a CT2 model path/repo; validation for compute-type compatibility.
- Modify: `models/` loader + cache integration (single-flight from P0-3 applies).
- Create: CT2 conversion runbook for the fine-tuned checkpoint (`ct2-transformers-converter` invocation, quantization choice) documented in this README — conversion itself happens in the model-training repo's release flow.
- Modify: `session_manager.py` — route Whisper-family pipelines to the new engine when configured; NeMo/Azure untouched.
- Dependency: add `faster-whisper` to `apps/stt/pyproject.toml` (pinned; verify CUDA 12/cuDNN 9 compatibility on the GPU host; CPU fallback works in `arcaenv` for tests).
- Tests: create `tests/unit/streaming/test_faster_whisper_asr.py` (mocked `WhisperModel`/`BatchedInferencePipeline`): kwargs contract (language pinning vs auto-LID, prompt passthrough, batch size from profile), word-timestamp mapping, per-item error isolation; yaml-parser tests for the new engine value; session-manager routing test.

**Verification**: unit suites green with mocked CT2; real-model smoke + P2-5 harness numbers on the GPU host before enabling per-pipeline.

**Rollback**: per-pipeline YAML (`engine:` value) — existing ONNX/HF pipelines remain untouched and selectable.

#### P1-3 · Redis stream hygiene: resume IDs, trimming, per-session readers, removal retry

**Files**
- Modify: `apps/stt/src/stt/streaming/redis_streams.py` + `session_manager.py` — persist the last processed stream entry ID in the session hash (per batch); resume `XREAD` from it (kill the `0-0` replay at `session_manager.py:2044`); `XTRIM MINID` consumed audio periodically.
- Modify: `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` — reader connection per subscriber (or consumer groups); `BLOCK 2000` → `500`.
- Modify: `apps/api/src/modules/streaming/stt-ws.gateway.ts` + a small Redis-backed retry list for failed `removeSession` calls (M6 part 2).
- Tests: stt unit (fake redis): resume-from-stored-ID; trim invoked after processing; bridge tests: two sessions don't serialize on one blocked XREAD; abort honored ≤ 500 ms; gateway test: failed DELETE enqueues a retry.

#### P1-4 · WS egress backpressure

**Files**: `apps/api/src/modules/streaming/stt-ws.gateway.ts`; tests in `__tests__/stt-ws.gateway.test.ts`.

**Contract (test-pinned)**: when `client.bufferedAmount > threshold` (e.g. 512 KiB): drop **partials** (count + log), always deliver **finals** (queued). Resume normal delivery when drained.

---

### 3.3 Wave P2 — Malayalam-English quality + verification infrastructure

#### P2-5 (land first) · Latency replay harness + per-stage metrics

**Files**
- Create: `apps/stt/tests/integration/test_streaming_latency_harness.py` + `scripts/stt-latency-replay.sh` — feed a reference WAV (committed small fixture or generated tone+speech) into `stt:audio:{sid}` at realtime pace against a running STT; measure **TTFW**, **partial cadence**, **final lag** (speech-end → final publish); emit JSON.
- Modify: stt metrics — histograms: `vad_confirm_ms`, `inference_queue_wait_ms`, `publish_ms` (per existing Prometheus setup, TASK-255).
- Marked `integration` (needs model weights; excluded from CI unit gate; run manually on the GPU host).

**Acceptance**: baseline numbers recorded in §4 **before** P1/P2 merges; post-change numbers after each wave.

#### P2-1 · Code-switch decoding contract: language pinning + guards + fillers

**Files**
- Modify: `apps/stt/src/stt/pipeline/yaml_parser.py` (+ DTOs): `language: ml` + `code_switching: true` now means **pinned matrix language with CS enabled** (info log, no warning). `language: null` + CS = auto-LID (current behavior). `ml` (or any unsupported language) + `engine: NEMO` = **validation error**.
- Modify: kwargs builders (batch + streaming): when CS **and** language set → pass `language`.
- Modify: `streaming/inference.py:36` — extend `_FILLER_PATTERN` with Malayalam filler forms (configurable extra pattern via settings).
- Seed/update: Malayalam pipeline YAML + `PromptTemplate` row with a mixed-script clinical exemplar prompt (data seed, no migration).
- Tests: update `tests/unit/test_yaml_parser.py:1508` warning test → pinning semantics; extend `test_batch_inference_kwargs.py` (`CS+language=ml → language passed`); new NeMo guard test next to `test_yaml_parser_nemo.py`; filler test in `tests/unit/streaming/`.

#### P2-2 · Indic punctuation restoration (D-2)

Spike Option A (Cadence-Fast direct `AutoModel`) in `arcaenv`; if green: wire `punctuation.model: cadence-fast` finals-only, async with timeout + raw-text fallback (extend `tests/unit/streaming/test_inference_punctuation.py`: finals-only, timeout fallback, danda normalization already covered). If the spike fails: present Option B (sidecar) before proceeding.

#### P2-3 · Streaming `english_text` gloss (opt-in)

Per-pipeline `inference.streaming_english_gloss: false`. When enabled: after a final publishes, run a low-priority `task=translate` pass (same cached model, batched via P1-2 scheduler) and publish a follow-up enriched result (same `utterance_index`, `type: gloss`) — final latency unaffected. Tests: publisher emits gloss only when enabled; gloss failure never blocks/han​gs finals.

#### P2-4 · Anti-aliased resampler

Replace linear interpolation in `packages/stt/src/utils/audioResampler.ts` with a windowed-sinc polyphase decimator (pure TS, no dependency). Tests extend `packages/stt/src/__tests__/audioResampler.test.ts`: a 10 kHz tone at 48 kHz, downsampled to 16 kHz, must show alias energy (folded ~6 kHz) attenuated ≥ 40 dB vs the linear baseline; existing length/identity tests stay green. Check `packages/vad`'s TASK-271 resample helper for shared use and align.

---

### 3.4 Test placement summary

| Layer | Files (verified to exist unless marked create) | Runner |
|---|---|---|
| Gateway | `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts`, `transcription-job.controller.test.ts` | Vitest (`apps/api`) |
| Applications | `packages/applications/src/services/stt/streaming/__tests__/streamingAudioBridge.service.test.ts`, `streamingSession.service.test.ts` | Vitest |
| SDK | `packages/agentic-sdk-v2/src/core/__tests__/SttWebSocketClient.test.ts` | Vitest |
| STT pkg | `packages/stt/src/__tests__/sttCaptureWorklet.test.ts`, `audioCapture.test.ts`, `audioResampler.test.ts`, `providers/__tests__/StreamingBackendSTTProvider.test.ts` | Vitest |
| Playground | `apps/ui-playground/src/hooks/__tests__/use-realtime-transcription.test.ts`, `features/audio/lib/__tests__/transcript-state.test.ts` (create) | Vitest |
| STT | `apps/stt/tests/unit/streaming/*` (+ create: `test_commit_policy.py`, `test_batch_scheduler.py`, `test_preprocessor_partial_window.py`, `test_model_cache_singleflight.py`); `tests/integration/test_streaming_latency_harness.py` (create) | pytest via `pnpm py:stt:test:unit` (conda `arcaenv`) |

### 3.5 Rollout, config gating, rollback

| Change | Gate | Rollback |
|---|---|---|
| Frame coalescing | `frameMs` option (default 80; `8` restores old behavior) | config |
| Non-blocking XADD | code-level; dropped-frame counter alarms | revert commit |
| Partial window / VAD silence | `STT_STREAMING_PARTIAL_WINDOW_S`, profile `vad_silence_threshold_ms` (env-overridable) | env |
| Commit policy | per-pipeline flag (`streaming.commit_policy: local_agreement_2 | none`, default `none` until validated on GPU host) | YAML |
| Batch scheduler | `STREAMING_MAX_BATCH_SIZE=1` disables batching | env |
| Language pinning | per-pipeline YAML (`language` + `code_switching`) | YAML |
| Punctuation | `PUNCTUATION_ENABLED` (existing, default false) | env |
| Gloss | per-pipeline flag, default off | YAML |

Wire-format changes are strictly additive (`stableChars`, gloss result type) — old SDK clients ignore unknown fields.

### 3.6 Verification criteria (Phase 5 gate, per wave)

```bash
# TypeScript layers
pnpm test:unit                                  # root suite green (baseline: 685 files / 13742 passed, TASK-350)
pnpm build --filter @arcaai/stt --filter @arcaai/vox --filter @arcaai/applications
pnpm build:api

# Python (conda arcaenv)
pnpm py:stt:test:unit                        # green
pnpm py:stt:lint && pnpm py:stt:typecheck # clean

# Evidence
# - ReadLints on every modified file: zero new errors
# - P2-5 harness JSON before/after pasted into §4 (TTFW, partial cadence, final lag vs 800 ms SLA)
# - ui-playground tsc baseline not worsened (TASK-321 context: 662 pre-existing errors)
```

### 3.7 Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Fire-and-forget XADD hides Redis outages | Med | Dropped-frame counter + error logs + client resume protocol; alert threshold |
| Tail-window partials clip a leading word | Low | Finals unaffected; P1-1 trims at committed boundaries instead |
| LA-2 commit policy adds one partial-cycle delay to confirmed text | Med | Tentative tail still rendered (dimmed); per-pipeline flag default off until GPU-host validation |
| Batch padding wastes GPU on mixed-length buckets | Med | Duration bucketing; `STREAMING_BATCH_WAIT_MS` small (≤ 50 ms when auto) |
| Cadence-Fast incompatible with transformers 5.5.4 | Med | D-2 spike before any wiring; sidecar fallback |
| Behavioral drift in gateway tests pinning old constants | Low | The two `16000` assertions are updated **deliberately** with a comment citing C5/TASK-351 (mirror of the TASK-350 lesson) |
| Live GPU validation unavailable locally (TASK-340 precedent) | Med | P2-5 harness runs on the GPU host; waves P1/P2 gated on its numbers |

---

## 4. Implementation Summary

### 4.1 Wave P0 — completed 2026-06-11

All six P0 items landed TDD-first (RED observed before every GREEN). Findings closed: **C1, C2 (bounding), C4, C5, H1, H4, H7, M6 (parallel awaits)**. AC-1…AC-6 are pinned by unit tests; AC-12 evidence below.

#### P0-1 · Client frame coalescing (C4)

The STT capture worklet now accumulates render quanta in a preallocated buffer and posts one coalesced frame per `frameMs` (default **80 ms**, `processorOptions`-driven, sampleRate-aware) instead of one message per 128-sample quantum (~375/s at 48 kHz → ~12/s). `{type:'flush'}` and disable-time flushing guarantee trailing audio is never lost; buffers ride the transfer list. `createAudioCapture` accepts `{ frameMs }`.

- `packages/stt/src/worklets/stt-capture.worklet.ts` — accumulation, flush, `DEFAULT_STT_CAPTURE_FRAME_MS`
- `packages/stt/src/core/audioCapture.ts` — `AudioCaptureOptions.frameMs` plumbed to the worklet
- Tests: 9 new behavior tests driving the actual worklet source in a fake `AudioWorkletGlobalScope` (+2 capture-option tests)
- **Deviation from plan**: the worklet keeps emitting `Float32Array` (not the sketched Int16 ring) — `AudioFrameCallback` consumers (local Whisper path) require Float32; Int16 conversion stays at the transport boundary (P0-5).

#### P0-2 · Gateway hot path (C1, C5, M6) — landed earlier this session

Session-negotiated `sampleRate` persisted as session meta and stamped on every forwarded frame; non-blocking fire-and-forget XADD with `droppedAudioFrames` accounting; `Promise.all` parallelization in `createStreamSession`.

#### P0-3 · Single-flight model cache (H1) — landed earlier this session

`ModelCache.get_or_load` deduplicates concurrent loads per slug via in-flight futures; failures don't poison the cache; different slugs still load in parallel.

#### P0-4 · STT partial window + profile VAD silence (C2 bounding, H4, H8)

- `streaming_partial_window_s` setting (default **8.0 s**): `_maybe_emit_partial` snapshots only the tail window (whole frames, correct `start_time` for trimmed snapshots) so per-partial decode cost stops growing with utterance length. Finals still decode the full buffer.
- `SessionManager._build_preprocessor_vad_kwargs()` — shared by session creation **and** crash recovery: pipeline YAML wins when VAD is configured; otherwise `min_silence_duration_ms` follows the hardware profile (500 ms vs the preprocessor's legacy 700 ms default → ~200 ms off every final). Recovery previously dropped force-emit kwargs; now identical wiring.
- H8 re-checked: `drain_processed_samples` is already O(new frames) — no change needed (finding corrected).
- `apps/stt/src/stt/core/config/settings.py`, `streaming/preprocessor.py`, `streaming/session_manager.py`
- Tests: 3 new preprocessor tests + new `tests/unit/streaming/test_preprocessor_wiring_kwargs.py` (4 tests)

#### P0-5 · Playground onto the SDK worklet path; zero-copy sends (C4 client half)

- `use-realtime-transcription` replaced its inline `createScriptProcessor` block with `@arcaai/stt`'s `createAudioCapture` (AudioWorklet, coalesced frames, off-main-thread); conversion via shared `float32ToInt16`; **`sampleRate` now sent on `createSession`** so the P0-2 session meta actually receives it end-to-end (C5).
- `SttWebSocketClient.sendAudioFrame(data: ArrayBuffer | ArrayBufferView)` — sends typed-array views natively (zero copy).
- `StreamingBackendSTTProvider.processAudio` — forwards the `Int16Array` view; the per-frame `ArrayBuffer.slice` copy is gone.
- `@arcaai/stt` barrel now exports `createAudioCapture` / `isAudioWorkletUsable` / capture types.
- Tests: 7 new hook tests (capture wiring, conversion correctness, disconnected-guard, bytes accounting, sampleRate propagation incl. default, teardown), 2 provider tests (view forwarding, no-slice), 1 vox client test (view send).

#### P0-6 · Playground render isolation (H7)

- `bytesSent` moved out of React state into a `useSyncExternalStore`-compatible external store (`src/lib/byte-counter.ts` + `<LiveByteCount>` leaf in `src/components/live-byte-count.tsx`): 250 ms byte commits now re-render **only** the counter span, not the transcript subtree. Hook contract changed (`bytesSent: ByteCounterHandle`); all three consumer panels updated.
- `TranscriptList` extracted to `features/audio/components/transcript-list.tsx` and windowed: newest **60** rows render (constant `TRANSCRIPT_WINDOW_SIZE`), older rows behind a "Show N earlier entries" expander. Rows were already memoized (`AudioTranscriptItem`); windowing + identity-stable upserts make the memo effective. No new dependency (virtualization not needed at N=300).
- `upsertTranscriptEntry` rewritten to exactly one array allocation per call with reference-stable retained rows (pinned by identity tests).
- Tests: 5 byte-counter, 3 `LiveByteCount` (incl. sibling-render probe), 5 `TranscriptList` windowing, 4 transcript-state identity, hook tests updated to the handle contract.

#### Wave P0 verification evidence (AC-12)

| Suite / build | Result |
|---|---|
| `packages/stt` vitest | **390 passed** (25 files) |
| `packages/agentic-sdk-v2` vitest (full) | **3342 passed** (178 files) |
| `apps/ui-playground` vitest (full) | **1285 passed** (151 files) |
| `apps/api` streaming + common suites | **195 passed** (7 files) |
| `apps/stt` pytest unit (full, `arcaenv`) | **1903 passed** |
| `pnpm turbo build --filter @arcaai/stt --filter @arcaai/vox` | 6/6 tasks OK |
| `pnpm build:api` | 8/8 tasks OK |
| `ruff` + `mypy` on touched stt files | clean |
| ui-playground `tsc --noEmit` | 3 errors — identical pre-existing baseline (unrelated admin files) |

No Prisma migrations. Wire protocol unchanged (sampleRate field was already part of the session-create body).

### 4.2 Wave P1 — completed 2026-06-11

Executed by two parallel exclusive-ownership lanes (stt Python lane; TS gateway/SDK lane) with the cross-lane wire contract (`stable_chars`) pinned up front. Findings closed: **C2 (commit policy proper), C3 (via D-1 engine migration), H2, H3 (stream trim — RAM spill stays deferred per plan), H5, H6, M6 (removal retry)**. AC-7…AC-9 pinned by unit tests.

#### P1-1 · LocalAgreement-2 commit policy + stableChars relay (C2, AC-7)

- Python: new `streaming/commit_policy.py` — pure `LocalAgreementPolicy` (n=2): token-level comparison on normalized tokens, commits the longest common prefix of consecutive partial hypotheses, monotonic committed count, `reset()` on finalization. Per-session instances in `SessionManager`; `_fire_partial` → `policy.update(text)` → `SegmentResult.stable_chars = len(committed)`. Committed *surface text* always comes from the latest hypothesis, so punctuation/casing refinements still propagate inside the committed region.
- Gate: per-pipeline `streaming.commit_policy: local_agreement_2 | none` (default **none**) — off ⇒ wire format byte-identical. **Finals carry no `stable_chars`** (implicitly 100 % stable; final payload unchanged).
- TS relay (additive, absence-tolerant at every hop): bridge maps `stable_chars` → `stableChars` (guarded parse); gateway forwards via spread; SDK `WsTranscriptResult.stableChars` with dual-casing normalize; playground renders partials as normal-styled committed prefix + dimmed tentative tail (`text-muted-foreground/70 italic`), clamped to the sanitized text length.

#### P1-2 · faster-whisper/CTranslate2 engine (C3 per D-1 Option B, AC-9)

- New `engine: FASTER_WHISPER` enum member (legacy `CTRANSLATE2` alias keeps the transformers loader — zero behavior change for existing pipelines), validated against `VALID_CT2_COMPUTE_TYPES`.
- `streaming/faster_whisper_asr.py` — adapter with the same ASR-callable contract (samples, sample_rate, prompt → text/word_timestamps/language), per-segment error isolation, honoring `code_switching`/`language` semantics and a `task` param (reused by P2-3 gloss). CT2 conversion runbook lives in the adapter docstring.
- `models/faster_whisper_loader.py` — **lazy** `import faster_whisper` (suite passes without the package), device/compute-type resolution honoring `ExecutionProfile.asr_compute_type` with CPU coercions (`float16/bfloat16→float32`, `int8_float16/int8_bfloat16→int8`, `mps→cpu`), prebuilt `BatchedInferencePipeline` carried in `LoadedModel.extra`; single-flight cache integration (P0-3) applies.
- Session-manager routing for Whisper-family pipelines when configured; batch size from `ExecutionProfile.asr_max_batch_size`; NeMo/Azure untouched. `faster-whisper==1.2.1` pinned in the `ml` extra (not installed locally; tests fully mocked). Real-model smoke + harness numbers on the GPU host gate per-pipeline enablement.

#### P1-3 · Redis stream hygiene (H2, H3-trim, H5, M6-pt2, AC-8)

- Python: `SessionMetadata.last_stream_id` persisted to the session hash after each processed `XREAD` batch (new `IngestionConsumer(on_batch=…)` hook); crash recovery resumes from it (the `0-0` replay survives only for first-start/legacy sessions). `XTRIM MINID ~ <last_id>` on `stt:audio:{sid}` only, throttled by `streaming_audio_trim_interval_s` (default 30 s; `0` disables); result stream never trimmed; all hygiene errors swallowed with logs.
- TS bridge: dedicated ioredis reader connection per result subscriber (one blocked XREAD no longer serializes sessions), `BLOCK 2000 → 500` (abort honored ≤ 500 ms), readers quit on teardown/disconnect.
- Removal retry: new `apps/api/.../session-removal-retry.service.ts` — failed disconnect-time `removeSession` enqueues onto Redis SET `stt:session-removal:retry` (24 h TTL, best-effort), exponential backoff 1 s base × 5 bounded attempts, exhaustion logged for ops (STT's 60 s reaper stays the backstop).

#### P1-4 · WS egress backpressure (H6)

`relayResult` egress policy in the gateway: when `client.bufferedAmount` > **512 KiB** (`STT_WS_EGRESS_HIGH_WATERMARK_BYTES`) — partials dropped *before* seq-tagging (per-session `droppedPartialResults`, no resume-buffer pollution), finals queued in order (bounded at 200; overflow evicts the **oldest** with `logger.error`, counted in `droppedFinalResults`), 50 ms flush poll runs only while finals are queued. Partials are also dropped while any finals are queued so a newer partial can never overtake an older final. Disconnect logs include both drop counters (mirrors `droppedAudioFrames`).

### 4.3 Wave P2 — completed 2026-06-11

Findings closed: **M1, M2, M3, M4, M5, M7**; D-2 resolved **GO** via spike evidence; AC-10 pinned; AC-11 harness delivered (GPU-host baseline run pending).

#### P2-5 · Latency replay harness (AC-11) — landed first, per plan

- New `apps/stt/tests/integration/test_streaming_latency_harness.py` + executable `scripts/stt-latency-replay.sh` (new files only — no existing stt file touched). Wire-format-exact: HTTP session bootstrap, `stt:audio/control/result:{sid}` streams, gateway field set; feeds a WAV at realtime pace (80 ms frames); measures **TTFW**, **partial cadence** (mean/p50/p95), **final lag** vs the 800 ms SLA using Redis server-clock timestamps; emits JSON (`LATENCY_REPORT_PATH`); `pytest.skip`s cleanly when Redis/stt unreachable. Deterministic synthetic fixture by default; `LATENCY_WAV_PATH` overrides with real speech.
- Locally validated: collection/ruff/black clean, deterministic-fixture test passed, byte-exact wire round-trip against live dev Redis, clean skip with stt down. **Baseline + post-change numbers must be captured on the GPU host** via `./scripts/stt-latency-replay.sh`.
- Deliberately deferred from the plan: per-stage Prometheus histograms (`vad_confirm_ms`, `inference_queue_wait_ms`, `publish_ms`) — would have touched lane-owned files; tracked as follow-up.

#### P2-1 · Code-switch decoding contract (M1, M5, M7, AC-10)

- **Pinned-language semantics**: `language: X` + `code_switching: true` now passes the language token in **all** kwargs builders (streaming static kwargs + processor path; batch transformers/ONNX; faster-whisper adapter); parser emits an info log ("pinned matrix language") instead of the old warning. `language: null` + CS keeps auto-LID.
- **NeMo guard**: `is_valid_language_for_engine` accepts only the Parakeet-v3 set for NEMO (silent Whisper-set fallback removed); `validate()` hard-errors on unsupported `inference.language` + NEMO. ⚠️ Existing `ml`+NEMO pipeline YAMLs that previously validated silently now fail — deliberate (M7).
- **Malayalam fillers**: `_FILLER_PATTERN` rebuilt via `build_filler_pattern(extra_forms)` with 13 Malayalam filler/disfluency forms (ഉം, ആ, അ, ഏ, ഓ, ഹാ, ഹും, …); real Malayalam text verified not to match. New setting `streaming_extra_filler_patterns` (pipe-separated alternates, default empty; invalid extras fall back with a warning).
- Test updates to pinned-behavior tests were made deliberately with TASK-351 citations (TASK-350 lesson).

#### P2-2 · Indic punctuation: Cadence-Fast direct load (M2, D-2)

- **Spike (GO)** — evidence in `spike-cadence-fast.md` + reproducible `scripts/spike-cadence-fast.py`: `ai4bharat/Cadence-Fast` loads under the pinned `transformers==5.5.4` via `AutoModel` + `trust_remote_code=True` **with `tie_word_embeddings=False`** (required on 5.x — the remote code's `Sequential` lm_head breaks weight-tying finalization otherwise) and post-load `config.use_bidirectional_attention = True` (restores intended non-causal masking). Warm CPU inference **60–95 ms per final**, ~1.1 GB RSS, 268M params, MIT license; correct outputs on Malayalam / code-switched clinical / English samples; Malayalam correctly uses `. , ?` (no danda). No missing deps, no env changes.
- **Production wiring** — new `punctuation/cadence_fast.py` (direct loader with pinned revision, warmup inference, `threading.Lock` single-flight forwards; wrapper-compatible `punctuate(texts, batch_size)` so the batch path works too); `punctuation/service.py` routes the exact model name `cadence-fast` to it (wrapper spellings keep legacy semantics, including partial punctuation) and resolves/lazy-loads **inside the executor** (first-use load can't block the event loop); `streaming/inference.py` runs cadence-fast **finals-only** under `asyncio.wait_for` (`streaming_punctuation_timeout_s`, default **0.4 s**) with raw-text fallback (warn once per session, then debug). Existing danda normalization already correct for Malayalam — pinned by tests, no change needed.
- Gloss interaction: punctuation runs **before** the gloss snapshot, so the gloss translates the punctuated final (on timeout both see the raw text) — test-pinned.
- Config: per-pipeline `postprocessing.punctuation.model: cadence-fast` or global `PUNCTUATION_MODEL_NAME=cadence-fast`; `PUNCTUATION_ENABLED=false` kill-switch precedence preserved; default behavior unchanged (off).

#### P2-3 · Streaming English gloss, opt-in (M3)

- Python: `inference.streaming_english_gloss` (default **false**). After a final publishes, a fire-and-forget task runs `task=translate` via the **same cached model** (single-flight cache re-fetch; transformers branch sets `task=translate`+`language=en`; FW adapter `task` param) and publishes a follow-up `SegmentResult` with `type: gloss`, `english_text`, `is_final: true`, and the **same `utterance_index`** as the final. 15 s ceiling; failures/timeouts/empty outputs swallowed with a log; final publish latency provably unaffected (event-gated test). NeMo/Azure/multimodal engines → warn + gloss disabled. `utterance_index` is now stamped on **every** partial/final so consumers can correlate.
- TS relay (additive): bridge maps `utterance_index` → `utteranceIndex`, wire `type` → `resultType: 'segment' | 'gloss'` (unknown values omitted; `english_text → englishText` already existed); gateway needed **pins only** (spread forwards; gloss `isFinal: true` ⇒ queued-never-dropped under P1-4 backpressure — test-pinned); SDK dual-casing normalize (envelope `type: 'transcript'` can never leak into `resultType`); playground merges gloss `englishText` into the matching entry by `utteranceIndex` (no new row; unmatched gloss dropped) and renders it as a muted secondary line.

#### P2-4 · Anti-aliased resampler (M4)

- `packages/stt/src/utils/audioResampler.ts`: Kaiser-windowed-sinc polyphase decimator (β = 9, ~7.2 kHz cutoff, 97 taps for 48 k→16 k, filter banks cached per rate pair) now backs `prepareFloat32ForWhisper`; `resampleLinear` stays exported for compatibility but is off the Whisper capture path.
- Measured (test-pinned): 10 kHz tone folded alias attenuated **100.1 dB** (48 kHz) / **95.0 dB** (44.1 kHz) vs the linear baseline — far beyond the ≥ 40 dB acceptance bar; 1 kHz passband amplitude error 0.0000 dB.
- `packages/vad`'s TASK-271 helper left untouched (different streaming semantics); recommendation recorded: promote the kernel to `@arcaai/room` if shared use emerges.

### 4.4 New config surface & wire additions (P1+P2 consolidated)

| Kind | Name | Default |
|---|---|---|
| Pipeline YAML | `streaming.commit_policy: local_agreement_2 \| none` | `none` |
| Pipeline YAML | `engine: FASTER_WHISPER` (+ CT2 compute-type validation) | — |
| Pipeline YAML | `inference.streaming_english_gloss` | `false` |
| Pipeline YAML | `postprocessing.punctuation.model: cadence-fast` | wrapper path |
| Env (stt) | `STREAMING_AUDIO_TRIM_INTERVAL_S` | `30` (`0` disables) |
| Env (stt) | `STREAMING_EXTRA_FILLER_PATTERNS` | `""` |
| Env (stt) | `STREAMING_PUNCTUATION_TIMEOUT_S` | `0.4` |
| Env (api) | `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` | `524288` |
| Redis key | `stt:session-removal:retry` (SET, 24 h TTL) | — |
| Dependency | `faster-whisper==1.2.1` (stt `ml` extra, GPU host) | not installed locally |

Wire additions (all additive; old SDK clients unaffected): `stable_chars`/`stableChars` (partials only, policy on), `utterance_index`/`utteranceIndex` (all segment results), `type: gloss` results with `english_text`/`englishText`. Ops note: the bridge now opens one extra Redis connection per active result subscriber.

### 4.5 Wave P1+P2 verification evidence (AC-12)

| Suite / build | Result |
|---|---|
| `apps/stt` pytest unit (full, `arcaenv`) | **2071 passed** (baseline 1903; +168 across P1/P2) |
| `apps/api` full vitest suite | **1752 passed** / streaming module **168** after gloss relay |
| `packages/applications` streaming suites | **61 passed** |
| `packages/agentic-sdk-v2` vitest (full) | **3349 passed** |
| `apps/ui-playground` vitest (full) | **1296 passed** |
| `packages/stt` vitest (full) | **401 passed** |
| `ruff` + `mypy` on all touched stt files | clean |
| ui-playground `tsc --noEmit` | 3 errors — identical pre-existing baseline |
| Root `pnpm test:unit` (all TS packages, all lanes combined) | **13816 passed** / 687 files (TASK-350 baseline: 13742 / 685) |
| `pnpm build --filter @arcaai/stt --filter @arcaai/vox --filter @arcaai/applications` | 13/13 tasks OK |
| `pnpm build:api` | 8/8 tasks OK |

**Still pending (GPU host)**: P2-5 harness baseline + post-change JSON (AC-11 numbers into this section); real-model faster-whisper smoke; per-pipeline enablement of `commit_policy` / `FASTER_WHISPER` / `cadence-fast` / gloss after on-host validation. Deferred: H3 RAM spill (plan note), per-stage Prometheus histograms (P2-5 scope cut), vad/room resampler promotion.

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-11 | Ticket opened. Full findings register (5 Critical / 8 High / 7 Medium, all file:line-verified) and phased P0/P1/P2 TDD implementation plan written from the 2026-06-11 pipeline review. Decision gates D-1 (GPU serving strategy) and D-2 (Indic punctuation deployment) defined. Awaiting plan approval. | This README |
| 2026-06-11 | Plan approved (full plan, wave-by-wave reporting). D-1 resolved: **Option B — faster-whisper/CTranslate2 migration** (P1-2 rewritten accordingly). D-2 resolved: **Option A — Cadence-Fast direct-load spike first**. Status → In Progress; Wave P0 started. | This README |
| 2026-06-11 | **Wave P0 completed** (P0-1…P0-6; closes C1, C2-bounding, C4, C5, H1, H4, H7, M6-parallel-awaits; H8 re-verified as already O(1)). Full evidence in §4.1. | `packages/stt` (worklet, audioCapture, provider, barrel), `packages/agentic-sdk-v2` (SttWebSocketClient), `apps/ui-playground` (use-realtime-transcription, transcript-panel/-list, transcript-state, byte-counter, live-byte-count, capture/consultation panels), `apps/api` (stt-ws.gateway, transcription-job.controller, stream-session-tenant-binding), `apps/stt` (cache.py, preprocessor.py, session_manager.py, settings.py) + tests |
| 2026-06-11 | **Waves P1 + P2 implemented in parallel** by five exclusive-ownership agent lanes (stt Python; TS gateway/SDK; resampler; D-2 spike; latency harness) + two follow-ups (P2-2 wiring after spike GO; gloss/utteranceIndex TS relay). Closes **C2, C3, H2, H3-trim, H5, H6, M1–M7**. D-2 resolved **GO** (Cadence-Fast direct load on transformers 5.5.4). Evidence §4.2–§4.5. Status → Review pending GPU-host validation. | `apps/stt` (commit_policy.py, faster_whisper_asr.py, faster_whisper_loader.py, cadence_fast.py, session_manager.py, schemas.py, redis_streams.py, inference.py, punctuation/service.py, dto.py, yaml_parser.py, batch_service.py, settings.py, pyproject.toml; tests/integration harness — new files), `apps/api` (stt-ws.gateway, session-removal-retry.service — new, streaming.module), `packages/applications` (streamingAudioBridge.service, streaming-session.dto), `packages/agentic-sdk-v2` (stt types, SttWebSocketClient), `apps/ui-playground` (audio-store, use-realtime-transcription, audio-transcript-item), `packages/stt` (audioResampler), `scripts/` (spike-cadence-fast.py, stt-latency-replay.sh), spike findings doc + ~70 new/updated test files |
