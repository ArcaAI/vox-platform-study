# TASK-014: STT High-Performance Streaming Architecture

- **Ticket**: TASK-014
- **Created**: 2026-02-09
- **Last Updated**: 2026-02-10
- **Status**: Pending

---

## Requirement Analysis

### Business Context

The stt service currently operates as a **batch-only** transcription engine — audio files are uploaded to MinIO, Dramatiq jobs process them, and results are stored. The system needs to support **real-time streaming** for 100+ concurrent audio streams with full audio processing (noise cancellation, VAD, segmentation, diarization, speaker recognition) while maintaining low latency (3-10 seconds).

### Use Cases

1. **Live medical consultation transcription** — doctors speak, live transcript appears with speaker labels
2. **Multi-party meeting transcription** — multiple speakers, real-time diarization
3. **Concurrent session handling** — up to 100 simultaneous audio streams on a single server

### Acceptance Criteria

- [ ] Support 100 concurrent audio streams on A100 80GB / H100
- [ ] End-to-end latency under 10 seconds (target 3-5s)
- [ ] Stateful noise cancellation (no boundary artifacts between chunks)
- [ ] End-of-utterance diarization with speaker recognition via Qdrant
- [ ] Auto-adaptive to different hardware (A100, Apple Silicon 48GB, RTX A2000 16GB, 2x RTX A2000, CPU 96-core)
- [ ] Batch pipeline (`transcribe_file`) remains untouched
- [ ] Model-agnostic — works with any ASR model configured via pipeline YAML
- [ ] Model hot-swap — load new ASR model without restart or dropping sessions
- [ ] Session persistence — Redis-backed state survives process restart with automatic recovery
- [ ] Audio recording — raw and processed audio saved to MinIO for audit/reprocessing
- [ ] Redis Stream TTL — best-practice retention (MAXLEN trimming + 1-hour EXPIRE after close)

---

## Current State Evaluation

### Existing Batch Pipeline (KEEP)

The current batch pipeline is well-designed and should not change:

- `transcribe_file` Dramatiq actor downloads audio from MinIO, runs preprocessing + inference + diarization
- `AudioPreprocessor` handles denoise, VAD, normalization on complete audio files
- `BatchTranscriptionService` supports chunked inference with overlap for long audio
- Pipeline config drives model selection, preprocessing, and diarization settings

### Current Streaming Attempt (REPLACE)

The existing `transcribe_stream` Dramatiq actor has fundamental issues:

| Problem | Detail |
|---------|--------|
| Audio format | Expects base64-encoded WAV chunks; WebSocket/WebRTC sends raw PCM |
| Stateless preprocessing | RNNoise re-instantiated per chunk — boundary artifacts |
| Per-chunk peak normalization | Inconsistent volume across stream |
| Dramatiq overhead | ~50-200ms per message hop, too slow for real-time |
| In-memory session state | `_sessions` dict doesn't survive across workers |
| Hardcoded assumptions | Duration assumes 16kHz mono 16-bit regardless of input |
| No GPU batching | Each chunk processed individually — wastes GPU capacity |
| No API Gateway integration | No WebSocket gateway for stt |

---

## Design Decisions (from Brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deployment | Single A100 80GB / H100, on-prem | Production target for 100 streams |
| Latency | 3-10 seconds | Medical consultation — few seconds lag acceptable |
| ASR Model | Flexible via pipeline config | Model-agnostic, swap via YAML |
| Client Transport | WebSocket primary, WebRTC future | Simpler; existing NestJS WebSocket patterns |
| Diarization Strategy | End-of-utterance | VAD silence detection triggers embedding + Qdrant lookup |
| Denoising | Optional per-pipeline, best-effort | Toggle via config, stateful when enabled |
| Gateway-to-STT Transport | Redis Streams | Decoupled, leverages existing Redis infra |
| GPU Batching | Dynamic (size + time limits) | Adapts to load — small batches when quiet, large at peak |
| Architecture | Monolithic streaming process | Single process, thread pool offloading for CPU work |
| CPU offloading | ThreadPoolExecutor | Denoise/VAD/embedding run on threads, event loop stays free |

---

## Architecture Overview

### Single-Process Design

