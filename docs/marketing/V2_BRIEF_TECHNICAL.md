# ARCA AI — Voice Intelligence Platform

## Architecture at a Glance

The platform consists of five Python FastAPI services, a NestJS API gateway, and a TypeScript SDK bundling the in-browser audio pipeline. A self-hosted MLflow MLOps plane _(planned)_ owns experiment tracking, dataset versioning, and the model registry every serving backend pulls from. The same audio pipeline (noise cancel → voice detect → recognize → diarize) is implemented twice — once in the browser, once on the server — so transcripts have a consistent structure regardless of path. Three companion services — Medical NER, Guardrail, and Text-to-Speech _(planned)_ — extend the core flow with structured entity extraction, safety validation, and synthesized speech output.

```
                          ┌────────────────────────────────┐
                          │   MLOps Plane  (planned)       │
                          │  • MLflow Tracking             │
                          │  • MLflow Model Registry       │
                          │  • Dataset / corpus versioning │
                          │  • Artifact storage (MinIO)    │
                          └─────────────┬──────────────────┘
                                        │  model artifacts +
                                        │  registry aliases
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                Doctor's Browser  (Local AI mode)                    │
│                                                                     │
│   @arcaai/noise-filter  (RNNoise WASM)                              │
│         ↓                                                           │
│   @arcaai/vad           (Silero VAD v5)                             │
│         ↓                                                           │
│   @arcaai/stt           (Whisper WebWorker + Diarizer)              │
│         ↓                                                           │
│   @arcaai/med-ner       (Medical NER, Transformers.js Web Worker)   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  Transport: WebSocket today;
                               │  WebRTC planned (Opus + DataChannel)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Server-side AI Plane                          │
│                                                                     │
│  ┌──────────────────────────────┐    ┌──────────────────────────┐   │
│  │  STT Backend Service         │    │  Guardrail Service       │   │
│  │                              │    │                          │   │
│  │  PCM → RNNoise               │    │  • Guardian model        │   │
│  │   → Silero VAD v5            │◀──▶│    (medical context      │   │
│  │   → ASR (Whisper / NeMo /    │    │     validation)          │   │
│  │      Azure / whisper.cpp*)   │    │  • Content safety        │   │
│  │   → pyannote diarization     │    │  • PII detection         │   │
│  │   → Cadence punctuation      │    │  • Prompt-injection      │   │
│  └──────────────────────────────┘    │    detection (GLiNER)    │   │
│                                      └──────────────────────────┘   │
│  ┌──────────────────────────────┐    ┌──────────────────────────┐   │
│  │  NLP / Medical NER Service   │    │  TTS Service  (planned)  │   │
│  │                              │    │                          │   │
│  │  • Medical NER (BIO tagging) │    │  • Synthesized speech    │   │
│  │  • Text classification       │    │    for patient-facing    │   │
│  │  • Diagnosis suggestion      │    │    summaries / readouts  │   │
│  │  • Spelling correction       │    │  • API Gateway stub      │   │
│  └──────────────────────────────┘    │    already present       │   │
│                                      └──────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  TranscriptionResult + structured
                               │  entities + safety verdicts
                               ▼
                ┌────────────────────────────────────┐
                │  API Gateway  (NestJS)             │
                │                                    │
                │  PromptResolutionService           │
                │  PromptAssemblyService             │
                │  DNA Writing Style generation jobs │
                │  Persistence (PostgreSQL · Prisma) │
                └────────────────┬───────────────────┘
                                 ▼
                ┌──────────────────────────────────────────┐
                │  SMR-V2 LLM Gateway                      │
                │                                          │
                │  Self-hosted: llama.cpp · LM Studio ·    │
                │    Ollama · any OpenAI-compatible        │
                │  Managed:     Azure OpenAI · AWS Bedrock │
                │                                          │
                │  Guardrails (in / out) ·  rate limit     │
                │  Circuit breaker · retry · streaming     │
                └────────────────┬─────────────────────────┘
                                 ▼
                ┌────────────────────────────────────┐
                │  Structured Note                   │
                │  (SOAP / referral / discharge / …) │
                └────────────────────────────────────┘
```

### Service Reference

| Component                     | Stack                                | Purpose                                                                                    |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| **STT Backend Service**       | Python 3.11 / FastAPI / Uvicorn      | Backend transcription, diarization, voice profile extraction                               |
| **SMR-V2 LLM Gateway**        | Python 3.11 / FastAPI / Uvicorn      | Multi-provider LLM gateway, prompt-injection scanner, structured streaming                 |
| **NLP / Medical NER Service** | Python 3.11 / FastAPI / Uvicorn / UV | Medical NER, text classification, diagnosis suggestion, spelling correction                |
| **Guardrail Service**         | Python 3.11 / FastAPI / Uvicorn      | Medical context validation (Guardian), content safety, PII, prompt-injection (GLiNER ONNX) |
| **TTS Service** _(planned)_   | Python / FastAPI _(planned)_         | Text-to-Speech synthesis; API Gateway integration stubs present                            |
| **API Gateway**               | NestJS 11 / TypeScript / Node 18+    | Orchestration, persistence (Prisma 7), prompt resolution + assembly, DNA generation jobs   |
| **MLflow Server** _(planned)_ | Python (self-hosted)                 | Experiment tracking, model registry, dataset versioning, artifact storage                  |
| `@arcaai/stt`                 | TypeScript                           | In-browser Whisper WebWorker, `STTProcessor`, `LocalSTTProvider`, `LocalSpeakerDiarizer`   |
| `@arcaai/vad`                 | TypeScript                           | In-browser Silero VAD v5 wrapper                                                           |
| `@arcaai/noise-filter`        | TypeScript                           | In-browser RNNoise WASM AudioWorklet                                                       |
| `@arcaai/med-ner`             | TypeScript                           | In-browser Medical NER plugin (Transformers.js Web Worker)                                 |
| `@arcaai/room`                | TypeScript                           | Audio track / pipeline orchestration (`ProcessorPipeline`, sample-rate enforcement)        |
| `@arcaai/vox`                 | TypeScript / Zustand                 | Consultation SDK, `useSTT`, `useDnaStyle`, agentic store                                   |
| Conda environment             | Python 3.11                          | `arcaenv` — required for all Python services                                               |

