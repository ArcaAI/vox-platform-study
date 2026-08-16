# STT Realtime + Batch — SOTA Assessment & Best-Practice Report

**Date:** 2026-07-10 (v2 — full fleet synthesis) · **Scope:** `apps/stt`, the client capture chain (`packages/{room,noise-filter,vad,stt,agentic-sdk-v2}`), and the gateway bridge (`apps/api` + `packages/applications/.../stt/streaming`). Covers **both** realtime streaming and batch/offline transcription.

**Method:** synthesized from a 17-agent research/mapping fleet — 5 top-level agents (stt service internals · browser+gateway audio path · STT docs & SOTA-ticket track · realtime-streaming external research · SOTA ASR-engine/quality external research) and 12 sub-agents (audio capture + RNNoise · Silero VAD integration · local Whisper + legacy WS client · SDK pipeline/store/UI wiring · gateway↔Redis bridge · ticket deep-dives TASK-454/461/464/470/471 · realtime diarization · endpointing/finalization · native streaming models · ambient clinical scribes · browser audio transport · auth detail). Every code claim carries `file:line`; every external claim carries a URL + date. The document *builds on* the in-flight SOTA track (TASK-451…487) — §1 lists what is already decided so it is not re-proposed.

---

## 0. Executive summary

The streaming stack is unusually mature for its stage: durable Redis-consumer-group transport (TASK-457), a finalize/outbox durability layer (TASK-456), a committed quality scorecard (TASK-470), LocalAgreement-2 commit policy, and a tentative-tail wire+render contract already exist. The SOTA track (TASK-472/473/475) is aimed at the right levers (native transducer, semantic endpointing, streaming diarization). This assessment therefore concentrates on **(a) sharpening the bets already in flight with specific mid-2026 evidence, (b) surfacing high-leverage findings that are in *no* ticket, and (c) the batch path, which every SOTA-track ticket explicitly declares a non-goal — yet it produces the durable clinical record where accuracy matters most.**

**Seven headline findings, in priority order:**

1. **The batch/offline path is entirely unaddressed and is the single biggest opportunity.** It still runs Whisper via faster-whisper/Optimum-ONNX; mid-2026 the offline accuracy+throughput frontier has moved to transducer models (Parakeet-TDT / Canary) that are *also* far less hallucination-prone and int8-lossless. This path writes the system-of-record transcript that feeds the harness/SOAP note. (§4)

2. **Noise suppression is applied twice on the ASR path, both on by default, and 2025–2026 evidence says spectral denoising *hurts* modern ASR — including a medical-ASR study where it lost in all 40 configurations.** The browser captures with `audio: true` (built-in NS on) *and* RNNoise runs by default before the STT send. This is in no ticket, is nearly free to test, and is plausibly a WER regression today. (§3.2)

3. **The just-merged tail-final fix (`0040fe3e`) is verified through the eval-harness WS client, but the production client teardown likely still drops the last live caption.** `useArcaAudio.stopAudio()` → `provider.destroy()` sends `stop` then synchronously closes the socket with no drain ([StreamingBackendSTTProvider.ts:250-264](../../../packages/stt/src/providers/StreamingBackendSTTProvider.ts)); the tail final arrives seconds later and the gateway relays only to an OPEN socket. The durable record is protected by the TASK-456 outbox, so this is a **live-caption** gap, not record loss — but it means the fix's "verified live" claim doesn't cover the real click-stop path. (§3.3)

4. **Model choice for clinical safety ≠ WER.** General WER hides drug-term error: Parakeet-TDT-0.6b posts ~15–22% *Drug* M-WER on PriMock57 despite top speed. If the TASK-472 pilot lands on Parakeet, it needs keyterm/drug biasing plus a clinical-accuracy pass; the best *small* open clinical model is Qwen3-ASR-1.7B (4.40% M-WER). (§5.1)

5. **Contextual biasing / keyterm boosting is the cheapest clinical accuracy win and is not in the track.** A per-tenant drug/formulary/condition list via NeMo word-boosting (Parakeet/Canary), Granite keyword biasing, or Whisper `initial_prompt`/`hotwords` — no retraining. The `initial_prompt` plumbing exists but is a single SYSTEM PromptTemplate, not a per-tenant term list. (§5.2)

6. **LocalAgreement-2 as the streaming default is dated:** its own authors deprecated `whisper_streaming` in 2025 in favor of AlignAtt/SimulStreaming, and the whole chunked-Whisper paradigm is being displaced by native cache-aware transducers. TASK-485 should not settle on LA-2 as the terminal default; keep it as the conservative fallback and let TASK-472 promote the transducer. (§3.1)

7. **Evaluation and observability have concrete, correctable gaps:** the scorecard baselines are on `say`-TTS audio (unrealistic, per TASK-487), it tracks `medical_wer` but not *Drug* M-WER or diarization cpWER/tcpWER, the text normalizer needs the Omi-documented bug check, seven Prometheus series are dead, streaming ASR isn't in the cross-service metric contract, and no RTF/WER is emitted in production. (§6, §7)

Plus a substantial inventory of **config/correctness debt** that costs quality, performance, or reliability silently — VAD defaults diverging across 4 layers, defined-but-inert perf knobs, settings read via `getattr` for fields that don't exist, a documented-but-nonexistent client audio queue, a dead legacy WS protocol island, CDN-fetched ML assets, no WS heartbeat, and more. Fully inventoried per layer in §7; the SOTA-vs-HOPE scorecard in §8 condenses the whole assessment into one table.

---

## 1. Already decided / in flight — do NOT re-propose

From the SOTA ticket-track review. Treat these as settled context:

| Area | Status | Ticket |
|---|---|---|
| Redis consumer-groups, resume-without-dup, multi-replica caption split | **Done** | TASK-457, 467 |
| Finalize lock, reaper on audio-idle, durable transcript outbox, tail-drain | **Done/Review** | TASK-456 |
| Commit-surface freeze/rollback (no meaning-flip), VAD onset dip tolerance | **Done/Review** | TASK-451 |
| Client audio-drop visibility (admin-console + vox provider chain) | **Review** | TASK-454, 464 |
| SDK reconnect UX (`onReconnected`, cleanup, tolerant parse, attempt-budget reset) | **Review** | TASK-461 |
| Streaming quality scorecard (`medical_wer`, keyterm/keyphrase recall) | **Review** | TASK-470 |
| Tentative-tail render + partial cadence 1.0→0.4s + LA-2 on seeds | **Review** | TASK-471 |
| Empty-final / `finalizing`-treated-as-terminal + redis read-timeout | **Fixed** `0040fe3e` | TASK-484 |
| **Planned but not started:** native transducer pilot (Kyutai/Parakeet) | Pending | TASK-472 |
| **Planned but not started:** semantic endpointing | Pending | TASK-473 |
| **Planned but not started:** diarization review → streaming Sortformer | Pending | TASK-474/475 |
| Default-pipeline LA-2 gap; scorecard threshold decision | Pending | TASK-485, 487 |

Open items the tickets themselves acknowledge (not new findings, listed for completeness): TASK-457 **I2** (gateway `resultSeq` resets to 0 on a fresh `SessionInfo` — client-side reconciliation issue, durable-safe; spec written, no ticket yet); TASK-456's transcript dedup is check-then-act, not a DB unique constraint ("TASK-466 territory"); TASK-485's go/no-go trace (does the live surface actually use the default pipeline?) has not been run; TASK-470's quality baselines are still `null` pending a real-audio capture; all commit-latency baselines were measured host-contended (3 processes on one box).

Governing constraints respected throughout: **self-hosted models only (no cloud PHI)**, **measure-first (everything gates on TASK-470)**, and **the durable transcript/harness system-of-record is never weakened for a live-surface latency win**.

---

## 2. Current state — how STT works today (code-verified map)

This section is the missing architecture reference: what actually runs, with exact parameters. It is the baseline every recommendation in §3–§7 measures against.

### 2.1 Realtime pipeline (browser mic → live caption)

**Capture & client-side processing chain** — orchestrated by `TranscriptionPipeline` in `@arcaai/vox` with hardcoded stage priorities `noiseFilter:10 → vad:20 → stt:30` ([TranscriptionPipeline.ts:119-217](../../../packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts)); each stage is an independent Web-Audio graph tap on the same shared track:

1. **Capture** — `useArcaAudio.startAudio()` calls `getUserMedia({audio: deviceId ? {deviceId:{exact}} : true})` directly ([useArcaAudio.ts:99-101](../../../packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts)) — *bypassing* `packages/room`'s constraint builder (`DEFAULT_AUDIO_OPTIONS`: EC/NS/AGC on, `channelCount:1`), so browser defaults (NS/EC/AGC **on**) apply implicitly. The shared `AudioContext` is forced to **48 kHz** (`useArcaAudio.ts:103`). A `secondaryDeviceId` mixes via `AudioMixer` (GainNode summation, `1/√N` master gain, **no** sample-rate/channel reconciliation — [AudioMixer.ts:145-149](../../../packages/room/src/core/AudioMixer.ts)).
2. **RNNoise** (default **on**: `noiseFilter: {enabled:true, level:'high'}`) — AudioWorklet, 480-sample/10 ms frames @48 kHz, WASM (`@jitsi/rnnoise-wasm` ABI), 960-sample drop-oldest output ring, `ScriptProcessorNode(4096)` fallback after a **10 s** init timeout ([NoiseFilterProcessor.ts:130-191](../../../packages/noise-filter/src/processors/NoiseFilterProcessor.ts)). The 48 kHz assumption is **never validated** against the live context (§7.2).
3. **Silero VAD v5** via `@ricky0123/vad-web@0.0.30` + `onnxruntime-web@1.27.0`, both fetched from **jsDelivr CDN by default** ([constants.ts:40-49](../../../packages/vad/src/constants.ts)); 512-sample/16 kHz frames inside vad-web's own worklet; production overrides `redemptionMs` to **500 ms** (package default 1400 ms). **For the backend-streaming path VAD is UI/telemetry-only** — it never gates the audio send; the hard `vadGate` applies only to the local-Whisper provider ([TranscriptionPipeline.ts:166](../../../packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts), [STTProcessor.ts:773-775](../../../packages/stt/src/core/STTProcessor.ts)).
4. **STT capture worklet** — coalesces 128-sample render quanta into **80 ms** frames (~12 postMessage/s; [stt-capture.worklet.ts:36](../../../packages/stt/src/worklets/stt-capture.worklet.ts)) → `StreamingBackendSTTProvider.processAudio()` resamples 48→16 kHz with a **Kaiser-windowed-sinc polyphase resampler** (32 taps/branch, β=9, ~90 dB stopband — [audioResampler.ts:230-248](../../../packages/stt/src/utils/audioResampler.ts)) → `float32ToInt16` → raw **binary Int16LE** WS frame, per-frame, no client batching timer.