```
┌─────────────────────────────────────────────────────────────────────┐
│                    stt Streaming Process                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              asyncio Event Loop (main thread)             │      │
│  │                                                           │      │
│  │  ┌─────────────┐   Redis Streams    ┌──────────────┐    │      │
│  │  │  Ingestion   │◄─────────────────►│   Response    │    │      │
│  │  │  Consumer    │  (per-session)     │   Publisher   │    │      │
│  │  └──────┬──────┘                    └──────▲───────┘    │      │
│  │         │                                  │            │      │
│  │         ▼                                  │            │      │
│  │  ┌─────────────┐                   ┌──────┴───────┐    │      │
│  │  │   Session    │                   │    Post-     │    │      │
│  │  │   Manager    │                   │  Processor   │    │      │
│  │  │  (100 slots) │                   └──────▲───────┘    │      │
│  │  └──────┬──────┘                          │            │      │
│  │         │ audio frames                     │ results    │      │
│  │         ▼                                  │            │      │
│  │  ┌──────────────────────────────────────────┐          │      │
│  │  │         Dynamic Batch Scheduler           │          │      │
│  │  │  (collects ready segments, forms batches)  │          │      │
│  │  └──────────────┬───────────────────────────┘          │      │
│  └─────────────────┼────────────────────────────────────────┘      │
│                    │                                                │
│  ┌─────────────────▼────────────────────────────────────────┐      │
│  │          ThreadPoolExecutor (CPU workers)                 │      │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │      │
│  │  │ RNNoise  │ │ Silero   │ │ Pyannote │ │ Normalize  │ │      │
│  │  │ Denoise  │ │ VAD      │ │ Embedding│ │ Resample   │ │      │
│  │  │ (stateful│ │ (stateful│ │          │ │            │ │      │
│  │  │ per-sess)│ │ per-sess)│ │          │ │            │ │      │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────┘ │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              GPU (A100 80GB / H100)                       │      │
│  │  ┌────────────────────────────────────────────┐          │      │
│  │  │     ASR Model (loaded once, shared)         │          │      │
│  │  │  Batched forward pass: up to 32 segments    │          │      │
│  │  └────────────────────────────────────────────┘          │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

**Three execution domains** within one process:

1. **asyncio event loop** (main thread) — coordination, Redis I/O, session management
2. **ThreadPoolExecutor** — CPU-bound work (denoise, VAD, embedding extraction)
3. **GPU** — batched ASR inference only

---

## Component Breakdown

### 1. Ingestion Consumer (asyncio)

Reads audio frames from Redis Streams. One asyncio task per active session.

**Responsibilities**:
- Listen on Redis Stream `stt:audio:{session_id}` for incoming frames
- Parse frame metadata (sequence number, sample rate, encoding, is_final flag)
- Push raw PCM bytes into the session's ring buffer
- On `is_final`, trigger session finalization

**Audio frame format** (written by API Gateway to Redis):

```python
{
    "seq": 42,                    # monotonic sequence number
    "sr": 16000,                  # sample rate
    "enc": "pcm_s16le",          # encoding (raw PCM 16-bit LE)
    "ch": 1,                      # channels (mono)
    "data": b"...",               # raw audio bytes (binary, NOT base64)
    "final": False,               # last chunk flag
    "ts": 1738800000.123,        # client timestamp
}
```

**Key difference from current design**: No base64 encoding. Redis Streams natively support binary fields, eliminating the 33% overhead of base64 that the current `transcribe_stream` actor uses.

**Backpressure**: If the session's buffer is full (e.g., >60 seconds of unprocessed audio), the consumer drops oldest frames and logs a warning.

---

### 2. Session Manager

Holds all per-stream state. Replaces the current in-memory `_sessions` dict with structured, lifecycle-managed objects.

```python
class StreamSession:
    session_id: str
    tenant_id: str
    pipeline_id: str
    consultation_id: str | None

    # Audio state
    ring_buffer: RingBuffer          # ~30s of raw PCM at 16kHz = ~960KB
    sample_rate: int
    total_samples_received: int

    # Preprocessing state (STATEFUL across chunks)
    rnnoise_state: RNNoise | None    # persists across frames, no boundary artifacts
    vad_state: SileroVADState        # running VAD with internal LSTM state

    # Segmentation
    current_utterance: bytearray     # accumulating current speech segment
    utterance_start_time: float
    silence_counter_ms: int          # how long since last speech frame

    # Results
    pending_segments: asyncio.Queue  # utterance-complete segments -> batch scheduler
    results: list[SegmentResult]     # completed transcriptions

    # Lifecycle
    created_at: datetime
    last_activity: datetime
    status: Literal["active", "finalizing", "closed"]
```

**Session lifecycle**:
1. **Created** — first frame arrives on new `session_id`
2. **Active** — receives frames, runs preprocessing, emits segments
3. **Finalizing** — `is_final` received, flush remaining audio, wait for pending inference
4. **Closed** — all results delivered, state cleaned up, session removed

**Memory budget**: ~1MB per session. 100 sessions = ~100MB.

---

### 3. Streaming Preprocessor (ThreadPoolExecutor)

**Stateful replacement** for the current `AudioPreprocessor`. Processes a continuous stream of PCM frames instead of complete audio files.

```python
class StreamingPreprocessor:
    """Stateful per-session audio preprocessor."""

    def __init__(self, config: PreprocessingConfig):
        self.config = config
        self._rnnoise: RNNoise | None = None     # stateful across calls
        self._vad_state: dict = {}                # Silero internal state
        self._normalize_ema: float = 0.0          # EMA for normalization

    def process_frame(self, pcm_frame: bytes, sr: int) -> PreprocessedFrame:
        """Process a single audio frame (10-50ms).

        Called from ThreadPoolExecutor — CPU-bound, never blocks event loop.
        Returns preprocessed samples + VAD decision for this frame.
        """
        samples = np.frombuffer(pcm_frame, dtype=np.int16).astype(np.float32) / 32767.0

        # 1. Normalize (EMA-based, stable across frames)
        if self.config.normalize:
            samples = self._normalize_streaming(samples)

        # 2. Denoise (RNNoise state carries over — no boundary artifacts)
        if self.config.denoise.enabled and self._rnnoise:
            samples = self._denoise_frame(samples)

        # 3. Resample if needed
        if sr != self.config.target_sample_rate:
            samples = self._resample(samples, sr, self.config.target_sample_rate)

        # 4. VAD decision (stateful — Silero LSTM state persists)
        is_speech, speech_prob = self._vad_frame(samples)

        return PreprocessedFrame(
            samples=samples,
            is_speech=is_speech,
            speech_probability=speech_prob,
        )