---

## 1. Live Transcription — In-Browser Pipeline

A strictly ordered audio chain assembled by `@arcaai/room`'s `ProcessorPipeline`. Each stage receives the processed `MediaStreamTrack` of the previous stage, so the chain is physically connected — there is no opportunity to skip a step at runtime.

```
Microphone (getUserMedia)
     │
     ▼
[priority 10] @arcaai/noise-filter  — RNNoise WASM
     │
     ▼
[priority 20] @arcaai/vad           — Silero VAD v5
     │
     ▼
[priority 30] @arcaai/stt           — Whisper Web Worker
     │
     ▼
LocalSpeakerDiarizer  → TranscriptionResult { text, speakerId, timestamps, latencyMs }
```

### Stage 1 — Noise Cancellation (`@arcaai/noise-filter`)

Wraps `@jitsi/rnnoise-wasm ^0.2.1` — the Mozilla / Xiph.org open-source neural noise suppressor (Jean-Marc Valin, originally for Opus and Jitsi). Runs as an `AudioWorkletNode`.

| Parameter                 | Value           | Notes                                       |
| ------------------------- | --------------- | ------------------------------------------- |
| Sample rate               | 48 kHz (native) | Enforced by `@arcaai/room`; mismatch throws |
| Frame size                | 480 samples     | ~10 ms algorithmic delay                    |
| CPU                       | ~1–2%           | On modern hardware                          |
| WASM binary               | ~85 KB          | Cached in browser after first load          |
| Native `noiseSuppression` | disabled        | When RNNoise is on (no double-processing)   |

### Stage 2 — Voice Activity Detection (`@arcaai/vad`)

Silero VAD v5 via `@ricky0123/vad-web ^0.0.30`, with `onnxruntime-web ^1.24.3`.

| Parameter                 | Default              | Notes                             |
| ------------------------- | -------------------- | --------------------------------- |
| Frame size                | 512 samples @ 16 kHz | ~32 ms per frame                  |
| Positive speech threshold | 0.5                  | Configurable                      |
| Negative speech threshold | 0.35                 | Configurable                      |
| Pre-speech padding        | 300 ms               | Captures utterance start          |
| Post-speech padding       | 300 ms               | Captures utterance end            |
| Min speech duration       | 250 ms               | Suppresses transients             |
| Redemption silence        | 1,400 ms             | Before declaring end-of-utterance |
| Languages                 | 6,000+               | Language-agnostic gating          |

Beyond clean segmentation, the gate prevents the well-known "Whisper hallucinates on silence" failure mode that plagues naive integrations.

### Stage 3 — Speech Recognition (`@arcaai/stt`)

Whisper via `@huggingface/transformers 3.8.1` in a dedicated ES Module Web Worker. Audio buffers cross the boundary as `Transferable` — zero-copy, avoiding the ~1.9 MB structured-clone cost per 30 s chunk.

| Parameter         | Default                                             | Notes                                                                        |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Inference runtime | WebGPU (FP16) → multi-threaded WASM → WASM          | Auto-detect with graceful fallback                                           |
| Multi-threading   | Requires `COOP: same-origin` + `COEP: require-corp` | `SharedArrayBuffer` needed for ORT threads                                   |
| ORT thread cap    | 8                                                   | Diminishing returns past this; protects page from starvation                 |
| Quantization      | INT8 (default)                                      | Smaller weights, faster inference                                            |
| Languages         | 99+                                                 | ISO 639-1 + ISO 3166-1 locale codes; `auto` for code-switching mode          |
| Crash recovery    | 3 retries, exponential backoff (100 ms base)        | Worker isolated from main thread                                             |
| Model cache       | Browser Cache API (`env.useBrowserCache=true`)      | Persists across sessions; warm pool keeps weights resident across reconnects |

| Model    | Size    | Real-time?   |
| -------- | ------- | ------------ |
| `tiny`   | ~40 MB  | Recommended  |
| `base`   | ~75 MB  | Recommended  |
| `small`  | ~240 MB | Borderline   |
| `medium` | ~770 MB | Backend mode |
| `large`  | ~1.5 GB | Backend mode |

Chunk strategy: **Streaming** 30 s chunk / 5 s overlap · **VAD-gated** 2 s / 0.2 s overlap · **Playground sidecar** 6 s max / 0.25 s overlap.

