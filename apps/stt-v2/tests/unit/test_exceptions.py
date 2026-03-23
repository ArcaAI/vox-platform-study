"""Unit tests for custom exceptions."""


from stt_v2.core.exceptions import (
    NON_RETRYABLE_EXCEPTIONS,
    RETRYABLE_EXCEPTIONS,
    APIGatewayError,
    AudioCorruptedError,
    AudioFormatError,
    AudioProcessingError,
    AudioTooShortError,
    CloudASRAuthError,
    CloudASRError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
    ConfigurationError,
    DatabaseConnectionError,
    InvalidPipelineError,
    JobCancelledError,
    JobError,
    JobNotFoundError,
    JobTimeoutError,
    ModelDownloadError,
    ModelError,
    ModelInferenceError,
    ModelLoadError,
    ModelNotFoundError,
    ModelOutOfMemoryError,
    PipelineNotFoundError,
    RedisConnectionError,
    StorageError,
    STTServiceError,
    TransientError,
    ValidationError,
)


class TestSTTServiceError:
    """Tests for base STTServiceError."""

    def test_basic_creation(self):
        """Test basic exception creation."""
        error = STTServiceError("Test error")

        assert str(error) == "Test error"
        assert error.message == "Test error"
        assert error.details == {}
        assert error.error_code == "STT_ERROR"

    def test_with_details(self):
        """Test exception with details."""
        details = {"key": "value", "count": 42}
        error = STTServiceError("Error with details", details=details)

        assert error.details == details
        assert error.details["key"] == "value"
        assert error.details["count"] == 42

    def test_inheritance(self):
        """Test that it inherits from Exception."""
        error = STTServiceError("Test")
        assert isinstance(error, Exception)


class TestConfigurationErrors:
    """Tests for configuration-related errors."""

    def test_configuration_error(self):
        """Test ConfigurationError."""
        error = ConfigurationError("Config error")
        assert error.error_code == "CONFIG_ERROR"
        assert isinstance(error, STTServiceError)

    def test_invalid_pipeline_error(self):
        """Test InvalidPipelineError."""
        error = InvalidPipelineError("Invalid pipeline", details={"pipeline_id": "p-123"})
        assert error.error_code == "INVALID_PIPELINE"
        assert isinstance(error, ConfigurationError)
        assert error.details["pipeline_id"] == "p-123"

    def test_model_not_found_error(self):
        """Test ModelNotFoundError."""
        error = ModelNotFoundError("Model not found", details={"model_slug": "whisper"})
        assert error.error_code == "MODEL_NOT_FOUND"
        assert isinstance(error, ConfigurationError)

    def test_pipeline_not_found_error(self):
        """Test PipelineNotFoundError."""
        error = PipelineNotFoundError("Pipeline not found")
        assert error.error_code == "PIPELINE_NOT_FOUND"
        assert isinstance(error, ConfigurationError)


class TestAudioProcessingErrors:
    """Tests for audio processing errors."""

    def test_audio_processing_error(self):
        """Test base AudioProcessingError."""
        error = AudioProcessingError("Audio processing failed")
        assert error.error_code == "AUDIO_ERROR"
        assert isinstance(error, STTServiceError)

    def test_audio_format_error(self):
        """Test AudioFormatError."""
        error = AudioFormatError("Unsupported format", details={"format": "xyz"})
        assert error.error_code == "AUDIO_FORMAT_ERROR"
        assert isinstance(error, AudioProcessingError)

    def test_audio_too_short_error(self):
        """Test AudioTooShortError."""
        error = AudioTooShortError("Audio too short", details={"duration_ms": 50})
        assert error.error_code == "AUDIO_TOO_SHORT"
        assert isinstance(error, AudioProcessingError)

    def test_audio_corrupted_error(self):
        """Test AudioCorruptedError."""
        error = AudioCorruptedError("Corrupted file")
        assert error.error_code == "AUDIO_CORRUPTED"
        assert isinstance(error, AudioProcessingError)