```

**Improvements over current `AudioPreprocessor`**:

| Current (batch) | New (streaming) |
|-----------------|-----------------|
| `soundfile.read(BytesIO(bytes))` — needs WAV header | Direct PCM — `np.frombuffer()` — no container |
| RNNoise re-instantiated per call | RNNoise state persists across frames |
| Peak normalization per chunk (inconsistent) | EMA normalization (stable across stream) |
| VAD runs on entire audio at once | VAD per-frame, LSTM state carries over |
| Stateless | Stateful per-session |

**Frame size**: 480 samples at 16kHz = 30ms per frame. Matches RNNoise (10ms at 48kHz) and Silero VAD preferred window.

---

### 4. Dynamic Batch Scheduler (GPU Core)

The heart of the system — collects utterance-complete segments from all sessions and runs them as one batched GPU call.

```
Session 1  ──utterance──┐
Session 4  ──utterance──┤     ┌─────────────────────┐     ┌──────────────┐
Session 17 ──utterance──┼────►│  Batch Scheduler     │────►│  GPU Forward │
Session 42 ──utterance──┤     │                      │     │  Pass (1x)   │
Session 99 ──utterance──┘     │  Trigger:            │     │              │
                              │  batch_size >= 32    │     │  Input:      │
                              │  OR wait >= 1000ms   │     │  [N padded   │
                              │                      │     │   segments]  │
                              │  Pad to max_len      │     │              │
                              │  Stack into tensor   │     │  Output:     │
                              └─────────────────────┘     │  [N texts]   │
                                                           └──────────────┘
```

```python
class DynamicBatchScheduler:
    """Collects segments from all sessions, batches GPU inference."""

    def __init__(self, max_batch_size: int = 32, max_wait_ms: int = 1000):
        self.max_batch_size = max_batch_size
        self.max_wait_ms = max_wait_ms
        self._queue: asyncio.Queue[InferenceRequest] = asyncio.Queue()
        self._model = None  # loaded ASR model (shared)

    async def run(self):
        """Main loop — runs forever, forming and dispatching batches."""
        while True:
            batch = await self._collect_batch()
            if batch:
                results = await asyncio.to_thread(self._infer_batch, batch)
                for req, result in zip(batch, results):
                    req.future.set_result(result)

    async def _collect_batch(self) -> list[InferenceRequest]:
        """Wait for segments, form batch when size OR time limit hit."""
        batch = []
        deadline = asyncio.get_event_loop().time() + (self.max_wait_ms / 1000)

        first = await self._queue.get()
        batch.append(first)

        while len(batch) < self.max_batch_size:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=remaining)
                batch.append(item)
            except asyncio.TimeoutError:
                break

        return batch

    def _infer_batch(self, batch: list[InferenceRequest]) -> list[str]:
        """GPU forward pass — runs on thread to avoid blocking event loop."""
        max_len = max(len(req.samples) for req in batch)
        padded = np.zeros((len(batch), max_len), dtype=np.float32)
        for i, req in enumerate(batch):
            padded[i, :len(req.samples)] = req.samples

        texts = self._model.batch_transcribe(padded, sample_rate=16000)
        return texts
```

**InferenceRequest**:

```python
@dataclass
class InferenceRequest:
    session_id: str
    samples: np.ndarray           # preprocessed float32 mono audio
    sample_rate: int
    utterance_start_time: float
    utterance_end_time: float
    future: asyncio.Future        # resolved when inference completes
```

**GPU capacity math (A100 80GB)**:

| Parameter | Value |
|-----------|-------|
| Model VRAM | ~2GB (Whisper Large V3 Turbo q4) to ~3GB (fp16) |
| Batch of 32 x 5s utterances | ~10MB working memory |
| GPU inference per batch | ~0.5-1.5 seconds |
| Batches needed/sec at peak (100 streams) | ~3-4 |
| GPU utilization at peak | ~60-80% |

---

### 5. Post-Processor and Diarization

After GPU inference returns text, diarization runs on CPU. ASR and embedding extraction run **in parallel**.

```python
async def process_utterance(session: StreamSession, utterance: np.ndarray):
    """Process complete utterance — ASR and embedding in parallel."""
    # Launch both concurrently
    asr_future = batch_scheduler.submit(InferenceRequest(
        session_id=session.session_id,
        samples=utterance,
        sample_rate=session.sample_rate,
        utterance_start_time=session.utterance_start_time,
        utterance_end_time=session.current_time,
        future=asyncio.get_event_loop().create_future(),
    ))
    embed_future = asyncio.get_event_loop().run_in_executor(
        cpu_pool, embedding_service.extract, utterance, session.sample_rate
    )

    # Wait for both
    text, embedding = await asyncio.gather(asr_future, embed_future)

    # Speaker identification (fast Qdrant lookup)
    speaker = await speaker_identifier.identify(
        embedding=embedding,
        tenant_id=session.tenant_id,
    )

    # Publish result
    await publish_result(session.session_id, SegmentResult(
        text=text,
        speaker_id=speaker.speaker_id,
        speaker_confidence=speaker.confidence,
        start_time=session.utterance_start_time,
        end_time=session.current_time,
    ))