### Speaker Labelling — `LocalSpeakerDiarizer`

Builds a ~50-dimensional feature vector per utterance (13 MFCCs, 13 delta-MFCCs, 24 mel-band energies, 9 spectral/pitch descriptors) via a hand-written radix-2 Cooley–Tukey FFT on 2048-sample Hann-windowed frames.

| Parameter                   | Default                                 | Notes                                                                    |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Cosine similarity threshold | 0.97                                    | Overridable per voice profile (`similarityThreshold`)                    |
| EMA centroid cap            | 20 samples                              | Prevents drift between distinct speakers                                 |
| Max speakers                | 2 (configurable)                        | Best-match assignment when cap reached                                   |
| Reserved speaker pinning    | Enabled                                 | First slot pinned to authenticated doctor / enrolled voice profile label |
| Runtime update              | `STTProcessor.setReservedSpeakerId(id)` | No pipeline rebuild required                                             |

Reserved-speaker pinning (TASK-296 C-2, TASK-304 Wave 3) flows the doctor's identity from `UserPreferences.activeVoiceProfile.reservedSpeakerId` through `PluginManager` → `TranscriptionPipeline` → `LocalSTTProvider` → `LocalSpeakerDiarizer`. The `useSTT` hook fingerprints `voiceProfile.id` and `reservedSpeakerId` so late-arriving enrolment triggers a clean processor reinit. The in-browser MFCC fingerprint is documented as a deliberate short-term mismatch with the backend's 256-d neural embedding; speaker IDs across modes are mapped at the application layer.

### Transport — WebSocket Today, WebRTC _(planned)_

Local-only mode requires no transport. The optional backend path streams raw PCM over a plain WebSocket today; **WebRTC migration is planned** — a single multiplexed PeerConnection with Opus audio (built-in jitter buffer + FEC), ICE / STUN / TURN traversal for hospital networks, and a bidirectional DataChannel for partial transcripts and control. The SDK contract is unchanged across the migration.

---

## 2. Backend Transcription — STT Backend Service

### Runtime

| Property      | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Language      | Python 3.11+ (supports 3.11–3.13)                                                      |
| Framework     | FastAPI ≥0.133.0 · Uvicorn ≥0.41.0                                                     |
| Conda env     | `arcaenv` (`conda create -n arcaenv python=3.11`)                                      |
| Torch         | `>=2.8.0, <2.9.0` (pinned by pyannote.audio for MPS + CUDA support)                    |
| Transformers  | `==5.5.4`                                                                              |
| ORT (backend) | `onnxruntime >=1.23.0` (CPU) · `onnxruntime-gpu >=1.23.0` (GPU variant)                |
| Workers       | Dramatiq on Redis (4 threads / process default)                                        |
| Vector store  | Qdrant (cross-session voice profile enrollment only; runtime diarization is in-memory) |

### Pipeline Shape

```
WebSocket (PCM int16 16 kHz mono)         ← WebRTC migration planned
     │
     ▼
RNNoise denoise (pyrnnoise)
     │
     ▼
Silero VAD v5 (ONNX Runtime, per-session LSTM state)
     │
     ▼
ASR Engine  (LRU cache: 5 models · 1 h TTL)
     │
     ▼
pyannote diarization (256-d speaker embeddings)
     │
     ▼
Cadence punctuation (cadence-punctuation)
     │
     ▼
Final transcript with speaker IDs + word timestamps
```

### Server-Side Noise Cancellation

| Parameter                | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Library                  | `pyrnnoise >=0.4.0`                                                   |
| Resample chain           | 16 kHz → 48 kHz (linear interpolation) → 48 kHz → 16 kHz (decimation) |
| Frame size               | 480 samples @ 48 kHz                                                  |
| Strength blend           | 0.0–1.0                                                               |
| Fade-in on session start | 0.1 s linear                                                          |
| Auto-disable threshold   | 10 consecutive RNNoise failures                                       |
| Temporal alignment       | Previous frame delayed by ~1 frame to match RNNoise output latency    |

The fade-in suppresses onset transients that otherwise trigger Whisper hallucinations on the first chunk; temporal alignment prevents comb-filter artifacts when the strength blend is mixed.

### VAD + Streaming

| Parameter                  | Default                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Library                    | Silero VAD v5 (ONNX Runtime), per-session LSTM hidden state                                     |
| Frame size                 | 512 samples (32 ms @ 16 kHz), 256 samples @ 8 kHz                                               |
| Pre-speech ring buffer     | 300 ms                                                                                          |
| Onset / offset thresholds  | speech-prob ≥ threshold for 350 ms / < threshold for 700 ms                                     |
| Partial emit cadence       | every 1.0 s during active speech (requires ≥0.5 s buffered)                                     |
| Force-emit on long speech  | utterance >25 s → split at lowest-energy frame in 1.5 s lookback + 500 ms overlap carry-forward |
| Session inactivity timeout | 60 s (reaper every 300 s)                                                                       |
| Session persistence        | In-memory + Redis snapshot every 5 s                                                            |
| Audio buffer hard cap      | 500 MB (~87 min int16 mono @ 16 kHz)                                                            |
| Fallback                   | RMS energy detection if Silero unavailable                                                      |

### Multi-Engine ASR

