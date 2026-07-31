"""Application settings using Pydantic Settings."""

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from hope_env import hope_settings_sources, load_env, register_settings_cache
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_ROOT = Path(__file__).resolve().parents[4]  # …/apps/stt
# Service-local overlay, ranked BELOW os.environ by pydantic-settings and so
# below both the host env and the root `.env.<env>` the shared loader applies.
# Retained because API_GATEWAY_KEY has no declaration in the root env files yet
# (TASK-558 lane D owns moving it there).
_ENV_FILE = _SERVICE_ROOT / ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE) if _ENV_FILE.is_file() else None,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "stt"
    app_version: str = "2.0.0"
    debug: bool = False
    host: str = "0.0.0.0"
    port: int = 8861
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    @field_validator("log_level", mode="before")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        """Accept case-insensitive log level values (e.g. 'info' -> 'INFO')."""
        if isinstance(v, str):
            return v.upper()
        return v

    # CORS
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])

    # Database (read-only)
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/hope",
        description="PostgreSQL connection string (read-only access)",
    )
    database_pool_size: int = 5

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Normalize Prisma-style postgres:// URLs to asyncpg format.

        Handles two Prisma conventions that are incompatible with SQLAlchemy/asyncpg:
        1. postgres:// scheme (asyncpg needs postgresql+asyncpg://)
        2. ?schema=public query param (Prisma-specific, rejected by asyncpg)
        """
        if isinstance(v, str):
            if v.startswith("postgres://"):
                v = v.replace("postgres://", "postgresql+asyncpg://", 1)
            elif v.startswith("postgresql://") and "+asyncpg" not in v:
                v = v.replace("postgresql://", "postgresql+asyncpg://", 1)

            from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

            parsed = urlparse(v)
            if parsed.query:
                params = parse_qs(parsed.query)
                params.pop("schema", None)
                cleaned_query = urlencode(params, doseq=True)
                v = urlunparse(parsed._replace(query=cleaned_query))
        return v

    database_max_overflow: int = 10

    # Redis (Dramatiq broker)
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection string for Dramatiq",
    )

    # MinIO (Object storage)
    minio_endpoint: str = "localhost:9000"
    minio_access_key: SecretStr = SecretStr("minio_admin")
    minio_secret_key: SecretStr = SecretStr("minio_admin")
    minio_secure: bool = False
    minio_cert_check: bool = True
    minio_audio_bucket: str = "hope-audio"
    minio_chunk_bucket: str = "hope-audio-chunks"

    @field_validator("minio_endpoint", mode="before")
    @classmethod
    def _default_minio_endpoint_when_blank(cls, v: str) -> str:
        """`MINIO_ENDPOINT` is deliberately blank in the shared env file — it's
        apps/api's bootstrap-fallback tier (empty until the SYSTEM storage row
        exists), and apps/api treats a blank value as absent. Do the same here
        instead of passing "" straight to the MinIO client.
        """
        if isinstance(v, str) and not v.strip():
            default = cls.model_fields["minio_endpoint"].default
            assert isinstance(default, str)
            return default
        return v

    # Object storage provider (platform default for the no-descriptor path).
    # Per-tenant requests may override this via a `storage` descriptor.
    storage_provider: Literal["minio", "aws_s3", "azure_blob"] = Field(
        default="minio",
        description=(
            "Default object-storage provider when no per-tenant storage "
            "descriptor is supplied. The default keeps using the global MinIO "
            "client unless set to 'azure_blob'."
        ),
    )
    azure_storage_account: str = Field(
        default="",
        description="Default Azure storage account name (used when STORAGE_PROVIDER=azure_blob).",
    )
    azure_storage_account_key: SecretStr = Field(
        default=SecretStr(""),
        description="Default Azure storage account shared key.",
    )
    # A connection string embeds `AccountKey=…`, so it is a credential in full.
    azure_storage_connection_string: SecretStr = Field(
        default=SecretStr(""),
        description="Default Azure connection string (preferred over account/key when set).",
    )
    azure_storage_endpoint_suffix: str = Field(
        default="core.windows.net",
        description="Default Azure storage endpoint suffix.",
    )

    # API Gateway (internal communication)
    api_gateway_url: str = Field(
        default="http://localhost:8868/api/v1",
        description="Internal API Gateway URL",
    )
    api_gateway_key: SecretStr = Field(
        default=SecretStr(""),
        description="Internal service authentication key",
    )
    api_gateway_timeout: int = 30

    # Model Cache
    # The two fields below are BOOTSTRAP FALLBACKS; their runtime values come
    # from the control plane (effective-config → ModelCache.apply_retention).
    model_cache_max_models: int = Field(
        default=5,
        description=(
            "Maximum number of models in LRU cache. Bootstrap fallback — the runtime "
            "value comes from the control plane (effective-config)."
        ),
    )
    model_cache_ttl_seconds: int = Field(
        default=3600,
        ge=60,
        le=3600,
        description=(
            "Idle TTL for cached models in seconds (product clamp: "
            "min 60s / max 3600s). Active sessions pin models so TTL applies "
            "only after the last release. Bootstrap fallback — the runtime value "
            "comes from the control plane (effective-config); the clamp is "
            "re-applied to whatever is served."
        ),
    )

    # HuggingFace
    huggingface_cache_dir: str = Field(
        default_factory=lambda: os.environ.get("HF_HOME")
        or os.path.expanduser("~/.cache/huggingface/hub"),
        description="HuggingFace model cache directory",
    )
    huggingface_token: SecretStr | None = Field(
        default=None,
        description="HuggingFace API token (optional)",
    )

    # Bootstrap credentials for `s3://` model sources (MinIO-compatible).
    # All optional: unset simply means an `s3://` source_uri errors cleanly rather
    # than silently falling back. This `Settings` class carries NO env_prefix, so
    # the documented `STT_MODEL_S3_*` names are wired via explicit aliases —
    # every service shares one env file, and un-prefixed names would collide.
    model_s3_endpoint: str | None = Field(
        default=None,
        validation_alias=AliasChoices("STT_MODEL_S3_ENDPOINT", "STT_V2_MODEL_S3_ENDPOINT"),
        description="S3/MinIO endpoint (host:port) backing s3:// model sources",
    )
    model_s3_access_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("STT_MODEL_S3_ACCESS_KEY", "STT_V2_MODEL_S3_ACCESS_KEY"),
        description="Access key for s3:// model sources",
    )
    model_s3_secret_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("STT_MODEL_S3_SECRET_KEY", "STT_V2_MODEL_S3_SECRET_KEY"),
        description="Secret key for s3:// model sources",
    )
    model_s3_secure: bool = Field(
        default=True,
        validation_alias=AliasChoices("STT_MODEL_S3_SECURE", "STT_V2_MODEL_S3_SECURE"),
        description="Use TLS for the s3:// model endpoint (set false for local MinIO)",
    )

    @field_validator("huggingface_cache_dir", mode="before")
    @classmethod
    def _resolve_huggingface_cache_dir(cls, v: object) -> str:
        """Never let the HuggingFace cache dir collapse to an empty string.

        An explicitly-empty value (e.g. ``HUGGINGFACE_CACHE_DIR=`` in a .env
        file, or an env var set to ``""``) must be treated as *unset*. If it
        is allowed through, ``os.makedirs("")`` in the model loaders raises
        ``FileNotFoundError: [Errno 2] No such file or directory: ''`` and
        every model load fails. Fall back to ``HF_HOME`` (then the production
        default) when the configured value is missing or blank.
        """
        if v is None or not str(v).strip():
            return os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface/hub")
        return str(v).strip()

    @field_validator("huggingface_token", mode="before")
    @classmethod
    def _normalize_huggingface_token(cls, v: object) -> str | None:
        """Treat a blank ``HUGGINGFACE_TOKEN`` as *unset* (``None``).

        An explicitly-empty value (e.g. ``HUGGINGFACE_TOKEN=`` in a .env file,
        or an env var set to ``""``) must not be forwarded to the HuggingFace
        libraries. Passing ``token=""`` builds an ``Authorization: Bearer ``
        header with no credential, which raises
        ``Illegal header value b'Bearer '`` on every model load. Returning
        ``None`` lets huggingface_hub fall back to the ``HF_TOKEN`` environment
        variable / local cache (or anonymous access for public models).
        """
        if v is None or not str(v).strip():
            return None
        return str(v).strip()

    # Azure Speech (cloud ASR engine)
    azure_speech_key: SecretStr | None = Field(
        default=None,
        description="Azure Cognitive Services Speech subscription key",
    )
    azure_speech_region: str | None = Field(
        default=None,
        description="Azure Speech service region (e.g., eastus, westeurope)",
    )

    # Azure AI Foundry — MAI-Transcribe (engine AZURE_FOUNDRY).
    # PREVIEW service (no SLA, no diarization) — disabled by default,
    # batch-only, and PHI must not flow until GA + data-residency sign-off.
    # Env vars: AZURE_FOUNDRY_ENABLED / _ENDPOINT / _API_KEY / _MODEL.
    azure_foundry_enabled: bool = Field(
        default=False,
        description="Enable the Azure AI Foundry MAI-Transcribe engine (preview, off by default)",
    )
    azure_foundry_endpoint: str | None = Field(
        default=None,
        description="Azure AI Foundry / Speech resource endpoint, e.g. https://<res>.cognitiveservices.azure.com",
    )
    azure_foundry_api_key: SecretStr | None = Field(
        default=None,
        description="Azure AI Foundry API key",
    )
    azure_foundry_model: str = Field(
        default="mai-transcribe-1.5",
        description="MAI transcription model name for enhancedMode",
    )

    # Sarvam AI speech-to-text (engine SARVAM, TASK-567 cloud fallback).
    # Platform-level env fallback; per-tenant BYOK overrides take precedence
    # when injected. Env vars: SARVAM_API_KEY / SARVAM_BASE_URL.
    sarvam_api_key: SecretStr | None = Field(
        default=None,
        description="Sarvam AI api-subscription-key (platform-level fallback)",
    )
    sarvam_base_url: str = Field(
        default="https://api.sarvam.ai",
        description="Sarvam AI API base URL",
    )

    # OpenAI speech-to-text (engine OPENAI, TASK-567 cloud fallback).
    # base_url supports Azure-OpenAI-compatible endpoints. Env vars:
    # OPENAI_API_KEY / OPENAI_BASE_URL.
    openai_api_key: SecretStr | None = Field(
        default=None,
        description="OpenAI API key (platform-level fallback)",
    )
    openai_base_url: str = Field(
        default="https://api.openai.com/v1",
        description="OpenAI (or Azure-OpenAI-compatible) API base URL",
    )

    # parakeet.cpp — ggml runtime for NVIDIA Parakeet/Nemotron ASR
    # (engine PARAKEET_CPP). No official Python bindings exist upstream
    # (mudler/parakeet.cpp is C API + CLI); the loader lazy-imports a
    # binding module when present, else loads the shared library path below.
    parakeet_cpp_library_path: str | None = Field(
        default=None,
        description="Path to libparakeet shared library (env PARAKEET_CPP_LIBRARY_PATH)",
    )
    parakeet_cpp_num_threads: int = Field(
        default=4,
        description="CPU threads for parakeet.cpp inference",
    )

    # whisper.cpp — ggml runtime for GGUF whisper-large-v3-turbo
    # (engine WHISPER_CPP), via the maintained `pywhispercpp` binding.
    whisper_cpp_library_path: str | None = Field(
        default=None,
        description="Optional path to a prebuilt libwhisper shared library (env WHISPER_CPP_LIBRARY_PATH)",
    )
    whisper_cpp_num_threads: int = Field(
        default=4,
        description="CPU threads for whisper.cpp inference",
    )
    whisper_cpp_max_audio_seconds: float = Field(
        default=7.0,
        description=(
            "Max audio length (s) fed to whisper.cpp in one decode. The ml-en "
            "code-switch fine-tune is accurate up to ~6-7s but truncates/garbles "
            "on longer audio (VAD does not segment continuous clinical speech), so "
            "longer utterances are split into <=this-many-second chunks at silence "
            "troughs, decoded independently, and stitched. 0 disables chunking. "
            "env WHISPER_CPP_MAX_AUDIO_SECONDS"
        ),
    )
    whisper_cpp_consultation_prompt_enabled: bool = Field(
        default=False,
        description=(
            "Whether the whisper.cpp adapter prepends its language-derived "
            "clinical-consultation initial_prompt (exemplar prior-context, not an "
            "instruction). Default OFF — measured to inject spurious tokens and "
            "break grapheme clusters on the ml-en code-switch fine-tune. Toggle on "
            "only if an eval shows it helps. env WHISPER_CPP_CONSULTATION_PROMPT_ENABLED"
        ),
    )

    # VAD — Silero v5 ONNX
    vad_model_path: str | None = Field(
        default=None,
        description="Path to Silero VAD ONNX model (auto-downloaded if None)",
    )
    vad_threshold: float = Field(
        default=0.5,
        description="Silero VAD speech detection threshold (0.0–1.0)",
    )
    vad_min_speech_duration_ms: int = Field(
        default=100,
        description="Minimum speech segment length in ms (100 so short clinical confirmations survive)",
    )
    vad_min_silence_duration_ms: int = Field(
        default=500,
        description="Minimum silence to end speech segment in ms",
    )
    vad_speech_pad_ms: int = Field(
        default=200,
        description="Padding applied to both segment ends in ms (200 per production ASR guidance)",
    )
    vad_sample_rate: int = Field(
        default=16000,
        description="VAD input sample rate (16000 or 8000)",
    )

    # Diarization -- Pyannote embeddings
    diarization_hf_model_id: str = Field(
        default="pyannote/wespeaker-voxceleb-resnet34-LM",
        description="HuggingFace model ID for speaker embedding extraction",
    )
    diarization_similarity_threshold: float = Field(
        default=0.7,
        description="Cosine similarity threshold for speaker matching (0.0–1.0)",
    )
    diarization_device: str = Field(
        default="auto",
        description="Device for pyannote inference (auto, cuda, cpu)",
    )

    # Voice profile enrollment
    voice_profile_min_similarity: float = Field(
        default=0.6,
        ge=0.0,
        le=1.0,
        description=(
            "Minimum acceptable pairwise cosine similarity between per-sample "
            "embeddings during enrollment. Below this, the enrollment is rejected "
            "as inconsistent. Lower this (~0.3) for dev with consumer-grade "
            "microphones; keep >=0.6 in production."
        ),
    )
    voice_profile_embedding_dim: int = Field(
        default=256,
        description=(
            "Speaker-embedding dimension — must match the deployed "
            "UserVoiceProfile.embedding vector(N) column. 256 = wespeaker "
            "(current); 192 = ECAPA-TDNN (cutover requires applying the "
            "vector(192) migration and re-enrolling)"
        ),
    )

    # Worker settings
    worker_threads: int = Field(
        default=4,
        description="Number of Dramatiq worker threads per process",
    )
    worker_concurrency: int = Field(
        default=4,
        description=(
            "DEPRECATED ALIAS — has no read sites anywhere in the service; "
            "`worker_threads` is the field that actually reaches Worker(...). "
            "The control-plane worker ceiling (effective-config) feeds "
            "`worker_threads`, not this. Retained only for env-compatibility."
        ),
    )
    worker_poll_timeout_ms: int = Field(
        default=1000,
        description="Dramatiq consumer poll interval max-backoff in milliseconds",
    )
    worker_max_retries: int = Field(
        default=3,
        description="Maximum job retry attempts",
    )
    # Process pool for CPU-bound inference (separate from Dramatiq threads)
    inference_pool_size: int = Field(
        default=0,
        description="ProcessPoolExecutor size for ML inference (0=auto: CPU cores)",
    )

    # ONNX Runtime threading
    onnx_num_threads: int = Field(
        default=0,
        description=(
            "Number of threads for ONNX Runtime intra_op parallelism. "
            "0 = auto (recommended): ONNX Runtime auto-sizes to physical "
            "CPU core count with proper thread affinity. Set explicitly "
            "only if profiling shows benefit."
        ),
    )

    # PyTorch threading (critical for CPU-only inference performance)
    torch_num_threads: int = Field(
        default=0,
        description=(
            "Number of threads for PyTorch intra-op parallelism "
            "(torch.set_num_threads). 0 = auto: uses the number of "
            "physical CPU cores. In K8s, set this to match the CPU "
            "request/limit (e.g. 8 for 8-core pods) to avoid under- "
            "or over-subscribing."
        ),
    )
    torch_num_interop_threads: int = Field(
        default=1,
        description=(
            "Number of threads for PyTorch inter-op parallelism "
            "(torch.set_num_interop_threads). Default 1 is optimal "
            "for single-request inference. Increase only for "
            "concurrent batch processing."
        ),
    )

    # PRELOAD_PIPELINES is deprecated as a selection/control
    # mechanism. Pipeline models load on first use; leave empty in production.
    # Retained only as an optional warm-start of known slugs (not routing).
    preload_pipelines: str = Field(
        default="",
        description=(
            "DEPRECATED: optional comma-separated pipeline slugs "
            "to warm at startup. Not used for provider/model/pipeline "
            "selection — request-time pipeline_id + DB AsrPipeline is authority. "
            "Prefer empty; models load on first use."
        ),
    )

    # Transcription settings
    transcription_timeout_seconds: int = Field(
        default=600,
        description="Maximum transcription job timeout in seconds (default: 10 min)",
    )
    transcription_chunk_length_s: int = Field(
        default=15,
        description=(
            "Audio chunk length (seconds) for Whisper inference. Whisper's "
            "feature extractor truncates audio to its context window (30s max). "
            "Audio longer than this value is split into overlapping chunks "
            "with configurable stride. Default 15s provides ~2x lower TTFW "
            "latency vs 30s while maintaining good accuracy. "
            "Set to 30 for maximum accuracy, 10 for ultra-low latency."
        ),
    )
    transcription_stride_length_s: str = Field(
        default="4,2",
        description=(
            "Left and right overlap (seconds) between consecutive chunks, as "
            "a comma-separated pair. The HF pipeline uses these overlaps to "
            "avoid cutting words at chunk boundaries. Default '4,2' means 4s "
            "left overlap and 2s right overlap."
        ),
    )

    # VAD segment merging
    segment_merge_gap_threshold_s: float = Field(
        default=2.0,
        description=(
            "Maximum gap (seconds) between adjacent VAD speech segments "
            "that allows merging into a single inference chunk.  Merging "
            "reduces the number of Whisper generate() calls, each of "
            "which incurs ~6s encoder overhead on CPU.  Default 2.0s "
            "works well for conversational audio with natural pauses.  "
            "Set to 0 to disable merging entirely."
        ),
    )

    # -------------------------------------------------------------------------
    # Streaming settings
    # -------------------------------------------------------------------------
    streaming_max_concurrent: int = Field(
        default=0,
        description=(
            "Maximum number of concurrent streaming sessions. "
            "0 = auto-detect from ExecutionProfile based on hardware. "
            "Bootstrap fallback — the runtime value comes from the control plane "
            "(effective-config), applied after hardware detection."
        ),
    )
    streaming_max_batch_size: int = Field(
        default=0,
        description=(
            "Maximum batch size for the dynamic batch scheduler (GPU inference). "
            "0 = auto-detect from ExecutionProfile based on hardware."
        ),
    )
    streaming_batch_wait_ms: int = Field(
        default=0,
        description=(
            "Maximum time (ms) the batch scheduler waits before dispatching "
            "an incomplete batch. 0 = auto-detect from ExecutionProfile."
        ),
    )
    streaming_embedding_device: str = Field(
        default="auto",
        description=(
            "Device for speaker embedding extraction during streaming. "
            "'auto' selects based on hardware profile (e.g. cuda:1, cpu, mps)."
        ),
    )
    streaming_multi_gpu_strategy: str = Field(
        default="auto",
        description=(
            "Multi-GPU strategy for streaming: 'auto' (detect), 'replicate' "
            "(same model on each GPU), 'split' (ASR on GPU 0, embeddings on "
            "GPU 1), or 'none' (single GPU / CPU)."
        ),
    )
    streaming_session_persist_interval_s: float = Field(
        default=5.0,
        description="How often (seconds) to persist session metadata to Redis.",
    )
    streaming_snapshot_interval_s: float = Field(
        default=30.0,
        description="Interval (seconds) between audio snapshot uploads to S3 "
        "during active streaming sessions.",
    )
    streaming_max_audio_buffer_bytes: int = Field(
        default=500_000_000,
        description="Hard cap (bytes) on the in-memory audio buffer per session. "
        "Once exceeded, new frames are silently dropped and a warning is logged. "
        "Default ~500 MB ≈ ~87 min of 16 kHz mono s16le audio.",
    )
    streaming_session_timeout_s: int = Field(
        default=60,
        description="Seconds of inactivity before a streaming session is auto-finalized by the reaper.",
    )
    streaming_audio_idle_timeout_s: int = Field(
        default=300,
        description="Seconds of no audio data before STT auto-stops a streaming session (default 5 min).",
    )
    streaming_reaper_interval_s: int = Field(
        default=300,
        description="Interval (seconds) between background reaper scans for expired sessions.",
    )
    streaming_transcript_persist_max_attempts: int = Field(
        default=3,
        description=(
            "Max attempts to persist the durable streaming transcript to the "
            "gateway during finalize. The transcript is the "
            "clinical system of record AND the harness auto-draft trigger, so a "
            "transient gateway blip is retried rather than silently swallowed. "
            "The persist endpoint is idempotent, so retries never double-create "
            "the transcript or re-trigger the harness. Must be >= 1."
        ),
    )
    streaming_transcript_persist_backoff_s: float = Field(
        default=0.5,
        description=(
            "Base backoff (seconds) between durable-transcript persist retries; "
            "the delay scales with the attempt number. 0 "
            "disables the wait (used in tests)."
        ),
    )
    streaming_transcript_outbox_max_attempts: int = Field(
        default=10,
        description=(
            "Max re-drive attempts for a transcript in the durable Redis outbox "
            "before it is dropped with a loud alert. When the "
            "inline persist exhausts its retries on a TRANSIENT error the "
            "transcript is enqueued to a shared Redis outbox and re-driven by "
            "the reaper loop (any worker) with an idempotency key; a PERMANENT "
            "(4xx) error is dropped immediately rather than retried."
        ),
    )
    streaming_inference_drain_timeout_s: float = Field(
        default=60.0,
        description=(
            "Max seconds finalize waits for the inference queue to drain before "
            "building the transcript. On timeout (e.g. GPU "
            "backlog) the still-queued tail utterances are transcribed inline "
            "rather than dropped, so the last utterance is never lost."
        ),
    )
    streaming_inference_queue_maxsize: int = Field(
        default=64,
        description=(
            "Bound on the per-session in-process inference queue "
            "(SessionManager._register_inference_runtime). F-08: the steady-state "
            "enqueue is a bounded wait_for (not a blocking put) — once the queue "
            "is full for longer than the bounded wait, the utterance is DROPPED "
            "(with a structured warning + counter) rather than blocking the "
            "single ingestion dispatch loop, which would otherwise stop XACK'ing "
            "Redis audio frames and let stt:audio's MAXLEN trim unread raw audio. "
            "The finalize-path drain uses the separate "
            "streaming_inference_drain_timeout_s bound and is unaffected."
        ),
    )
    streaming_inference_stop_timeout_s: float = Field(
        default=30.0,
        description=(
            "Seconds to wait for a session's inference worker task to "
            "drain/stop before giving up (used both on graceful session "
            "removal and when force-finalizing on session-end)."
        ),
    )
    streaming_worker_heartbeat_s: int = Field(
        default=10,
        description="Interval (seconds) between worker heartbeat extensions in Redis.",
    )
    streaming_worker_heartbeat_ttl_s: int = Field(
        default=30,
        description="TTL (seconds) for the worker heartbeat key in Redis.",
    )
    streaming_audio_stream_maxlen: int = Field(
        default=10000,
        description=(
            "Approximate MAXLEN for Redis audio streams (per-session). "
            "The SINGLE source of truth for the audio-stream "
            "bound: kept equal to the TS gateway bridge's XADD MAXLEN (the sole "
            "production writer of stt:audio). At ~30-80ms/frame this retains "
            "minutes of audio, comfortably ahead of the consumer group."
        ),
    )
    streaming_result_stream_maxlen: int = Field(
        default=10000,
        description=(
            "Approximate MAXLEN for the per-session Redis result stream "
            "(stt:result). Bounds the stream DURING an active "
            "session (previously unbounded until the post-close EXPIRE). High "
            "enough that a keeping-up bridge/consumer never misses a result; "
            "overflowed finals remain in the durable transcript."
        ),
    )
    streaming_audio_trim_interval_s: float = Field(
        default=30.0,
        description=(
            "Minimum interval (seconds) between XTRIM MINID calls on the "
            "consumed portion of stt:audio:{session_id}. "
            "0 disables consumed-portion trimming (MAXLEN bound still applies)."
        ),
    )
    streaming_extra_filler_patterns: str = Field(
        default="",
        description=(
            "Pipe-separated extra regex alternates appended to the streaming "
            "hallucination filler pattern. Default empty — "
            "built-in English + Malayalam filler forms only."
        ),
    )
    streaming_punctuation_timeout_s: float = Field(
        default=0.4,
        description=(
            "Max seconds a streaming FINAL waits for Cadence-Fast "
            "punctuation before the raw text is published "
            "(0.3-0.5 s recommended). Applies only when the punctuation "
            "model resolves to 'cadence-fast'."
        ),
    )
    streaming_partial_window_s: float = Field(
        default=8.0,
        description=(
            "Tail window (seconds) of the current utterance decoded for "
            "PARTIAL transcripts. Bounds per-partial decode cost on long "
            "utterances; finals always decode the full utterance."
        ),
    )
    streaming_partial_interval_s: float = Field(
        default=0.4,
        description=(
            "Minimum wall-clock interval (seconds) between successive PARTIAL "
            "transcript emissions for a live utterance. Lowered "
            "from the legacy hardcoded 1.0 s so newly-spoken words surface in "
            "near-real-time as a tentative tail; the LocalAgreement-2 commit "
            "policy still governs when a word is *committed* (unchanged). The "
            "streaming_partial_window_s tail bound and the 0.5 s minimum-"
            "buffered-audio floor are unaffected. The Settings class has NO "
            "env_prefix, so the env var is the bare STREAMING_PARTIAL_INTERVAL_S."
        ),
    )
    # -------------------------------------------------------------------------
    # Semantic endpointing — content-driven end-of-utterance.
    # The Settings class has NO env_prefix, so these are the bare uppercased
    # env names (e.g. SEMANTIC_ENDPOINT_ENABLED), NOT STT_*.
    # -------------------------------------------------------------------------
    semantic_endpoint_enabled: bool = Field(
        default=False,
        description=(
            "Enable content-driven semantic end-of-utterance detection on the "
            "streaming hot path. Default OFF — the preprocessor "
            "keeps the fixed Silero-VAD silence offset until this is enabled and "
            "measured against the accuracy/latency scorecard. Env: SEMANTIC_ENDPOINT_ENABLED."
        ),
    )
    semantic_endpoint_min_silence_ms: int = Field(
        default=200,
        description=(
            "Trailing-silence floor (ms) before a semantic early cut is allowed "
            "(target-min EOU latency, 160–500 ms band). Kept below the fixed "
            "VAD backstop so a semantic cut is genuinely earlier."
        ),
    )
    semantic_endpoint_max_silence_ms: int = Field(
        default=500,
        description=(
            "Target-max EOU latency band (ms) — informational; the fixed VAD "
            "silence offset remains the true upper bound / backstop."
        ),
    )
    semantic_endpoint_confidence_threshold: float = Field(
        default=0.85,
        description=(
            "Minimum decision confidence (0–1) to cut a final early. Raise it if "
            "measurement shows early cuts truncating clinical content (measure-"
            "first; the fixed backstop always still fires)."
        ),
    )
    semantic_endpoint_min_words: int = Field(
        default=3,
        description=(
            "Minimum running-hypothesis word count before a semantic early cut; "
            "tiny fragments defer to the fixed silence timer."
        ),
    )
    semantic_endpoint_model_id: str = Field(
        default="",
        description=(
            "OPTIONAL self-hosted turn/EOU model id. Empty = model-free "
            "heuristic only. A staged model can endpoint on unpunctuated complete "
            "text; an un-staged id degrades to the heuristic (no cloud vendor "
            "ever — track guardrail)."
        ),
    )
    streaming_result_stream_expire_s: int = Field(
        default=3600,
        description="TTL (seconds) for Redis stream keys after session closes (1 hour).",
    )
    streaming_session_metadata_expire_s: int = Field(
        default=86400,
        description="TTL (seconds) for Redis session metadata keys after session closes (24 hours).",
    )

    # -------------------------------------------------------------------------
    # Real-time event publishing (Redis Pub/Sub)
    # -------------------------------------------------------------------------
    pubsub_channel_prefix: str = Field(
        default="stt:transcription:",
        description=(
            "Redis Pub/Sub channel prefix for real-time transcription events. "
            "Full channel: {prefix}{job_id}. The NestJS subscriber listens on "
            "the same channel to relay events via SSE."
        ),
    )
    pubsub_enabled: bool = Field(
        default=True,
        description=(
            "Enable Redis Pub/Sub publishing for real-time transcription events. "
            "When disabled, the worker skips event publishing but still calls "
            "the gateway API for job lifecycle updates."
        ),
    )

    # -------------------------------------------------------------------------
    # Observability (OpenTelemetry + Prometheus)
    # -------------------------------------------------------------------------
    otel_enabled: bool = Field(
        default=False,
        description="Enable OpenTelemetry distributed tracing",
    )
    otel_exporter_endpoint: str = Field(
        default="http://localhost:4317",
        description="OTLP gRPC collector endpoint",
    )
    otel_service_name: str = Field(
        default="stt",
        description="Service name in traces and metrics",
    )
    metrics_enabled: bool = Field(
        default=True,
        description="Enable Prometheus metrics on /metrics",
    )

    # MLFlow (reserved — not yet implemented)
    mlflow_tracking_uri: str | None = Field(
        default=None,
        description="MLFlow tracking server URI (reserved for future use)",
    )
    mlflow_model_registry: str | None = Field(
        default=None,
        description="MLFlow model registry URI (reserved for future use)",
    )

    # -------------------------------------------------------------------------
    # Punctuation restoration (Cadence)
    # -------------------------------------------------------------------------
    punctuation_enabled: bool = Field(
        default=False,
        description=(
            "Enable Cadence punctuation restoration at startup and runtime. "
            "Default false: the production Whisper ASR pipelines already emit "
            "punctuation and casing, so Cadence is redundant for them, and "
            "cadence-punctuation 1.1.0 cannot load under the pinned "
            "transformers 5.5.4 (its tied-weights finalization raises "
            "'Sequential has no attribute weight'). Enable only with a "
            "transformers/cadence combination that is known to load the "
            "model — e.g. an Indic ASR path whose engine does not "
            "self-punctuate, running transformers <5 in a dedicated "
            "environment — or with the direct-load 'cadence-fast' option, "
            "which works under the pinned transformers 5.x."
        ),
    )
    punctuation_model_name: str = Field(
        default="Cadence",
        description="Default punctuation model: 'Cadence' (1B) or 'Cadence-Fast' "
        "(270M) via the cadence-punctuation wrapper, or 'cadence-fast' for the "
        "direct transformers load (works under transformers 5.x). "
        "Can be overridden per-pipeline via YAML.",
    )
    punctuation_model_cache_dir: str | None = Field(
        default=None,
        description="Cache dir for punctuation model weights (None = HF default cache)",
    )
    punctuation_device: str = Field(
        default="auto",
        description="Device for punctuation inference: 'cpu', 'cuda', 'auto'",
    )
    punctuation_max_length: int = Field(
        default=300,
        description="Max sequence length / sliding window width for punctuation model",
    )


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    load_env()
    return Settings()


# stt is the ONE service that caches its settings, so it is the one service where
# a Vault Agent rewriting `/vault/secrets/*` in place would otherwise be served the
# pre-rotation value forever. Registering the cache lets `hope_env.reload_secrets()`
# drop it; the other five build a fresh `Settings()` per `get_settings()` call and
# need no bookkeeping (§13.2 P6).
register_settings_cache(get_settings.cache_clear)
