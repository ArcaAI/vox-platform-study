"""Unit tests for application settings."""

import os
from unittest.mock import patch

from stt.core.config.settings import Settings, get_settings


class TestSettings:
    """Tests for Settings class."""

    def test_default_values(self):
        """Test default configuration values."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.app_name == "stt"
            assert settings.app_version == "2.0.0"
            assert settings.debug is False
            assert settings.host == "0.0.0.0"
            assert settings.port == 8861
            assert settings.log_level == "INFO"

    def test_database_defaults(self):
        """Test database default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)

            assert "postgresql" in settings.database_url
            assert settings.database_pool_size == 5
            assert settings.database_max_overflow == 10

    def test_redis_defaults(self):
        """Test Redis default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert "redis://" in settings.redis_url

    def test_minio_defaults(self):
        """Test MinIO configuration has valid values."""
        # Note: We don't check specific values as they may come from .env file
        settings = get_settings()

        assert settings.minio_endpoint is not None
        assert settings.minio_access_key is not None
        assert settings.minio_secret_key is not None
        assert isinstance(settings.minio_secure, bool)
        assert settings.minio_audio_bucket == "hope-audio"
        assert settings.minio_chunk_bucket == "hope-audio-chunks"

    def test_api_gateway_defaults(self):
        """Test API Gateway configuration has valid values."""
        # Note: We don't check specific values as they may come from .env file
        settings = get_settings()

        assert settings.api_gateway_url is not None
        assert "http" in settings.api_gateway_url
        assert settings.api_gateway_timeout > 0

    def test_model_cache_defaults(self):
        """Test model cache default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.model_cache_max_models == 5
            assert settings.model_cache_ttl_seconds == 3600

    def test_huggingface_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)

            assert settings.huggingface_cache_dir == os.path.expanduser(
                "~/.cache/huggingface/hub"
            )

    def test_worker_defaults(self):
        """Test worker default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.worker_concurrency == 4
            assert settings.worker_max_retries == 3

    def test_transcription_defaults(self):
        """Test transcription default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.transcription_timeout_seconds == 600
            assert settings.transcription_chunk_length_s == 15
            assert settings.transcription_stride_length_s == "4,2"

    def test_byok_credentials_are_not_settings_fields(self):
        """TASK-602: Sarvam / OpenAI / Azure-Speech subscription keys are BYOK-only
        — they are NOT Settings fields at all (resolved per request from the
        provider-connection plane). Their env vars are silently ignored (extra=ignore)
        and the attributes do not exist on Settings. The non-secret region / base_url
        fields remain."""
        env_vars = {
            "SARVAM_API_KEY": "leaked-sarvam",
            "OPENAI_API_KEY": "leaked-openai",
            "AZURE_SPEECH_KEY": "leaked-azure",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings(_env_file=None)

            assert not hasattr(settings, "sarvam_api_key")
            assert not hasattr(settings, "openai_api_key")
            assert not hasattr(settings, "azure_speech_key")
            # Non-secret operational fields are unaffected.
            assert settings.sarvam_base_url == "https://api.sarvam.ai"
            assert settings.openai_base_url == "https://api.openai.com/v1"

    def test_env_override(self):
        """Test environment variable overrides."""
        env_vars = {
            "APP_NAME": "test-stt",
            "APP_VERSION": "3.0.0",
            "DEBUG": "true",
            "HOST": "127.0.0.1",
            "PORT": "9000",
            "LOG_LEVEL": "DEBUG",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.app_name == "test-stt"
            assert settings.app_version == "3.0.0"
            assert settings.debug is True
            assert settings.host == "127.0.0.1"
            assert settings.port == 9000
            assert settings.log_level == "DEBUG"

    def test_database_url_override(self):
        """Test database URL override."""
        env_vars = {
            "DATABASE_URL": "postgresql+asyncpg://user:pass@db:5432/test",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.database_url == "postgresql+asyncpg://user:pass@db:5432/test"

    def test_redis_url_override(self):
        """Test Redis URL override."""
        env_vars = {
            "REDIS_URL": "redis://redis-server:6379/1",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.redis_url == "redis://redis-server:6379/1"

    def test_minio_override(self):
        """Test MinIO configuration override."""
        env_vars = {
            "MINIO_ENDPOINT": "minio.example.com:9000",
            "MINIO_ACCESS_KEY": "access123",
            "MINIO_SECRET_KEY": "secret456",
            "MINIO_SECURE": "true",
            "MINIO_AUDIO_BUCKET": "custom-audio",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.minio_endpoint == "minio.example.com:9000"
            assert settings.minio_access_key.get_secret_value() == "access123"
            assert settings.minio_secret_key.get_secret_value() == "secret456"
            assert settings.minio_secure is True
            assert settings.minio_audio_bucket == "custom-audio"

    def test_api_gateway_override(self):
        """Test API Gateway configuration override."""
        env_vars = {
            "API_GATEWAY_URL": "http://api:8868/api/v1",
            "API_GATEWAY_KEY": "secret-key",
            "API_GATEWAY_TIMEOUT": "60",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.api_gateway_url == "http://api:8868/api/v1"
            assert settings.api_gateway_key.get_secret_value() == "secret-key"
            assert settings.api_gateway_timeout == 60

    def test_huggingface_token_override(self):
        """Test HuggingFace token override."""
        env_vars = {
            "HUGGINGFACE_TOKEN": "hf_test_token",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.huggingface_token.get_secret_value() == "hf_test_token"

    def test_huggingface_token_empty_string_normalized_to_none(self):
        """An empty ``HUGGINGFACE_TOKEN`` must be treated as unset (None).

        Regression: an explicitly-empty value (``HUGGINGFACE_TOKEN=``) was
        forwarded to the HuggingFace libraries as ``token=""``, which builds an
        ``Authorization: Bearer `` header with no credential and raises
        ``Illegal header value b'Bearer '`` on every model load. It must become
        ``None`` so huggingface_hub falls back to ``HF_TOKEN`` / anonymous.
        """
        with patch.dict(os.environ, {"HUGGINGFACE_TOKEN": ""}, clear=True):
            settings = Settings()

            assert settings.huggingface_token is None

    def test_huggingface_token_whitespace_normalized_to_none(self):
        """A whitespace-only ``HUGGINGFACE_TOKEN`` must be treated as unset."""
        with patch.dict(os.environ, {"HUGGINGFACE_TOKEN": "   "}, clear=True):
            settings = Settings()

            assert settings.huggingface_token is None

    def test_cors_origins_default(self):
        """Test CORS origins default."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.cors_origins == ["*"]

    def test_log_level_validation(self):
        """Test log level is constrained to valid values."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            # Default should be valid
            assert settings.log_level in ["DEBUG", "INFO", "WARNING", "ERROR"]

    def test_azure_speech_region_defaults(self):
        """Test Azure Speech region default (None when not set).

        TASK-602: the Azure Speech KEY is no longer a settings field (BYOK-only);
        only the non-secret region remains.
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)

            assert settings.azure_speech_region is None

    def test_azure_speech_region_env_override(self):
        """Test the non-secret Azure Speech region env override.

        TASK-602: AZURE_SPEECH_KEY is intentionally ignored (BYOK-only, no field).
        """
        env_vars = {
            "AZURE_SPEECH_KEY": "test-azure-key-123",  # ignored (no field)
            "AZURE_SPEECH_REGION": "eastus2",
        }

        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()

            assert settings.azure_speech_region == "eastus2"
            assert not hasattr(settings, "azure_speech_key")

    def test_vad_defaults(self):
        """Test Silero VAD default configuration.

        `_env_file=None` so the CODE defaults are asserted — a local
        untracked .env previously masked the defaults (and diverged from CI).
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.vad_model_path is None
            assert settings.vad_threshold == 0.5
            assert settings.vad_min_speech_duration_ms == 100
            assert settings.vad_min_silence_duration_ms == 500
            assert settings.vad_speech_pad_ms == 200
            assert settings.vad_sample_rate == 16000

    def test_vad_env_override(self):
        """Test Silero VAD environment variable overrides."""
        env_vars = {
            "VAD_MODEL_PATH": "/custom/vad.onnx",
            "VAD_THRESHOLD": "0.6",
            "VAD_MIN_SPEECH_DURATION_MS": "300",
            "VAD_MIN_SILENCE_DURATION_MS": "600",
            "VAD_SPEECH_PAD_MS": "50",
            "VAD_SAMPLE_RATE": "8000",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()
            assert settings.vad_model_path == "/custom/vad.onnx"
            assert settings.vad_threshold == 0.6
            assert settings.vad_min_speech_duration_ms == 300
            assert settings.vad_min_silence_duration_ms == 600
            assert settings.vad_speech_pad_ms == 50
            assert settings.vad_sample_rate == 8000

    def test_diarization_defaults(self):
        """Test Pyannote diarization default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.diarization_hf_model_id == "pyannote/wespeaker-voxceleb-resnet34-LM"
            assert settings.diarization_similarity_threshold == 0.7
            assert settings.diarization_device == "auto"

    def test_diarization_env_override(self):
        """Test diarization environment variable overrides."""
        env_vars = {
            "DIARIZATION_HF_MODEL_ID": "custom/embedding-model",
            "DIARIZATION_SIMILARITY_THRESHOLD": "0.8",
            "DIARIZATION_DEVICE": "cuda",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()
            assert settings.diarization_hf_model_id == "custom/embedding-model"
            assert settings.diarization_similarity_threshold == 0.8
            assert settings.diarization_device == "cuda"

    def test_inference_pool_defaults(self):
        """Test inference pool default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()
            assert settings.inference_pool_size == 0

    def test_inference_pool_env_override(self):
        """Test inference pool environment variable overrides."""
        env_vars = {"INFERENCE_POOL_SIZE": "4"}
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()
            assert settings.inference_pool_size == 4

    def test_mlflow_defaults(self):
        """Test MLFlow reserved fields default to None."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.mlflow_tracking_uri is None
            assert settings.mlflow_model_registry is None


class TestGetSettings:
    """Tests for get_settings singleton."""

    def test_returns_settings_instance(self):
        """Test that get_settings returns Settings instance."""
        # Clear cache for test isolation
        get_settings.cache_clear()

        settings = get_settings()

        assert isinstance(settings, Settings)

    def test_caches_result(self):
        """Test that get_settings caches the result."""
        get_settings.cache_clear()

        settings1 = get_settings()
        settings2 = get_settings()

        assert settings1 is settings2


class TestSecretRedaction:
    """TASK-558-H (§13.2 P4) — credentials must never render in the clear.

    These fields become Vault-Agent-rendered files in the cloud, so a plain
    ``str`` here would put live credentials into any ``repr()``, ``model_dump()``
    or traceback that captures the settings object.
    """

    SECRET_ENV = {
        "MINIO_ACCESS_KEY": "leak-minio-access",
        "MINIO_SECRET_KEY": "leak-minio-secret",
        "AZURE_STORAGE_ACCOUNT_KEY": "leak-azure-account",
        "AZURE_STORAGE_CONNECTION_STRING": "leak-azure-conn",
        "API_GATEWAY_KEY": "leak-gateway",
        "HUGGINGFACE_TOKEN": "leak-hf",
        # TASK-602: AZURE_SPEECH_KEY is no longer a settings field (BYOK-only).
        "AZURE_FOUNDRY_API_KEY": "leak-foundry",
    }

    def _settings(self) -> Settings:
        with patch.dict(os.environ, self.SECRET_ENV, clear=True):
            return Settings(_env_file=None)

    def test_secrets_absent_from_repr(self):
        rendered = repr(self._settings())

        for value in self.SECRET_ENV.values():
            assert value not in rendered, f"{value} leaked into repr()"

    def test_secrets_absent_from_model_dump(self):
        settings = self._settings()

        for value in self.SECRET_ENV.values():
            assert value not in str(settings.model_dump()), f"{value} leaked into model_dump()"
            assert value not in settings.model_dump_json(), f"{value} leaked into model_dump_json()"

    def test_values_still_reachable_via_get_secret_value(self):
        settings = self._settings()

        assert settings.minio_access_key.get_secret_value() == "leak-minio-access"
        assert settings.minio_secret_key.get_secret_value() == "leak-minio-secret"
        assert settings.azure_storage_account_key.get_secret_value() == "leak-azure-account"
        assert settings.azure_storage_connection_string.get_secret_value() == "leak-azure-conn"
        assert settings.api_gateway_key.get_secret_value() == "leak-gateway"
        assert settings.huggingface_token.get_secret_value() == "leak-hf"
        assert settings.azure_foundry_api_key.get_secret_value() == "leak-foundry"