| Engine                           | Currently shipped  | Models / runtime                                                                                                                |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Whisper (ONNX)**               | ✓                  | `onnx-community/whisper-large-v3-turbo`, `whisper-large-v3-turbo_timestamped`; ORT ≥1.23 + Optimum 2.1.0; FP16/INT8/Q4 variants |
| **Whisper (SafeTensor/PyTorch)** | ✓                  | `openai/whisper-large-v3-turbo`, `whisper-large-v3`, `whisper-medium`; Transformers 5.5.4 + torch 2.8.0                         |
| **NVIDIA NeMo Parakeet**         | ✓ (optional extra) | `nvidia/parakeet-tdt-0.6b-v2`, `nvidia/parakeet-tdt-1.1b`; `nemo_toolkit[asr] >=2.7.2,<3.0.0`                                   |
| **Azure Speech Service**         | ✓                  | Cloud REST / WebSocket; `azure-cognitiveservices-speech >=1.47.0`                                                               |
| **whisper.cpp**                  | _(planned)_        | Any gguf-format Whisper checkpoint; ggml-quantized variants; CPU-first with optional CUDA / Metal builds                        |

Common knobs:

| Parameter              | Default                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Model cache            | LRU 5 models · 1 h TTL                                         |
| Cache env vars         | `MODEL_CACHE_MAX_MODELS`, `MODEL_CACHE_TTL_SECONDS`            |
| Warm-up                | `PRELOAD_PIPELINES` (comma-separated pipeline slugs)           |
| Whisper chunk strategy | 15 s chunks · 4 s / 2 s stride · VAD merge gap ≤ 2 s           |
| ONNX threads           | `intra_op_num_threads = 0` (auto); `ONNX_NUM_THREADS` override |
| Torch threads          | `torch.set_num_threads` / `OMP_NUM_THREADS`                    |
| Inference pool         | `ProcessPoolExecutor`, `INFERENCE_POOL_SIZE=0` (auto)          |

### Diarization

| Parameter                   | Value                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Library                     | `pyannote.audio >=3.3.0`                                                                          |
| Default embedding model     | `pyannote/wespeaker-voxceleb-resnet34-LM` (256-d)                                                 |
| Alternative embedding model | `speechbrain/spkrec-ecapa-voxceleb` (auto-selected when `hf_model_id` starts with `speechbrain/`) |
| Inference                   | `pyannote.audio.Inference(window="whole")` dispatched via `asyncio.to_thread`                     |
| Device                      | Auto-detect CUDA / MPS / CPU; SpeechBrain falls back to CPU on MPS                                |
| Session-scoped tracker      | In-memory `deque` of up to 8 embeddings per speaker                                               |
| Max speakers                | 2 (configurable)                                                                                  |
| Hybrid score formula        | `0.7 × cosine(centroid, new) + 0.3 × max(cosine(history, new))`                                   |
| Ambiguity refinement model  | `pyannote/segmentation-3.0`                                                                       |
| Ambiguity recursion depth   | 1 (split → re-embed → re-identify only once)                                                      |

Runtime diarization is purely in-memory per session. Qdrant is used only for cross-session voice profile enrollment / retrieval.

### Voice Profile Enrollment

| Parameter                 | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Input                     | 1–3 audio file uploads (any `soundfile`-readable format), ≤15 s each                        |
| Decoding                  | float32 mono at native sample rate; resampled to first file's rate via `librosa`            |
| Per-sample embedding      | 256-d via configured pyannote / SpeechBrain model                                           |
| Pairwise similarity check | reject if `< voice_profile_min_similarity` (default **0.6** prod, ~0.3 dev mics)            |
| Output                    | Averaged + L2-normalized centroid; returned as JSON                                         |
| Persistence dimension     | `EXPECTED_EMBEDDING_DIM = 256` (matches `UserVoiceProfile.embedding vector(256)` in Prisma) |
| Database writes           | None — API Gateway owns persistence                                                         |

### Cadence Punctuation Restoration

| Parameter                       | Value                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Library                         | `cadence-punctuation >=1.1.0`                                                                                                                  |
| Models                          | `Cadence` (~~1B params, Gemma-3 backbone) · `Cadence-Fast` (~~270M)                                                                            |
| Inference                       | Sliding-window, max sequence length 300 tokens                                                                                                 |
| Backbone configuration override | Force `use_bidirectional_attention = True` at load — Cadence's shipped `config.json` defaults to causal masking, which causes over-punctuation |
| Loading                         | Default model loaded at startup; non-default models lazy-loaded on first use                                                                   |

### Production Hardening

A startup execution-profile detector auto-tunes compute precision, batch size, concurrency limits, and denoiser defaults — no manual operator tuning. A dynamic batch scheduler coalesces concurrent sessions into a single inference pass.

---

## 3. Summarization — SMR-V2 LLM Gateway + Application Layer

### Service Boundary

| Service                             | Owns                                                                                                              | Knows nothing about                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **SMR-V2 LLM Gateway**              | LLM provider routing, rate-limit / circuit breaker, prompt-injection scanner, structured streaming, observability | SOAP notes, specialties, patients, DNA writing style |
| **NestJS API Gateway + apps layer** | Prompt templates (DB), prompt resolution, prompt assembly, DNA generation jobs, consultation context              | LLM provider implementation details                  |

