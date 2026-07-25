> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `a8dcc12352049f581` (top-level). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# STT Technical Map — Performance/Quality Review

All paths relative to `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/stt/` unless stated. Line numbers correspond to file content read during this analysis.

## 0. Dependencies (pyproject.toml) — ASR/ML-relevant, verbatim

Core (always installed): `fastapi>=0.133.0`, `dramatiq[redis]>=2.0.0`, `redis[hiredis]>=5.2.0,<9.0` (pyproject.toml:43-46), `numpy>=2.0.0`, `azure-cognitiveservices-speech>=1.47.0`, `cadence-punctuation>=1.1.0` (pyproject.toml:74-80).

`[ml]` extra (pyproject.toml:98-136): `torch>=2.8.0,<2.9.0`, `torchaudio>=2.8.0,<2.9.0` (hard-pinned for pyannote.audio 4.x compat), `accelerate>=1.12.0`, `safetensors>=0.7.0`, `huggingface_hub>=0.28.0`, `soundfile>=0.13.1`, `librosa>=0.11.0`, `onnxruntime>=1.23.0`, `pyrnnoise>=0.4.0`, `pyannote.audio>=3.3.0`, `speechbrain>=1.0.0`, `omegaconf>=2.3.0`, `torchcodec>=0.6.0,<0.8.0`, `optimum==2.1.0`, `transformers==5.5.4` (exact pin), `torchvision>=0.23.0,<0.24.0`, `faster-whisper==1.2.1` (exact pin). `nemo` extra: `nemo_toolkit[asr]>=2.7.2,<3.0.0`. `ml-gpu` extra swaps `onnxruntime-gpu>=1.23.0` + `flash-attn>=2.8.3`.

README.md:140-144 records the actually-installed versions on Apple Silicon: `torch 2.8.0`, `torchaudio 2.8.0`, `pyannote.audio 4.0.3`, `azure-speech 1.48.1`, `onnxruntime 1.23.2` (providers `CoreMLExecutionProvider, AzureExecutionProvider, CPUExecutionProvider`). `transformers==5.5.4` is load-bearing: `cadence-punctuation 1.1.0`'s wrapper cannot load under it (settings.py:601-609).

---

## 1. ASR Engines

**Six engine families**, dispatched by `AiModelFormat` enum (pipeline/dto.py:29-43): `SAFETENSOR`/`PYTORCH` (HF Transformers), `ONNX`/`ONNX_OPTIMUM` (ONNX Runtime / HF Optimum), `NEMO` (NVIDIA Parakeet), `CTRANSLATE2` (legacy alias, loads via transformers path), `FASTER_WHISPER` (CTranslate2 via faster-whisper), `AZURE_SPEECH` (cloud). A 7th path, multimodal LLM (Gemma-4-family), is auto-detected within the HF loader, not a distinct enum value.

**Loaders** (`models/`):
- `huggingface_loader.py` — `HuggingFaceLoader._load_by_task` tries `WhisperForConditionalGeneration` → `AutoModelForSpeechSeq2Seq` → `AutoModelForCTC` in that order (huggingface_loader.py:198-233). Auto-detects multimodal LLMs by inspecting `AutoConfig.architectures` for `"MultimodalLM"` or `model_type=="gemma4"` + `Gemma4ForConditionalGeneration` + `audio_config` present (`_is_multimodal_lm`, huggingface_loader.py:342-381), loading via `AutoModelForMultimodalLM` instead.
- `onnx_loader.py` — routes to `_load_with_optimum` (HF Optimum `ORTModelForSpeechSeq2Seq`) when format is `ONNX_OPTIMUM`, or when format is `ONNX` + `is_asr` + source contains `"onnx-community"`/`"whisper"` (onnx_loader.py:230-264); else raw `onnxruntime.InferenceSession`. Supports quantization variants `fp16/int8/uint8/q4/q4f16/bnb4/quantized` (pipeline/dto.py:58-66) by selecting `encoder_model_{suffix}.onnx`/`decoder_model_merged_{suffix}.onnx` filenames (onnx_loader.py:394-429).
- `nemo_loader.py` — `nemo.collections.asr.models.ASRModel.from_pretrained`/`.restore_from`; detects word-timestamp capability via class name membership in `{EncDecRNNTBPEModel, EncDecHybridRNNTCTCBPEModel, EncDecRNNTModel}` or substring match on `RNNT/TDT/Hybrid` (nemo_loader.py:16-20,60-64).
- `faster_whisper_loader.py` — lazy-imports `faster_whisper.WhisperModel` + prebuilds a `BatchedInferencePipeline` (faster_whisper_loader.py:40,72-80); resolves CTranslate2 device (`resolve_ct2_device`, streaming/faster_whisper_asr.py:79-99 — MPS falls back to CPU, no MPS backend in CT2) and compute_type (`resolve_ct2_compute_type`, coerces fp16-family to fp32/int8 on CPU, streaming/faster_whisper_asr.py:102-122).
- `azure_speech_loader.py` — no model download; wraps a reusable `SpeechConfig` (`OutputFormat.Detailed`, `request_word_level_timestamps()`, azure_speech_loader.py:116-120); `estimate_memory` returns 0.

**Model selection/registry**: pipeline YAML (`pipeline/yaml_parser.py`) defines `models.asr` (required) + optional `vad`/`denoise`/`embedding`/`segmentation`, each either a **DB slug** (`AsrPipeline`/`AiModel` Postgres tables via `pipeline/config_reader.py`) or an **inline definition** (`hf_model_id` + `engine`, no DB row needed — `pipeline/dto.py:244-308 InlineModelDef`). Per-request resolution: streaming session creation calls `SessionManager._load_pipeline_config(pipeline_id, tenant_id=tenant_id)` (streaming/session_manager.py:791-815); batch Dramatiq job calls `pipeline_reader.get_pipeline(pipeline_id)` (transcription/workers/transcribe_file.py:163). **Tenant scoping**: `PipelineConfigReader.get_pipeline` filters `AsrPipelineRead.tenant_id == tenant_id` when supplied (pipeline/config_reader.py:70-71) — documented as TASK-298 D-3 defense-in-depth on top of the API gateway's own check (streaming/session_manager.py:797-801).

**Caching**: single process-wide `ModelCache` singleton (models/cache.py:63-116, 416-421), LRU + TTL (`model_cache_max_models`=5, `model_cache_ttl_seconds`=3600, settings.py:132-139), plus a hardcoded `max_memory_mb=10000` (10GB) default NOT settings-driven (cache.py:82). Single-flight loading via `asyncio.Future` in-flight dict keyed by slug (cache.py:90-93,157-216) — concurrent `get_or_load()` callers for the same slug await one shared load. Models are **shared across ALL sessions/tenants/jobs on a process** — no per-tenant model isolation.

**Device**: `BaseModelLoader._get_device("auto")` → `core/platform.get_device_string()` → CUDA→MPS→CPU detection (platform.py:66-86, base_loader.py:89-138). `ExecutionProfile` (streaming/execution_profile.py) hardware-tiers into 5 profiles: A100/H100 (≥40GB VRAM: `asr_device="cuda:0"`, `asr_compute_type="float16"`, `asr_max_batch_size=32`, `max_concurrent_streams=100`), multi-GPU (`asr_max_batch_size=8`, `embedding_device="cuda:1"`, `max_concurrent_streams=40`), single RTX-A2000-class (`asr_max_batch_size=8`, `embedding_device="cpu"`, `max_concurrent_streams=20`), Apple Silicon (`asr_device="mps"`, streams scaled 5/10/15 by unified-memory ≥32/≥48GB, `denoise_enabled_default=True`), CPU-only (`asr_compute_type="float32"`, `denoise_enabled_default=False` — "too slow on CPU for real-time", execution_profile.py:142-291). Env overrides via `streaming_max_concurrent`/`streaming_max_batch_size`/`streaming_batch_wait_ms`/`streaming_embedding_device`/`streaming_multi_gpu_strategy` only apply when non-zero/non-"auto" (execution_profile.py:361-395).

**Compute type / quantization**: HF loader forces fp32 on CPU when fp16/bf16 requested (`_get_torch_dtype`, base_loader.py:140-193) and also does an in-place runtime cast (`model = model.float()`) if a cached model's dtype is unsafe for the current device at inference time (batch_service.py:1810-1829; session_manager.py:1116-1128). ONNX Optimum disables `ORT_ENABLE_ALL`→uses `ORT_ENABLE_BASIC` graph opt for `fp16` quantization on CPU (`SimplifiedLayerNormFusion` lacks fp16 CPU kernels — onnx_loader.py:481-489).

**Warm-up**: `main.py:81-139 _preload_pipeline_models()` reads `settings.preload_pipelines` (comma-separated slugs, default empty) at FastAPI startup and loads all of a pipeline's models via `BatchTranscriptionService._load_models` before first request. VAD + diarization-embedding services are always eagerly initialized at both FastAPI (main.py:156-174) and Dramatiq-worker (worker.py:72-91) startup, regardless of preload list. Punctuation model loads conditionally on `PUNCTUATION_ENABLED` (main.py:179-193). `cadence_fast.load_model()` runs one warm-up inference (`wrapped.punctuate([_WARMUP_TEXT])`, punctuation/cadence_fast.py:131-132) to absorb the ~1.6s cold first forward.

### Decoding parameters — `InferenceConfig` defaults (pipeline/dto.py:519-546)