```

**End-of-utterance diarization flow**:
1. VAD detects silence gap (>500ms) — marks utterance boundary
2. Full utterance audio (3-15s) sent to batch scheduler for ASR
3. Same audio sent to `ThreadPoolExecutor` for pyannote embedding extraction (parallel)
4. When both ready, Qdrant cosine similarity search for speaker matching
5. Result published to Redis Stream

---

## Device-Adaptive Execution Profiles

### Target Environments

| Environment | Compute | Memory | Max Streams |
|-------------|---------|--------|-------------|
| **A100 80GB** (production) | CUDA | 80GB VRAM | 100 |
| **Apple Silicon 48GB** (dev) | MPS | 48GB unified | 15 |
| **RTX A2000 16GB** (dev) | CUDA | 16GB VRAM | 20 |
| **2x RTX A2000 16GB** (staging) | Multi-CUDA | 32GB VRAM | 40 |
| **CPU 96-core 256GB** (CI) | CPU | 256GB RAM | 50 |

### ExecutionProfile

```python
@dataclass
class ExecutionProfile:
    """Hardware-adaptive execution configuration.
    Auto-detected at startup, overridable via environment variables.
    """

    # Identity
    platform: PlatformType
    device_name: str
    gpu_count: int
    total_vram_gb: float
    total_ram_gb: float
    cpu_cores: int

    # Inference tuning
    asr_device: str                     # "cuda:0", "mps", "cpu"
    asr_compute_type: str               # "float16", "int8", "float32"
    asr_max_batch_size: int             # 32 / 8 / 4 / 2
    asr_model_quantization: str         # "fp16" / "q4"

    # Embedding tuning
    embedding_device: str               # "cuda:1", "cpu", "mps"
    embedding_batch_size: int

    # Preprocessing tuning
    preprocess_pool_size: int           # ThreadPoolExecutor workers
    denoise_enabled_default: bool

    # Streaming tuning
    max_concurrent_streams: int
    batch_scheduler_max_wait_ms: int
    vad_silence_threshold_ms: int

    # Multi-GPU
    multi_gpu_strategy: str             # "replicate", "split", "none"
```

### Per-Environment Profile Details

#### A100 80GB (Production)

```
asr_device            = "cuda:0"
asr_compute_type      = "float16"
asr_max_batch_size    = 32
asr_model_quantization = "fp16"
embedding_device      = "cuda:0"        # share GPU
embedding_batch_size  = 16
preprocess_pool_size  = 16
max_concurrent_streams = 100
batch_scheduler_max_wait_ms = 1000

VRAM: Whisper fp16 ~3GB + Pyannote ~0.5GB + working ~15GB = ~18GB / 80GB
```

#### Apple Silicon 48GB (Dev)

```
asr_device            = "mps"
asr_compute_type      = "float16"
asr_max_batch_size    = 4
asr_model_quantization = "q4"
embedding_device      = "mps"           # unified memory
embedding_batch_size  = 4
preprocess_pool_size  = 8
max_concurrent_streams = 15
batch_scheduler_max_wait_ms = 1500

Memory: Whisper q4 ~1.5GB + Pyannote ~0.5GB + working ~3GB = ~15GB / 48GB
```

#### RTX A2000 16GB (Dev)

```
asr_device            = "cuda:0"
asr_compute_type      = "float16"
asr_max_batch_size    = 8
asr_model_quantization = "q4"
embedding_device      = "cpu"           # offload to save VRAM
embedding_batch_size  = 4
preprocess_pool_size  = 8
max_concurrent_streams = 20
batch_scheduler_max_wait_ms = 800

VRAM: Whisper q4 ~1.5GB + working ~6GB = ~8GB / 16GB
```

#### 2x RTX A2000 16GB (Staging)

```
asr_device            = "cuda:0"        # ASR on GPU 0
asr_compute_type      = "float16"
asr_max_batch_size    = 8
asr_model_quantization = "q4"
embedding_device      = "cuda:1"        # embeddings on GPU 1
embedding_batch_size  = 8
preprocess_pool_size  = 12
max_concurrent_streams = 40
batch_scheduler_max_wait_ms = 800
multi_gpu_strategy    = "split"

VRAM: GPU0 Whisper ~8GB/16GB | GPU1 Pyannote ~2GB/16GB
```

#### CPU 96-core 256GB (CI/Fallback)

```
asr_device            = "cpu"
asr_compute_type      = "float32"
asr_max_batch_size    = 2
asr_model_quantization = "q4"
embedding_device      = "cpu"
embedding_batch_size  = 8
preprocess_pool_size  = 32             # leverage many cores
max_concurrent_streams = 50
batch_scheduler_max_wait_ms = 2000

RAM: ~15GB / 256GB
```

### Environment Variable Overrides

All profile values can be overridden via env vars (extending existing `Settings`):

```python
streaming_max_concurrent: int = Field(default=0, description="0=auto from profile")
streaming_max_batch_size: int = Field(default=0, description="0=auto from profile")
streaming_batch_wait_ms: int = Field(default=0, description="0=auto from profile")
streaming_embedding_device: str = Field(default="auto")
streaming_multi_gpu_strategy: str = Field(default="auto")
```

---

## End-to-End Data Flow

```
CLIENT (Browser/App)
  |
  | WebSocket: binary PCM frames (30ms each, 16kHz mono, 960 bytes)
  v
API GATEWAY (NestJS)
  |
  | 1. Authenticate (API key / JWT)
  | 2. Create/resume session (session_id, pipeline_id, tenant_id)
  | 3. XADD each frame to Redis Stream: stt:audio:{session_id}
  | 4. XREAD from Redis Stream: stt:result:{session_id}
  | 5. Forward results back to client via WebSocket
  |
  v                                           ^
REDIS STREAMS                                 |
  | stt:audio:{session_id}                    | stt:result:{session_id}
  v                                           |
STT STREAMING PROCESS                     |
  |                                           |
  |  Ingestion Consumer (asyncio)             |
  |    -> Session Manager (ring buffer)       |
  |    -> Preprocessing (ThreadPool, stateful)|
  |    -> VAD detects utterance boundary      |
  |    -> Submit to Batch Scheduler           |
  |                                           |
  |  Dynamic Batch Scheduler                  |
  |    -> Collect segments (max 32 or 1s)     |
  |    -> GPU batched forward pass            |
  |                                           |
  |  Post-Processor (parallel)                |
  |    -> Embedding extraction (ThreadPool)   |
  |    -> Qdrant speaker lookup               |
  |    -> Publish to stt:result:{session_id} -+
  |
  |  On session end (is_final):
  |    -> Flush remaining audio
  |    -> Wait for pending inference
  |    -> Assemble full transcript
  |    -> Upload to MinIO (JSON + WAV)
  |    -> Call API Gateway: create context item
  |    -> Clean up session state
