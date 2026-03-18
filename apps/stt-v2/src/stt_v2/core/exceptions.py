"""Custom exception hierarchy for STT Service V2."""


class STTServiceError(Exception):
    """Base exception for STT service."""

    error_code: str = "STT_ERROR"

    def __init__(self, message: str, details: dict | None = None) -> None:
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
# Vector Store Errors
# =============================================================================


class VectorStoreError(STTServiceError):
    """Base class for vector store (Qdrant) errors."""

    error_code = "VECTOR_STORE_ERROR"


class VectorStoreConnectionError(VectorStoreError):
    """Failed to connect to vector store."""

    error_code = "VECTOR_STORE_CONNECTION_ERROR"


class SpeakerEmbeddingError(VectorStoreError):
    """Error during speaker embedding operations."""

    error_code = "SPEAKER_EMBEDDING_ERROR"


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
# Exception Groups for Retry Logic
# =============================================================================

# Exceptions that should NOT trigger a retry
NON_RETRYABLE_EXCEPTIONS = (
    ConfigurationError,
    AudioProcessingError,
    ValidationError,
    JobCancelledError,
    CloudASRAuthError,
)

# Exceptions that should trigger a retry
RETRYABLE_EXCEPTIONS = (
    TransientError,
    ModelError,
    CloudASRQuotaError,  # Quota errors are transient — retry after backoff
    VectorStoreConnectionError,  # Qdrant connection issues are transient
)