The gateway calls SMR-V2 via `POST /api/v1/generate` with a fully-assembled prompt. SMR-V2 just generates.

### SMR-V2 Runtime

| Property      | Value                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Internal name | `hope-smr` v2.0.0                                                          |
| Language      | Python 3.11 / FastAPI                                                      |
| Conda env     | `arcaenv`                                                                  |
| Azure SDK     | `openai >=2.24.0` (Azure + OpenAI-compat)                                  |
| Bedrock SDK   | `boto3 >=1.42.0`                                                           |
| Streaming     | `sse-starlette >=3.2.0` + Redis Streams                                    |
| Logging       | `structlog >=25.5.0`                                                       |
| Metrics       | `prometheus-client >=0.24.1` · `prometheus-fastapi-instrumentator >=7.1.0` |
| Tracing       | OpenTelemetry SDK + OTLP gRPC exporter ≥1.39.x                             |

### LLM Providers

A single internal abstraction (`generate` / `generate_stream`) routes per-request to one of the backends below. All disabled by default; toggled via env flags. **LM Studio (OpenAI-compatible) is the default self-hosted engine**; Ollama remains available as an optional, lower-priority engine. Today's self-hosted set: LM Studio, Ollama, any OpenAI-compatible endpoint (vLLM, TGI, etc.). **llama.cpp is planned** as a direct self-host engine via its OpenAI-compatible `llama-server` — finer-grained control over quantization, batching, and resource limits.

| Tier            | Provider              | Status      | Registry key                     | Typical models                                      | Implementation                                                                            |
| --------------- | --------------------- | ----------- | -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Self-hosted** | **LM Studio**         | ✓ current (default) | `lm-studio` / `openai_compat`    | `lmstudio-community/gemma-4-E4B-it-QAT-GGUF` (default), `qwen3.5-0.8b` | OpenAI-compatible local endpoint; default local LLM engine                  |
| Self-hosted     | **Ollama**            | ✓ current (optional) | `ollama`                         | `qwen3.5:2b`, `granite4:latest` (tests)             | httpx + NDJSON streaming via `/api/generate`; built on llama.cpp; optional/lower-priority |
| Self-hosted     | **OpenAI-Compatible** | ✓ current   | `openai_compat`                  | vLLM, TGI, Groq-self-host, Together-self-host       | Any `/v1/chat/completions` endpoint                                                       |
| Self-hosted     | **llama.cpp**         | _(planned)_ | `openai_compat` (`llama-server`) | Any gguf-quantized open-weights LLM                 | Primary direct self-host engine; OpenAI-compatible HTTP; CPU / CUDA / Metal               |
| **Managed**     | **Azure OpenAI**      | ✓ current   | `azure-openai` / `azure`         | `gpt-4`, `gpt-4o-mini`, `gpt-4-turbo`               | `AsyncAzureOpenAI` from `openai` SDK; API version `2024-12-01-preview`                    |
| Managed         | **AWS Bedrock**       | ✓ current   | `bedrock`                        | `anthropic.claude-3-haiku-20240307-v1:0` and family | boto3 `converse` / `converse_stream` via `asyncio.to_thread`; supports Bedrock Guardrails |

**Not implemented:** Gemini, native OpenAI (non-Azure). The legacy v1 README mentions these; they are not in the v2 source.

### Streaming Architecture

- **Sync** (`stream: false`): blocks until LLM returns, full content in one JSON body.
- **Async / streaming** (`stream: true`): returns HTTP 202 + `task_id`. Generation runs as a FastAPI `BackgroundTask`; chunks stream to a **Redis Stream** via `TaskManager.append_chunk()`. Consumers connect to `GET /api/v1/tasks/{task_id}/stream` (SSE backed by `XREAD BLOCK`) and can **resume** from a `Last-Event-ID` cursor on network drop. WebRTC DataChannel _(planned)_ replaces SSE for environments where WebRTC is available; SSE remains as fallback.

### Prompt Templates (Application Layer)

Templates live in PostgreSQL as `PromptTemplate` rows.

| Field                | Behavior                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Categories           | `SYSTEM` · `SUMMARY` · `DNA_ANALYSIS` · `CUSTOM`                                                                                                                                                      |
| Lifecycle            | `DRAFT` → `PUBLISHED` with full version history                                                                                                                                                       |
| Resolution chain     | (1) department-level prompt IDs (`newPatientPromptId`, `revisitPromptId`, `preSummaryPromptId`); (2) `CATCHALL_SOAP` system default (ID `71000000-0000-0000-0000-000000000036`) — guaranteed fallback |
| Variable regex       | `/{([a-zA-Z_][\w-]*)}/g`                                                                                                                                                                              |
| Transcript injection | Auto-injected if not already referenced in the template                                                                                                                                               |
| Per-template config  | JSON schema + hyperparameters carried in `template.metaData.promptConfig`                                                                                                                             |

Variables the `PromptAssemblyService` knows about:

| Variable                                    | Carries                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `{conversation_language}`                   | Detected / declared consultation language                           |
| `{pre_summary_text}`                        | Pre-consultation context (e.g. triage notes)                        |
| `{same_day_prequel_summary}`                | Earlier same-day visits, if any                                     |
| `{style_DNA_doctor_department_<specialty>}` | Doctor's learned writing style (one variable per of 11 specialties) |
| (transcript)                                | Auto-injected if not already present                                |

