"""Custom exception hierarchy for STT Service."""

from typing import Any


class STTServiceError(Exception):
    """Base exception for STT service."""

    error_code: str = "STT_ERROR"

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


# =============================================================================
# Configuration Errors (no retry)
# =============================================================================


class ConfigurationError(STTServiceError):
    """Base class for configuration-related errors."""

    error_code = "CONFIG_ERROR"


class InvalidPipelineError(ConfigurationError):
    """Invalid pipeline configuration."""

    error_code = "INVALID_PIPELINE"


class ModelNotFoundError(ConfigurationError):
    """Requested model not found in registry."""

    error_code = "MODEL_NOT_FOUND"


class PipelineNotFoundError(ConfigurationError):
    """Requested pipeline not found."""

    error_code = "PIPELINE_NOT_FOUND"


# =============================================================================
# Audio Processing Errors (no retry)
# =============================================================================


class AudioProcessingError(STTServiceError):
    """Base class for audio processing errors."""

    error_code = "AUDIO_ERROR"


class AudioFormatError(AudioProcessingError):
    """Unsupported or invalid audio format."""

    error_code = "AUDIO_FORMAT_ERROR"


class AudioTooShortError(AudioProcessingError):
    """Audio is too short for processing."""

    error_code = "AUDIO_TOO_SHORT"


class AudioCorruptedError(AudioProcessingError):
    """Audio file is corrupted or unreadable."""

    error_code = "AUDIO_CORRUPTED"


# =============================================================================
# Model Errors (limited retry)
# =============================================================================


class ModelError(STTServiceError):
    """Base class for model-related errors."""

    error_code = "MODEL_ERROR"


class ModelLoadError(ModelError):
    """Failed to load model into memory."""

    error_code = "MODEL_LOAD_ERROR"


class ModelNotCacheServedError(ModelLoadError):
    """The row's DECLARED serving library is executed by a dedicated runtime, not by this cache.

    TASK-944 lane B2. A ``ModelLoadError`` subclass so every existing handler
    keeps catching it, but a DISTINCT type so "this cache does not load that
    kind of artifact" can never again be mistaken for "the weights are missing".
    The two used to be indistinguishable: a pyannote checkpoint handed to
    ``transformers`` fails offline with *"couldn't connect to huggingface.co ...
    couldn't find them in the cached files"*, which reads exactly like an absent
    snapshot, and twice sent this ticket looking at the data.

    The message MUST name the declared library and the runtime that owns it.
    """

    error_code = "MODEL_NOT_CACHE_SERVED"


class ModelDownloadError(ModelError):
    """Failed to download model from source."""

    error_code = "MODEL_DOWNLOAD_ERROR"


class ModelInferenceError(ModelError):
    """Error during model inference."""

    error_code = "MODEL_INFERENCE_ERROR"


class ModelOutOfMemoryError(ModelError):
    """Out of memory when loading model."""

    error_code = "MODEL_OOM_ERROR"


# =============================================================================
# Cloud ASR Errors (limited retry for transient, no retry for auth)
# =============================================================================


class CloudASRError(STTServiceError):
    """Base class for cloud ASR service errors."""

    error_code = "CLOUD_ASR_ERROR"


class CloudASRAuthError(CloudASRError):
    """Authentication/credentials error for cloud ASR service."""

    error_code = "CLOUD_ASR_AUTH_ERROR"


class CloudASRQuotaError(CloudASRError):
    """Quota or rate-limit exceeded on cloud ASR service."""

    error_code = "CLOUD_ASR_QUOTA_ERROR"


class CloudASRTranscriptionError(CloudASRError):
    """Transcription failed on cloud ASR service."""

    error_code = "CLOUD_ASR_TRANSCRIPTION_ERROR"


# =============================================================================
# Diarization Errors
# =============================================================================


class DiarizationError(STTServiceError):
    """Base class for diarization errors."""

    error_code = "DIARIZATION_ERROR"


class EmbeddingExtractionError(DiarizationError):
    """Failed to extract speaker embedding."""

    error_code = "EMBEDDING_EXTRACTION_ERROR"