```
batch_size=16, compute_type="auto", device="auto", num_workers=4,
beam_size=5, temperature=[0.0,0.2,0.4,0.6,0.8,1.0] (Whisper fallback schedule),
compression_ratio_threshold=2.4, logprob_threshold=-1.0, no_speech_threshold=0.6,
no_repeat_ngram_size=3, language=None (auto-detect), code_switching=False,
initial_prompt=None (PromptTemplate UUID), prev_text_context_words=50,
enable_prev_text_context=True, condition_on_prev_tokens=False,
max_words_per_second=1000.0, max_segment_text_chars=1200,
hallucination_rms_threshold=0.01, hallucination_short_word_count=3,
streaming_english_gloss=False
```

These are re-derived into 3 **separately-implemented** `generate_kwargs`/`kwargs` dicts (kept manually in sync — flagged in §11):
1. Batch transformers path — `batch_service._run_transformers_inference`, generate_kwargs built at batch_service.py:1848-1900 (`num_beams`, `temperature`/`do_sample`, `compression_ratio_threshold`, `logprob_threshold`, `no_speech_threshold`, `condition_on_prev_tokens`, `no_repeat_ngram_size`, `prompt_ids` injected from `processor.get_prompt_ids`).
2. Batch Optimum-ONNX path — `batch_service._run_optimum_onnx_inference`, generate_kwargs at batch_service.py:2165-2225 (`return_timestamps=False` deliberately — "triggers Whisper's internal sequential long-form decoding which is extremely slow (~20x)"; timestamps instead extracted via `processor.decode(output_offsets=True)`, batch_service.py:2157-2161,2335-2348).
3. Streaming transformers path — `session_manager._make_asr_callable`, static_kwargs at session_manager.py:1159-1210 (built ONCE per session at pipeline-load time, not per-utterance).
4. `faster_whisper_asr.FasterWhisperAsrAdapter._build_decode_kwargs` (streaming/faster_whisper_asr.py:200-231) — maps to CTranslate2's own param names: `log_prob_threshold` (not `logprob_threshold`), `condition_on_previous_text` (bool, not `condition_on_prev_tokens`); explicitly sets `"vad_filter": False` (line 248) because VAD already ran upstream in the streaming preprocessor.

**word_timestamps**: transformers path via `processor.decode(outputs[0], skip_special_tokens=False, output_offsets=True)` (batch_service.py:1930-1941; session_manager.py:1283-1305); faster-whisper native `word_timestamps=True` (faster_whisper_asr.py:246); NeMo via `model.transcribe(timestamps=True)` (nemo_adapter.py:47-53); Azure via NBest JSON `Words[]` array, ticks→seconds `/10_000_000` (azure_asr.py:108-130; batch_service.py:1674-1710).

**language handling**: TASK-351 P2-1 semantics — a *configured* language is **always pinned** to the engine even when `code_switching=True` (language:null is what enables auto-LID + code-switching together) (session_manager.py:1164-1168, batch_service.py:2170-2181). Two validated language sets: `VALID_WHISPER_LANGUAGES` (~100 ISO codes, pipeline/dto.py:71-172) vs `VALID_PARAKEET_V3_LANGUAGES` (26 European languages only, pipeline/dto.py:188-192) — YAML validation hard-fails if a NeMo pipeline requests a Whisper-only code like `ml` (yaml_parser.py:327-343).