### DNA Writing Style

| Step | Behavior                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 1    | BullMQ job queued (`JobQueue.GenerateDnaReport`)                                                       |
| 2    | Fetch doctor's past `ContextItem` records, types `RAW_SUMMARY                                          |
| 3    | Up to 50 samples (`dna-regen.max-samples`), capped at 100,000 chars (`dna-regen.max-context-chars`)    |
| 4    | Load `DNA_ANALYSIS` category template from DB                                                          |
| 5    | Call `POST /api/v1/generate` on SMR-V2 — raw text-to-text                                              |
| 6    | Parse response → `reportData` (structured) + `styleText` (free-text); store in `DnaWritingStyleReport` |
| 7    | Create versioned snapshot + `DnaUsageRecord`                                                           |
| 8    | SSE progress: `GET /dna-writing-styles/jobs/:jobId/stream`                                             |

**Injection at summary time:** When `dnaStyleId` is passed to `PromptAssemblyService.assemble()`, it loads the report's `styleText` and populates every `{style_DNA_doctor_department_*}` variable in the prompt template.

**SDK exposure:** `useDnaStyle()` React hook → `generate()`, `getMyStyle()`, `update()`, `getVersions()`, `pollJobStatus()`, `streamJobStatus()`. The legacy `useArcaSummary.analyzeDNA()` is `@deprecated` and throws at runtime.

### Guardrails