class TestModelErrors:
    """Tests for model-related errors."""

    def test_model_error(self):
        """Test base ModelError."""
        error = ModelError("Model error")
        assert error.error_code == "MODEL_ERROR"
        assert isinstance(error, STTServiceError)

    def test_model_load_error(self):
        """Test ModelLoadError."""
        error = ModelLoadError("Failed to load", details={"model": "whisper-large"})
        assert error.error_code == "MODEL_LOAD_ERROR"
        assert isinstance(error, ModelError)

    def test_model_download_error(self):
        """Test ModelDownloadError."""
        error = ModelDownloadError("Download failed")
        assert error.error_code == "MODEL_DOWNLOAD_ERROR"
        assert isinstance(error, ModelError)

    def test_model_inference_error(self):
        """Test ModelInferenceError."""
        error = ModelInferenceError("Inference failed")
        assert error.error_code == "MODEL_INFERENCE_ERROR"
        assert isinstance(error, ModelError)

    def test_model_oom_error(self):
        """Test ModelOutOfMemoryError."""
        error = ModelOutOfMemoryError("Out of memory", details={"required_mb": 4000})
        assert error.error_code == "MODEL_OOM_ERROR"
        assert isinstance(error, ModelError)


class TestTransientErrors:
    """Tests for transient/recoverable errors."""

    def test_transient_error(self):
        """Test base TransientError."""
        error = TransientError("Transient error")
        assert error.error_code == "TRANSIENT_ERROR"
        assert isinstance(error, STTServiceError)

    def test_storage_error(self):
        """Test StorageError."""
        error = StorageError("MinIO error", details={"bucket": "audio"})
        assert error.error_code == "STORAGE_ERROR"
        assert isinstance(error, TransientError)

    def test_api_gateway_error(self):
        """Test APIGatewayError."""
        error = APIGatewayError("Gateway unavailable", details={"status_code": 503})
        assert error.error_code == "API_GATEWAY_ERROR"
        assert isinstance(error, TransientError)

    def test_redis_connection_error(self):
        """Test RedisConnectionError."""
        error = RedisConnectionError("Redis connection failed")
        assert error.error_code == "REDIS_CONNECTION_ERROR"
        assert isinstance(error, TransientError)

    def test_database_connection_error(self):
        """Test DatabaseConnectionError."""
        error = DatabaseConnectionError("DB connection failed")
        assert error.error_code == "DATABASE_CONNECTION_ERROR"
        assert isinstance(error, TransientError)


class TestJobErrors:
    """Tests for job-related errors."""

    def test_job_error(self):
        """Test base JobError."""
        error = JobError("Job error")
        assert error.error_code == "JOB_ERROR"
        assert isinstance(error, STTServiceError)

    def test_job_not_found_error(self):
        """Test JobNotFoundError."""
        error = JobNotFoundError("Job not found", details={"job_id": "j-123"})
        assert error.error_code == "JOB_NOT_FOUND"
        assert isinstance(error, JobError)

    def test_job_cancelled_error(self):
        """Test JobCancelledError."""
        error = JobCancelledError("Job cancelled")
        assert error.error_code == "JOB_CANCELLED"
        assert isinstance(error, JobError)

    def test_job_timeout_error(self):
        """Test JobTimeoutError."""
        error = JobTimeoutError("Timeout exceeded", details={"timeout_seconds": 300})
        assert error.error_code == "JOB_TIMEOUT"
        assert isinstance(error, JobError)


class TestValidationError:
    """Tests for ValidationError."""

    def test_validation_error(self):
        """Test ValidationError."""
        error = ValidationError("Invalid input", details={"field": "name"})
        assert error.error_code == "VALIDATION_ERROR"
        assert isinstance(error, STTServiceError)