**initial_prompt**: UUID reference to a `SYSTEM`-category `PromptTemplate` row, resolved via `core/initial_prompt.get_initial_prompt()` (core/initial_prompt.py:14-38), concatenated with a rolling previous-text carry-forward (`compose_prompt`, core/initial_prompt.py:41-51; `prev_text_context_words` controls how many trailing words of prior text feed forward — separate mechanism from `condition_on_prev_tokens`, which is the model's own internal conditioning flag). NeMo and Azure explicitly warn+ignore `initial_prompt` (session_manager.py:1013-1018; batch_service.py:2555-2559 — "Parakeet does not accept text conditioning").

**condition_on_prev_tokens**: default `False`; only forwarded to `generate()`/faster-whisper when explicitly truthy (session_manager.py:1208-1210; batch_service.py:1896-1898,2214-2216).

---

## 2. Realtime Streaming Path (end-to-end)

**No WebSocket route lives inside stt.** `streaming/api/routes.py` exposes only internal HTTP session-lifecycle endpoints under `/internal/streaming` (routes.py:29): `POST /sessions` (create, routes.py:48-114), `GET /sessions/active` (routes.py:122-139), `GET /sessions/{id}` (routes.py:147-171), `DELETE /sessions/{id}` (idempotent, routes.py:179-197), `POST /sessions/{id}/end` (routes.py:205-228), `GET /availability` (routes.py:236-267, returns `available_slots`/`max_concurrent`/`current_active`, used for pre-flight capacity checks). These are called by the NestJS **API Gateway**, which owns the actual WebSocket connection to clients.

**Audio transport = Redis Streams** (streaming/redis_streams.py), keys per session:
- `stt:audio:{session_id}` — audio in, `XADD` by gateway, consumed via a **consumer group** (`AUDIO_CONSUMER_GROUP="stt-ingest"`, redis_streams.py:45) using `XREADGROUP`+`XACK` (TASK-457 C3-01/02) so a worker crash hands unacked entries to a recovering worker via `XAUTOCLAIM` (redis_streams.py:249-301).
- `stt:result:{session_id}` — results out, `XADD` by `ResultPublisher`, bounded by `MAXLEN ~ streaming_result_stream_maxlen` (default 10000, settings.py:476-485) so it never grows unbounded during a live session (TASK-457 C3-05).
- `stt:control:{session_id}` — control commands (`finalize`/`pause`/`resume`/`cancel`), `XREAD` (not a consumer group).
- `stt:session:{session_id}` — Redis Hash, Tier-1 durable session metadata (`SessionMetadata.to_redis_dict`, streaming/schemas.py:320-352).
- `stt:worker:{worker_id}` — per-worker heartbeat hash, TTL `streaming_worker_heartbeat_ttl_s`=30 (settings.py:462-465).

**Audio format** (`AudioFrame`, streaming/schemas.py:49-121): `seq` (monotonic int), `sr` (sample rate int, e.g. 16000), `enc` (`AudioEncoding`: `pcm_s16le` default or `pcm_f32le`), `ch` (channels, 1=mono), `data` (raw bytes, NOT base64), `final` (bool), `ts` (client epoch float). Working assumption throughout the preprocessor is 16-bit signed LE mono (`np.frombuffer(dtype=np.int16)`, preprocessor.py:284-286). Chunk cadence is gateway-controlled, not enforced by stt; the test/latency harness uses 80ms frames as a stand-in for "like the gateway path" (tests/integration/test_streaming_latency_harness.py:62).

**Segmentation** = VAD-based, via `StreamingPreprocessor` (streaming/preprocessor.py). Silero frame size 512 samples/32ms@16kHz or 256/16ms@8kHz (preprocessor.py:30-31). State machine: speech **onset** confirmed after `min_speech_duration_ms` frames above `threshold`, tolerating up to `_ONSET_HANGOVER_FRAMES=1` cumulative sub-threshold "dip" frame per onset attempt (C2-06/I-1 guard against periodic near-threshold noise, preprocessor.py:37-43,350-363); speech **offset** confirmed after `min_silence_duration_ms` consecutive below-threshold frames (preprocessor.py:404-410). Pre-speech context ring buffer prepended to the utterance (`pre_speech_context_ms`). **Force-emit** splits an utterance exceeding `max_utterance_duration_ms` (VadConfig `force_emit_after_ms`=25000ms default, pipeline/dto.py:455) either at the lowest-energy point in the last `force_emit_lookback_ms`(1500ms) window (`_find_best_split_point`, preprocessor.py:578-601) or, failing that, a hard `force_emit_overlap_ms`(500ms) overlap split (preprocessor.py:392-401). **Energy-based fallback VAD** activates when Silero is unloaded/errors (`_run_energy_fallback`, preprocessor.py:481-516): adaptive noise floor (0.95/0.05 EMA, capped `_FALLBACK_NOISE_FLOOR_MAX=0.015`), frozen during onset/cooldown to avoid a "detection death-spiral."

⚠️ **Threshold/silence-duration values differ by layer** — global `Settings.vad_threshold=0.5`/`vad_min_silence_duration_ms=500` (settings.py:199-210, used only by `SileroVADService.detect_speech`'s batch-API defaults) vs per-pipeline `VadConfig` defaults `threshold=0.6`/`min_silence_duration_ms=100` (pipeline/dto.py:447-452, YAML-parser default `min_silence_duration_ms=100` at yaml_parser.py:459 — note the parser's *own* hardcoded default there is 100 even though the dataclass says the same) vs the profile-driven fallback `ExecutionProfile.vad_silence_threshold_ms=500` used when a session has **no** pipeline VAD config at all (`session_manager._build_preprocessor_vad_kwargs`, session_manager.py:214-249) vs `StreamingPreprocessor.__init__`'s own constructor default `min_silence_duration_ms=700` (preprocessor.py:124, effectively legacy/superseded).

**Partial vs. final**: `AudioUtterance.is_final` flag. Partials fire every `streaming_partial_interval_s` (default **0.4s**, lowered from a legacy hardcoded 1.0s per TASK-471 A1, settings.py:520-532) once `_PARTIAL_MIN_AUDIO_S=0.5s` of buffered audio exists (preprocessor.py:518-576); partial decode is bounded to the trailing `streaming_partial_window_s`=8.0s (settings.py:511-519) — finals always decode the **full** buffer. `SessionManager._fire_partial` is skip-if-busy, not cancel-and-replace (session_manager.py:1567-1619), and waits on a per-session `asyncio.Event` gate (`_final_published_gates`) so partials for utterance N+1 don't race the still-publishing final for utterance N (2s timeout then publishes anyway).

**Commit policy / LocalAgreement-2** (streaming/commit_policy.py) — **opt-in** via pipeline YAML `streaming.commit_policy: local_agreement_2` (default `"none"`, `VALID_STREAMING_COMMIT_POLICIES`, pipeline/dto.py:576,589). `LocalAgreementPolicy.update()` (commit_policy.py:61-116) token-normalizes (lowercase, strip edge punctuation) the last two hypotheses, computes the longest agreeing prefix, and **freezes** it as `committed`; a later hypothesis that contradicts an already-committed word **rolls back** to the point of divergence rather than silently changing settled text (TASK-451 C2-01, commit_policy.py:100-108). Publishes `stable_chars` on the partial `SegmentResult` (streaming/schemas.py:166,192-193) so the client can distinguish stable vs. tentative tail.

**Endpointing / finalization** — `SessionStatus`: `ACTIVE → FINALIZING → CLOSED` (streaming/schemas.py:27-32). Four independent triggers all funnel through **one** `_finalize_session()` guarded by a per-session `asyncio.Lock` (`_finalize_locks`, TASK-456 C2-07, session_manager.py:2355-2373) so a race between them is a no-op on the second entrant (checked via `if session.status == SessionStatus.CLOSED: return`, session_manager.py:2382-2383): (a) `frame.final=True` on the last audio frame (session_manager.py:1721-1743), (b) control-stream `FINALIZE` (session_manager.py:1757-1782), (c) `end_session()` API call (session_manager.py:676-703), (d) the reaper (§ below). Sequence: `_flush_final_utterance` (drains the preprocessor's current buffer as one final `AudioUtterance`) → `_drain_inference_queue` (waits up to `streaming_inference_drain_timeout_s`=60.0s on `queue.join()`; **on timeout**, cancels the background consumer and transcribes remaining queued utterances **inline** so the tail is never silently dropped — C2-05, session_manager.py:1444-1519) → `_finalize_session_locked` (uploads raw/processed WAV + `transcript.json` + `metadata.json` to blob storage, persists the durable transcript to the gateway, `session.close()` sets `CLOSED` + Redis TTLs) → `remove_session` (stop consumers, release capacity slot).

**"finalizing" tail-final bug + Redis read-timeout (commit `0040fe3e`, 2026-07-10)** — per `MEMORY.md`, and confirmed by `git show`:
- **Root cause (P0)**: stt publishes `type:"status" status:"finalizing"` (session_manager.py:1765-1766,2394-2396) **before** the tail final is transcribed+published, then eventually `status:"closed"`. The actual bug was in the **API Gateway**, not stt: `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` `parseAndEmitResult` (lines 611-632) treated `"finalizing"` as **terminal**, closing the result-stream reader before the tail final arrived — every single-utterance streaming session produced an empty final transcript. Fixed by making the bridge terminate only on `closed`/`cancelled`.
- **Red herring (P2)**: persistent `"Timeout reading from :6380"` was an env-injected redis-py `socket_timeout` shorter than the 5000ms `BLOCK` window on `XREADGROUP`/`XREAD`. `IngestionConsumer._run` and `ControlListener._run` now catch `redis.exceptions.TimeoutError` and treat it as a benign empty-read — `continue`, **no** error log, **no** 1s backoff (redis_streams.py:328-340 and 549-557). The committed client itself sets **no** `socket_timeout` (only `health_check_interval=30` was added, streaming/_runtime.py:90-106) — this never actually starved audio; it "logs-and-recovers via the consumer-group cursor."

**Durable transcript persistence** — `_persist_streaming_transcript` (session_manager.py:2024-2115): up to `streaming_transcript_persist_max_attempts`=3 inline retries with scaling backoff `streaming_transcript_persist_backoff_s`=0.5s×attempt; **4xx except 408/425/429** dropped immediately as permanent (`_RETRYABLE_4XX`, session_manager.py:68); other failures land in a durable Redis Hash outbox (`TRANSCRIPT_OUTBOX_KEY="stt:transcript_outbox"`, session_manager.py:65) re-driven by the reaper with a soft lease (`OUTBOX_LEASE_TTL_S=90.0`, session_manager.py:74) up to `streaming_transcript_outbox_max_attempts`=10 before a loud `ERROR`-level drop (session_manager.py:2319-2327, "ALERT: durable transcript lost").

**Result publish schema** — `SegmentResult.to_redis_dict()` (streaming/schemas.py:170-194): `type`(`segment`/`gloss`), `text`, `start_time`, `end_time`, `is_final`(`0`/`1`), `inference_ms`, `utterance_index`, plus conditionally `speaker_id`/`speaker_confidence`, `english_text`, `word_timestamps_json`, `stable_chars`. Status/error entries reuse the same stream: `type:"status" status:"finalizing"|"closed"|"cancelled"`, `type:"error" message:...` (redis_streams.py:448-470).

**Timeouts**: `streaming_session_timeout_s`=60 (defined but the reaper actually keys off audio-**idle**, not this — see below), `streaming_audio_idle_timeout_s`=300 (5min, the *real* reap threshold per C2-02, settings.py:411-414, session_manager.py:2803-2807), `streaming_reaper_interval_s`=300 (scan cadence), `streaming_worker_heartbeat_s`=10/`_ttl_s`=30, `streaming_inference_drain_timeout_s`=60.0. **Two knobs read via `getattr(settings, ..., default)` are NOT actually declared on `Settings`** — `streaming_inference_queue_maxsize` (fallback 64, session_manager.py:144-146) and `streaming_inference_stop_timeout_s` (fallback 30.0, session_manager.py:150-152) — confirmed absent from `core/config/settings.py` by grep; they can never be set via env var.

**Commit policy for capacity**: `CapacityGuard` (streaming/capacity_guard.py) — `asyncio.Lock`-guarded in-memory `set[str]`, sized from `ExecutionProfile.max_concurrent_streams`. `try_acquire` is idempotent per session; on exhaustion returns `False` → API layer returns **HTTP 503 + `Retry-After: 5`** (streaming/api/routes.py:99-107). No cross-pod/cross-process capacity coordination — each FastAPI process tracks its own guard; `_reconcile_capacity_guard` self-heals leaked slots every heartbeat (10s) by diffing guard IDs against the live session map (session_manager.py:2992-3007).

---

## 3. Batch Path (end-to-end)

**Two entry points**, not one:
1. **Queued** — Dramatiq actor `transcribe_file` (transcription/workers/transcribe_file.py:28-96), `@dramatiq.actor(queue_name="stt_batch", max_retries=3, min_backoff=10000, max_backoff=300000, time_limit=settings.transcription_timeout_seconds*1000)` (default 600s→600000ms). Receives an **already-uploaded** `audio_uri`; downloads via `blob_service.download_audio(audio_uri, tenant_id=tenant_id)` (transcribe_file.py:172-174) — it does not accept raw bytes over the queue.
2. **Direct HTTP** — `POST /api/v1/transcribe` (transcription/api/routes.py:51-181), `multipart/form-data` upload capped at `_MAX_UPLOAD_BYTES=100MB` (routes.py:47-101), calls `BatchTranscriptionService.transcribe()` synchronously in-request (no Dramatiq, no `blob_service` param → processed-audio upload step is skipped for this path, batch_service.py:483-496).

**Broker/queue config** (`core/messaging/broker.py`) — `dramatiq.brokers.redis.RedisBroker(url, middleware=[])` built from scratch (broker.py:56), middleware added explicitly: `AgeLimit(max_age=86400000)` (24h), `TimeLimit(600000ms default)`, `Retries(max_retries=settings.worker_max_retries=3, min_backoff=60000, max_backoff=900000, retry_when=should_retry)` (broker.py:62-71 — **different** backoff values than the actor decorator's own `min_backoff=10000/max_backoff=300000`, a possible dead/superseded decorator config), `CurrentMessage()`, `Results(RedisBackend)`, custom `WorkerInitMiddleware` (broker.py:76). `should_retry` (broker.py:21-41) **never** retries `NON_RETRYABLE_EXCEPTIONS` (`ConfigurationError, AudioProcessingError, ValidationError, JobCancelledError, JobTerminalError, CloudASRAuthError`, core/exceptions.py:270-277); retries everything else up to `worker_max_retries`.

**Concurrency**: worker Docker image runs `dramatiq stt.worker --processes 2 --threads 4` (docker/Dockerfile:242) = 8 concurrent job slots per pod by default image config. `make run-worker` uses `--processes 1 --threads 4`. A **third** start path — `stt-worker` entrypoint / `python -m stt.worker` → `worker.main()` (worker.py:150-229) — builds its own `dramatiq.Worker(worker_threads=settings.worker_threads=4, worker_timeout=settings.worker_poll_timeout_ms=1000)` and calls `initialize_services()` directly; this is distinct from the raw `dramatiq` CLI's forked-process path, which relies on `WorkerInitMiddleware.after_process_boot`/`before_worker_shutdown` (core/messaging/worker_init_middleware.py:26-40) instead since forked children never run `worker.main()`.

**Pipeline stages** (`BatchTranscriptionService.transcribe`, transcription/batch_service.py:156-573):
1. `_load_models()` (batch_service.py:784-859) — ASR required, VAD/denoise optional, via `ModelCache`.
2. `AudioPreprocessor.process()` (transcription/preprocessing.py:50-146) — load bytes (`soundfile`, fallback `librosa`) → mono downmix → normalize (optional) → **denoise** (RNNoise @ 48kHz, upsample-once/downsample-once to avoid a 3-resample round-trip, preprocessing.py:1-29,435-529) → **single final resample** to `target_sample_rate` → VAD (pipeline model first via `_apply_vad_smart`, Silero singleton fallback, preprocessing.py:148-214).
3. Inline diarization setup if `spec.diarization.enabled and tenant_id` (batch_service.py:242-302).
4. ASR inference: **per-segment** (`_run_per_segment_inference`, batch_service.py:1031-1492 — sub-splits any VAD segment longer than `transcription_chunk_length_s`(15s default) into overlapping sliding-window chunks with stride `transcription_stride_length_s`("4,2" default) + `_dedup_overlap` de-duplication of repeated boundary words, batch_service.py:76-126) when VAD produced segments, else **full-audio** (`_run_inference`).
5. Diarization collection — either results already produced inline-per-chunk, or a separate `_run_diarization` pass over `raw_result.segments` (batch_service.py:592-716).
6. Upload **processed** audio to blob storage (Dramatiq path only) **before** postprocessing (batch_service.py:483-496) — uses `processed.get_vad_merged_wav_bytes()` (speech-only concatenation) when VAD applied, else the full processed WAV.
7. `_postprocess()` (batch_service.py:2577-2659) — punctuation (`punctuate_sync`, sync since already off-loop in a Dramatiq/worker thread), disfluency removal, lowercase, word/sentence timestamp extraction.
8. Timing metrics + `record_transcription()` Prometheus call.

**VAD-segment merge for efficiency**: `segment_merger.merge_vad_segments` (transcription/segment_merger.py) greedily merges adjacent speech segments when `gap ≤ segment_merge_gap_threshold_s`(2.0s default) **and** `merged_duration ≤ transcription_chunk_length_s`(15s) — docstring cites ~6s Whisper encoder overhead per `generate()` call regardless of audio length (TASK-017), reducing inference-call count.

**`transcribe_file.py` orchestration around `batch_service.transcribe()`**: marks job `PROCESSING` via gateway (`api_client.start_job`), publishes real-time SSE events via Redis Pub/Sub on channel `{pubsub_channel_prefix}{job_id}` = `stt:transcription:{job_id}` (`TranscriptionEventPublisher`, core/messaging/pubsub.py:34-36) — `status`/`progress`/`chunk`/`transcript`/`error` event types (pubsub.py:143-297); progress updates are **coalesced** to the latest value with an in-flight guard to avoid task pile-up on frequent callbacks (`_flush_progress_updates`, transcribe_file.py:189-226); periodic cancellation polling every ~10% progress (`_check_cancelled`, transcribe_file.py:136-146,209-211); uploads `transcript.json` + `metadata.json`; POSTs a `"TRANSCRIPT"` context item to the gateway if `consultation_id` present (`api_client.create_transcript`); `complete_job()`; final `publish_transcript` SSE event.

**Artifacts** (storage/path_resolver.py) — batch: `{y}/{m}/{d}/{consultations/{cid}|jobs}/{job_id}/{raw|processed}/{filename}`, `.../transcript.{json,txt,vtt,srt}`, `.../metadata.json` (day-level partitioning). Streaming uses a **structurally different** scheme: `{y}/{m}/streams/{session_id}/{raw|processed}/{chunk_NNNN.pcm|complete.wav}`, `.../transcript.json`, `.../metadata.json` (no day level, path_resolver.py:208-354).

**Error mapping** (transcribe_file.py:352-386): `NotFoundError`→`dramatiq.middleware.SkipMessage` (no retry); `JobCancelledError`→`SkipMessage`; `JobTerminalError`→silent return (duplicate-delivery guard); `TranscriptionError`→re-raised (broker retries per policy); generic `Exception`→re-raised + `fail_job()`.

**Near-real-time partials for batch too**: `chunk_callback` threads through `_run_per_segment_inference`/`_run_optimum_onnx_inference`, publishing `ChunkTranscriptionResult` via the same Pub/Sub `publish_chunk` used for streaming — batch jobs get incremental SSE output despite being a full-file pass.

---

## 4. VAD

**Silero VAD v5**, ONNX Runtime (vad/silero_service.py). Model source: HF `onnx-community/silero-vad`, file `onnx/model.onnx`, auto-downloaded via `huggingface_hub.hf_hub_download` into `huggingface_cache_dir`, or explicit `settings.vad_model_path` (silero_service.py:233-256). ONNX session config: **single-threaded** (`inter_op_num_threads=1`, `intra_op_num_threads=1` explicitly, unlike the general ONNX loader which auto-sizes), `CPUExecutionProvider` only, `ORT_ENABLE_ALL` (silero_service.py:61-70).

**Frame size**: 512 samples/32ms@16kHz, 256/16ms@8kHz (`_SILERO_FRAME_SIZE_16K/_8K`, silero_service.py:27-28). LSTM hidden state shape `(2,1,128)` float32 (`_SILERO_STATE_SHAPE`), per-session persisted in `VADSessionState.h_state` (vad/dto.py:47-77), reset per session and carried frame-to-frame during streaming.

**Thresholds** — three distinct "default" sources (flagged above in §2): global `Settings` (`vad_threshold=0.5`, `vad_min_speech_duration_ms=250`, `vad_min_silence_duration_ms=500`, `vad_speech_pad_ms=30`, `vad_sample_rate=16000`, settings.py:194-218 — used by `SileroVADService.detect_speech`'s batch API when no override passed); per-pipeline `VadConfig` (`threshold=0.6`, `min_speech_duration_ms=250` — aligned to Silero's own reference default per TASK-451 C2-06 comment, was previously 350ms, pipeline/dto.py:448-451 — `min_silence_duration_ms=100`, `padding_ms=30`, `pre_speech_context_ms=500`, `force_emit_after_ms=25000`, `force_emit_lookback_ms=1500`, `force_emit_overlap_ms=500`, pipeline/dto.py:443-457); `StreamingPreprocessor.__init__`'s own constructor defaults (`threshold=0.6`, `min_speech_duration_ms=250`, `min_silence_duration_ms=700`, preprocessor.py:122-124).

**Where applied**:
- **Streaming** — per-frame via `StreamingPreprocessor._run_vad` → `SileroVADService.process_chunk()` (streaming state machine, §2).
- **Batch** — `AudioPreprocessor._apply_vad_smart` (transcription/preprocessing.py:148-214): pipeline-configured VAD model tried first via `_apply_vad`, which duck-types a raw Silero ONNX session by input-name set `{"input","state","sr"}` (`_is_silero_onnx_session`, preprocessing.py:370-381) vs. a generic `AutoModelForAudioClassification`-style transformers model (chunked 1s windows, softmax); falls back to the Silero singleton's batch `detect_speech()` API.
- **Third invocation site**: `BatchTranscriptionService.transcribe()` re-runs `get_vad_service().detect_speech()` specifically when diarization is enabled but VAD wasn't applied upstream (batch_service.py:429-454) — VAD can run **twice** in the same batch job under that condition.

**Segment merging** (batch efficiency): `segment_merger.merge_vad_segments` (§3).

---

## 5. Diarization

**Speaker embedding extraction** — two swappable backends selected by HF model-ID prefix (`create_embedding_service`, diarization/embedding_service.py:228-243): `speechbrain/*` prefix → `SpeechBrainEmbeddingService` (`speechbrain.inference.speaker.EncoderClassifier.from_hparams`, MPS unsupported → forced CPU, speechbrain_embedding.py:23-53), else → `PyannoteEmbeddingService` (`pyannote.audio.Inference(model, window="whole")`, pyannote_embedding.py:23-55). **Default model**: `settings.diarization_hf_model_id = "pyannote/wespeaker-voxceleb-resnet34-LM"` (settings.py:221-224) — ⚠️ this **differs** from the value documented in the README's env-var table (`pyannote/embedding`, README.md:234). `pyannote.audio>=3.3.0` pinned (actual installed: 4.0.3, hard-pins `torch==2.8.0`/`torchaudio==2.8.0`, README.md:150-152).

**Embedding dimension** — `voice_profile/extraction_service.py:22 EXPECTED_EMBEDDING_DIM=256` (must match the pgvector column in `core."UserVoiceProfile".embedding`); `diarization/dto.py:11` docstring likewise says "256-dimensional vector". ⚠️ **README.md:326** project-structure comment says "Pyannote embedding extraction (**512-dim**)" — a doc/code mismatch. Actual runtime dimension depends entirely on the configured HF model's output and is not asserted anywhere at extraction time.

**Segmentation refinement** (on-demand only) — `diarization/segmentation_service.py`, model `pyannote/segmentation-3.0`, lazy-loaded (`Model.from_pretrained`), dominant-speaker-per-frame turn-boundary extraction at ~16ms frames (`_extract_turn_boundaries`, segmentation_service.py:110-146). Invoked only from `SpeakerIdentifier.identify()` when confidence falls in the **ambiguous zone** `[low_threshold, high_threshold)` **and** `enable_segmentation_refinement=True` (default `True`) **and** recursion depth is 0 (speaker_identifier.py:86-127) — splits the segment and re-identifies each sub-segment at depth=1 (no further nesting).

**Tracking = fully in-memory, session-scoped, no external vector store.** README.md:17-28 explicitly documents the **removed** Qdrant collection `stt_speaker_embeddings` as legacy/unused — "the absence of a `core/vectorstore` module is intentional, not a regression." `SpeakerTracker` (diarization/speaker_tracker.py): per-speaker rolling window (`collections.deque(maxlen=max_embeddings_per_speaker=8)`) of L2-normalized embeddings; **hybrid centroid+max-similarity** scoring, `score = 0.7·cos(query,centroid) + 0.3·max(cos(query,e) for e in window)` (`centroid_weight=0.7` default, speaker_tracker.py:19-57). `max_speakers=2` default (`DiarizationConfig`, pipeline/dto.py:478 — a two-speaker doctor+patient consult assumption); `register()` returns `None` at capacity, caller falls back to best-match.

**Identification** (`SpeakerIdentifier.identify`, diarization/speaker_identifier.py:36-131) — 4-case decision: (1) no speakers registered → register as new; (2) `confidence ≥ high_threshold`(0.7 default) → confident match, updates reference embedding if `confidence ≥ min_update_confidence`(0.8); (3) `confidence < low_threshold`(0.4 default) → confident new-speaker registration; (4) ambiguous zone → optional segmentation-refinement sub-split, else falls back to best-match anyway.

**Online vs offline**: identical classes reused; streaming builds **one `SpeakerTracker`+`SpeakerIdentifier` per WebSocket session** (session_manager.py:498-535, embedding extracted **in parallel with ASR** via `asyncio.gather` per final utterance, capped to first 5s of audio, streaming/inference.py:315-318,673-708); batch builds **one per job** (either inline-per-chunk, batch_service.py:242-302, or a separate full pass, batch_service.py:592-716). No persistence beyond a single session/job lifetime.

**Cross-session identity ("voice profile" preseed)** — `diarization/preseed.py:preseed_speaker()`: resolves the consultation's doctor (or explicit `user_id`) via raw SQL against `core."Consultation"`/`"UserProfile"` (`core/database/voice_profile_model.py:get_user_identity`/`get_user_display_name`), fetches the doctor's **active** 256-dim pgvector embedding from `core."UserVoiceProfile"` (raw `text()` SQL since pgvector isn't SQLAlchemy-mapped, voice_profile_model.py:36-81), then `tracker.register(vec, speaker_id=display_name)` — the first-recognized speaker is labeled with the doctor's real name instead of `"Speaker 1"`. **Known gap**: `tenant_id` filtering on `UserVoiceProfile` is written but **commented out** — `TODO(TASK-296 M-6 / master roadmap P2-5)` — because the table lacks a `tenantId` column (voice_profile_model.py:46-49,60-65,95-96,107-112).

**Merge with transcript**: streaming attaches `speaker_id`/`speaker_confidence` directly on `SegmentResult` in `process_utterance` Step 3 (streaming/inference.py:413-433); batch uses a **best-time-overlap** heuristic (`_attach_speaker_metadata_to_segments`, batch_service.py:728-782) matching each ASR segment's `[start,end]` against diarized segments by largest overlap duration.

---

## 6. Punctuation / Postprocessing

**Punctuation — global kill-switch, default OFF** (`settings.punctuation_enabled=False`, settings.py:595-610): production Whisper pipelines already emit punctuation/casing, and `cadence-punctuation 1.1.0`'s wrapper cannot load under pinned `transformers==5.5.4` (tied-weights finalizer raises `AttributeError: Sequential has no attribute 'weight'`). Per-pipeline YAML `postprocessing.punctuation.enabled: true` is **overruled** by the global flag when it's off — `punctuation/service.py:_warn_suppressed_once` logs a one-time process-level warning then silently passes text through (service.py:28-46,166-168,184-186,203-205).

Two model paths:
- **Legacy wrapper** — `from cadence import PunctuationModel` (`"Cadence"`=1B or `"Cadence-Fast"`=270M), `d_type="bfloat16"`, `sliding_window=True`, `max_length=punctuation_max_length`(300 default) (service.py:59-94). A manual patch forces `inner.config.use_bidirectional_attention = True` because the shipped `config.json` defaults to causal masking, breaking token-classification (service.py:84-91).
- **Direct-load `cadence-fast`** (exact string match only, `MODEL_NAME="cadence-fast"`, cadence_fast.py:25-30) — bypasses the broken wrapper entirely: `AutoModel`/`AutoTokenizer.from_pretrained("ai4bharat/Cadence-Fast", revision="8971c5011e4fba5dcfbcac52744587d7da605534", trust_remote_code=True, tie_word_embeddings=False)` (`tie_word_embeddings=False` **required** under transformers 5.x, cadence_fast.py:114-124); manual `use_bidirectional_attention=True`; single-flight `threading.Lock`-serialized forward pass (`CadenceFastModel._infer_lock`, cadence_fast.py:40-55); one warm-up inference on load.

**Streaming-specific**: `cadence-fast` is **finals-only** — partials are never punctuated — and time-boxed via `asyncio.wait_for(..., timeout=streaming_punctuation_timeout_s=0.4s)` (settings.py:502-510); on timeout or any exception the **raw unpunctuated text is published** so the final's latency budget always holds (inference.py:820-855); fallback logged `WARNING` once per session then `DEBUG` thereafter (`_note_punctuation_fallback`, inference.py:857-869).

**Batch**: synchronous `punctuate_sync()` in the worker thread — punctuates the full text **and** every segment's text separately when `sentence_timestamps` is enabled (batch_service.py:2586-2611), `batch_size=8`.

**Output normalization** (`_normalize_punctuation_output`, inference.py:870-888): fixes Devanagari danda (U+0964/U+0965) mis-emitted on non-Devanagari-script text, collapses `....`→`...`, drops accidental double periods, strips trailing period after `!`/`?`.

**Disfluency removal** (postprocessing/disfluency.py) — pure regex, word-boundary-delimited filler list (`uh/um/ah/eh/er/hmm/huh/mhm/mm/oh` + `", you know"`/`", i mean"`/`", sort of"`/`", kind of"`/`", like"`), opt-in via `postprocessing.remove_disfluencies` (default `False`), applied identically in streaming (inference.py:374-378) and batch (batch_service.py:2613-2617).

**Inverse text normalization**: **no dedicated ITN module exists** anywhere in the codebase (grep found none) — numeric/date/unit formatting is whatever the underlying ASR engine natively emits (Whisper does some ITN-like normalization internally; NeMo/Azure output raw recognition text with no post-hoc normalization stage).

**Language coverage**: model-inherent (Cadence family targets Indic languages); no explicit language gating in `punctuation/service.py` — applied to whatever text arrives. Settings docstring recommends punctuation "only with a transformers/cadence combination known to load" — "e.g. an Indic ASR path whose engine does not self-punctuate" (settings.py:602-608).

**Adjacent optional stage — streaming English gloss**: `inference_config.streaming_english_gloss` (default `False`) — after a final publishes, fires a background `task="translate"` pass on the **same cached** ASR model (Whisper-family only; NeMo/Azure/multimodal LM explicitly excluded, session_manager.py:967-988) and publishes a follow-up `type:"gloss"` `SegmentResult` carrying `english_text`, bounded by `_GLOSS_TIMEOUT_S=15.0` (inference.py:474-527).

---

## 7. Configuration — `core/config/settings.py` (`Settings(BaseSettings)`)

⚠️ **No `env_prefix` is set on the `Settings` class** (settings.py:18-23, `model_config = SettingsConfigDict(env_file=..., case_sensitive=False, extra="ignore")` — no `env_prefix` key). Every setting below is therefore a **bare, uppercased field name** as its env var (e.g. `VAD_THRESHOLD`, `WORKER_THREADS`), **not** `STT_*`-prefixed — explicitly confirmed in the field's own docstring: *"The Settings class has NO env_prefix, so the env var is the bare STREAMING_PARTIAL_INTERVAL_S"* (settings.py:529-531).

Performance/quality-relevant settings, verbatim defaults:

| Field (env var) | Default | Line |
|---|---|---|
| `model_cache_max_models` | 5 | settings.py:132 |
| `model_cache_ttl_seconds` | 3600 | settings.py:136 |
| `vad_threshold` | 0.5 | settings.py:199 |
| `vad_min_speech_duration_ms` | 250 | settings.py:203 |
| `vad_min_silence_duration_ms` | 500 | settings.py:207 |
| `vad_speech_pad_ms` | 30 | settings.py:211 |
| `vad_sample_rate` | 16000 | settings.py:215 |
| `diarization_hf_model_id` | `pyannote/wespeaker-voxceleb-resnet34-LM` | settings.py:221 |
| `diarization_similarity_threshold` | 0.7 | settings.py:225 |
| `diarization_device` | `auto` | settings.py:229 |
| `voice_profile_min_similarity` | 0.6 | settings.py:235 |
| `worker_threads` | 4 | settings.py:248 |
| `worker_concurrency` | 4 (alias) | settings.py:252 |
| `worker_poll_timeout_ms` | 1000 | settings.py:256 |
| `worker_max_retries` | 3 | settings.py:260 |
| `inference_pool_size` | 0 (auto) — **unused, see §11** | settings.py:265 |
| `onnx_num_threads` | 0 (auto) | settings.py:271 |
| `torch_num_threads` | 0 (auto) | settings.py:282 |
| `torch_num_interop_threads` | 1 | settings.py:292 |
| `preload_pipelines` | `""` | settings.py:303 |
| `transcription_timeout_seconds` | 600 | settings.py:315 |
| `transcription_chunk_length_s` | 15 | settings.py:319 |
| `transcription_stride_length_s` | `"4,2"` | settings.py:330 |
| `segment_merge_gap_threshold_s` | 2.0 | settings.py:341 |
| `streaming_max_concurrent` | 0 (auto from profile) | settings.py:356 |
| `streaming_max_batch_size` | 0 (auto) | settings.py:363 |
| `streaming_batch_wait_ms` | 0 (auto) | settings.py:370 |
| `streaming_embedding_device` | `auto` | settings.py:377 |
| `streaming_multi_gpu_strategy` | `auto` — **unused, see §11** | settings.py:384 |
| `streaming_session_persist_interval_s` | 5.0 | settings.py:392 |
| `streaming_snapshot_interval_s` | 30.0 | settings.py:396 |
| `streaming_max_audio_buffer_bytes` | 500,000,000 (~87 min @16kHz mono) | settings.py:401 |
| `streaming_session_timeout_s` | 60 | settings.py:407 |
| `streaming_audio_idle_timeout_s` | 300 | settings.py:411 |
| `streaming_reaper_interval_s` | 300 | settings.py:415 |
| `streaming_transcript_persist_max_attempts` | 3 | settings.py:419 |
| `streaming_transcript_persist_backoff_s` | 0.5 | settings.py:430 |
| `streaming_transcript_outbox_max_attempts` | 10 | settings.py:438 |
| `streaming_inference_drain_timeout_s` | 60.0 | settings.py:449 |
| `streaming_worker_heartbeat_s` | 10 | settings.py:458 |
| `streaming_worker_heartbeat_ttl_s` | 30 | settings.py:462 |
| `streaming_audio_stream_maxlen` | 10000 | settings.py:466 |
| `streaming_result_stream_maxlen` | 10000 | settings.py:476 |
| `streaming_audio_trim_interval_s` | 30.0 | settings.py:486 |
| `streaming_extra_filler_patterns` | `""` | settings.py:494 |
| `streaming_punctuation_timeout_s` | 0.4 | settings.py:502 |
| `streaming_partial_window_s` | 8.0 | settings.py:511 |
| `streaming_partial_interval_s` | 0.4 | settings.py:520 |
| `streaming_result_stream_expire_s` | 3600 | settings.py:533 |
| `streaming_session_metadata_expire_s` | 86400 | settings.py:537 |
| `pubsub_channel_prefix` | `stt:transcription:` | settings.py:545 |
| `pubsub_enabled` | True | settings.py:553 |
| `otel_enabled` | False | settings.py:565 |
| `metrics_enabled` | True | settings.py:577 |
| `punctuation_enabled` | False | settings.py:595 |
| `punctuation_model_name` | `Cadence` | settings.py:611 |
| `punctuation_device` | `auto` | settings.py:622 |
| `punctuation_max_length` | 300 | settings.py:626 |

`preload_pipelines`, `model_cache_max_models`, and `worker_threads` are the main "throughput-shaping" knobs; language-support surfaces are encoded as static sets in `pipeline/dto.py` (`VALID_WHISPER_LANGUAGES`, `VALID_PARAKEET_V3_LANGUAGES`), not settings.

---

## 8. Concurrency / Performance Architecture

**Two orthogonal process domains**: (a) FastAPI/uvicorn (`main.py:301-308 uvicorn.run(..., reload=settings.debug)` — **no** `workers=` kwarg, single process/single event loop unless externally scaled) handles streaming sessions + `/transcribe` + internal endpoints; (b) separate Dramatiq worker process(es) for the `stt_batch` queue.

**Per-utterance streaming ASR** is offloaded via `asyncio.to_thread()` (default `ThreadPoolExecutor`, **not** the `ProcessPoolExecutor` implied by `inference_pool_size`) in every adapter branch of `session_manager._make_asr_callable` (`run_inference`/`run_nemo_inference`/`run_faster_whisper_inference`/`run_azure_inference`, session_manager.py:1028-1101,1212-1221). `settings.inference_pool_size` is **defined but never consumed** — grep-confirmed no `ProcessPoolExecutor(` construction anywhere in `src/` (only mentioned in `worker.py`'s module docstring as "optional" and in the settings description).

**Model sharing**: one `ModelCache` singleton **per process** (`get_model_cache()`, models/cache.py:416-421) — all concurrent sessions/jobs on that process share the same loaded model object. **No lock guards concurrent `model.generate()` calls** across `asyncio.to_thread` workers in either `session_manager._run_model`/`_make_asr_callable` or `batch_service._run_transformers_inference` — thread-safety is delegated entirely to the underlying library (transformers/onnxruntime/CTranslate2/NeMo). By contrast, the punctuation (`CadenceFastModel._infer_lock`) and embedding services (`EmbeddingService._lock`, embedding_service.py:66,188,205) **do** explicitly serialize their forward passes — an asymmetry worth noting.

**Batching**: `ExecutionProfile.asr_max_batch_size`/`batch_scheduler_max_wait_ms` exist but the **only** consumer is `FasterWhisperAsrAdapter`'s own `batch_size` kwarg into CTranslate2's `BatchedInferencePipeline.transcribe()` (streaming/faster_whisper_asr.py:254-257) — batching **one utterance's own audio** into internal sub-batches, not cross-request/cross-session dynamic batching. No general request-level batch scheduler exists.

**GPU placement**: `ExecutionProfile.multi_gpu_strategy` (`"replicate"/"split"/"none"`) is detected/stored (execution_profile.py `_build_multi_gpu_profile` sets `"split"`) but grep confirms it is **never read/branched on** outside its own dataclass definition — device placement is implicit per-profile string literals (`asr_device="cuda:0"`, `embedding_device="cuda:1"` for the multi-GPU profile) rather than dynamically driven by this field.

**Single-flight** applies to model **loading** only (`ModelCache.get_or_load`'s `asyncio.Future` in-flight dict, TASK-351 P0-3/H1, cache.py:157-216) — prevents duplicate concurrent loads of the same slug; does not batch/queue concurrent inference.

**Threading knobs**: `onnx_num_threads` (0=auto, intra_op only on the general ONNX loader — inter_op left at ORT default 1 since Whisper decode is sequential, onnx_loader.py:98-110; the VAD ONNX session is hardcoded single-threaded regardless). `torch_num_threads`/`torch_num_interop_threads` configured **once**, at FastAPI startup, via `_configure_torch_threading()` (main.py:27-79) — sets `OMP_NUM_THREADS`/`MKL_NUM_THREADS` env vars **before** any torch import if not already set by the environment (env wins over the setting), then `torch.set_num_threads()`. ⚠️ **`worker.py` never calls `_configure_torch_threading()`** — the Dramatiq worker process's CPU threading relies purely on ambient env vars / torch defaults, an asymmetry with the FastAPI process.

**Memory management**: `cleanup_accelerator_memory()` (models/base_loader.py:196-221) runs `gc.collect()` + `torch.cuda.empty_cache()`/`torch.mps.empty_cache()` after every model unload/eviction. `ModelCache.__init__`'s `max_memory_mb=10000` (10GB) default is a **hardcoded magic number**, not settings-driven (cache.py:82), unlike `max_models`/`ttl_seconds`. Streaming per-session audio buffer hard-capped at `streaming_max_audio_buffer_bytes`=500MB — new frames **silently dropped** past the cap with a one-time warning, not surfaced as backpressure to the client (session.py:200-210). A separate 30-second in-memory ring buffer (`max_ring_bytes = sample_rate*2*30`) is intended for crash-recovery audio replay but is a documented `TODO`/deferred feature (session_manager.py:2719-2721 — "VAD starts cold but stabilizes within 1-2s of new audio. Full audio replay for state warming is deferred").

---

## 9. Tests & Evaluation

**Counts** (find, this session): 91 unit test files (`tests/unit/` + subpackages `diarization/models/punctuation/streaming/transcription/voice_profile/`), 8 integration test files, 11 e2e test files.

**pytest config** (pyproject.toml:234-263): markers `unit/integration/e2e/slow/asyncio/cpu/gpu/cuda/mps/apple_silicon/ml`; `asyncio_mode="auto"`. **Coverage config excludes several high-complexity modules from measurement entirely** (`[tool.coverage.run] omit`, pyproject.toml:268-279): `models/huggingface_loader.py`, `models/nemo_loader.py`, `models/onnx_loader.py`, `transcription/batch_service.py` (2672 lines — the entire batch orchestration file), `transcription/preprocessing.py` — meaning `Makefile`'s `test-cov`/`ci-test-unit` `--cov-fail-under=80` gate never sees these files.

**E2E fixtures** (`tests/e2e/fixtures/`, Git-LFS-tracked per `git lfs ls-files`): `20260205_52886591770282917_ml.wav` (Malayalam, 16kHz mono, ~107s per test_streaming_latency_harness.py:59-60 comment), `20260206_52886591770369502_en.wav` (English), `2p_argument.mp3`. **New clinical set** `tests/e2e/fixtures/clinical/{cardiology_consult_01,discharge_summary_01,medication_review_01}.{gt.txt,keyterms.json}` — six ground-truth-transcript + curated-keyterm/keyphrase JSON files exist and were read in full (e.g. `cardiology_consult_01.gt.txt`: *"The patient presents with shortness of breath on exertion... Heart rate is 88 and regular... We are ordering an electrocardiogram and a troponin level... start aspirin 81 mg daily."*). The corresponding `.wav` audio is **deliberately not committed** (PHI-free posture) — `test_streaming_quality_scorecard.py:387-391` comment: *"Self-hosted scripted read not provided in-repo (PHI-free posture); the orchestrator's live step drops the matching WAV in."* ⚠️ **Discrepancy**: this session's initial git-status snapshot listed 3 `.wav` files under `tests/e2e/fixtures/clinical/` as untracked (`??`), but a fresh `find`/`ls -la` at analysis time shows **no** `.wav` files on disk in that directory — only the 6 `.gt.txt`/`.keyterms.json` files. Consistent with the documented PHI-free posture but inconsistent with the earlier untracked-file listing; not resolvable from repo state alone.

**Quality/WER harness** — `tests/integration/streaming_quality.py` (imported module: `medical_wer`, `keyterm_recall`, `keyphrase_recall`, `normalize_text`, `build_scorecard`, `regression_report`, `assert_no_regression`, `MEDICAL_SYNONYMS`) + `tests/integration/test_streaming_quality_scorecard.py` (TASK-470). Regression gate in `tests/integration/streaming_thresholds.json` (read in full): `medical_wer` ceiling=**0.35** (bootstrap; "SOTA short-form English medical WER is ~0.10-0.20"), `keyterm_recall` floor=**0.70**, `keyphrase_recall` floor=**0.70**, `partial_revision_rate` baseline=**0.0**/epsilon=0.02, `commit_latency_ms` p50_baseline=**6023.2**/p99_baseline=**7624.2**/epsilon_ratio=**0.15** (ratio-gated — "inference-dominated on the offline whisper-turbo host"), `seq_gap_count` max=**0** (zero-tolerance dropped-caption guardrail), `audio_coverage_ratio` baseline=**0.996**/epsilon=0.005. Self-skips off-stack; the pure-math self-check `test_quality_metric_functions_are_correct` is the CI-enforced unit gate. `medical_wer` uses a synonym-aware normalizer (e.g. `"milligrams"→"mg"` folds WER from 1/3 to 0.0, test at test_streaming_quality_scorecard.py:150-154). Commit `0040fe3e`'s message reports a **live verified run** post-fix: *"finals now commit on all three clinical clips — medical_wer 0.03-0.07, keyterm_recall 1.0, audio_coverage 0.994-0.997, 0 redis timeout errors."*

**Latency harness** — `tests/integration/test_streaming_latency_harness.py` (TASK-351 P2-5): replays a WAV (or a deterministic synthetic speech-like signal — voiced-harmonic-stack + syllabic AM envelope + consonant noise bursts, seeded, `synthesize_speech_like_audio`) into a **running** stt instance at realtime pace over the real Redis Streams wire protocol; derives `ttfw_ms`/`partial_cadence_ms`/`final_lag_ms` purely from Redis Stream entry-ID millisecond prefixes (clock-skew-immune by construction); SLA default **800ms** (`LATENCY_SLA_MS`); writes `./stt-latency-report.json`; only asserts session closed + ≥1 final (no hard SLA gate — informational, self-skips off-stack).

**Loss harness** — `tests/integration/test_streaming_loss_harness.py` (TASK-455, not read in full; imported by the quality scorecard for `compute_metrics`, `_run_one_session`, WS-gateway login helpers) — supplies the transport half (`commit_latency_ms`, `partial_revision`, `loss.seq.gap_count`, `audio_coverage_ratio`) of the combined scorecard.

**Test runners** — three overlapping mechanisms for the same suite: `Makefile` (`test`/`test-unit`/`test-integration`/`test-e2e`/`test-cov` — `--cov-fail-under=80`), `scripts/run-tests.sh` (bash, own coverage-threshold parsing via `awk`), and root `pnpm py:stt:test*` aliases per monorepo convention. ⚠️ README.md:398-417 and the Makefile's own `help` text (Makefile:48-52) reference `test-unit-cpu`/`test-unit-gpu`/`test-unit-apple`/`test-unit-all`/`test-integration-{cpu,gpu,apple}` targets that are **not actually defined** anywhere in the Makefile body — only the generic, non-platform-suffixed targets exist. `scripts/validate-build.sh` (Docker build smoke test) and `scripts/test_worker.py` exist but were not read in full.

---

## 10. Observability

**Prometheus**: `prometheus-fastapi-instrumentator` auto-instruments the FastAPI app + exposes `/metrics` (main.py:276-279, gated by `metrics_enabled=True`), giving generic HTTP metrics for free. A hand-written module `core/metrics.py` defines ~16 custom series; wiring status per series (confirmed by grep for `.inc(`/`.observe(`/`.set(` call sites):

| Metric | Wired? | Call site |
|---|---|---|
| `stt_transcription_total{pipeline,engine,status}` | ✅ | `record_transcription()` → batch_service.py:539,562 |
| `stt_transcription_latency_seconds{pipeline,engine}` | ✅ | same |
| `stt_transcription_errors_total{pipeline,error_type}` | ✅ | `record_transcription_error()` → batch_service.py:569 |
| `stt_audio_duration_seconds` | ✅ | same (`record_transcription`) |
| `stt_streaming_sessions_active` (Gauge) | ✅ | `streaming_session_started/ended()` → session_manager.py:595,751 |
| `stt_streaming_sessions_total{status}` | ✅ | same |
| `stt_streaming_inference_latency_seconds` | ✅ | `observe_streaming_inference()` → streaming/inference.py:558 |
| `stt_model_load_latency_seconds{model,engine}` | ❌ **DEAD** | no call site found |
| `stt_model_cache_hits_total` | ❌ **DEAD** | `ModelCache` tracks its own internal `_hits` int instead |
| `stt_model_cache_misses_total` | ❌ **DEAD** | same (internal `_misses`, exposed only via `/internal/cache/stats`) |
| `stt_vad_segments_total` | ❌ **DEAD** | no call site found |
| `stt_vad_processing_latency_seconds` | ❌ **DEAD** | no call site found |
| `stt_worker_jobs_in_progress` | ❌ **DEAD** | no call site found |
| `stt_worker_jobs_total{queue,status}` | ❌ **DEAD** | no call site found |
| `model_running_instances{service="stt",model}` (cross-service TASK-386 contract) | ✅ (2 sites only) | `track_model_inference()` → batch_service.py:337 (whole ASR call, labeled by `asr_model.model_slug`), vad/silero_service.py:129 (batch VAD pass, labeled literally `"silero-vad-v5"`) |
| `model_inference_latency_seconds{service="stt",model}` | ✅ (same 2 sites) | — |

⚠️ The `model_running_instances`/`model_inference_latency_seconds` cross-service contract metric (documented at `docs/implementation/TASK-386-Platform-Metrics-Backend/METRIC-CONTRACT.md`, not read) is **never used in the streaming path** — neither per-utterance streaming ASR calls nor streaming VAD frame processing wrap `track_model_inference()`; only the unlabeled `stt_streaming_inference_latency_seconds` histogram covers streaming ASR timing.

**structlog** (core/logging.py) — JSON-rendered via `structlog.stdlib.ProcessorFormatter`, bridges stdlib `logging` into the same pipeline/handler (logging.py:94-109) so mixed usage (`structlog.get_logger` in `streaming/*`, `core/*` vs. plain `logging.getLogger(__name__)` in `transcription/batch_service.py:63`, `preprocessing.py`, model loaders) still produces uniform JSON output, though the call-site API (bound-logger kwargs vs. `%`-style formatting) differs file-to-file. OTel trace/span IDs auto-injected into every log line when a span is active (`_add_otel_context`, logging.py:29-52 — `traceId`/`spanId` hex fields). Ad hoc `component=` tag convention in the streaming inference/preprocessor modules (grep-confirmed set: `"VAD"`, `"INFERENCE"`, `"SPEAKER_DIARIZATION"`, `"POSTPROCESSOR"`, `"NOISE_SUPPRESSION"`) — not a formal schema, just conventionally-named log calls at debug/info level (e.g. streaming/inference.py:311,321,369,415; streaming/preprocessor.py:339,626).

**Dotted event-name catalog**: only present in the transcript-durability subsystem (session_manager.py:2090-2354) — `stt.transcript.persist_permanent_drop`, `outbox_enqueued`, `outbox_enqueue_failed`, `outbox_corrupt_drop`, `outbox_drain_error`, `outbox_claim_failed`, `outbox_ack_delete_failed`, `outbox_drained`, `outbox_permanent_drop`, `outbox_exhausted_drop`, `outbox_retry_deferred`, `outbox_reenqueue_failed` — grep-able alert names (some messages explicitly say `"ALERT"`), used in exactly this one subsystem, not repo-wide.

**OpenTelemetry** (core/telemetry.py) — tracing (`TracerProvider`+`OTLPSpanExporter` gRPC+`BatchSpanProcessor`) + log export (`LoggerProvider`+`OTLPLogExporter` gRPC+`BatchLogRecordProcessor`), both gated by `otel_enabled=False` default. Auto-instruments FastAPI (`excluded_urls="docs,redoc,openapi.json,metrics,health,live,ready"`, telemetry.py:96-99) + HTTPX client. The Dramatiq worker gets **log export only** (`setup_telemetry_logs()` called standalone with service name suffixed `-worker`, worker.py:38-45) — no distributed tracing, since there's no FastAPI app to instrument spans on.

**No RTF (real-time-factor) or WER metric is computed/exposed in production code** — RTF is only implicitly derivable in Grafana from `stt_audio_duration_seconds` vs. `stt_transcription_latency_seconds` `_sum`s; WER exists **only** in the offline `streaming_quality.py` test harness and never runs as part of a live request.

---

## 11. Notable Weaknesses / TODOs / Tech Debt Observed in Code

Grep for `TODO|FIXME|HACK|XXX` across `src/` (5 hits, all `TODO`, no `FIXME`/`HACK`/`XXX`):
- `core/database/voice_profile_model.py:47,61-65,95-96,108-112` — `TODO(TASK-296 M-6 / master roadmap P2-5)`: `tenant_id` filter on `UserVoiceProfile` lookups is written but commented out (column doesn't exist yet); cross-tenant voice-profile query scoping is incomplete until that migration lands.
- `streaming/session_manager.py:2719-2721` — `TODO`: crash-recovered streaming sessions do not replay the last ~2s of audio to warm VAD/RNNoise state; documented as "deferred," VAD starts cold on recovery.

Additional issues found via targeted grep/reading (not `TODO`-tagged, but concrete):

3. **Seven dead Prometheus metrics** defined in `core/metrics.py` with zero `.inc()`/`.observe()`/`.set()` call sites anywhere else in `src/`: `stt_model_load_latency_seconds`, `stt_model_cache_hits_total`, `stt_model_cache_misses_total`, `stt_vad_segments_total`, `stt_vad_processing_latency_seconds`, `stt_worker_jobs_in_progress`, `stt_worker_jobs_total` (§10 table).
4. `settings.inference_pool_size` (core/config/settings.py:264-268) is documented ("ProcessPoolExecutor size for ML inference") but grep confirms **no `ProcessPoolExecutor(` construction exists anywhere** in `src/` — the setting is inert.
5. `ExecutionProfile.multi_gpu_strategy` (`"replicate"/"split"/"none"`) is detected and stored but grep confirms it is **never read outside its own definition/detection files** (`settings.py`, `execution_profile.py`) — GPU placement is implicitly hardcoded per hardware-profile string literals instead.
6. `session_manager.py:144-146,150-152` reads `streaming_inference_queue_maxsize` (fallback 64) and `streaming_inference_stop_timeout_s` (fallback 30.0) via `getattr(settings, ..., default)` — **neither field is declared on `Settings`** (grep-confirmed absent from `core/config/settings.py`); both are permanently hardcoded despite the `getattr` pattern implying configurability.
7. **No `env_prefix`** on the `Settings` class (settings.py:18-23) — every env var is a bare uppercased field name with no service namespacing, increasing collision risk in a shared `.env`/ConfigMap across the monorepo's other services.
8. **Embedding-dimension inconsistency**: README.md:326 says pyannote embeddings are "512-dim"; `diarization/dto.py:11` and `voice_profile/extraction_service.py:22 EXPECTED_EMBEDDING_DIM=256` say/assume 256-dim. Separately, `settings.diarization_hf_model_id` default (`pyannote/wespeaker-voxceleb-resnet34-LM`, settings.py:222) differs from the README's documented default (`pyannote/embedding`, README.md:234).
9. **No lock around concurrent ASR `model.generate()` calls** when multiple `asyncio.to_thread` workers share the same cached model instance (`session_manager._run_model`, `batch_service._run_transformers_inference`, etc.) — contrasts with the punctuation (`CadenceFastModel._infer_lock`) and embedding (`EmbeddingService._lock`) services, which explicitly serialize their forward passes.
10. `ModelCache.__init__`'s `max_memory_mb=10000` (10GB) default (models/cache.py:82) is a hardcoded magic number, unlike `max_models`/`ttl_seconds` which are `Settings`-driven — no env var can change the memory ceiling.
11. **Decode-kwargs duplication**: `batch_service._run_transformers_inference`, `batch_service._run_optimum_onnx_inference`, and `session_manager._make_asr_callable`'s HF-generate branch each independently re-implement the identical `InferenceConfig`→`generate_kwargs` mapping (beam_size→num_beams, temperature list/scalar handling, compression_ratio_threshold, logprob_threshold, no_speech_threshold, condition_on_prev_tokens, no_repeat_ngram_size) — any change to decoding semantics must be applied in 3 places to stay consistent.
12. **Artifact path-scheme asymmetry**: batch uses `{y}/{m}/{d}/...` (day-level partitioning, storage/path_resolver.py:34-112); streaming uses `{y}/{m}/streams/{session_id}/...` (no day level, path_resolver.py:208-354).
13. Dramatiq actor decorator's own `min_backoff=10000`/`max_backoff=300000` (transcription/workers/transcribe_file.py:31-32) differ from the broker `Retries` middleware's actually-effective `min_backoff=60000`/`max_backoff=900000` (core/messaging/broker.py:65-70) — the decorator-level values' precedence versus the middleware was not verified from code alone; worth flagging as a possibly-misleading/dead config.
14. **No inverse-text-normalization stage** anywhere in the postprocessing pipeline (grep found no ITN/number-normalization module).
15. README-documented `test-unit-{cpu,gpu,apple,all}`/`test-integration-{cpu,gpu,apple}` Make targets (README.md:398-417, Makefile help text:48-52) are **not actually defined** in the Makefile body — only generic `test`/`test-unit`/`test-integration`/`test-e2e`/`test-cov`/`test-all` exist.
16. Coverage `omit` list (pyproject.toml:268-279) excludes `batch_service.py` (2672 lines, the largest and most complex file in the service), `preprocessing.py`, and all three ML-loader modules from the `--cov-fail-under=80` gate entirely.
17. Three overlapping test-invocation mechanisms for the identical suite (`Makefile`, `scripts/run-tests.sh`, root `pnpm py:stt:test*`) with no single documented canonical entry point.
18. Clinical e2e fixture `.wav` files referenced as untracked in the session's initial git-status snapshot are **not present in the working tree** at analysis time (§9) — a factual discrepancy, consistent with but not fully explained by the tests' documented PHI-free posture.
19. Mixed logger APIs: `transcription/batch_service.py:63` uses plain stdlib `logging.getLogger(__name__)` while most other modules (`streaming/*`, `core/*`) use `structlog.get_logger(__name__)` — both funnel through the same root JSON formatter, but call-site ergonomics (bound kwargs vs. `%`-formatting) differ file-to-file.

---

### Key files index (for follow-up reading)

Streaming core: `streaming/session_manager.py` (3029 lines), `streaming/session.py`, `streaming/inference.py`, `streaming/preprocessor.py`, `streaming/redis_streams.py`, `streaming/commit_policy.py`, `streaming/capacity_guard.py`, `streaming/execution_profile.py`, `streaming/_runtime.py`, `streaming/faster_whisper_asr.py`, `streaming/azure_asr.py`, `streaming/denoiser.py`, `streaming/schemas.py`, `streaming/api/routes.py`, `streaming/api/schemas.py`.
Batch core: `transcription/batch_service.py` (2672 lines), `transcription/preprocessing.py`, `transcription/segment_merger.py`, `transcription/workers/transcribe_file.py`, `transcription/api/routes.py`, `transcription/dto.py`.
Models: `models/{base_loader,cache,huggingface_loader,onnx_loader,nemo_loader,nemo_adapter,faster_whisper_loader,azure_speech_loader,multimodal}.py`.
VAD/Diarization/Punctuation: `vad/{silero_service,session_manager,dto}.py`; `diarization/{embedding_service,pyannote_embedding,speechbrain_embedding,speaker_tracker,speaker_identifier,preseed,segmentation_service,dto}.py`; `punctuation/{service,cadence_fast}.py`; `postprocessing/disfluency.py`.
Pipeline/Config: `pipeline/{dto,config_reader,yaml_parser}.py`; `core/config/{settings,constants}.py`.
Infra: `core/{metrics,logging,telemetry,initial_prompt,platform,exceptions}.py`; `core/messaging/{broker,pubsub,worker_init_middleware}.py`; `core/storage/minio_client.py`; `core/database/{models,voice_profile_model}.py`; `core/api_client/gateway.py`; `storage/{blob_service,path_resolver}.py`; `main.py`; `worker.py`; `health/api/routes.py`.
Tests: `tests/integration/{test_streaming_latency_harness,test_streaming_loss_harness,test_streaming_quality_scorecard,streaming_quality,streaming_thresholds.json}`; `tests/e2e/fixtures/clinical/*`; `Makefile`; `scripts/{run-tests.sh,validate-build.sh}`.
Gateway (outside `apps/stt`, directly relevant to §2/§10): `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`.