| Direction | Implementation                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound   | `PromptInjectionScanner` (pre-compiled regex). Detects `[INST]`, `<<SYS>>`, `<                                                          |
| Outbound  | Leak scanner for OpenAI keys (`sk-`_), AWS keys (`AKIA`_), private key headers                                                          |
| Bedrock   | Native AWS Bedrock Guardrails passthrough (`guardrail_id`, `guardrail_version` configurable); `guardrail_intervened` stop reason logged |

### Resilience & Concurrency

| Mechanism                    | Limits                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **Per-provider concurrency** | Azure 10 · Bedrock 10 · Ollama 4 · OpenAI-compat (incl. LM Studio) 4             |
| **Global rate-limit queue**  | `RateLimitTracker` (TPM + RPM) + `ProviderQueue` (max 200 slots, 60 s max wait)  |
| **Circuit breaker**          | Per provider: 5-failure threshold · 30 s recovery · half-open with 3 probe calls |
| **Retry**                    | Up to 3 attempts · exponential backoff · only on timeout or `provider_error`     |
| **Structured outputs**       | `response_format: json_schema` validates JSON shape before returning             |

### Observability

| Surface           | Detail                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **Prometheus**    | Generation count, latency, time-to-first-token, token counts, circuit breaker state, queue size              |
| **OpenTelemetry** | Spans on every `generate` / `generate_stream` call with `gen_ai.`\* semantic conventions; OTLP gRPC exporter |
| **Logging**       | Structured JSON via `structlog`                                                                              |

---

## 4. Companion Services — NER, Guardrail, TTS

Three companion services extend the core transcription → summarization flow with structured entity extraction, safety validation, and synthesized speech output. They communicate with the API Gateway over internal HTTP (and WebSocket for the streaming surfaces) and can be invoked independently by any client that holds the appropriate token.

### 4.1 Medical Named Entity Recognition

NER is exposed in two complementary places: an **in-browser plugin** (`@arcaai/med-ner`) for real-time entity extraction during live transcription, and a **backend NLP service** for higher-fidelity batch extraction plus auxiliary classification and correction.

#### `@arcaai/med-ner` — In-Browser Plugin

| Property               | Value                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Runtime                | Browser ES Module + dedicated Web Worker                                                     |
| Library                | `@huggingface/transformers ^3.8.1` (Transformers.js)                                         |
| Inference              | WebGPU (FP16) → multi-threaded WASM → WASM (graceful fallback)                               |
| Default model          | `blaze999/Medical-NER` (BERT-based BIO token classification)                                 |
| Integration            | `@arcaai/room` `ProcessorPipeline` plugin; consumes finalized transcripts from `@arcaai/stt` |
| Output                 | Array of `{ text, entity_type, confidence, position: { start, end } }` per utterance         |
| Default entity classes | DISEASE · SYMPTOM · MEDICATION · DOSAGE · FREQUENCY · ANATOMY · PROCEDURE · LAB_VALUE        |
| Workload               | Idempotent per transcript chunk — safe to re-run on partial updates                          |

#### NLP / Medical NER Service — Backend

A FastAPI service exposing batch and streaming NER plus three auxiliary capabilities.

| Property     | Value                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Runtime      | Python 3.11+ · FastAPI · Uvicorn · UV package manager                                                |
| Conda env    | `arcaenv`                                                                                            |
| ML framework | `transformers` + `torch` (CPU or CUDA, FP16 on GPU)                                                  |
| Capabilities | Token classification (NER) · Text classification · Diagnosis suggestion · Spelling / term correction |
| Concurrency  | 10–50 concurrent requests per instance; batch up to 100 texts                                        |
| Streaming    | WebSocket endpoint for real-time classification on incoming transcripts                              |
| Languages    | English, Malayalam (extensible via dictionaries)                                                     |

##### Models

| Capability           | Model                                   | Notes                                                       |
| -------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Medical NER          | `blaze999/Medical-NER`                  | BERT-based BIO token classification                         |
| Diagnosis suggestion | `shanover/symps_disease_bert_v3_c41`    | 41 disease classes; symptom-to-condition ranking            |
| Text classification  | `michellejieli/emotion_text_classifier` | 11 emotion categories; used for clinical tone analysis      |
| Spelling correction  | SymSpellPy + medical dictionaries       | Configurable edit distance, prefix length, suggestion limit |

---

### 4.2 Guardrail Service

Standalone safety service that other services (or the API Gateway) call before processing user input. Two-tier capability:

- **Primary — Guardian Model (Medical Context Validation):** Validates whether incoming text is medical-related before routing it to downstream STT, NLP, or SMR pipelines. Cuts wasted compute and prevents off-domain usage.
- **Secondary — Content Safety:** Detects harmful or dangerous content, personally identifiable information (PII), and prompt-injection attempts.

| Property         | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Runtime          | Python 3.11+ · FastAPI · Uvicorn                                                  |
| Conda env        | `arcaenv`                                                                         |
| Inference path   | llama.cpp/Ollama/LMStudio (Guardian model) + for content safety / PII / injection |
| Job queue        | Redis (sync direct API + async job submission)                                    |
| Default model    | `meta-llama/Prompt-Guard-86M`                                                     |
| Processing modes | Real-time (sync) · async (Redis-queued, batch-friendly)                           |
| Audit            | Per-request audit log of every validation decision                                |

#### Guardrail Types

| Type               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `content_safety`   | Detect harmful, abusive, or dangerous content                            |
| `pii_detection`    | Identify personally identifiable information                             |
| `prompt_injection` | Detect attempts to manipulate the system prompt or override instructions |
| `comprehensive`    | All three checks combined; recommended default                           |

---

### 4.3 Text-to-Speech Service _(planned)_

The platform reserves a Text-to-Speech surface for patient-facing readouts (summary playback, multilingual handover, accessibility), but the service is **not yet implemented**. Today's footprint:

| Present                                                  | Not yet present                                                |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `TtsGateway` stub in the API Gateway WebSocket layer     | Backend FastAPI service                                        |
| Health monitoring endpoints expecting TTS                | TTS model serving (Piper / Coqui / XTTS / Azure TTS / similar) |
| Service status panel surfaced in the UI                  | Voice catalog persistence                                      |
| Reserved `TTS_URL` configuration slot in API Gateway env | Per-tenant voice selection                                     |

#### Planned Capabilities

| Capability          | Notes                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| Streaming synthesis | Phrase-by-phrase audio over WebRTC DataChannel / WebSocket                     |
| Multi-engine        | Self-hosted (Piper / Coqui / XTTS) + managed (Azure TTS / AWS Polly)           |
| Voice catalog       | Per-tenant catalog with locale, gender, persona presets                        |
| Style continuity    | Optional voice cloning from doctor voice profiles (subject to consent + audit) |
| Output formats      | PCM 16 kHz mono · Opus over WebRTC · WAV download                              |

Like the rest of the platform, TTS will be **provider-portable** — a single internal abstraction backed by self-hosted and managed engines, selected per request or per tenant policy.

---

## 5. MLOps and Model Lifecycle _(planned)_

The historic MLflow API-Gateway proxy was removed in SDK-207 when prompt and DNA management migrated to PostgreSQL-native modules. Infrastructure remains partially provisioned (MinIO `mlflow` bucket, `AiModelEntity.isMLFlow` source flag, STT-V2 settings stubs disabled by default). The next investment stands up self-hosted MLflow as the unified MLOps plane for all model-serving backends.

### Capabilities (planned)

| Capability              | What it provides                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Experiment tracking** | Every fine-tune / evaluation run logs params, metrics, code revision, environment, and artifacts                                           |
| **Model registry**      | Versioned model lineage with `None → Staging → Production → Archived` transitions; serving backends load by alias, not by file name        |
| **Dataset versioning**  | Training and evaluation corpora versioned with hashed content lineage; any reported metric is traceable to the exact data that produced it |
| **Artifact storage**    | Model files in self-hosted MinIO (S3-compatible) under the `mlflow` bucket, referenced from the registry                                   |
| **Lineage**             | Each registered model carries lineage back to its training run, dataset version, and the prior model version it replaced                   |

### Model Lifecycle Flow _(planned)_

```
  Explore (LM Studio · Ollama · llama.cpp · Azure playground)
       ↓
  Fine-tune (HF Transformers · Unsloth · axolotl · Azure ML)
       ↓
  Track (MLflow Tracking — params · metrics · lineage)
       ↓
  Register (MLflow Registry → Stage = Staging)
       ↓
  Promotion gate (Evaluation harness must pass:
                  WER · DER · faithfulness · latency)
       ↓                                              ↓
  Production — Self-hosted:                      Production — Managed cloud:
    whisper.cpp · llama.cpp (llama-server)         Azure Speech · Azure OpenAI · AWS Bedrock
    Ollama · LM Studio · ONNX / PyTorch            (Azure ML Registry federated with MLflow)
       ↓                                              ↓
  Observe (Prometheus + OpenTelemetry · per-model latency / cost · drift detection)
       ↓
  Rollback (MLflow alias re-points to prior Production version — no code redeploy)