```

### Redis Stream Schema

**Audio input** (`stt:audio:{session_id}`):

```
XADD stt:audio:sess_abc123 *
    seq 42
    sr 16000
    enc pcm_s16le
    ch 1
    data <binary 960 bytes>
    final 0
    ts 1738800000.123
```

**Result output** (`stt:result:{session_id}`):

```
XADD stt:result:sess_abc123 *
    type segment
    text "The patient reports mild discomfort..."
    speaker_id spk_tenant1_dr_smith
    speaker_confidence 0.92
    start_time 12.5
    end_time 17.3
    is_final 0
```

**Session control** (`stt:control:{session_id}`):

```
XADD stt:control:sess_abc123 *
    action finalize          # or: pause, resume, cancel
```

### Timing Breakdown (A100, worst case)

| Stage | Time | Notes |
|-------|------|-------|
| Client -> Redis | ~2-5ms | WebSocket frame + XADD |
| Redis -> Ingestion | ~1-3ms | XREAD polling |
| Preprocessing | ~0ms marginal | Done frame-by-frame while audio arrives |
| Batch scheduler wait | 0-1000ms | Waiting for batch to fill |
| GPU inference (batch of 32) | ~500-1500ms | Model + utterance length dependent |
| Embedding extraction | ~50-100ms | Hidden behind GPU inference (parallel) |
| Qdrant speaker lookup | ~5-10ms | Cosine similarity search |
| Result -> Redis -> Client | ~5-10ms | XADD + WebSocket push |
| **Total end-to-end** | **~0.6 - 2.6s** | **Within 3-10s budget** |

---

## Error Handling

### Stream-Level Errors

| Error | Detection | Recovery |
|-------|-----------|----------|
| Client disconnects | Gateway writes `action: finalize` to control stream | Flush remaining audio, finalize with partial transcript, clean up |
| Sequence gap (dropped frames) | Ingestion checks `seq` monotonicity | Log warning, insert silence padding, continue |
| Audio corruption | `np.frombuffer()` produces NaN/Inf | Discard frame, increment `frames_dropped` counter, continue |
| Session timeout (60s no frames) | Background reaper task | Auto-finalize, clean up, notify gateway |

### Inference Errors

| Error | Detection | Recovery |
|-------|-----------|----------|
| GPU OOM | `torch.cuda.OutOfMemoryError` | Halve `max_batch_size`, retry in smaller batches, restore after 60s cooldown |
| Model inference failure | Exception from model | Return empty text for segment, session continues |
| Batch scheduler overload | Queue > 3x max_batch_size | Reject new sessions (503), continue existing, shed oldest |

### Infrastructure Errors

| Error | Detection | Recovery |
|-------|-----------|----------|
| Redis down | `redis.ConnectionError` | Exponential backoff reconnect, buffer in-memory up to 10s |
| Qdrant unavailable | Connection timeout | Degrade: return `speaker_id: "unknown"`, retry in background |
| MinIO unavailable | Upload failure | Retry 3x, store locally in `/tmp/stt/pending/`, background retry |

### Capacity Protection

```python
class CapacityGuard:
    """Prevents overload by tracking active sessions against profile limits."""

    def __init__(self, profile: ExecutionProfile):
        self.max_streams = profile.max_concurrent_streams
        self._active = 0
        self._lock = asyncio.Lock()

    async def try_acquire(self, session_id: str) -> bool:
        async with self._lock:
            if self._active >= self.max_streams:
                return False
            self._active += 1
            return True

    async def release(self, session_id: str) -> None:
        async with self._lock:
            self._active = max(0, self._active - 1)
```

Gateway receives rejection -> returns **HTTP 503** with `Retry-After` header.

---

## Observability

Prometheus metrics (extending existing `/metrics` endpoint):

```
stt_streaming_active_sessions           gauge
stt_streaming_sessions_total            counter
stt_streaming_frames_received_total     counter     (per session_id)
stt_streaming_frames_dropped_total      counter
stt_streaming_utterances_total          counter
stt_streaming_batch_size_histogram      histogram
stt_streaming_batch_wait_seconds        histogram
stt_streaming_inference_seconds         histogram
stt_streaming_embedding_seconds         histogram
stt_streaming_e2e_latency_seconds       histogram
stt_streaming_speaker_matches_total     counter     (known vs new)
stt_streaming_gpu_memory_used_bytes     gauge
stt_streaming_gpu_utilization_percent   gauge
```

---

## Testing Strategy

### Unit Tests

- **StreamingPreprocessor**: RNNoise state persistence, VAD state continuity, EMA normalization stability
- **DynamicBatchScheduler**: Batch formation (size/time triggers), future resolution, OOM recovery
- **SessionManager**: Lifecycle (create/active/finalize/cleanup), ring buffer overflow, sequence gaps
- **ExecutionProfile**: Mock hardware configs, verify correct profile per platform
- **CapacityGuard**: Concurrent acquire/release, rejection at limit

### Integration Tests

- **Redis Streams round-trip**: Write frames -> verify results
- **End-to-end single stream**: Known WAV as PCM frames -> verify transcript
- **Multi-stream concurrency**: 10-20 simulated streams, no cross-contamination
- **Graceful degradation**: Kill Redis mid-stream, verify buffering + recovery

### Load Tests

- **100-stream stress test**: P50/P95/P99 latency, GPU utilization, throughput
- **Capacity boundary**: Ramp 0->150 streams, verify rejection, existing streams unaffected
- **Long-running stability**: 20 streams for 2 hours, check memory leaks

### Per-Platform CI

```yaml
test_platforms:
  - name: cpu-only
    runner: [self-hosted, cpu-96]
    env: { STREAMING_MAX_CONCURRENT: 10, ASR_DEVICE: cpu }

  - name: apple-silicon
    runner: [self-hosted, macos-arm64]
    env: { STREAMING_MAX_CONCURRENT: 5 }

  - name: cuda-single
    runner: [self-hosted, gpu-a2000]
    env: { STREAMING_MAX_CONCURRENT: 10 }

  - name: cuda-multi
    runner: [self-hosted, gpu-2xa2000]
    env: { STREAMING_MAX_CONCURRENT: 20, STREAMING_MULTI_GPU_STRATEGY: split }