**Session & auth flow** — `POST /api/v1/audio/transcription-jobs/stream/session` → gateway calls stt `POST /internal/streaming/sessions` (503 + `Retry-After: 5` at capacity) and mints a **one-shot stream ticket** (Redis, TTL 30 s, scope `stt_session:<id>`, GET+unconditional-DEL) → browser opens `wss://…/ws/stt/stream?sessionId&ticket&tenantId`. All auth failures close with generic **4401** (no enumeration). On success the gateway sends `{type:'ready', fromSeq}` so the client never races registration. Reconnect: fresh ticket via `refresh-ticket`, `{type:'resume', sessionId, lastSeq}` handshake, 5 attempts, exp backoff 1 s→30 s cap + additive 0–50% jitter, attempt budget reset on first post-reconnect server message ([SttWebSocketClient.ts:194-200,545-547](../../../packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts)).

**Transport (gateway ↔ stt) = Redis Streams, not HTTP.** Per session: `stt:audio:{id}` (audio in, consumer group `stt-ingest`, `XREADGROUP count=100 block=5000ms` + `XACK` + `XAUTOCLAIM`), `stt:result:{id}` (results out, gateway reads with stable group `captions`, `block=500ms`, ack-after-emit, reclaim after 30 s idle), `stt:control:{id}` (`finalize`/`pause`/`resume`/`cancel`, plain `XREAD`), `stt:session:{id}` (metadata hash), both data streams bounded `MAXLEN ~ 10000`. The gateway hardcodes `enc='pcm_s16le'` per frame regardless of client declaration.

**Audio format contract end-to-end:**

| Hop | Format / rate | Evidence |
|---|---|---|
| `getUserMedia` (mic) | Browser default (no explicit constraints on the real SDK path) | `useArcaAudio.ts:99-101` |
| Shared `AudioContext` | Forced **48 000 Hz** | `useArcaAudio.ts:103` |
| RNNoise worklet | 48 kHz, 480-sample (10 ms) frames | `RNNoiseProcessor.ts:27,32` |
| Silero VAD | 16 kHz internal (resampled inside vad-web), 512-sample frames | `VADProcessor.ts` |
| STT capture worklet | 48 kHz tap, 80 ms coalesced frames | `stt-capture.worklet.ts:36` |
| Client resample | 48→16 kHz Kaiser-sinc | `audioResampler.ts:17,230-248` |
| Browser→gateway | **Binary Int16LE PCM** mono, per-frame (JSON+base64 alt exists, unused) | `SttWebSocketClient.ts:355-363` |
| Gateway→stt | `XADD` raw bytes + `seq/sr/enc/ch/final/ts` fields | `streamingAudioBridge.service.ts:232-267` |
| stt→gateway | `XADD` flat fields (`text`, `is_final`, `stable_chars`, `utterance_index`, `speaker_*`, `word_timestamps_json`, …) | `schemas.py:170-194` |
| Gateway→browser | JSON text frames, `resultSeq`-tagged, 200-entry resume buffer | `stt-ws.gateway.ts:687-698` |

**Server-side streaming (stt)** — no WebSocket in stt itself; `SessionManager` + `StreamingPreprocessor` per session:

- **Segmentation** — Silero v5 ONNX (single-threaded CPU session) state machine: onset after `min_speech_duration_ms` (250) above threshold with 1-frame dip tolerance (TASK-451); offset after `min_silence_duration_ms` of silence — **500 ms** effective profile default; pre-speech ring buffer (500 ms) prepended; force-emit split at 25 s (lowest-energy point in a 1.5 s lookback, else 500 ms overlap split); adaptive-noise-floor **energy fallback VAD** when Silero is unavailable ([preprocessor.py:350-601](../../../apps/stt/src/stt/streaming/preprocessor.py)).
- **Partials** — every `streaming_partial_interval_s` = **0.4 s** (TASK-471; ≥0.5 s buffered audio floor), decoding only the trailing **8 s** window; finals decode the full utterance buffer. `_fire_partial` is skip-if-busy (not cancel-and-replace) and gated so partials for utterance N+1 don't race the final for N.
- **Engine** — per-utterance re-transcription via the pipeline-configured engine (faster-whisper `BatchedInferencePipeline` typical), offloaded with `asyncio.to_thread` (thread pool, **not** the `inference_pool_size` process pool — that setting is inert, §7.1). `LocalAgreement-2` commit policy is **opt-in** per pipeline YAML (`commit_policy: local_agreement_2`, default `"none"`): token-normalized longest-agreeing-prefix freeze with rollback-on-contradiction, emitting `stable_chars` on partials — it stabilizes text, it does **not** decide finalization.
- **Finalization** — 4 triggers (final audio frame, control `FINALIZE`, `end_session()`, reaper on 300 s audio-idle) funnel through one lock-guarded `_finalize_session()`: flush final utterance → drain inference queue (60 s; on timeout, transcribe remaining **inline** so the tail is never dropped) → upload WAV/transcript/metadata to blob → persist durable transcript to gateway (3 inline retries, then a **Redis outbox** with 90 s lease re-driven up to 10 attempts before a loud `ALERT` drop) → publish `status:"closed"`. Wire order is always `finalizing → tail FINAL → closed` — the exact order the pre-`0040fe3e` gateway got wrong.
- **Capacity** — in-process `CapacityGuard` sized by hardware `ExecutionProfile` (A100/H100 100 streams · multi-GPU 40 · single-GPU 20 · Apple Silicon 5–15 · CPU-only profile disables denoise); no cross-pod coordination.

**Result relay & egress policy (gateway)** — partials above a **512 KiB** `bufferedAmount` watermark are **silently dropped** (counted only); finals are queued (bounded 200) and flushed on a 50 ms poll, with an explicit `{type:'gap'}` marker if the final queue overflows. 15 s resume-grace keeps the upstream session alive across a transient WS drop. **No app-level ping/pong or idle timeout exists** ([stt-ws.gateway.ts:547-636](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts)).

**Latency budget (code-evidenced floors, excluding inference):** 80 ms client coalescing → per-frame XADD (no gateway batching) → 0.4 s partial cadence (0.5 s min-audio floor) → 500 ms VAD-silence finalize threshold → gateway 500 ms result-read BLOCK ceiling (not added latency when active). Measured commit latency: p50 **7 383 ms** on a contended single box (TASK-487 flags this as unrepresentative; no clean-host number exists yet). SOTA reference targets: first-partial < 300 ms, commit < 1 s, final < 2 s.

### 2.2 Batch pipeline (upload → durable transcript)

Two entry points: **queued** — Dramatiq actor `transcribe_file` (`queue stt_batch`, `max_retries=3`, `time_limit` 600 s, audio pre-uploaded to MinIO, downloaded per-tenant) — and **direct** `POST /api/v1/transcribe` (multipart ≤ 100 MB, synchronous in-request, skips the processed-audio upload). Worker image runs `--processes 2 --threads 4` (8 slots/pod).