```

### Tooling per Stage _(planned)_

| Stage                             | Self-Hosted Path                                        | Managed-Cloud Path                                   |
| --------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| **Explore / try a model**         | LM Studio (GUI) · Ollama (CLI) · llama.cpp direct       | Azure OpenAI playground · AWS Bedrock playground     |
| **Fine-tune / customize**         | HuggingFace Transformers · Unsloth · axolotl            | Azure ML (managed fine-tuning) · Azure AI Studio     |
| **Track experiments**             | MLflow Tracking (self-hosted)                           | MLflow on Azure ML (Azure-native, MLflow-compatible) |
| **Register versions**             | MLflow Model Registry                                   | Azure ML Model Registry (federated with MLflow)      |
| **Serve in production — Whisper** | whisper.cpp (gguf) · Whisper ONNX / PyTorch             | Azure Speech Service                                 |
| **Serve in production — LLM**     | llama.cpp (`llama-server`) · Ollama · OpenAI-compatible | Azure OpenAI · AWS Bedrock                           |
| **Monitor**                       | Prometheus + OpenTelemetry (existing stack)             | Same; cloud-native metrics surfaced through OTel     |
| **Rollback**                      | MLflow alias / stage transition                         | MLflow alias + cloud deployment slot                 |

The lifecycle is **provider-portable** by design. The same gguf or safetensors artifact tracked in MLflow can be served through llama.cpp on-premise, through Ollama on a developer's laptop, through Azure OpenAI for managed cloud, or through any OpenAI-compatible endpoint — without code changes. Promotion in the registry decides which backend pulls which version.

---

## 6. Engineering Harness Roadmap _(planned)_

Scaffolding that makes every model change, every prompt revision, and every provider addition a low-risk operation.

| Harness                          | Purpose                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evaluation**                   | Automated metrics — WER / CER and clinical-vocabulary-weighted WER (STT), DER + confusion matrix (diarization), ROUGE / BERTScore + LLM-as-judge faithfulness (summarization), P50/P95 latency. Logged to MLflow; gates `Staging → Production` promotion. |
| **Regression / Replay**          | Library of consented, PHI-scrubbed real-world audio replayed end-to-end through each candidate version. Catches regressions on the audio doctors actually produce, not just public benchmarks.                                                            |
| **Shadow / Canary Deployment**   | Mirrors a fraction of live traffic to a candidate version and compares outputs without surfacing them. Statistically significant divergences block promotion automatically.                                                                               |
| **Synthetic Data**               | PHI-safe corpus generator covering rare scenarios (rare drug names, deliberate ambiguity, code-switching mid-sentence) without touching real patient data.                                                                                                |
| **Provider Conformance**         | Contract test suite every supported LLM provider must pass: streaming semantics, structured-output behavior, retry / rate-limit handling, guardrail interaction. Adding a new provider becomes "pass the conformance suite".                              |
| **Tenant Smoke-Test**            | Nightly end-to-end exercise per tenant: synthetic audio → backend STT → API Gateway prompt assembly → SMR-V2 summary, against that tenant's actual templates and DNA styles.                                                                              |
| **Voice Profile QA**             | Validates enrolment intra-sample similarity (already enforced at runtime), tracks embedding drift across re-enrollments, flags profiles whose match rate degrades.                                                                                        |
| **Cost & Latency Observability** | Per-provider / per-tenant / per-model dashboards over the existing Prometheus / OpenTelemetry stack, with anomaly detection on token usage and latency regressions.                                                                                       |

---

## 7. Product Roadmap — Engineering Integration

Product-facing items integrate with the existing architecture rather than replace it. None requires breaking changes to the pipelines, the LLM gateway interface, or the SDK's public surface.

| Roadmap item                           | Integration point                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation Memory**                | Sits alongside `ContextItem` records in PostgreSQL with `vector(N)` embeddings for semantic recall. Feeds `PromptAssemblyService` through new variables (e.g. `{recall_memory}`). Lifecycle mirrors `DnaWritingStyleReport` versioning.                                                   |
| **Deep Finding Analytics**             | Built on memory + existing `ContextItem` / consultation history. Vector similarity for pattern matching; SMR-V2 for trend synthesis; new analytics endpoints on the API Gateway with the same per-tenant guardrails.                                                                      |
| **Real-Time Medical NER + Correction** | `@arcaai/med-ner` (in-browser, Transformers.js Web Worker) and the NLP / Medical NER backend are both already shipped (§4.1). The planned addition is live transcription integration — inline streaming entity annotation and grammar correction reusing Cadence's bidirectional pattern. |
| **Guardrail Enhancement**              | Builds on the standalone Guardrail Service (§4.2). LLM-as-judge moderation as an additional SMR-V2 step (same `log` / `block` mode as the prompt-injection scanner). PHI / PII redaction as an outbound regex + NER hybrid. Per-tenant policy packs declarative (YAML / JSON).            |
| **WebRTC Transport**                   | Replaces WebSocket (audio uplink) and SSE (result downlink) with a single multiplexed PeerConnection. SDK contract (`TranscriptionResult`, lifecycle events, reserved-speaker semantics) unchanged. SSE remains as fallback.                                                              |
