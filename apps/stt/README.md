# STT — Speech-to-Text service

Python/FastAPI service (port **8861**, package `stt`) providing live streaming
transcription, batch transcription, voice activity detection and speaker
diarization for the HOPE platform. The gateway (`apps/api`) fronts every route;
browsers reach transcription and streaming only through it. Batch jobs run on a
separate Dramatiq worker process (`pnpm stt:worker:dev`).

## Layout

```
apps/stt/
|-- src/stt/
|   |-- main.py                # create_app() + lifespan (FastAPI entrypoint, `stt.main:app`)
|   |-- worker.py               # Dramatiq worker entrypoint (`stt.worker`)
|   |-- core/
|   |   |-- config/settings.py  # Settings (pydantic-settings, no env_prefix)
|   |   |-- control_plane.py    # Settings field -> control-plane registry key map
|   |   |-- middleware/auth.py  # ServiceAuthMiddleware (X-Service-Token)
|   |   |-- database/           # SQLAlchemy, read-only, OFF by default (STT_DATABASE_ENABLED)
|   |   |-- messaging/           # Dramatiq broker setup
|   |   `-- storage/            # MinIO / S3 / Azure Blob client
|   |-- pipeline/spec.py        # ResolvedAsrSpec — the gateway-resolved runtime contract
|   |-- processors/             # (kind, name) engine registry (registry.py, asr_capabilities.py, asr_engines.py)
|   |-- vad/                    # Silero VAD v5 (ONNX), streaming + batch
|   |-- diarization/            # Pluggable speaker embedding + in-memory, session-scoped tracking
|   |-- punctuation/             # Cadence-Fast punctuation restoration (direct transformers loader)
|   |-- streaming/               # Session manager, engine switch (fallback), Redis Streams transport
|   |-- transcription/          # Batch service, Dramatiq workers
|   |-- voice_profile/           # Cross-session speaker identity (Postgres voice profiles)
|   `-- models/                 # Model loaders (HF, ONNX, Azure Speech, NeMo, ggml, Azure Foundry)
|-- tests/{unit,integration,e2e}/
|-- docker/{Dockerfile,Dockerfile.apple}
|-- Makefile                    # local conda-based setup/test/lint targets
`-- pyproject.toml
```

> **Speaker identity & persistence.** Diarization is **in-memory and
> session-scoped**: within a consultation a `SpeakerTracker` assigns and
> matches speakers with no external vector store. **Cross-session** speaker
> identity is persisted via **PostgreSQL voice profiles** — at session start
> `diarization.preseed.preseed_speaker()` loads the doctor's stored voice
> embedding and registers it. There is no Qdrant-backed speaker store; `stt`
> has no `core/vectorstore` module by design.

## Commands

| Command | Effect |
|---|---|
| `pnpm stt:setup` / `:cpu` / `:apple` / `:gpu` | Install this service into conda env `arcaenv` for the given platform |
| `pnpm stt:dev` | `scripts/dev-service.sh stt` — uvicorn on `:8861` |
| `pnpm stt:dev:watch` | Same, with reload |
| `pnpm stt:worker:dev` | `scripts/dev-service.sh stt-worker` — the Dramatiq worker process |
| `pnpm stt:test` | `pytest apps/stt/tests/` |
| `pnpm stt:test:unit` / `:integration` / `:e2e` | Scoped pytest runs |
| `pnpm stt:test:cov` | With coverage |
| `pnpm stt:lint` / `:lint:fix` | ruff |
| `pnpm stt:typecheck` | mypy |
| `pnpm stt:format` / `:format:check` | black |

Local alternatives (from `apps/stt/`, conda env `arcaenv` active): `make lint`,
`make format`, `make type-check`, `make quality` (all read `src/` and `tests/`
directly). The Makefile's `docker-test-*` and `dev-up`/`dev-down` targets
reference `docker/docker-compose.dev.yml` / `docker/docker-compose.test.yml`,
neither of which exists in this directory — do not use them. For local
infrastructure use the monorepo root's `pnpm infra:dev:up` / `pnpm
infra:test:up` (`09-infrastructure-devops.md`).

Installing ML dependencies: `pip install -e ".[ml,dev,test]"` (CPU/Apple
Silicon) or `".[ml-gpu,dev,test]"` (NVIDIA CUDA) from `apps/stt/`, inside
`arcaenv`. `pyannote.audio` 4.x hard-pins `torch==2.8.0`/`torchaudio==2.8.0` —
do not upgrade torch past 2.8.x while it is installed.

## How it works

**Selection arrives from the gateway, this service reads no Postgres for it
(TASK-861).** Every streaming session and every batch job carries a
`ResolvedAsrSpec` (`src/stt/pipeline/spec.py`, the pydantic mirror of
`packages/types/src/asr-spec.ts`, parity-pinned against the committed fixture
`tests/contracts/resolved-asr-spec.fixture.json`) with the ASR/VAD/denoise/
diarization/embedding models already resolved to a local path, format and
compute type, plus decoding parameters and the fallback chain
(`AsrSpecFallback`). `session_manager` and the batch worker build their
callables from the spec; there is no `AsrPipeline`/`AiModel` SQL lookup on this
path. The read-only SQLAlchemy connection is therefore **optional and off by
default** (`STT_DATABASE_ENABLED` — a bare, unprefixed name; `Settings` carries
no `env_prefix`), used only by the deprecated `pipeline_id` readers and the
voice-profile / initial-prompt readers.

**`Settings` carries no `env_prefix`.** Every field resolves to its bare
uppercased name (`PORT`, `HOST`, `DEBUG`, `LOG_LEVEL`, `DATABASE_URL`, ...);
several fields also accept an `STT_`-prefixed alias first (e.g. `STT_PORT`
before `PORT`). Default port is `8861`.

**Most tuning knobs are control-plane-owned, not real env vars.** VAD
thresholds, worker thread/retry counts, diarization device, punctuation
device/cache-dir/max-length, and the model-cache size/TTL are declared as
`Settings` fields with a `moved_alias(...)` validation alias — a dead name
like `VAD_THRESHOLD__MOVED_TO_CONTROL_PLANE` — so the bare env var no longer
binds. Their real value is pulled once at boot from the gateway's
effective-config route (`refresh_settings_from_control_plane`,
`core/runtime_limits.py`) and kept fresh by a Redis pub/sub invalidation
listener (`arca:config:invalidate`), not by polling. Bootstrap-only real env
vars still worth setting locally: `DATABASE_URL`, `REDIS_URL`, `MINIO_*`,
`API_GATEWAY_URL`, `API_GATEWAY_KEY`, `INTERNAL_ACCESS_TOKEN`,
`HUGGINGFACE_CACHE_DIR`.

**No cloud ASR engine has an env var.** Azure Speech, Azure AI Foundry, Sarvam
and OpenAI are BYOK: the key, region/endpoint/base URL, and whether the engine
is available at all come from the tenant's `AiProviderConnection` row (or the
SYSTEM row as the platform default). `HUGGINGFACE_TOKEN` moved the same way,
to the `model-registry:huggingface` connection — its `Settings` field carries
a dead validation alias and `populate_by_name` off, so no env var can
re-open it.

**Inbound auth.** `ServiceAuthMiddleware` (`core/middleware/auth.py`) requires
`X-Service-Token` on every route except `/metrics`, `/api/v1/docs`,
`/api/v1/redoc`, `/api/v1/openapi.json`, `/api/v1/health(/live|/ready)` and
`/api/v1/live`, `/api/v1/ready`. The accepted token is the single shared
`INTERNAL_ACCESS_TOKEN`; empty => auth bypassed, but only in a local/dev
environment. A deployed process with no token configured logs an error at
boot and rejects everything non-exempt.

**Engine registry.** Registry name -> runtime, from
`processors/asr_capabilities.py`. Engine names are `AiModelFormat` values
lowercased, so YAML/spec engine strings and registry keys are one vocabulary:

| Registry name | Runtime | Notes |
|---|---|---|
| `faster_whisper` | CTranslate2 | Fast CPU/CUDA Whisper, batch + stream |
| `onnx` / `onnx_optimum` | ONNX Runtime | Offline CPU/GPU (`optimum` adds streaming) |
| `whisper_cpp` | ggml (pywhispercpp) | GGUF, CPU/Metal/CUDA offline |
| `safetensor` | PyTorch/Transformers | CUDA/MPS/CPU HF models |
| `nemo` | PyTorch (NeMo) | Parakeet, CUDA GPUs |
| `parakeet_cpp` | ggml quantized | CPU/Metal/CUDA Parakeet |
| `azure_speech` | REST/WebSocket | Cloud, BYOK |
| `azure_foundry` | Cloud (batch) | Azure AI Foundry (MAI), BYOK |
| `sarvam` | REST | Indic languages + English, BYOK |
| `openai` | REST | `gpt-4o-transcribe` family, BYOK |

**Per-tenant BYOK + fallback.** `azure_speech`, `sarvam` and `openai` accept a
per-tenant credential override (`provider_overrides`, keyed by
`azure-speech`/`sarvam`/`openai`): the streaming session-create request
carries it in-memory (never persisted/logged), and the Dramatiq batch worker
pulls it via the gateway's `GET /internal/stt/provider-overrides`
(`core/effective_config.py`). A tenant's `ResolvedAsrSpec.fallback` names a
one-way fallback engine; `streaming/engine_switch.py`'s `EngineSwitchController`
swaps a live session onto it on a classified outage (auth/quota immediately,
transient after N consecutive failures) or a manual
`POST /internal/streaming/sessions/{id}/switch`, publishing a `status`/
`provider_switched` result on the session's result stream. `transcribe_file`
re-dispatches once onto the fallback within the same Dramatiq attempt.

**Diarization backend.** Embedding + in-memory clustering
(`pyannote/wespeaker-voxceleb-resnet34-LM`, 256-dim, or SpeechBrain
ECAPA-TDNN, 192-dim, selected by a `speechbrain/*` model id) is the only
backend: `ResolvedAsrSpec.audioFrontEnd.diarization.backend` accepts `embedding`
alone, and a spec or legacy pipeline YAML naming anything else is refused, never
coerced. The self-hosted NeMo Streaming Sortformer backend was retired by
TASK-980 — its checkpoint was a code literal no agent could select, and the
production image carries no NeMo to run it.

**Punctuation restoration (Cadence).** `punctuation/cadence_fast.py` loads
`ai4bharat/Cadence-Fast` directly via `transformers` under the exact model
name `cadence-fast` — the `cadence-punctuation` wrapper package (selected by
the legacy names `Cadence` / `Cadence-Fast`) cannot load under the pinned
transformers 5.x, so a session whose agent binds a punctuation model under
any name other than the exact `cadence-fast` string silently gets no
punctuation restoration rather than an error. Enable/placement/cache-dir are
control-plane- or agent-owned, not a single global env flag.

### API endpoints
Health lives under `/api/v1`; internal, transcription, streaming and
voice-profile routers mount their own prefixes.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/health` `/health/live` `/health/ready` | Health / liveness / readiness |
| `GET` | `/api/v1/ready` `/api/v1/live` | Aliases |
| `GET` | `/metrics` | Prometheus metrics |
| `GET`/`POST` | `/internal/cache/*` | Model cache stats / clear / per-model entry |
| `GET`/`POST` | `/internal/pipelines/loaded`, `/internal/sessions*`, `/internal/streaming/status` | Runtime inventory (service-token gated) |
| `GET`/`POST` | `/api/v1/internal/models/resolvable` | Runtime resolvability probe for the gateway readiness sweep |
| — | `/internal/streaming/*` | Session create/switch (gateway-only) |
| — | `/internal/voice-profile/*` | Voice profile enrollment (gateway-only) |

## Gotchas

- `pyannote.audio` 4.x hard-pins `torch==2.8.0`/`torchaudio==2.8.0`; do not let
  pip drift either package past 2.8.x while it is installed.
- FFmpeg must be `>=6,<7` — `torchcodec` (a `pyannote.audio` dependency) links
  against `libavutil.58`; FFmpeg 7/8 breaks it. On Apple Silicon the conda
  activation script sets `DYLD_LIBRARY_PATH`; if `torchcodec: Could not load
  libtorchcodec` appears, re-run `conda activate arcaenv` or export it by hand.
- A punctuation model bound under `Cadence` or `Cadence-Fast` (rather than the
  exact string `cadence-fast`) loads the `cadence-punctuation` wrapper, which
  cannot load under the pinned transformers 5.x — text passes through
  unpunctuated with no error surfaced per request.
- `STT_DATABASE_ENABLED=false` (the default) makes `initialize_database()` a
  no-op; the deprecated `pipeline_id` readers then fail closed with a named
  `DatabaseDisabledError` rather than hanging.
- `HUGGINGFACE_TOKEN` and `DIARIZATION_HF_MODEL_ID`-style env vars are GONE —
  setting them has no effect; the values now come from the resolved spec's
  models and the `model-registry:huggingface` `AiProviderConnection`.
- The legacy Qdrant collection `stt_speaker_embeddings`, if still provisioned
  in an environment, is unused by this service — its absence is not a defect.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — FastAPI service conventions, env loading, gateway integration
- [`01-development-workflow.md`](../../.claude/rules/01-development-workflow.md) — layer gates, test placement
- [TASK-861 README](../../docs/implementation/TASK-861-Audio-Pipeline-Retirement/README.md) — the ResolvedAsrSpec cutover
- [TASK-880 README](../../docs/implementation/TASK-880-Asr-Remainder-Moves/README.md) — env-to-control-plane/row moves
- [TASK-887 README](../../docs/implementation/TASK-887-Diarization-Agent-Option/README.md) — diarization as an agent option
- [`apps/api` README](../api/README.md) — the gateway that resolves and injects the spec