class TestCloudASRErrors:
    """Tests for cloud ASR service errors."""

    def test_cloud_asr_error(self):
        """Test base CloudASRError."""
        error = CloudASRError("Cloud ASR failed")
        assert error.error_code == "CLOUD_ASR_ERROR"
        assert isinstance(error, STTServiceError)

    def test_cloud_asr_auth_error(self):
        """Test CloudASRAuthError."""
        error = CloudASRAuthError(
            "Invalid credentials",
            details={"has_key": False, "has_region": True},
        )
        assert error.error_code == "CLOUD_ASR_AUTH_ERROR"
        assert isinstance(error, CloudASRError)
        assert isinstance(error, STTServiceError)
        assert error.details["has_key"] is False
        assert error.details["has_region"] is True

    def test_cloud_asr_quota_error(self):
        """Test CloudASRQuotaError."""
        error = CloudASRQuotaError("Rate limit exceeded", details={"retry_after": 30})
        assert error.error_code == "CLOUD_ASR_QUOTA_ERROR"
        assert isinstance(error, CloudASRError)
        assert error.details["retry_after"] == 30

    def test_cloud_asr_transcription_error(self):
        """Test CloudASRTranscriptionError."""
        error = CloudASRTranscriptionError("Transcription cancelled")
        assert error.error_code == "CLOUD_ASR_TRANSCRIPTION_ERROR"
        assert isinstance(error, CloudASRError)

    def test_cloud_asr_error_hierarchy(self):
        """Test that all cloud errors inherit from CloudASRError and STTServiceError."""
        for error_class in [CloudASRAuthError, CloudASRQuotaError, CloudASRTranscriptionError]:
            err = error_class("test")
            assert isinstance(err, CloudASRError)
            assert isinstance(err, STTServiceError)


class TestExceptionGroups:
    """Tests for exception groupings."""

    def test_non_retryable_exceptions(self):
        """Test non-retryable exception tuple."""
        assert ConfigurationError in NON_RETRYABLE_EXCEPTIONS
        assert AudioProcessingError in NON_RETRYABLE_EXCEPTIONS
        assert ValidationError in NON_RETRYABLE_EXCEPTIONS
        assert JobCancelledError in NON_RETRYABLE_EXCEPTIONS
        assert CloudASRAuthError in NON_RETRYABLE_EXCEPTIONS

    def test_retryable_exceptions(self):
        """Test retryable exception tuple."""
        assert TransientError in RETRYABLE_EXCEPTIONS
        assert ModelError in RETRYABLE_EXCEPTIONS
        assert CloudASRQuotaError in RETRYABLE_EXCEPTIONS

    def test_isinstance_checks(self):
        """Test isinstance with exception groups."""
        # Non-retryable
        config_err = ConfigurationError("test")
        assert isinstance(config_err, NON_RETRYABLE_EXCEPTIONS)

        # Retryable
        storage_err = StorageError("test")
        assert isinstance(storage_err, RETRYABLE_EXCEPTIONS)

        model_err = ModelLoadError("test")
        assert isinstance(model_err, RETRYABLE_EXCEPTIONS)

    def test_child_classes_in_groups(self):
        """Test that child classes work with isinstance."""
        # InvalidPipelineError is child of ConfigurationError
        err = InvalidPipelineError("test")
        assert isinstance(err, NON_RETRYABLE_EXCEPTIONS)

        # StorageError is child of TransientError
        err = StorageError("test")
        assert isinstance(err, RETRYABLE_EXCEPTIONS)

    def test_cloud_asr_auth_is_non_retryable(self):
        """Test that CloudASRAuthError is non-retryable via isinstance."""
        err = CloudASRAuthError("bad creds")
        assert isinstance(err, NON_RETRYABLE_EXCEPTIONS)

    def test_cloud_asr_quota_is_retryable(self):
        """Test that CloudASRQuotaError is retryable via isinstance."""
        err = CloudASRQuotaError("throttled")
        assert isinstance(err, RETRYABLE_EXCEPTIONS)

    def test_cloud_asr_transcription_error_not_in_groups(self):
        """Test CloudASRTranscriptionError is not in either predefined group.

        It inherits from CloudASRError -> STTServiceError, not from
        TransientError, ModelError, ConfigurationError, etc.
        """
        err = CloudASRTranscriptionError("failed")
        assert not isinstance(err, NON_RETRYABLE_EXCEPTIONS)
        assert not isinstance(err, RETRYABLE_EXCEPTIONS)