class SpeakerIdentificationError(DiarizationError):
    """Failed to identify speaker."""

    error_code = "SPEAKER_IDENTIFICATION_ERROR"


# =============================================================================
# Transient Errors (retry)
# =============================================================================


class TransientError(STTServiceError):
    """Base class for transient/recoverable errors."""

    error_code = "TRANSIENT_ERROR"


class StorageError(TransientError):
    """MinIO/storage operation failed."""

    error_code = "STORAGE_ERROR"


class APIGatewayError(TransientError):
    """Communication with API Gateway failed."""

    error_code = "API_GATEWAY_ERROR"


class RedisConnectionError(TransientError):
    """Redis connection failed."""

    error_code = "REDIS_CONNECTION_ERROR"


class DatabaseConnectionError(TransientError):
    """Database connection failed."""

    error_code = "DATABASE_CONNECTION_ERROR"


# =============================================================================
# Job Errors
# =============================================================================


class JobError(STTServiceError):
    """Base class for job-related errors."""

    error_code = "JOB_ERROR"


class JobNotFoundError(JobError):
    """Requested job not found."""

    error_code = "JOB_NOT_FOUND"


class JobCancelledError(JobError):
    """Job was cancelled."""

    error_code = "JOB_CANCELLED"


class JobTimeoutError(JobError):
    """Job exceeded maximum timeout."""

    error_code = "JOB_TIMEOUT"


class JobTerminalError(JobError):
    """The job can never be claimed again — COMPLETED, CANCELLED or DEAD.

    The caller should ACK its message: no retry, however patient, will change
    the answer.

    Note the list no longer includes FAILED. Since TASK-992 the gateway
    re-attempts a FAILED job while retries remain, which is what finally makes
    ``transcribe_file``'s ``max_retries=3`` mean something; the LEGACY
    substring branch in ``gateway.py`` still treats FAILED as terminal,
    because an older gateway genuinely cannot restart one.
    """

    error_code = "JOB_TERMINAL"


class JobConflictError(JobError):
    """The job cannot be claimed RIGHT NOW, but the refusal is not final.

    Deliberately absent from ``NON_RETRYABLE_EXCEPTIONS`` below: the whole
    point is that the broker retries with backoff. Conflating this with
    ``JobTerminalError`` is the TASK-992 defect — a job whose worker died was
    redelivered, refused because the row still said PROCESSING, classified
    terminal, and ACKed into oblivion.
    """

    error_code = "JOB_CONFLICT"


# =============================================================================
# Transcription Errors
# =============================================================================


class TranscriptionError(STTServiceError):
    """Base class for transcription-related errors."""

    error_code = "TRANSCRIPTION_ERROR"


# =============================================================================
# Not Found Errors
# =============================================================================


class NotFoundError(STTServiceError):
    """Generic not found error."""

    error_code = "NOT_FOUND"


# =============================================================================
# Validation Errors
# =============================================================================


class ValidationError(STTServiceError):
    """Input validation failed."""

    error_code = "VALIDATION_ERROR"


# =============================================================================
# Streaming / Session-Lifecycle Errors
# =============================================================================


class SessionManagerDrainingError(STTServiceError):
    """Raised by SessionManager.create_session() when this worker process has
    been marked draining (a PLANNED scale-down, distinct from the ordinary
    "at capacity" ``None`` return CapacityGuard produces) — see
    """

    error_code = "SESSION_MANAGER_DRAINING"


# =============================================================================
# Exception Groups for Retry Logic
# =============================================================================

# Exceptions that should NOT trigger a retry
NON_RETRYABLE_EXCEPTIONS = (
    ConfigurationError,
    AudioProcessingError,
    ValidationError,
    JobCancelledError,
    JobTerminalError,
    CloudASRAuthError,
)

# Exceptions that should trigger a retry
RETRYABLE_EXCEPTIONS = (
    TransientError,
    ModelError,
    CloudASRQuotaError,  # Quota errors are transient — retry after backoff
)