Stages ([batch_service.py:156-573](../../../apps/stt/src/stt/transcription/batch_service.py)): model load (shared LRU `ModelCache`: 5 models, 1 h TTL, hardcoded 10 GB ceiling, single-flight loads) → `AudioPreprocessor` (soundfile/librosa → mono → normalize → **RNNoise denoise @48 kHz** (profile-gated) → single resample to target rate → VAD) → VAD-segment **merge** (gap ≤ 2 s, merged ≤ 15 s — amortizes Whisper's ~6 s fixed per-`generate()` encoder overhead) → **per-segment inference** (segments > 15 s sub-split with stride `"4,2"` + overlap-word dedup) → diarization (inline per-chunk or best-time-overlap merge pass) → punctuation (globally **off** — §2.4) / disfluency removal (opt-in) / word+sentence timestamps → artifacts (`{y}/{m}/{d}/…/transcript.{json,txt,vtt,srt}`, `metadata.json`) → gateway callbacks (`/internal/stt/*`, header `X-Internal-Service-Key` handled by the generic API-key extractor) → SSE progress/chunk/transcript events via Redis Pub/Sub (`stt:transcription:{job_id}`), progress-coalesced, cancellation polled ~every 10%.

Notable: the batch path also emits **incremental chunk results** over SSE despite being a full-file pass; VAD can run **twice** in one job when diarization is enabled but VAD wasn't applied upstream (`batch_service.py:429-454`); the retry policy on the actor decorator (10 s/300 s) conflicts with the broker `Retries` middleware (60 s/900 s) — one of the two is dead config.

### 2.3 Engine matrix & decoding defaults

Six engine families dispatched by `AiModelFormat` ([pipeline/dto.py:29-43](../../../apps/stt/src/stt/pipeline/dto.py)); models resolve per-request from DB slug or inline YAML (tenant-scoped read as defense-in-depth):

| Engine | Loader | Notes |
|---|---|---|
| `SAFETENSOR`/`PYTORCH` (HF transformers) | `huggingface_loader.py` | Whisper → Seq2Seq → CTC probe order; auto-detects Gemma-4-family multimodal LMs |
| `ONNX` / `ONNX_OPTIMUM` | `onnx_loader.py` | Optimum `ORTModelForSpeechSeq2Seq` for whisper/onnx-community; quant variants fp16/int8/uint8/q4/q4f16/bnb4; `return_timestamps=False` deliberately (sequential long-form decode is ~20× slower) with offsets via `processor.decode` |
| `NEMO` (Parakeet/Canary) | `nemo_loader.py` | Word-timestamp capability by class (RNNT/TDT/Hybrid); **plumbing for the TASK-472 pilot already exists**, incl. `VALID_PARAKEET_V3_LANGUAGES` (26 langs) |
| `FASTER_WHISPER` (CT2 1.2.1) | `faster_whisper_loader.py` | Prebuilt `BatchedInferencePipeline`; MPS→CPU fallback; fp16→fp32/int8 coercion on CPU |
| `AZURE_SPEECH` | `azure_speech_loader.py` | Cloud; detailed output + word timestamps (ticks/1e7) |
| multimodal LLM | (inside HF loader) | `AutoModelForMultimodalLM` |

`InferenceConfig` defaults: `beam_size=5`, temperature fallback `[0.0…1.0]`, `compression_ratio_threshold=2.4`, `logprob_threshold=-1.0`, `no_speech_threshold=0.6`, `no_repeat_ngram_size=3`, `condition_on_prev_tokens=False` (correct anti-loop default), `prev_text_context_words=50`, pinned-language semantics under code-switching (TASK-351), `initial_prompt` = a single SYSTEM `PromptTemplate` UUID (ignored with a warning by NeMo/Azure). These are re-derived into **four separately-maintained kwargs builders** (batch transformers / batch Optimum / streaming transformers / faster-whisper) — a drift hazard (§7.1).

### 2.4 Ancillary subsystems

- **Diarization** — exists end-to-end but **disabled by default** (`DiarizationConfig.enabled=False`, `max_speakers=2`): pyannote/wespeaker embeddings (default `pyannote/wespeaker-voxceleb-resnet34-LM`, expected **256-d** to match the pgvector column) → session-scoped `SpeakerTracker` (rolling 8-embedding window, hybrid `0.7·centroid + 0.3·max` scoring) → `SpeakerIdentifier` (high 0.7 / low 0.4 / update 0.8 thresholds; `pyannote/segmentation-3.0` refinement in the ambiguous zone) → doctor **voice-profile preseed** from PostgreSQL (`UserVoiceProfile`; ⚠️ tenant filter written but commented out — the column doesn't exist yet). Streaming diarization is finals-only, embedding extraction runs in parallel with ASR (first 5 s of the utterance), state is lost on session recovery, and the surfacing contract is broken: backend emits `speaker_id`, the UI renders `speaker_label` — **no speaker labels reach the clinician today** (TASK-474/475 scope this).
- **Punctuation** — global kill-switch default **off** (`punctuation_enabled=False`): production Whisper self-punctuates, and `cadence-punctuation 1.1.0` cannot load under the pinned `transformers==5.5.4`. The direct-load `cadence-fast` path (revision-pinned, lock-serialized, warm-up inference) is finals-only in streaming with a **0.4 s timeout** — on timeout the raw text publishes so the final's latency budget holds. Per-pipeline YAML `punctuation.enabled: true` is silently overruled by the global flag (one-time warning).
- **Disfluency removal** — regex filler list, opt-in, identical in streaming and batch. **No inverse text normalization exists anywhere** (grep-confirmed) — numbers/dosages/units are whatever the engine emits (§4.5).
- **English gloss** — optional per-pipeline `streaming_english_gloss`: a background `task="translate"` pass on the same cached Whisper after each final, published as `type:"gloss"` (15 s bound).
- **Local browser Whisper** (the non-`pipelineId` path) — `@huggingface/transformers@4.2.0` in a WebWorker (zero-copy Transferable audio; crash recovery 3 retries, 100/200/400 ms backoff), models `onnx-community/whisper-{tiny,base,small}[.en]` (default `base`; fp16 only on WebGPU), 30 s/5 s-overlap sliding buffer drained every 500 ms single-flight, **hard VAD gating** (frames dropped; transcription fires on `vad-speech-end` segments). A fully separate **deprecated legacy WS protocol island** (`WebSocketClient.ts` + `MessageHandler.ts` + `RemoteSTTProvider`, TASK-298 D-4) remains reachable when `pipelineId` is absent (§7.2).
- **Dual capture** — `DualStreamRecorder` records raw+processed blobs for QA playback but only in the **local** workflow; `ProcessedAudioTap` (the building block for remote-workflow dual capture) has zero call sites.

### 2.5 Observability & evaluation infrastructure today

- **Prometheus**: FastAPI auto-instrumentation + ~16 custom series, of which **7 are dead** (no call sites): model-load latency, cache hits/misses, VAD segments/latency, worker jobs in-progress/total. The cross-service `model_running_instances`/`model_inference_latency_seconds` contract (TASK-386) wraps only batch ASR + batch VAD — **the streaming path is outside the contract** (only the unlabeled `stt_streaming_inference_latency_seconds` histogram covers it). **No RTF or WER is computed in production.**
- **Logging**: structlog JSON with OTel trace injection; a grep-able dotted-event alert catalog exists only in the transcript-durability subsystem (`stt.transcript.*`). OTel tracing is off by default; the Dramatiq worker gets log export only.
- **Eval harnesses** (all offline, TASK-455/470): latency harness (Redis-entry-ID-derived `ttfw_ms`/`partial_cadence_ms`/`final_lag_ms`, clock-skew-immune), loss harness (`seq.gap_count`, `audio_coverage_ratio`), quality scorecard (`medical_wer` with synonym-aware normalization, `keyterm_recall` contiguous-span, `keyphrase_recall` ordered-subsequence, `partial_revision_rate`, `commit_latency`) gated by `streaming_thresholds.json` (bootstrap: WER ≤ 0.35, recall ≥ 0.70, seq-gap 0, coverage ≥ 0.996−ε). Post-`0040fe3e` live run: WER 0.033–0.066, keyterm recall 1.0, coverage 0.994–0.997 — but `partial_revision_rate` 0.77–0.80 (designed cadence trade-off, measured on full-caption text not the committed region) and contended `commit_latency_p50` 7 383 ms are the open TASK-487 decisions. Fixtures: 3 de-identified scripted clinical reads (`.gt.txt` + `.keyterms.json` committed; `.wav` generated via `say`-TTS — unrealistically clean).

---

## 3. Realtime streaming — findings & recommendations

### 3.1 Streaming engine — validate & sharpen the TASK-472 transducer bet

**Current state:** the live path re-transcribes a growing utterance buffer per partial via faster-whisper, with optional LocalAgreement-2 for stable-prefix commit. Measured stable-word latency ~1–2 s; TASK-472 already identifies this as a ~5–7× gap vs SOTA and proposes a native-transducer pilot.

**Evidence to sharpen the bet:**

- **LocalAgreement-2 is officially dated.** `ufal/whisper_streaming`'s README now states it is "becoming outdated, replaced by SimulStreaming" ([github.com/ufal/whisper_streaming](https://github.com/ufal/whisper_streaming), accessed 2026-07-10). **AlignAtt/SimulStreaming** (attention-guided policy, IWSLT-2025 winner, ~5× faster than whisper_streaming; [github.com/ufal/SimulStreaming](https://github.com/ufal/SimulStreaming), released 2025-10-22) is the drop-in successor *if you stay on Whisper* — it also adds beam search, in-domain terminology prompt injection, and bounded 30 s context carryover. **⚠️ verify its LICENSE before commercial clinical use** — one source surfaced a "noncommercial" note despite an MIT header.
- **Native cache-aware transducers are the real target.** The encoder keeps self-attention+conv state in a cache and updates per chunk — no re-encoding, a runtime `att_context_size` latency knob, and no hallucinated-partial risk. The published CTC-vs-transducer curve ([nvidia/stt_en_fastconformer_hybrid_large_streaming_multi](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi)) shows the transducer beats CTC by ~0.8–1.4 WER pts at **every** latency (5.4 vs 6.2 @1040 ms → 7.0 vs 8.4 @0 ms). Concrete pilot candidates, all with production lineage:

| Candidate | Date / license | Why |
|---|---|---|
| **`nvidia/parakeet-unified-en-0.6b`** | 2026-04-07, NVIDIA Open Model | *One checkpoint that is both offline and cache-aware streaming*: 8.44% WER @160 ms → 6.14% @2.08 s; offline 1.63% LS-clean. Collapses the two-tier live+final architecture into one artifact. EN-only. |
| **`nvidia/nemotron-speech-streaming-en-0.6b`** | 2026-01-05, NVIDIA Open Model | 6.93% @1.12 s → 8.43% @80 ms, **24 ms median time-to-final**, 560 streams/H100, ships via Riva/NIM (best ops maturity). EN-only. |
| **`nvidia/nemotron-3.5-asr-streaming-0.6b`** | 2026-06-04, OpenMDW-1.1 | **40 language-locales**, FLEURS avg 8.84% @1.12 s (ES 4.11%, IT 4.25%, EN 7.91%), ~2 400 streams/H100. The multilingual answer — check OpenMDW terms. |
| **`kyutai/stt-1b-en_fr`** | CC-BY-4.0 | 0.5 s fixed delay, **built-in semantic VAD** (folds §3.4 into the ASR), production Rust WS server, 400 streams/H100, MLX. The strongest non-NVIDIA option and the one TASK-472 already names. EN+FR only; no runtime latency knob. |
| `mistralai/Voxtral-Mini-4B-Realtime-2602` | 2026-02, Apache-2.0 | Most permissive license, 13 langs, 80 ms–2.4 s delay, vLLM day-1 — but 4B ≈ 6–7× the per-stream compute of a 0.6B FastConformer. Hedge, not primary. |

- **Do NOT pilot streaming on `parakeet-tdt-0.6b-v2/v3`** — those are *offline* models (chunked inference re-encodes; not cache-aware). They are the right *batch* choice (§4), not the streaming choice. The streaming NVIDIA checkpoints ship RNN-T decoders; TDT is the throughput multiplier for the offline/final pass.
- Clinical incumbent corroboration: **Corti publicly argues exactly this position** — Whisper-style AED models are "batch-oriented and prone to over-generation/hallucination"; streaming CTC/transducer wins because the metric that matters is word-level latency ([corti.ai](https://www.corti.ai/stories/building-better-speech-recognition-for-healthcare), 2025-07-22).

**Recommendation:** keep TASK-472 as-is but (1) add `parakeet-unified-en-0.6b` as an explicit candidate (its dual offline/streaming nature simplifies the two-tier architecture), (2) benchmark against **WhisperLiveKit** ([github.com/QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit), Apache-2.0, v0.2.23 2026-07-09 — AlignAtt default, Sortformer diarization, dual VAD, Deepgram/OpenAI-compatible WS endpoints) as the open reference integration rather than hand-rolling AlignAtt, and (3) resolve TASK-485 by promoting the transducer (or AlignAtt) to default and demoting LA-2 to fallback, rather than settling LA-2 as terminal default.

### 3.2 🔴 New finding — remove/AB-test noise suppression on the ASR path

**Current state (double NS, both defaulted on):**
- Browser capture uses `getUserMedia({ audio: true | {deviceId} })` on the real SDK path ([useArcaAudio.ts:99-101](../../../packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts)) → browser built-in `noiseSuppression`/`echoCancellation`/`autoGainControl` default **on**. (`packages/room`'s careful `DEFAULT_AUDIO_OPTIONS` constraint builder is *bypassed* by this path — §7.2 debt item.)
- RNNoise then runs by default before the STT send (`_enabled = true` [RNNoiseProcessor.ts:71](../../../packages/noise-filter/src/processors/RNNoiseProcessor.ts); `noiseCancellation ?? true` [useNoiseFilter.ts:148](../../../packages/noise-filter/src/hooks/useNoiseFilter.ts); pipeline default `noiseFilter: { enabled: true }` [TranscriptionPipeline.ts:40](../../../packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts)).
- The **batch** preprocessor *also* denoises with RNNoise (profile-gated) before inference (§2.2) — so the finding applies to both paths.

**Evidence that this hurts WER:**
- *"When De-noising Hurts — Speech Enhancement Effects on Modern Medical ASR"* ([arXiv:2512.17562](https://arxiv.org/html/2512.17562), Dec 2025): 500 medical recordings × 9 noise conditions, Whisper-large-v3 + **Parakeet-TDT-1.1B** + healthcare-tuned models — **original noisy audio beat MetricGAN+-enhanced audio in ALL 40 configurations**; denoising added **+1.32–3.19% semWER even on clean audio**; severe cases catastrophic (Whisper 8.82→25.83% at 10 dB SNR). Authors: enhancement "should not be applied by default."
- *"When Denoising Hinders… Whisper"* ([arXiv:2603.04710](https://arxiv.org/abs/2603.04710), Mar 2026): denoising raised WER/CER across Whisper sizes despite higher perceptual quality; errors grew with model size.
- Mechanism: Whisper/Parakeet were trained on hundreds of thousands of hours of *noisy* audio and ingest noise directly; enhancement's speech-distortion artifacts are what the ASR chokes on ([Microsoft Research arXiv:2111.11606](https://arxiv.org/pdf/2111.11606)).
- The "RNNoise gives 15–25% WER win" claim is vendor-blog only, scoped to *older* ASR in stationary noise.

**Recommendation (measure-first, near-zero cost):** wire an A/B into the TASK-470 scorecard — RNNoise-on vs RNNoise-off, and browser-NS-on vs off — on real (not `say`-TTS) consultation audio. Expectation from the literature: **disable RNNoise on the ASR send path** and request `noiseSuppression:{exact:false}` (plus explicit EC/AGC decisions) for the ASR stream — noting Chrome may not fully honor it ([Chromium issue 327472528](https://issues.chromium.org/issues/327472528)), so verify empirically per browser. Keep VAD (segmentation only is safe and valuable). If a genuine WER win can't be shown, ship undenoised PCM16. Denoised audio can still be kept for *human playback* via the dual-capture tap (`ProcessedAudioTap` exists, unused — §2.4) — a separate concern from the ASR feed.

### 3.3 🔴 New finding — verify the live tail-caption reaches the production client after `0040fe3e`

**What the fix did:** the gateway result-reader now terminates only on `closed`/`cancelled`, not `finalizing` ([streamingAudioBridge.service.ts:609-693](../../../packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts), commit `0040fe3e`), matching stt's wire order `finalizing → tail FINAL → closed`. Verified via the eval-harness WS client. (The companion redis-timeout hardening — treating `RedisTimeoutError` on blocking reads as a benign empty read, plus `health_check_interval=30` — is correct and closed.)

**Why the production path likely still drops the last live caption:** on click-stop, `useArcaAudio.stopAudio()` → `await pluginManager.destroy()` → … → `STTProcessor.onDestroy()` → `StreamingBackendSTTProvider.stop()` then `destroy()` ([StreamingBackendSTTProvider.ts:213-264](../../../packages/stt/src/providers/StreamingBackendSTTProvider.ts)):
```
await this.stop();            // sends {"type":"stop"}, returns immediately — no ack listener
this.wsClient.disconnect();   // synchronous ws.close(1000) — socket now CLOSING/CLOSED
await this.session.closeSession();  // DELETEs the gateway session
```
There is **no state-machine gate, timeout, or Promise between `sendStop()` and the socket close** (confirmed by two independent code walks). The tail final is produced only after stt runs ASR on the drained buffer (realistically ~1–3 s; the commit's own scorecard cites p50 ~7.4 s under single-box contention). The gateway `relayResult()` only sends to an OPEN socket, and `closeSession()` removes the session, so the 15 s resume-grace can't help (nothing reconnects). **Net: the live caption UI most likely never renders the final utterance of a normal stop-and-done consultation.** The durable TRANSCRIPT ContextItem is still complete (TASK-456 outbox persists server-side independently), so severity is *live-UX*, not record loss.

**Recommendation:** add a graceful-drain handshake to stop — client sends `stop`, then waits (bounded, e.g. ≤3–5 s) for the tail `isFinal` or a terminal `{type:'status', status:'closed'}` before `disconnect()`; the gateway already emits `closed`. Add an **end-to-end test through the real `useArcaAudio` teardown** (not the harness WS client) asserting the last utterance's final is received client-side. This closes the loop TASK-484 opened.

### 3.4 Endpointing — sharpen TASK-473 semantic endpointing

**Current state:** finalization is VAD-silence-driven (500 ms effective default resolved from one of four config layers — §7.1), with a `force_emit_after_ms` safety cap. TASK-473 correctly plans a self-hosted semantic end-of-utterance (EOU) layer, with the fixed timer as fallback.

**2026 consensus:** VAD is the *trigger only*; a semantic/acoustic EOU model gates the actual endpoint, choosing the delay adaptively in a `[min, max]` window. Every leading system now works this way — LiveKit `min 0.3 s / max 2.5 s` with its detector, Deepgram Flux `eot_threshold=0.7` + `eot_timeout_ms=5000` hard cap, AssemblyAI per-mode `min_turn_silence` 128/224/800 ms + `max_turn_silence` 1536 ms, OpenAI `semantic_vad` eagerness dial.

**Self-hostable options (all verified 2026-07-10):**

| Model | Type | Cost | License / note |
|---|---|---|---|
| **Pipecat smart-turn v3.2** | audio-native | **12 ms CPU**, 8 MB quantized | Fully open (weights+data+training) — cleanest license story ([daily.co](https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/)) |
| **LiveKit Turn Detector v1-mini** | dual-branch audio+semantic (Qwen2.5-0.5B backbone) | CPU-capable | 14 langs; LiveKit Model License; at a 300 ms budget: 9.9% false-cutoff vs Flux 12.9% |
| **Kyutai semantic VAD** | built into Kyutai STT | free with the ASR | Multi-head "pause of length L ∈ {0.5,1,2,3 s}" = a tunable patience dial — folds §3.1 and §3.4 into one model |
| **TEN Turn Detection** | transcript-based (google/gemma-4-e4b) | heavier | 3-state `finished`/`unfinished`/`wait` — the `unfinished` "hold" label is worth copying; can reuse the LA-2 transcript you already have |

**Clinical tuning is the key refinement:** doctors pause long and deliberately (reading, enumerating doses) and the cost of a false-early cut is high — bias the window *longer* than voice-agent defaults (min ~0.3–0.5 s, **max ~2.5–3.5 s**), and add a "hold/unfinished" state on trailing numbers/conjunctions so the downstream SOAP summarizer doesn't fire mid-sentence (§3.8 makes this a wire-contract field).

**Trigger-layer upkeep:** **Silero v6 is out** (v6.0 2025-08-25: 16% fewer errors on noisy data; v6.2.1 2026-02-24 made onnxruntime optional — [github.com/snakers4/silero-vad](https://github.com/snakers4/silero-vad/releases)). Both the server (Silero v5 ONNX) and client (`@ricky0123/vad-web` v5 assets) are a version behind; a v6 bump is a low-risk accuracy pickup. **TEN VAD** (Apache-2.0, 10/16 ms hop, beats Silero on precision and transition latency, catches short inter-speech silences Silero misses) is the alternative if endpoint tightness ever becomes the binding constraint. Note Silero's inference window is **512 samples/32 ms @16 kHz** (fixed since v5) — the code already gets this right.

### 3.5 Diarization — de-risk TASK-475 (licensing + capture)

**Current state:** a full embedding-clustering diarization subsystem exists but is disabled by default, finals-only, loses state on session recovery, and has a surfacing-contract mismatch — no speaker labels reach the clinician today (§2.4). TASK-474/475 already scope fixing this + adding streaming Sortformer.

**De-risking points for TASK-475:**

1. **License trap:** use **`nvidia/diar_streaming_sortformer_4spk-v2`** (CC-BY-4.0 ✅) or v2.1 (NVIDIA OML ✅). The *offline* `diar_sortformer_4spk-v1` is **CC-BY-NC** (✗ not for a commercial clinical product). Counter-intuitively, the streaming models are the *more* licensable choice.
2. **Streaming no longer costs accuracy.** Streaming Sortformer (Arrival-Order Speaker Cache, ~117M params, max 4 speakers; [arXiv:2507.18446](https://arxiv.org/abs/2507.18446), Interspeech 2025) @1.04 s latency *beats* offline Sortformer (DIHARD III 19.02 vs 21.71; CALLHOME 11.22 vs 14.25) and essentially ties it on 2-speaker CH109 (5.09 vs 4.86). **2-speaker is its best-case regime (~6.6% DER CALLHOME-2spk)**; dropping to 0.32 s latency barely moves it; RTF 0.09–0.18 (GPU-cheap).
3. **Prefer a hardware channel boundary where the capture setup allows.** Stereo/dual-channel capture (doctor mic vs patient mic, or telehealth's two legs) gives a ~0-DER, zero-latency, zero-license-risk speaker label — standard call-center practice. Reserve model-based streaming diarization for genuine single-mic ambient rooms. Note the current `AudioMixer` *sums* primary+secondary mics into one mono track (§2.1) — dual-channel capture would need to keep the channels separate instead; that is an architectural fork worth deciding in TASK-474.
4. **Joint speaker-attributed ASR exists as a packaged recipe:** `nvidia/multitalker-parakeet-streaming-0.6b-v1` + Sortformer v2 gives word-level speaker-attributed streaming at ~1.12 s end-to-end (NeMo tutorial) — directly aligned with the TASK-472 transducer pilot if both land on NeMo. (Riva constraint: its packaged streaming Sortformer pairs with CTC ASR.)
5. **Keep the doctor voice-profile preseed** — clinician enrollment ("not-clinician = patient") is the cheap 2-party robustness boost the ambient-scribe industry converges on; an enrollment-free variant exists ([arXiv:2506.22646](https://arxiv.org/pdf/2506.22646)). Fix the preseed `tenant_id` scoping gap while there ([voice_profile_model.py:46-49](../../../apps/stt/src/stt/core/database/voice_profile_model.py)).
6. **Don't reach for pyannote for streaming:** pyannote.audio 4.x/Community-1 (Sep 2025) is offline-only; diart (its streaming wrapper) pins `pyannote<3.1` and lags the quality curve; pyannoteAI Live-1 (<300 ms, GA 2026-07-07) is API-only — excluded by the PHI posture. pyannote 4.x remains a fine *offline/batch re-processing* option.
7. **Evaluate with cpWER/tcpWER, not DER** (§6) — speaker-attributed WER is what tells you the note attributed symptoms to the right party.

### 3.6 Tentative-tail render is unreachable via default SDK wiring (new finding)

TASK-471 shipped the two-tone settled/tentative render ([transcript-segment.tsx:178-187](../../../packages/ui/src/components/live-transcript/transcript-segment.tsx)) and the `stable_chars` wire field, and `SttWebSocketClient.normalizeTranscript()` parses `stableChars`/`utteranceIndex`/`resultType` off the wire. **But** `StreamingBackendSTTProvider.normalizeTranscript()` drops all three when converting to the generic `TranscriptionResult` ([StreamingBackendSTTProvider.ts:301-320](../../../packages/stt/src/providers/StreamingBackendSTTProvider.ts)) — `TranscriptionResult` has no such fields — and `useArcaAudio`'s `onTranscription` only appends `isFinal` segments to the store; partials populate a plain `currentTranscript` string rendered via the UI's flat-italic `interim` path with no `stableChars` slicing. So in the repo's default hook chain, `transcriptSegments` is always fully-final and the two-tone tentative-tail path never receives the data it needs. It works only if an out-of-repo consumer builds `LiveTranscriptSegment{isFinal:false, stableChars}` directly from the raw WS payload.

**Recommendation:** thread `stableChars`/`resultType`/`utteranceIndex` through `normalizeTranscript()` and have `onTranscription` construct a partial segment carrying `stableChars`, so the feature TASK-471 built is actually reachable from the stock SDK. Pairs naturally with a stability-gated render to control flicker (UPWR, §6). Also note the same hop drops `speakerLabel` (only `speakerId` is copied) — the §3.5 surfacing fix should land here too.

### 3.7 Transport reliability — the remaining loss/visibility gaps (new)

TASK-454/457/461/464 fixed the big ones (consumer-group resume, drop counters, reconnect UX). What remains, code-verified:

1. **Audio captured during a disconnect is silently discarded — the documented queue does not exist.** `WsBackpressureOptions` documents an `audioQueue` with `maxQueueSize=200` drop-oldest ([SttWebSocketClient.ts:103-140](../../../packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts)) — **no such queue exists anywhere in the class** (confirmed by full read + grep). While disconnected, `StreamingBackendSTTProvider.processAudio()` returns early on `!isConnected()` — no buffering, no replay on reconnect. Every reconnect episode therefore loses its gap audio from both the live caption *and* the durable transcript. **Best practice (and the browser-transport research consensus): a client-side seconds-long PCM ring buffer + replay-from-`lastSeq` on resume** — the resume handshake and Redis Stream IDs already provide the sequencing substrate. Either implement the queue the docblock promises or delete the dead config and document the drop.
2. **Egress partial drops are invisible to the clinician.** Above the 512 KiB watermark the gateway silently drops partials (counter only); only *final* overflows emit a `{type:'gap'}` marker ([stt-ws.gateway.ts:551-636](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts)). Harmless to the record, but the live UI freezes with no signal — emit a lightweight degraded/gap hint for partials too (the TASK-454 banner pattern already exists client-side).
3. **No app-level WS heartbeat / idle timeout** on `SttWsGateway` — a network black-hole (no close frame) leaves `SessionInfo` + the upstream stt session + its consumer-group reader alive until the 300 s server-side audio-idle reaper fires. Add ping/pong + idle reap at the gateway.
4. **TASK-457 I2 (deferred): gateway `resultSeq` resets to 0 on a fresh `SessionInfo`** (process restart / grace-expiry / cross-instance reconnect) — clients can see duplicate/regressed seq. The spec exists in the ticket; file and fix it alongside item 1 since both touch resume semantics.
5. **Client backpressure counters exist but nothing throttles.** On sustained `bufferedAmount` pressure the provider counts and surfaces drops (TASK-464) — good — but capture keeps running at full rate. Consider degrading gracefully (e.g. pause-and-buffer, or Opus fallback ≥24 kbps via WebCodecs where available with PCM fallback — [arXiv:2106.07994](https://arxiv.org/abs/2106.07994) puts good-bitrate Opus at only ~2% relative WER) instead of dropping medical audio.

Transport fundamentals are otherwise **right** by 2026 best practice: AudioWorklet capture (not ScriptProcessor), anti-aliased Kaiser-sinc 48→16 kHz resample, raw PCM16-over-WSS (firewall-friendly on clinical networks; matches Google's lossless preference and OpenAI Realtime's pcm16 stance), monotonic seq + ticket-auth + single-use resume — keep WebSocket, do not adopt WebRTC (it forces Opus + an SFU for no benefit on a server-ingest path).

### 3.8 Wire-contract v2 — expose endpoint semantics (enhancement proposal)

The current result schema (`segment`/`gloss` + `stable_chars` + `status`) is a solid LA-2 surface but collapses the three concerns the 2026 vendor contracts now separate: revisable hypothesis, immutable commit, and the **endpoint decision**. When TASK-473 lands, extend the WS schema (superset of Deepgram/AssemblyAI/Google/Azure/OpenAI semantics, maps 1:1 onto LA-2/AlignAtt or a transducer):

- `partial` — tail text + `stable_chars` (exists) **+ a `stability` score** so the UI can hold jittery low-stability words (flicker/UPWR control).
- `commit` — the immutable prefix advance (today implicit in `stable_chars` growth; make it explicit for audit-safe consumers).
- **`endpoint` — `{utterance_index, reason: "semantic"|"silence"|"max_timeout"|"forced", end_of_turn_confidence, trailing_silence_ms}`** — the single most valuable missing field: *why* the turn ended and how confident. Distinguishes a semantic sentence completion from a silence/timeout cutoff in both the UI and the audit trail.
- **`hold`** — `{p_incomplete}` on trailing conjunctions/numbers (TEN-style `unfinished`) so live-documentation consumers (`LiveDocumentationService` → SMR) don't fire mid-sentence.
- `final` — formatted turn (post-punctuation/ITN), optional speaker tag.
- Client→server `finalize` already exists (`stop`→`finalize` control); keep it.

All fields carry monotonic timestamps/seq (already the case). This is additive — existing consumers keep working.

---

## 4. 🟠 Batch / offline path — the biggest untapped opportunity

Every SOTA-track ticket declares the Dramatiq batch path a non-goal, yet this path produces the **durable transcript that feeds the harness and the SOAP note** — where clinical accuracy matters most. It currently runs Whisper (faster-whisper 1.2.1 / Optimum-ONNX) with beam_size=5, temperature fallback, VAD-segmented per-segment inference (§2.2). The two prior internal research docs (`whisper-onnx-*.md`) tuned this Whisper path well — but they predate the model-choice question entirely.

**Recommendations (all self-hosted, GPU-friendly):**

1. **Move the offline workhorse to a transducer, int8.** `parakeet-tdt-0.6b-v3` (CC-BY-4.0, 25 EU languages, native word timestamps, Open-ASR 6.34%, RTFx in the thousands) or `canary-1b-v2` (25 EU langs + translation). int8 is **essentially lossless for CTC/TDT** (8.01% vs 8.03% FP32) and ~2× density — the highest-leverage lever for a GPU-limited k3s cluster. These models were trained on non-speech audio and **barely hallucinate on silence**, unlike Whisper — a direct clinical-safety upgrade. Keep Whisper-large-v3 as the 99-language fallback. (The NeMo loader + `VALID_PARAKEET_V3_LANGUAGES` mean the plumbing already exists; native NeMo word timestamps also replace the Optimum offset-extraction workaround.) For the English accuracy ceiling, track `granite-speech-4.1-2b` (Apache-2.0, 5.33% Open-ASR #1; NAR variant ~1 820 RTFx/H100 + native keyword biasing) and `canary-qwen-2.5b` (5.63%).
2. **Gate medication/critical audio on a clinical-accuracy model.** Parakeet's fast tier has a **15–22% Drug M-WER** — not safe for prescriptions (§5.1). Add a second pass with **Qwen3-ASR-1.7B** (Apache-2.0, 52 langs, 4.40% M-WER, vLLM) or a LoRA-on-clinical Whisper for medication-bearing segments.
3. **Anti-hallucination hardening on the Whisper path you keep** (defaults are already right: VAD-first, `no_speech_threshold=0.6`, `logprob_threshold=-1.0`, `compression_ratio=2.4`, temperature fallback, `condition_on_prev_tokens=False`): keep them; consider CrisperWhisper (nyrahealth — verbatim + filler detection; check its CC-BY-NC-ish license) only if verbatim capture is ever needed. The structural fix is recommendation 1: transducers sidestep this failure class. See §5.3.
4. **Serving:** the faster-whisper `BatchedInferencePipeline` batches only a single utterance's own audio — there's no cross-request dynamic batch scheduler (`inference_pool_size` is inert, §7.1). Pragmatic density play for the Dramatiq queue: int8 + multiple worker replicas per GPU (MIG on A100/H100, time-slicing on L4/A10 — an L4 runs Parakeet fp16 at ~200–230× realtime at batch 8); keep the realtime pool separate so streaming latency isn't starved by batch jobs. If Qwen3-ASR/Voxtral enter the stack, vLLM unifies ASR+LLM serving (SMR already runs LLMs). TensorRT-LLM only if throughput becomes the binding constraint.
5. **Add an ITN stage.** There is no inverse-text-normalization anywhere (grep-confirmed) — numbers/dates/units/dosages are whatever the engine emits raw. For clinical text ("81 mg", "twice daily", "BP 120/80"), a light ITN pass (e.g. NeMo text-processing WFST grammars) materially improves the record and downstream NER. Corti's production chain treats units/notation normalization as a first-class stage and reports 98.5% formatted-entity recall on dosages/units.
6. **Batch-path hygiene while in there** (details §7.1): fix the double-VAD when diarization is enabled; reconcile the actor-vs-broker retry/backoff config; bring `batch_service.py`/`preprocessing.py`/loaders back under coverage.

---

## 5. Cross-cutting: model selection, biasing, hallucination, scribe patterns

### 5.1 Clinical safety ≠ WER (the number that should drive model choice)

The **Omi Health Medical STT Benchmark** (PriMock57, v4 2026-04-08, [omi.health/research/stt-benchmark](https://omi.health/research/stt-benchmark)) ranks by *Medical* WER and reports a separate **Drug M-WER**. Load-bearing rows for a self-hosted stack:

| Model | M-WER | Drug M-WER | License | Note |
|---|---|---|---|---|
| VibeVoice-ASR 9B | 3.16% | 5.6% | Open (verify) | best open, large |
| **Qwen3-ASR-1.7B** | **4.40%** | 8.6% | Apache-2.0 | **best small open clinical**, streaming, vLLM |
| Parakeet-TDT-1.1B | 5.20% | **15.5%** | CC-BY-4.0 | fast, weak on drugs |
| Parakeet-TDT-0.6b-v3 | — | **~22%** | CC-BY-4.0 | fastest, weakest on drugs |
| Whisper (hosted whisper-1) | 5.62% | — | — | ≈large-v2, not local large-v3 — don't read as Whisper's ceiling |

Commercial ceilings for benchmarking only (not adoption — PHI): Gemini 3 Pro 2.65% M-WER, Deepgram Nova-3 Medical 4.53% (vs its own "3.45%" marketing). **Takeaway:** pick the streaming/batch engine on *clinical* metrics; if a fast transducer wins on speed, pair it with biasing (§5.2) + a clinical-accuracy pass for medication-bearing audio. All public WER numbers (LibriSpeech/FLEURS/Open-ASR) under-predict real consultation error — validate every shortlist on de-identified in-house audio via TASK-470.

### 5.2 Contextual biasing — the cheapest clinical accuracy win (not in the track)

A per-tenant **drug/formulary/condition/procedure term list**, no retraining:
- **NeMo word-boosting** for Parakeet/Canary (CTC word-spotter / shallow-fusion phrase boosting; [docs.nvidia.com word_boosting](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/asr_customization/word_boosting.html)); see also TurboBias ([arXiv:2508.07014](https://arxiv.org/abs/2508.07014)).
- **Whisper/faster-whisper** `initial_prompt` (only the last 224 tokens are consumed — keep compact, rare terms last) and the `hotwords` param.
- **IBM Granite-4.1 "Plus"** native keyword-biased ASR.

The service has `initial_prompt` plumbing but it resolves a *single SYSTEM PromptTemplate* ([core/initial_prompt.py](../../../apps/stt/src/stt/core/initial_prompt.py)) — and NeMo/Azure engines warn-and-ignore it entirely, so the future transducer path currently has **no biasing hook at all**. Extend to a **per-tenant term list** surfaced from pipeline/tenant config, mapped per engine (prompt for Whisper, word-boosting for NeMo). Corti reports keyterm biasing cut missed terms ~50%; synthetic TTS audio for rare drug names is their companion trick for training-free coverage. This is the highest accuracy-per-effort item in the whole assessment and complements (doesn't compete with) the harness's clinical NER track.

### 5.3 Anti-hallucination — keep hardening the Whisper paths

Whisper-class models fabricate fluent text on silence/music and enter repetition loops — clinically dangerous (documented: invented medications; long aphasic/elderly pauses are a top trigger). The batch path already has the right defaults (§4.3). Additions worth tracking: **Calm-Whisper** ([arXiv:2505.12969](https://arxiv.org/abs/2505.12969) — masks the few decoder heads responsible) and **SAE activation steering** ([arXiv:2606.07473](https://arxiv.org/abs/2606.07473), cuts non-speech hallucination 86.9%→27.3% for large-v3, no retraining). If LLM post-editing is ever added, constrain it (N-best selection, span preservation) — free-generating correctors are themselves a hallucination source. The structural fix remains §4.1: **prefer a transducer** (Canary generates ~16.7% fewer hallucinated characters than Whisper-large-v3; Parakeet-v3 "almost never hallucinates on silence").

### 5.4 Ambient-scribe production patterns (architecture references)

From the vendor research (Microsoft Dragon Copilot, Abridge, Nabla, Suki, Corti), the patterns worth borrowing — most map onto existing HOPE surfaces:

1. **Two-tier ASR** — fast streaming pass for the live UI + heavier post-stop pass for the record. Confirmed industry norm ("live streaming + heavier post-visit pass"); whether incumbents literally re-transcribe with a *larger ASR* is inferred, not confirmed — Corti argues against batch-Whisper rescoring in favor of streaming transducers end-to-end. HOPE's realtime/batch split already mirrors this; §4 is the tier-2 investment.
2. **A verification/fact-check model between draft and clinician** — the single most-copied non-obvious move. Abridge: separate detection model (50k+ examples) catching **97%** of confabulations vs GPT-4o's 82%, running first-draft→final-draft. Nabla: notes split into **atomic facts**, each LLM-checked against transcript+context, "only facts with definitive proof kept." Maps onto the existing groundedness track (TASK-479/481) at the harness layer, not the ASR layer.
3. **Provenance / "Linked Evidence"** — every note span maps back to its transcript+audio segment; cheap if char-offset alignment is retained from ASR through summarization, and it's what makes clinician review fast and defensible.
4. **Orchestrated ASR chain, not one model** — acoustic → LM/context refinement → punctuation/formatting/units → domain normalization → structured output, with keyterm biasing injected (Corti's public stages; §4.5/§5.2 are exactly the missing HOPE stages).
5. **Diarization via clinician voice enrollment + explicit speaker-role tags feeding the LLM** — the practical fix everyone lands on (§3.5; the preseed already exists).
6. **Sobriety check:** a Mayo/OHSU simulated-encounter study found transcripts averaged **13.9 errors, 19.5% propagating into notes, mean note error rate 26.3%** ([mcpdigitalhealth.org, Oct 2025](https://www.mcpdigitalhealth.org/article/S2949-7612(25)00099-9/fulltext)) — mandatory clinician review is non-negotiable regardless of stack; the only independent RCT (NEJM AI, 238 physicians) showed modest time-in-note wins (Nabla −9.5%). Design for review-speed, not autonomy.

---

## 6. Evaluation methodology (validates & extends TASK-470/487)

The scorecard (`medical_wer`, `keyterm_recall`, `keyphrase_recall`, `partial_revision_rate`, `commit_latency`, `seq_gap_count`, `audio_coverage_ratio`) is a strong foundation. Gaps to close:

- **Baselines are on `say`-TTS audio** — unrealistically clean; TASK-487 already flags this. Capture a real de-identified clinical read to set honest floors/ceilings (`streaming_thresholds.json` quality baselines are currently null-gated with a bootstrap ceiling of 0.35).
- **Add Drug M-WER and MEDCON concept-F1**, not just aggregate `medical_wer` — drug/medication recall is the clinical safety signal (§5.1). MEDCON (UMLS concept F1 via QuickUMLS, semantic groups Anatomy/Drugs/Disorders/…, [ACI-Bench arXiv:2306.02022](https://arxiv.org/abs/2306.02022)) is the standard note-level concept-fidelity metric and dovetails with the harness.
- **Add diarization metrics** for TASK-475: **cpWER / tcpWER** (concatenated min-permutation WER, via `meeteval` — [github.com/fgnt/meeteval](https://github.com/fgnt/meeteval)), not just DER — cpWER is what tells you the note attributed symptoms to the right speaker.
- **Pin and bug-check the text normalizer.** Omi Health found normalizer bugs "quietly inflating WER by 2–3% across every model in the industry"; the Whisper normalizer is opinionated and can *hide* errors ([arXiv:2409.02449](https://arxiv.org/abs/2409.02449)). Version it; report jiwer + a fixed normalizer. (The scorecard's synonym folding — "milligrams"→"mg" — is good; it needs the same pin-and-version treatment.)
- **Add streaming-stability metrics as first-class:** **UPWR** (Unstable Partial Word Ratio — fraction of already-emitted partial words later changed; [arXiv:2006.01416](https://arxiv.org/pdf/2006.01416)) and partial latency **PR50/PR90**, alongside `partial_revision_rate` — and resolve TASK-487 by measuring revision on the **committed region only** (the tentative tail is *designed* to revise; measuring full-caption churn double-counts the feature as a defect). A low-WER stream that flickers is unusable at the bedside.
- **Latency measurement hygiene:** recapture `commit_latency` on a non-contended host (TASK-487's point — 7.4 s is 3 processes on one box). The two-cursor method (audio-submitted minus audio-processed-from-interims, interims only — [Deepgram methodology](https://developers.deepgram.com/docs/measuring-streaming-latency)) is worth adopting for the harness; the Redis-entry-ID trick already gives clock-skew immunity.
- **Wire the same metrics into production** (§7.1): RTF + first-partial + finalization-lag as Prometheus series, not just offline harness artifacts.

Targets to adopt (streaming-latency literature): first-partial <300 ms, committed-text lag <1 s, final formatted turn <2 s, note draft <30 s.

---

## 7. Config & correctness debt inventory (silent quality/perf/reliability cost)

Code-verified; grouped by layer. Items marked ◆ are load-bearing for quality/latency, ◇ are hygiene.

### 7.1 stt service

1. ◆ **VAD threshold defaults diverge across 4 layers** — global `Settings` (0.5 / min_silence 500 ms), per-pipeline `VadConfig` (0.6 / 100 ms), profile fallback (500 ms), `StreamingPreprocessor.__init__` (700 ms legacy) ([settings.py:199-210](../../../apps/stt/src/stt/core/config/settings.py), [pipeline/dto.py:447-457](../../../apps/stt/src/stt/pipeline/dto.py), [preprocessor.py:122-124](../../../apps/stt/src/stt/streaming/preprocessor.py)). Consolidate to one documented source of truth.
2. ◆ **Inert perf knobs:** `inference_pool_size` (no `ProcessPoolExecutor` exists — ASR runs on `asyncio.to_thread`), `streaming_multi_gpu_strategy` / `ExecutionProfile.multi_gpu_strategy` (never read — GPU placement is hardcoded per profile), and two settings read via `getattr(settings, 'streaming_inference_queue_maxsize'|'streaming_inference_stop_timeout_s', default)` for fields **not declared on `Settings`** — permanently hardcoded despite looking configurable.
3. ◆ **No lock around concurrent `model.generate()`** across `asyncio.to_thread` workers sharing one cached model — thread-safety is delegated entirely to transformers/CT2/NeMo, while punctuation (`CadenceFastModel._infer_lock`) and embeddings (`EmbeddingService._lock`) explicitly serialize. Verify the libs are safe under concurrency or add a per-model semaphore.
4. ◆ **Decode-kwargs quadruplication** — `InferenceConfig`→generate-kwargs mapping is re-implemented in 4 places (batch transformers, batch Optimum, streaming transformers, faster-whisper adapter); any decoding-semantics change must land in all four ([batch_service.py:1848-2225](../../../apps/stt/src/stt/transcription/batch_service.py), [session_manager.py:1159-1210](../../../apps/stt/src/stt/streaming/session_manager.py), [faster_whisper_asr.py:200-231](../../../apps/stt/src/stt/streaming/faster_whisper_asr.py)).
5. ◇ **No `env_prefix` on `Settings`** — every env var is a bare uppercased field name (`VAD_THRESHOLD`, not `STT_*`), unlike every other HOPE Python service; collision risk in shared env/ConfigMaps.
6. ◇ `ModelCache` memory ceiling is a hardcoded **10 GB** (`max_memory_mb=10000`, [cache.py:82](../../../apps/stt/src/stt/models/cache.py)) — not settings-driven, unlike max_models/TTL.
7. ◇ **Dramatiq retry config conflict** — actor decorator (`min_backoff=10000/max_backoff=300000`) vs broker `Retries` middleware (`60000/900000`); one is dead/misleading ([transcribe_file.py:31-32](../../../apps/stt/src/stt/transcription/workers/transcribe_file.py), [broker.py:65-70](../../../apps/stt/src/stt/core/messaging/broker.py)).
8. ◇ **VAD can run twice per batch job** when diarization is enabled but VAD wasn't applied upstream ([batch_service.py:429-454](../../../apps/stt/src/stt/transcription/batch_service.py)).
9. ◇ **`worker.py` never calls `_configure_torch_threading()`** — the Dramatiq process's CPU threading relies on ambient env, asymmetric with FastAPI startup.
10. ◆ **Observability:** 7 dead Prometheus series; streaming ASR/VAD outside the TASK-386 metric contract; **no RTF/WER in production** (§2.5, §6).
11. ◇ **Coverage gate excludes the biggest files** — `batch_service.py` (2 672 lines), `preprocessing.py`, all three ML loaders are in the coverage `omit` list, so `--cov-fail-under=80` never sees the batch core.
12. ◇ Diarization doc/code mismatches: README says 512-dim embeddings, code expects **256** (`EXPECTED_EMBEDDING_DIM`); README's documented default model differs from `settings.diarization_hf_model_id`; runtime dimension is never asserted at extraction time. Plus the preseed tenant-scope TODO (§3.5).
13. ◇ Streaming per-session buffer caps at 500 MB with **silent** frame drops past the cap (one-time warning, no client backpressure signal); crash-recovered sessions start VAD cold (documented deferred TODO).
14. ◇ Makefile documents platform test targets (`test-unit-{cpu,gpu,apple}` …) that don't exist; three overlapping test runners with no canonical entry point.
15. ◇ Artifact path schemes differ structurally between batch (`{y}/{m}/{d}/…`) and streaming (`{y}/{m}/streams/…`).
16. ◇ Punctuation: per-pipeline `enabled: true` silently overruled by the global kill-switch (one-time process log); revisit when the `transformers` pin moves.

### 7.2 Browser SDK & packages

1. ◆ **VAD model + ONNX-WASM fetched from public CDN** (`cdn.jsdelivr.net`) on every session by default ([constants.ts:40-49](../../../packages/vad/src/constants.ts)) — a self-hosting posture violation, a cold-start network round-trip, and the exact version-drift class the package's own header records as a past silent-failure incident. Bundle/self-host these (the header itself says "prefer self-hosting in production").
2. ◆ **`packages/room`'s constraint builder is dead code on the real capture path** — `useArcaAudio` calls `getUserMedia({audio:true})` directly, so nothing explicitly requests/declines EC/NS/AGC or `channelCount` (§3.2). Route capture through `buildAudioConstraints()` (or replicate it) and make the NS decision explicit.
3. ◆ **RNNoise's 48 kHz assumption is never enforced.** `AudioContextManager.acquire({requireSampleRate})` exists precisely for this and **no production caller opts in**; at a non-48 kHz context RNNoise silently runs 480-sample frames over the wrong wall-clock window ([AudioContextManager.ts:14-19,189-204](../../../packages/room/src/core/AudioContextManager.ts), [NoiseFilterProcessor.ts](../../../packages/noise-filter/src/processors/NoiseFilterProcessor.ts)). One-line guard if RNNoise survives the §3.2 A/B.
4. ◆ **Dead documented client audio queue** (`maxQueueSize=200`) + silent disconnect-window drops — §3.7 item 1.
5. ◇ **Two divergent VAD negative-threshold formulas** — `positive − 0.15` (pipeline construction) vs `positive × 0.7` (live sensitivity update; its comment claims to mirror the former) — coincide only at sensitivity 0.5 ([TranscriptionPipeline.ts:632-634](../../../packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts), [PluginManager.ts:664-666](../../../packages/agentic-sdk-v2/src/core/PluginManager.ts)). Production `redemptionMs` 500 ms vs package default 1400 ms vs a third dead 300 ms default in `DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG` — intentional? document or reconcile.
6. ◇ **Legacy WS protocol island still shipped and reachable** — `WebSocketClient.ts` + `MessageHandler.ts` + `RemoteSTTProvider` (`@deprecated` TASK-298 D-4, own reconnect/keep-alive/framing, duplicated float32→int16) is the fallback whenever `pipelineId` is absent. Schedule removal or make the fallback explicit-opt-in.
7. ◇ Dead public API vs shipped path: `packages/vad`'s `FrameAccumulator`/`AudioRingBuffer`/`resampler.ts` are exported but unused by the realtime path (real framing/resampling lives inside `vad-web`); `WhisperWorkerEngine`/`STTWorkerCrashError` are *not* exported from the `@arcaai/stt` barrel even though the worker engine is what actually runs (consumers can't `instanceof` its crash error).
8. ◇ Local Whisper `AudioBufferManager` grows unboundedly if inference is slower than capture (500 ms drain poll, single-flight, no cap); the 10 s RNNoise worklet-init timeout can add dead time before fallback; `STTProcessor` builds two `MediaStreamAudioSourceNode`s per attach.
9. ◇ `AudioMixer` performs no sample-rate/channel reconciliation between primary/secondary mics (relevant to §3.5's stereo-capture decision).
10. ◇ Worklet constants duplicated in triplicate (RNNoise frame size in processor + worklet + blob-string mirror) — documented, but a known sync hazard.

### 7.3 Gateway (apps/api + applications bridge)

1. ◆ **No WS heartbeat/idle timeout** — §3.7 item 3.
2. ◆ **Egress partial drops invisible** (finals get `gap` markers, partials don't) — §3.7 item 2.
3. ◇ **TASK-457 I2** seq-reset on fresh `SessionInfo` — deferred with spec, unfiled — §3.7 item 4.
4. ◇ Gateway hardcodes `enc='pcm_s16le'` on every XADD regardless of client message (fine today — the client only sends Int16 — but a silent trap if the client ever negotiates f32/Opus).
5. ◇ Internal callbacks authenticate via the generic API-key extractor (`X-Internal-Service-Key` among `apikey`/`api-key`/`x-api-key`), not the documented `X-Service-Token` shared-secret convention — align docs or implementation.

### 7.4 Docs & process drift

1. `docs/architecture/overview.md` §3.5 and `traceability-matrix.md` rows 13 still describe speaker embeddings as **Qdrant-backed**; the Qdrant store was removed by design (TASK-330) — diarization is in-memory/session-scoped with PostgreSQL voice-profile cross-session identity. Fix the architecture docs (stt's README already documents the removal correctly).
2. `SttWebSocketClient`'s header docblock omits the `resume`/`resumed`/`resume_failed` frames that exist in code; `StreamingSessionManager`'s doc describes an `{type:'auth'}` first-frame pattern that is never sent (auth is the ticket query param).
3. The prior research docs (`whisper-onnx-*.md`) remain valid for Whisper batch tuning but should gain a pointer here for the model-choice dimension they don't cover.

---

## 8. Best-practice scorecard — mid-2026 SOTA vs HOPE today

| Practice (mid-2026 SOTA) | HOPE today | Verdict | Action |
|---|---|---|---|
| Streaming engine: native cache-aware transducer (or AlignAtt if Whisper-bound) | Chunked faster-whisper full-buffer re-decode + opt-in LA-2 | 🔴 Behind | TASK-472 + §3.1 |
| Commit policy active on the default clinician path | LA-2 on 2 seeds only; default `production` pipeline unconfirmed | 🟠 Gap | TASK-485 trace |
| Partial/final contract: revisable tail + immutable commit + stability + endpoint reason/confidence | `stable_chars` + `finalizing/closed` statuses; no stability, no endpoint metadata | 🟡 Partial | §3.8 |
| Endpointing: VAD trigger + semantic EOU, adaptive [min,max] window, clinical-long bias | Fixed 500 ms silence + 25 s force cap | 🔴 Behind | TASK-473 + §3.4 |
| VAD trigger layer current | Silero v5 both sides (v6 out since 2025-08) | 🟡 Minor | §3.4 bump |
| Diarization: streaming Sortformer (licensed) / stereo channel split; cpWER-evaluated | Embedding-clustering built but disabled; surfacing broken; DER-only thinking | 🔴 Behind | TASK-474/475 + §3.5 |
| No spectral denoising on the ASR feed (evidence-backed) | **Double NS on by default** (browser + RNNoise), batch denoises too | 🔴 Anti-pattern | §3.2 A/B |
| Capture: AudioWorklet, anti-aliased resample, explicit constraints | Worklets ✅, Kaiser-sinc ✅, constraints bypassed (`audio:true`) | 🟡 Partial | §7.2.2 |
| Transport: PCM16/WSS + seq + ticket auth + resume | ✅ All present (TASK-457/461) | 🟢 Good | — |
| Never silently lose audio: replay buffer on reconnect, throttle/degrade over drop | Disconnect audio dropped (doc'd queue doesn't exist); drops are at least *visible* (454/464) | 🟡 Partial | §3.7 |
| Session hygiene: WS heartbeat/idle reap | None at app level (server reaper only, 300 s) | 🟠 Gap | §3.7 |
| Batch engine: transducer + int8 + clinical second pass | Whisper-only (well-tuned) | 🔴 Behind | §4 |
| Contextual biasing: per-tenant keyterm lists | Single SYSTEM `initial_prompt`; nothing for NeMo | 🔴 Missing | §5.2 |
| Anti-hallucination: VAD-first + decoder triage + `condition_on_prev=False` | ✅ All present on Whisper paths | 🟢 Good | keep; §5.3 |
| Word timestamps: native model output preferred | Whisper offsets/DTW; NeMo native plumbed | 🟢 OK | rides §4 |
| ITN/formatting stage (units, dosages) | None | 🔴 Missing | §4.5 |
| Punctuation stage healthy | Globally off (transformers-pin conflict); Whisper self-punctuates | 🟡 Watch | §7.1.16 |
| Eval: M-WER + Drug-WER + concept-F1 + cpWER + UPWR + pinned normalizer + real audio | medical_wer/keyterm/keyphrase/revision/latency on say-TTS | 🟡 Partial | §6 |
| Production observability: RTF, latency, per-model streaming metrics | Streaming outside metric contract; 7 dead series; no RTF/WER | 🟠 Gap | §7.1.10 |
| Self-host all runtime assets | Browser VAD/ONNX WASM from public CDN | 🟠 Violation | §7.2.1 |
| Draft-verification model + provenance before clinician (scribe pattern) | Groundedness track planned at harness layer (TASK-479/481) | 🟡 Planned | §5.4 |

---

## 9. Prioritized roadmap

| # | Recommendation | Impact | Effort | Ties to | Self-hosted |
|---|---|---|---|---|---|
| 1 | A/B and (likely) disable NS on the ASR path (RNNoise + browser NS, streaming **and** batch) | High (WER) | XS | new · TASK-470 | ✅ |
| 2 | Graceful-drain stop handshake + real-client tail-final e2e test | High (live UX) | S | TASK-484/461 | ✅ |
| 3 | Per-tenant keyterm/drug biasing (NeMo boosting / initial_prompt list, per-engine mapping) | High (clinical) | S–M | new · harness NER | ✅ |
| 4 | Batch offline → Parakeet-TDT/Canary int8 + clinical-accuracy 2nd pass (Qwen3-ASR-1.7B) | High (record) | M–L | new (batch) | ✅ |
| 5 | Extend scorecard: Drug M-WER, MEDCON F1, cpWER, UPWR/committed-region revision, normalizer pin, real-audio baselines, clean-host latency | High (trust) | M | TASK-470/487 | ✅ |
| 6 | TASK-472 pilot: add `parakeet-unified-en-0.6b`; benchmark vs WhisperLiveKit; resolve TASK-485 by promoting the winner (LA-2 → fallback) | High (latency) | L | TASK-472/485 | ✅ |
| 7 | Semantic endpointing: smart-turn v3.2 / Kyutai VAD, clinical-long window + hold state | Med–High | M | TASK-473 | ✅ |
| 8 | Streaming diarization: Sortformer v2 (CC-BY-4.0) + prefer stereo (decide the AudioMixer fork); fix surfacing contract + preseed tenant scope | Med | M–L | TASK-474/475 | ✅ |
| 9 | Thread `stableChars`/`speakerLabel` through `normalizeTranscript` + partial segments so the tentative-tail (and speaker) render is reachable | Med (UX) | S | TASK-471/464 | ✅ |
| 10 | Transport reliability: client PCM ring-buffer + replay-on-resume (implement or delete the doc'd queue), egress-partial gap signal, WS heartbeat/idle reap, file+fix TASK-457 I2 | Med (loss/visibility) | M | TASK-457/461 | ✅ |
| 11 | Config/observability cleanup sweep (§7: VAD default unification, inert knobs, decode-kwargs dedup, dead metrics, RTF, CDN self-host, coverage, doc drift) | Med (hygiene) | M | §7 | ✅ |
| 12 | Add ITN stage for clinical numbers/dosages/units | Med | S–M | new (batch) | ✅ |
| 13 | Wire-contract v2: `endpoint{reason,confidence}`, `hold`, `stability` (additive) | Med | S–M | TASK-473/471 | ✅ |
| 14 | Bump Silero VAD v5→v6 (server + client assets) | Low–Med | S | TASK-473 | ✅ |

**Sequencing suggestion:** items 1–3 are days-scale, high-leverage, and independent of the big model bets — do them first and re-baseline the scorecard on real audio (item 5's capture) so 4/6/7/8 are measured honestly. Items 4 and 6 are the two structural model moves (batch transducer, streaming transducer) and can proceed in parallel since they target different pools; both want item 3's biasing hook and item 5's Drug-M-WER gate in place to pass the clinical bar. Items 10/13 slot naturally into whichever ticket next touches the WS surface.

---

## Appendix A — research fleet & coverage map

| Agent | Scope | Feeds |
|---|---|---|
| stt service internals map | engines/loaders/cache, streaming session manager, batch service, VAD/diarization/punctuation, settings, tests, metrics | §2.2–2.5, §7.1 |
| Browser+gateway audio path map (+5 children) | capture/RNNoise, Silero VAD wiring, local Whisper + legacy WS, SDK pipeline/store/UI, gateway WS + Redis bridge, ticket deep-dives 454/461/464/470/471 | §2.1, §3.3/3.6/3.7, §7.2–7.3 |
| STT docs & SOTA-ticket review | architecture docs vs code, 16-ticket track (451–487), prior ai-ml research docs, already-decided register | §1, §7.4 |
| Realtime streaming research (+5 children: diarization, endpointing, native models, ambient scribes, browser transport) | whisper_streaming/SimulStreaming/WhisperLiveKit, cache-aware transducers, Silero v6/TEN, smart-turn/LiveKit/Kyutai EOU, vendor partial/final contracts, Sortformer/pyannote, PCM/Opus/WebCodecs/WebRTC, NS-hurts-ASR evidence, scribe architectures | §3, §5.4, §6 |
| SOTA ASR engines/quality research | Open ASR Leaderboard v4, Omi Medical STT, model/license matrix, biasing, anti-hallucination, timestamps, batch serving, eval methodology | §4, §5.1–5.3, §6 |

**Every agent's full report is captured in-repo** under [`stt-realtime-batch-sota-2026-07/`](stt-realtime-batch-sota-2026-07/README.md) — 01–07 external deep research, 10–19 codebase maps/spot checks — with per-file provenance headers. Raw session transcripts and fetched source PDFs remain under `~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/277917b1-c566-4111-99f3-e2cfa2fea765/{subagents,tool-results}/`.

## Appendix B — source pointers

- Model/quality (mid-2026): HF Open ASR Leaderboard v4 ([arXiv:2510.06961](https://arxiv.org/abs/2510.06961)); Omi Health Medical STT ([omi.health](https://omi.health/research/stt-benchmark), 2026-04-08); HF cards for Parakeet-unified/TDT-v3, Nemotron-speech/3.5, Canary-1b-v2/Qwen, Granite-4.1, Qwen3-ASR, Voxtral-Realtime, Kyutai STT, distil-large-v3.5, Omnilingual; anti-hallucination arXiv:2505.12969, 2606.07473, 2501.11378; denoising-hurts arXiv:2512.17562, 2603.04710, 2111.11606.
- Streaming practice: whisper_streaming/SimulStreaming (UFAL, arXiv:2307.14743/2305.11408); WhisperLiveKit; NVIDIA cache-aware FastConformer + Streaming Sortformer v2 (arXiv:2507.18446) + multitalker-parakeet; TDT (arXiv:2304.06795); smart-turn v3.2 / LiveKit turn detector / Kyutai semantic VAD / TEN; vendor partial/final + endpointing contracts (Deepgram Nova/Flux, AssemblyAI U-S/U3-Pro, Google V2, Azure semantic segmentation, OpenAI Realtime); latency metrics UPWR/PR50 (arXiv:2006.01416, Deepgram methodology); browser transport (COOP/COEP, WebCodecs baseline status, Opus-vs-PCM arXiv:2106.07994).
- Ambient scribes: Abridge confabulation whitepaper (2025-08-19), Nabla Whisper/atomic-facts posts, Corti pipeline posts (2025-07/10), Dragon Copilot launch (2025-03-03); independent: NEJM AI RCT (AIoa2501000), Mayo/OHSU simulated-encounter error study (Oct 2025).
- Eval tooling: jiwer, meeteval (cpWER/tcpWER), OpenWER (arXiv:2606.21237), normalizer pitfalls (arXiv:2409.02449), MEDCON/ACI-Bench (arXiv:2306.02022).
- Prior internal research: `whisper-onnx-apple-silicon-best-practices.md`, `whisper-onnx-optimum-inference-optimization-2025.md` (batch/offline Whisper tuning; this doc extends them to model choice + realtime).
