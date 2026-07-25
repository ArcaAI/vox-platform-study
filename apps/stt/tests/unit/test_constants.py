"""Unit tests for application constants.

Tests verify that all expected constants are defined and have correct values.
"""


class TestDatabaseNamespaces:
    """Tests for database namespace constants."""

    def test_stt_config_namespace(self):
        from stt.core.config.constants import NAMESPACE_STT_CONFIG

        assert NAMESPACE_STT_CONFIG == "stt.config"

    def test_stt_pipelines_namespace(self):
        from stt.core.config.constants import NAMESPACE_STT_PIPELINES

        assert NAMESPACE_STT_PIPELINES == "stt.pipelines"

    def test_stt_models_namespace(self):
        from stt.core.config.constants import NAMESPACE_STT_MODELS

        assert NAMESPACE_STT_MODELS == "stt.models"


class TestSystemConstants:
    """Tests for system-level constants."""

    def test_default_tenant_id(self):
        from stt.core.config.constants import DEFAULT_TENANT_ID

        assert DEFAULT_TENANT_ID == "50000000-0000-0000-0000-000000000000"

    def test_system_user_id(self):
        from stt.core.config.constants import SYSTEM_USER_ID

        assert SYSTEM_USER_ID == "60000000-0000-0000-0000-000000000000"


class TestResourceStatusConstants:
    """Tests for resource status constants."""

    def test_resource_status_enabled(self):
        from stt.core.config.constants import RESOURCE_STATUS_ENABLED

        assert RESOURCE_STATUS_ENABLED == "ENABLED"

    def test_resource_status_disabled(self):
        from stt.core.config.constants import RESOURCE_STATUS_DISABLED

        assert RESOURCE_STATUS_DISABLED == "DISABLED"


class TestModelFormatConstants:
    """Tests for model format constants."""

    def test_model_format_safetensor(self):
        from stt.core.config.constants import MODEL_FORMAT_SAFETENSOR

        assert MODEL_FORMAT_SAFETENSOR == "SAFETENSOR"

    def test_model_format_onnx(self):
        from stt.core.config.constants import MODEL_FORMAT_ONNX

        assert MODEL_FORMAT_ONNX == "ONNX"

    def test_model_format_nemo(self):
        from stt.core.config.constants import MODEL_FORMAT_NEMO

        assert MODEL_FORMAT_NEMO == "NEMO"

    def test_model_format_pytorch(self):
        from stt.core.config.constants import MODEL_FORMAT_PYTORCH

        assert MODEL_FORMAT_PYTORCH == "PYTORCH"


class TestModelSourceConstants:
    """Tests for model source constants."""

    def test_model_source_huggingface(self):
        from stt.core.config.constants import MODEL_SOURCE_HUGGINGFACE

        assert MODEL_SOURCE_HUGGINGFACE == "HUGGINGFACE"

    def test_model_source_github(self):
        from stt.core.config.constants import MODEL_SOURCE_GITHUB

        assert MODEL_SOURCE_GITHUB == "GITHUB"

    def test_model_source_mlflow(self):
        from stt.core.config.constants import MODEL_SOURCE_MLFLOW

        assert MODEL_SOURCE_MLFLOW == "MLFLOW"

    def test_model_source_local(self):
        from stt.core.config.constants import MODEL_SOURCE_LOCAL

        assert MODEL_SOURCE_LOCAL == "LOCAL"


class TestJobStatusConstants:
    """Tests for job status constants."""

    def test_job_status_queued(self):
        from stt.core.config.constants import JOB_STATUS_QUEUED

        assert JOB_STATUS_QUEUED == "QUEUED"

    def test_job_status_processing(self):
        from stt.core.config.constants import JOB_STATUS_PROCESSING

        assert JOB_STATUS_PROCESSING == "PROCESSING"

    def test_job_status_completed(self):
        from stt.core.config.constants import JOB_STATUS_COMPLETED

        assert JOB_STATUS_COMPLETED == "COMPLETED"

    def test_job_status_failed(self):
        from stt.core.config.constants import JOB_STATUS_FAILED

        assert JOB_STATUS_FAILED == "FAILED"

    def test_job_status_cancelled(self):
        from stt.core.config.constants import JOB_STATUS_CANCELLED

        assert JOB_STATUS_CANCELLED == "CANCELLED"

    def test_job_status_dead(self):
        from stt.core.config.constants import JOB_STATUS_DEAD

        assert JOB_STATUS_DEAD == "DEAD"


class TestJobTypeConstants:
    """Tests for job type constants."""

    def test_job_type_batch(self):
        from stt.core.config.constants import JOB_TYPE_BATCH

        assert JOB_TYPE_BATCH == "BATCH"

    def test_job_type_streaming(self):
        from stt.core.config.constants import JOB_TYPE_STREAMING

        assert JOB_TYPE_STREAMING == "STREAMING"


class TestAudioConstants:
    """Tests for audio-related constants."""

    def test_supported_audio_formats(self):
        from stt.core.config.constants import SUPPORTED_AUDIO_FORMATS

        expected = ["wav", "mp3", "flac", "ogg", "webm", "m4a", "aac"]
        assert SUPPORTED_AUDIO_FORMATS == expected

    def test_default_sample_rate(self):
        from stt.core.config.constants import DEFAULT_SAMPLE_RATE

        assert DEFAULT_SAMPLE_RATE == 16000

    def test_default_channels(self):
        from stt.core.config.constants import DEFAULT_CHANNELS

        assert DEFAULT_CHANNELS == 1  # Mono