```

---

## What Changes vs. What Stays

| Component | Current | Change |
|-----------|---------|--------|
| `preprocessing.py` | Stateless, batch-only | **New**: `StreamingPreprocessor` (stateful, raw PCM) |
| `transcribe_stream.py` | Dramatiq, base64, in-memory dict | **Replace**: Redis Streams, SessionManager, CapacityGuard |
| `transcribe_file.py` | Batch Dramatiq actor | **Keep as-is** |
| `batch_service.py` | Single-stream inference | **New**: `DynamicBatchScheduler` (multi-stream batched) |
| `platform.py` | CPU/CUDA/MPS detection | **Extend**: `ExecutionProfile` with hardware tuning |
| `settings.py` | Batch worker settings | **Extend**: Streaming settings |
| `worker.py` | Dramatiq entry point | **New**: `streaming_server.py` (FastAPI + asyncio) |
| API Gateway | No stt WebSocket | **New**: WebSocket gateway, Redis Streams bridge |
| Diarization | Batch post-processing | **Adapt**: End-of-utterance embedding + Qdrant |
| Infrastructure | Redis (Dramatiq) | **Extend**: Redis Streams for audio/result channels |

---

## Resolved Design Decisions

### 1. Redis Stream TTL — Best Practice Retention

**Strategy**: Two-tier retention using Redis native mechanisms.

**During active session**:
- Audio streams (`stt:audio:{session_id}`) use approximate trimming on every XADD:
  `XADD stt:audio:sess_abc123 MAXLEN ~ 2000 * ...` — retains last ~2000 frames (~60s at 30ms/frame)
- This keeps memory bounded per-stream while the session is active
- Result streams (`stt:result:{session_id}`) are small — no trimming needed during session

**After session ends**:
- Set `EXPIRE` on all three stream keys with a 1-hour TTL:
  ```
  EXPIRE stt:audio:sess_abc123 3600
  EXPIRE stt:result:sess_abc123 3600
  EXPIRE stt:control:sess_abc123 3600
  ```
- This allows clients to reconnect and read missed results within 1 hour
- After 1 hour, Redis auto-deletes the keys — zero manual cleanup

**Background reaper** (every 5 minutes):
- Scan for session metadata keys (`stt:session:{session_id}`) with `status: closed` and `closed_at` older than 1 hour
- Safety net for sessions that didn't get proper EXPIRE (crash recovery)
- Uses `SCAN` with pattern matching, never `KEYS`

### 2. WebRTC — Deferred

WebRTC is out of scope for this iteration. Focus on WebSocket as the primary transport. WebRTC can be added later as an alternative ingestion path — the Redis Streams decoupling means the ingestion layer is swappable without changing the streaming process.

### 3. Model Hot-Swap — Zero-Downtime Model Replacement

The streaming process must support loading a different ASR model (or a new version of the same model) without restarting the process or dropping active sessions.

**Design**:

```python
class ModelManager:
    """Manages ASR model lifecycle with hot-swap support."""

    def __init__(self, model_cache: ModelCache):
        self._active_model: LoadedModel | None = None
        self._next_model: LoadedModel | None = None
        self._swap_lock = asyncio.Lock()
        self._model_cache = model_cache
        self._active_model_slug: str = ""

    async def get_model(self) -> LoadedModel:
        """Get the currently active model (called by batch scheduler)."""
        return self._active_model

    async def request_swap(self, new_model_slug: str, pipeline_id: str) -> None:
        """Request a model swap. Non-blocking — swap happens between batches."""
        if new_model_slug == self._active_model_slug:
            logger.info("Model %s already active, skipping swap", new_model_slug)
            return

        async with self._swap_lock:
            # Pre-load the new model while current model continues serving
            logger.info("Pre-loading model %s for hot-swap...", new_model_slug)
            pipeline_reader = get_pipeline_reader()
            model_reader = get_model_reader()

            pipeline = await pipeline_reader.get_pipeline(pipeline_id)
            model_configs = await model_reader.get_models_for_pipeline(pipeline)
            self._next_model = await self._model_cache.get_or_load(
                model_configs[new_model_slug]
            )
            logger.info("Model %s pre-loaded, swap will happen at next batch boundary",
                        new_model_slug)

    async def apply_swap_if_pending(self) -> None:
        """Called by batch scheduler between batches. Atomically swaps model."""
        if self._next_model is None:
            return

        async with self._swap_lock:
            old_slug = self._active_model_slug
            old_model = self._active_model

            self._active_model = self._next_model
            self._active_model_slug = self._next_model.model_slug
            self._next_model = None

            logger.info("Hot-swapped model: %s -> %s", old_slug, self._active_model_slug)

            # Unload old model after swap (free VRAM)
            if old_model:
                await asyncio.to_thread(self._model_cache.evict, old_slug)
