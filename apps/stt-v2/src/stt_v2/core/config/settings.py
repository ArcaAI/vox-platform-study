"""Application settings using Pydantic Settings."""

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_ROOT = Path(__file__).resolve().parents[4]  # …/apps/stt-v2
_ENV_FILE = _SERVICE_ROOT / ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE) if _ENV_FILE.is_file() else None,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "stt-v2"
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
    minio_access_key: str = "minio_admin"
    minio_secret_key: str = "minio_admin"
    minio_secure: bool = False
    minio_audio_bucket: str = "hope-audio"
    minio_chunk_bucket: str = "hope-audio-chunks"

    # API Gateway (internal communication)
    api_gateway_url: str = Field(
        default="http://localhost:8868/api/v1",
        description="Internal API Gateway URL",
    )
    api_gateway_key: str = Field(
        default="",
        description="Internal service authentication key",
    )
    api_gateway_timeout: int = 30

    # Model Cache
    model_cache_max_models: int = Field(
        default=5,
        description="Maximum number of models in LRU cache",
    )
    model_cache_ttl_seconds: int = Field(
        default=3600,
        description="TTL for cached models in seconds",
    )

    # HuggingFace
    huggingface_cache_dir: str = Field(
        default_factory=lambda: os.environ.get("HF_HOME", "/models/hf-cache"),
        description="HuggingFace model cache directory",
    )
    huggingface_token: str | None = Field(
        default=None,
        description="HuggingFace API token (optional)",
    )

    # Azure Speech (cloud ASR engine)
    azure_speech_key: str | None = Field(
        default=None,
        description="Azure Cognitive Services Speech subscription key",
    )
    azure_speech_region: str | None = Field(
        default=None,
        description="Azure Speech service region (e.g., eastus, westeurope)",
    )

    # Qdrant (vector store for speaker embeddings)
    qdrant_url: str = Field(
        default="http://localhost:6333",
        description="Qdrant server URL (HTTP API)",
    )
    qdrant_api_key: str | None = Field(
        default=None,
        description="Qdrant API key (optional for dev)",
    )
    qdrant_collection_speakers: str = Field(
        default="stt_speaker_embeddings",
        description="Qdrant collection for speaker embeddings",
    )
    qdrant_pool_size: int = Field(
        default=20,
        description="Qdrant client connection pool size",
    )
    qdrant_timeout: int = Field(
        default=30,
        description="Qdrant client timeout in seconds",
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
        default=250,
        description="Minimum speech segment length in ms",
    )
    vad_min_silence_duration_ms: int = Field(
        default=500,
        description="Minimum silence to end speech segment in ms",
    )
    vad_speech_pad_ms: int = Field(
        default=30,
        description="Padding before speech onset in ms",
    )
    vad_sample_rate: int = Field(
        default=16000,
        description="VAD input sample rate (16000 or 8000)",
    )

    # Diarization — Pyannote embeddings
    diarization_hf_model_id: str = Field(
        default="pyannote/embedding",
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

    # Worker settings
    worker_threads: int = Field(
        default=4,
        description="Number of Dramatiq worker threads per process",
    )
    worker_concurrency: int = Field(
        default=4,
        description="Number of Dramatiq worker threads (alias for worker_threads)",
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

    # Model preloading at startup
    preload_pipelines: str = Field(
        default="",
        description=(
            "Comma-separated list of pipeline slugs to preload at "
            "application startup. Models are downloaded and loaded "
            "into the cache before the first request, eliminating "
            "cold-start latency. Example: "
            "'turbo-whisper-large-v3,production-whisper-large-v3'"
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

    # VAD segment merging (TASK-017)
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
            "0 = auto-detect from ExecutionProfile based on hardware."
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
        description="Seconds of no audio data before STT-V2 auto-stops a streaming session (default 5 min).",
    )
    streaming_reaper_interval_s: int = Field(
        default=300,
        description="Interval (seconds) between background reaper scans for expired sessions.",
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
        default=2000,
        description=(
            "Approximate MAXLEN for Redis audio streams (per-session). "
            "At 30ms/frame this retains ~60 seconds of audio."
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
        default="stt-v2",
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


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