```

**Swap trigger**: Via Redis pub/sub channel `stt:model_swap`:
```
PUBLISH stt:model_swap '{"model_slug": "whisper-large-v3-turbo-q4", "pipeline_id": "pipe_abc"}'
```

**Swap flow**:
1. Admin publishes swap request to Redis channel
2. Streaming process receives message, calls `request_swap()`
3. New model loads in background (ThreadPoolExecutor) while current model serves
4. Between batch scheduler cycles, `apply_swap_if_pending()` atomically swaps
5. Old model is evicted from cache, VRAM freed
6. Zero downtime — no request is dropped, no session is interrupted

**VRAM consideration**: During swap, both models are in VRAM briefly. For A100 80GB this is fine (2x 3GB = 6GB). For RTX A2000 16GB, ensure q4 models are used (2x 1.5GB = 3GB — still fits).

### 4. Session Persistence — Redis-Backed State

Session state must survive process restarts. The `StreamSession` object is split into two tiers:

**Tier 1 — Redis (durable, survives restart)**:
```python
# Stored in Redis Hash: stt:session:{session_id}
{
    "session_id": "sess_abc123",
    "tenant_id": "tenant_1",
    "pipeline_id": "pipe_xyz",
    "consultation_id": "consult_456",
    "status": "active",                    # active | finalizing | closed
    "created_at": "2026-02-09T12:00:00Z",
    "last_activity": "2026-02-09T12:05:30Z",
    "total_samples_received": 480000,
    "total_duration_seconds": 30.0,
    "utterance_count": 7,
    "last_seq": 1000,                      # last processed sequence number
    "sample_rate": 16000,
    "pipeline_config_json": "...",         # serialized PreprocessingConfig
}
```

**Tier 2 — In-Memory (ephemeral, rebuilt on restart)**:
```python
# These are NOT persisted — reconstructed from audio stream replay
rnnoise_state: RNNoise               # rebuilt by replaying last ~2s of audio
vad_state: SileroVADState            # rebuilt similarly
current_utterance: bytearray         # rebuilt from audio stream since last utterance boundary
ring_buffer: RingBuffer              # rebuilt from Redis Stream XRANGE
```

**Recovery flow on process restart**:
1. Process starts, scans Redis for `stt:session:*` keys with `status: active`
2. For each active session:
   a. Restore Tier 1 metadata from Redis Hash
   b. Read last ~2 seconds of audio from `stt:audio:{session_id}` via `XREVRANGE`
   c. Replay those frames through a fresh `StreamingPreprocessor` to warm up RNNoise/VAD state
   d. Resume consuming from `last_seq + 1` — no frames are lost (Redis Stream retains them)
3. Sessions that were in `finalizing` state are re-finalized
4. Gateway detects reconnection via result stream activity — no client-side change needed

**Persistence frequency**: Tier 1 metadata is updated every 5 seconds (batched HSET), not on every frame — avoids Redis write amplification.

**Session discovery**: On startup, the process registers itself in Redis:
```
SET stt:worker:{worker_id} '{"pid": 12345, "started_at": "...", "sessions": [...]}' EX 30
```
Heartbeat extends TTL every 10 seconds. If a worker crashes, its registration expires after 30s, and another worker (or the restarted process) can claim orphaned sessions.

### 5. Audio Recording — Dual-Track MinIO Upload

Both raw and processed audio are saved to MinIO for audit and reprocessing.

**Recording strategy**: Buffer audio in memory and flush to MinIO periodically (every 30 seconds) and on session finalization.

```python
class AudioRecorder:
    """Records raw and processed audio to MinIO for audit/reprocessing."""

    def __init__(self, blob_service: BlobService, tenant_id: str,
                 session_id: str, consultation_id: str | None):
        self._blob = blob_service
        self._tenant_id = tenant_id
        self._session_id = session_id
        self._consultation_id = consultation_id

        # Buffers (flushed every 30s or on finalize)
        self._raw_buffer = bytearray()       # original PCM from client
        self._processed_buffer = bytearray() # after denoise + resample
        self._chunk_index = 0
        self._flush_interval_s = 30

    def append_raw(self, pcm_frame: bytes) -> None:
        """Append raw PCM frame from client."""
        self._raw_buffer.extend(pcm_frame)

    def append_processed(self, samples: np.ndarray, sr: int) -> None:
        """Append preprocessed audio (after denoise, resample)."""
        int16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
        self._processed_buffer.extend(int16.tobytes())

    async def flush_if_needed(self) -> None:
        """Flush buffers to MinIO if interval exceeded."""
        if len(self._raw_buffer) < self._flush_interval_s * 16000 * 2:
            return  # not enough data yet
        await self._flush()

    async def finalize(self) -> AudioRecordingResult:
        """Final flush — upload remaining buffers as complete WAV files."""
        await self._flush()
        # Upload final combined WAV files
        raw_uri = await self._upload_wav(
            self._all_raw_chunks, "raw", self._raw_sample_rate
        )
        processed_uri = await self._upload_wav(
            self._all_processed_chunks, "processed", self._processed_sample_rate
        )
        return AudioRecordingResult(
            raw_audio_uri=raw_uri,
            processed_audio_uri=processed_uri,
        )

    async def _flush(self) -> None:
        """Upload current buffers as numbered chunks."""
        if self._raw_buffer:
            chunk_path = (
                f"streaming/{self._tenant_id}/{self._session_id}"
                f"/raw/chunk_{self._chunk_index:04d}.pcm"
            )
            await self._blob.upload_bytes(self._raw_buffer, chunk_path)
            self._raw_buffer = bytearray()

        if self._processed_buffer:
            chunk_path = (
                f"streaming/{self._tenant_id}/{self._session_id}"
                f"/processed/chunk_{self._chunk_index:04d}.pcm"
            )
            await self._blob.upload_bytes(self._processed_buffer, chunk_path)
            self._processed_buffer = bytearray()

        self._chunk_index += 1
```

**MinIO storage layout**:
```
hope-audio/
  streaming/
    {tenant_id}/
      {session_id}/
        raw/
          chunk_0000.pcm         # 30s raw PCM chunks (periodic flush)
          chunk_0001.pcm
          ...
          complete.wav           # final combined WAV (on finalize)
        processed/
          chunk_0000.pcm         # 30s processed PCM chunks
          chunk_0001.pcm
          ...
          complete.wav           # final combined WAV (on finalize)
        transcript.json          # final transcript with speaker labels
        metadata.json            # session metadata, pipeline config, timing
```

**Memory impact**: At 16kHz mono 16-bit, raw audio = 32KB/s. Two buffers (raw + processed) at 30s flush interval = ~2MB per session. 100 sessions = ~200MB — acceptable.

**Reprocessing**: The `complete.wav` files can be fed back into the existing batch pipeline (`transcribe_file`) for reprocessing with a different model or pipeline config. This closes the loop between streaming and batch.

---

## Updated Session Manager

With Redis-backed persistence and audio recording, the `StreamSession` gains new responsibilities:

```python
class StreamSession:
    # ... (existing fields from earlier design) ...

    # NEW — Redis persistence
    _redis: Redis
    _persist_interval_s: float = 5.0
    _last_persisted_at: float = 0.0

    # NEW — Audio recording
    recorder: AudioRecorder

    async def persist_if_needed(self) -> None:
        """Persist Tier 1 state to Redis every 5 seconds."""
        now = time.monotonic()
        if now - self._last_persisted_at < self._persist_interval_s:
            return
        await self._redis.hset(f"stt:session:{self.session_id}", mapping={
            "status": self.status,
            "last_activity": datetime.utcnow().isoformat(),
            "total_samples_received": self.total_samples_received,
            "total_duration_seconds": self.total_duration_seconds,
            "utterance_count": self.utterance_count,
            "last_seq": self.last_seq,
        })
        self._last_persisted_at = now

    async def finalize(self) -> SessionResult:
        """Finalize session — flush audio, upload, clean up."""
        self.status = "finalizing"
        await self.persist_if_needed()

        # Wait for pending inference
        while not self.pending_segments.empty():
            await asyncio.sleep(0.1)

        # Finalize audio recording
        recording = await self.recorder.finalize()

        # Assemble full transcript
        transcript = self._assemble_transcript()

        # Upload transcript
        transcript_uri = await self._upload_transcript(transcript)

        # Update Redis state
        self.status = "closed"
        await self._redis.hset(f"stt:session:{self.session_id}", mapping={
            "status": "closed",
            "closed_at": datetime.utcnow().isoformat(),
            "raw_audio_uri": recording.raw_audio_uri,
            "processed_audio_uri": recording.processed_audio_uri,
            "transcript_uri": transcript_uri,
        })

        # Set TTL on all stream keys (1 hour retention)
        for key in [
            f"stt:audio:{self.session_id}",
            f"stt:result:{self.session_id}",
            f"stt:control:{self.session_id}",
        ]:
            await self._redis.expire(key, 3600)

        # Session metadata key expires after 24 hours (for audit)
        await self._redis.expire(f"stt:session:{self.session_id}", 86400)

        return SessionResult(
            transcript=transcript,
            raw_audio_uri=recording.raw_audio_uri,
            processed_audio_uri=recording.processed_audio_uri,
            transcript_uri=transcript_uri,
        )
```

---

## Updated Batch Scheduler with Model Hot-Swap

```python
class DynamicBatchScheduler:
    """Collects segments, batches GPU inference, supports model hot-swap."""

    def __init__(self, model_manager: ModelManager, profile: ExecutionProfile):
        self.model_manager = model_manager
        self.max_batch_size = profile.asr_max_batch_size
        self.max_wait_ms = profile.batch_scheduler_max_wait_ms
        self._queue: asyncio.Queue[InferenceRequest] = asyncio.Queue()

    async def run(self):
        """Main loop — form batches, check for model swap between cycles."""
        while True:
            # Check for pending model swap BETWEEN batches (zero-downtime)
            await self.model_manager.apply_swap_if_pending()

            batch = await self._collect_batch()
            if batch:
                model = await self.model_manager.get_model()
                results = await asyncio.to_thread(self._infer_batch, batch, model)
                for req, result in zip(batch, results):
                    req.future.set_result(result)

    # ... _collect_batch and _infer_batch remain as before ...
```

---

## Implementation Plan

> **Status**: Pending — requires approval before implementation begins.

Suggested implementation order:

1. **Phase 1 — Foundation**: ExecutionProfile auto-detection, Redis-backed StreamSession, CapacityGuard, Redis Streams consumer/publisher, session recovery on restart
2. **Phase 2 — Preprocessing**: StreamingPreprocessor with stateful RNNoise + VAD, raw PCM ingestion
3. **Phase 3 — Inference**: DynamicBatchScheduler with GPU batching, ModelManager with hot-swap support
4. **Phase 4 — Audio Recording**: AudioRecorder with dual-track MinIO upload (raw + processed), periodic flush, finalization
5. **Phase 5 — Diarization**: End-of-utterance embedding extraction + Qdrant speaker matching
6. **Phase 6 — API Gateway**: WebSocket gateway for stt, Redis Streams bridge, session lifecycle management
7. **Phase 7 — Testing**: Unit + integration + load tests across all platforms, session recovery tests
8. **Phase 8 — Observability**: Prometheus metrics, health checks, alerting, session audit dashboard
