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

            assert settings.huggingface_cache_dir == os.path.expanduser("~/.cache/huggingface/hub")

    def test_worker_defaults(self):
        """Test worker default configuration."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.worker_threads == 4
            assert settings.worker_max_retries == 3

    def test_transcription_defaults(self):
        """Test transcription default configuration.

        TASK-880 — `transcription_chunk_length_s` / `_stride_length_s` were asserted
        here. Chunking is the agent's (`decoding.{chunkLengthSec,strideLengthSec}`) and
        the engine defaults moved to `InferenceConfig`; the job timeout stays, because a
        batch worker's wall-clock budget is a property of this process.
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            assert settings.transcription_timeout_seconds == 600
            assert "transcription_chunk_length_s" not in Settings.model_fields
            assert "transcription_stride_length_s" not in Settings.model_fields

            from stt.pipeline.dto import InferenceConfig

            assert InferenceConfig().chunk_length_sec == 15.0
            assert InferenceConfig().stride_length_sec == (4, 2)

    def test_no_cloud_asr_engine_has_a_settings_field_of_any_kind(self):
        """TASK-880 — the cloud STT engines have NO fields left, secret or not.

        Their KEYS never had one (BYOK, resolved per request from
        `AiProviderConnection`). The non-secret halves — region, base URL, endpoint,
        enable flag — are properties of the CONNECTION, and a connection reaches a
        loader only as a `provider_overrides` entry, which exists only behind an
        enabled, keyed row: the same row that carries `baseUrl`/`region`. So these
        fields could only ever patch a row that forgot to set its own, while making
        a PUBLIC vendor endpoint the silent default on a PHI platform.
        """
        env_vars = {
            "SARVAM_API_KEY": "leaked-sarvam",
            "OPENAI_API_KEY": "leaked-openai",
            "AZURE_SPEECH_KEY": "leaked-azure",
            "SARVAM_BASE_URL": "https://leaked.sarvam.ai",
            "OPENAI_BASE_URL": "https://leaked.openai.com/v1",
            "AZURE_SPEECH_REGION": "leakedregion",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings(_env_file=None)

            for field in (
                "sarvam_api_key",
                "openai_api_key",
                "azure_speech_key",
                "sarvam_base_url",
                "openai_base_url",
                "azure_speech_region",
            ):
                assert not hasattr(settings, field), field

    def test_azure_foundry_has_no_settings_field_including_its_gate(self):
        """TASK-880 — Foundry's ENABLE FLAG went with its endpoint and its key.

        `stt.azureFoundry.enabled` was a per-PLATFORM boolean standing in for "is this
        preview engine available?". The `AiProviderConnection(stt, azure-foundry)` row
        answers that better and PER TENANT: no row / disabled / keyless = no override
        entry = the engine cannot load, with the SYSTEM row seeded disabled as the
        preview veto. Foundry has its own row now rather than aliasing `azure-speech`,
        so enabling Speech does not enable a PREVIEW service for PHI.
        """
        env_vars = {
            "AZURE_FOUNDRY_API_KEY": "leaked-foundry",
            "AZURE_FOUNDRY_MODEL": "mai-transcribe-1.5",
            "AZURE_FOUNDRY_ENDPOINT": "https://res.cognitiveservices.azure.com",
            "AZURE_FOUNDRY_ENABLED": "true",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings(_env_file=None)

            for field in (
                "azure_foundry_api_key",
                "azure_foundry_model",
                "azure_foundry_enabled",
                "azure_foundry_endpoint",
            ):
                assert not hasattr(settings, field), field

    def test_verified_dead_settings_fields_are_gone(self):
        """Fields with ZERO read sites anywhere in the service. `WORKER_CONCURRENCY`
        was even self-documented as dead in `core/runtime_limits.py` and still
        shipped — a dead knob an operator can set is worse than no knob, because
        setting it looks like it did something.

        Beware the same-named LIVE symbols: `resolve_worker_concurrency()` and the
        effective-config snapshot's `worker_concurrency()` method both stay — only
        the SETTINGS FIELD was dead. `worker_threads` is what reaches `Worker(...)`."""
        dead = (
            "whisper_cpp_library_path",
            "vad_sample_rate",
            "diarization_similarity_threshold",
            "inference_pool_size",
            "mlflow_tracking_uri",
            "mlflow_model_registry",
            "worker_concurrency",
        )
        for name in dead:
            assert name not in Settings.model_fields, f"{name} is dead and must not be a field"

        # The live neighbours these sat next to must survive.
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.worker_threads == 4
            assert settings.whisper_cpp_num_threads == 8
            assert settings.vad_threshold == 0.5
            assert settings.diarization_device == "auto"

    def test_env_override(self):
        """Process identity and topology stay env-settable; build identity does not.

        `DEBUG` / `HOST` / `PORT` / `LOG_LEVEL` are the bootstrap floor — how the
        process is launched and where it listens — so they remain env vars.
        `APP_NAME` / `APP_VERSION` are BUILD identity and were removed from the
        env surface by : the authoritative version is the release tag in
        the image's `build-info.json`, and a service that reports whatever
        version an env var claims is the `apps/api` reported-`0.1.0` defect.
        """
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

            assert settings.app_name == "stt"
            assert settings.app_version == "2.0.0"
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
            # the URL and KEY stay in env — they are BOOTSTRAP
            # TRANSPORT, the means by which this process reaches the config
            # source, so they cannot themselves come from it. The TIMEOUT is
            # ordinary tuning and moved to `stt.gateway.timeoutSeconds`.
            assert settings.api_gateway_timeout == 30

    def test_huggingface_token_env_path_is_CLOSED(self):
        """HUGGINGFACE_TOKEN no longer reaches this process.

        The token is a BYO credential on ``AiProviderConnection``
        (``model-registry`` / ``huggingface``), resolved tenant -> SYSTEM for the
        tenant that OWNS the model being fetched. The env path is closed
        STRUCTURALLY — a dead ``validation_alias`` no variable matches, with
        ``populate_by_name`` off so the field name cannot re-open it — rather
        than by convention, so this cannot regress by someone reading a comment
        and disagreeing with it.

        Asserted with the variable SET, because "it is ignored when present" is
        the property that matters; "absent yields None" would pass even if the
        path were wide open.
        """
        with patch.dict(os.environ, {"HUGGINGFACE_TOKEN": "hf_test_token"}, clear=True):
            settings = Settings(_env_file=None)

            assert settings.huggingface_token is None

    def test_model_s3_credential_env_paths_are_CLOSED(self):
        """the STT_MODEL_S3_* triple no longer reaches this process.

        Endpoint, access key id and secret key are ONE credential and moved
        together onto the ``model-registry`` / ``s3`` connection. The endpoint
        travels WITH the pair rather than staying in env: a tenant that brings
        its own weights bucket brings its own host, and splitting them across
        two tiers is how a credential ends up pointed at the wrong endpoint.
        """
        env = {
            "STT_MODEL_S3_ENDPOINT": "leaked-minio:9000",
            "STT_MODEL_S3_ACCESS_KEY": "leaked-access",
            "STT_MODEL_S3_SECRET_KEY": "leaked-secret",
        }
        with patch.dict(os.environ, env, clear=True):
            settings = Settings(_env_file=None)

            assert settings.model_s3_endpoint is None
            assert settings.model_s3_access_key is None
            assert settings.model_s3_secret_key is None

    def test_cors_origins_default(self):
        """CORS is EMPTY by default — no wildcard.

        stt handles PHI audio and the browser never talks to :8861 directly
        (the gateway fronts every route), so the service names no origin of its
        own. An operator with a genuine direct-browser need sets CORS_ORIGINS
        explicitly; ``["*"]`` was the old shipped default and must not return.

        ``_env_file=None`` skips the gitignored service-local ``apps/stt/.env``
        dev overlay (which sets ``CORS_ORIGINS=["*"]``) so this asserts the
        code default, not the developer's machine.
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)

            assert settings.cors_origins == []

    def test_log_level_validation(self):
        """Test log level is constrained to valid values."""
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings()

            # Default should be valid
            assert settings.log_level in ["DEBUG", "INFO", "WARNING", "ERROR"]

    def test_no_cloud_engine_key_is_settable_from_the_control_plane_either(self):
        """TASK-880 — the cloud engine family has NO control-plane keys left.

        `stt.azureSpeech.region`, `stt.azureFoundry.{enabled,endpoint}`,
        `stt.sarvam.baseUrl` and `stt.openai.baseUrl` all moved onto the
        `AiProviderConnection` row that already had to exist for the credential to
        arrive. The env path was closed before; now the CONTROL-PLANE path is closed
        too, so there is exactly one place a cloud endpoint can be set.
        """
        from stt.core.control_plane import CONTROL_PLANE_KEYS

        moved = ("stt.azureSpeech.", "stt.azureFoundry.", "stt.sarvam.", "stt.openai.")
        assert [k for k in CONTROL_PLANE_KEYS.values() if k.startswith(moved)] == []

    def test_vad_defaults(self):
        """Test Silero VAD default configuration.

        `_env_file=None` so the CODE defaults are asserted — a local
        untracked .env previously masked the defaults (and diverged from CI).
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.vad_threshold == 0.5
            assert settings.vad_min_speech_duration_ms == 100
            assert settings.vad_min_silence_duration_ms == 500

    def test_vad_is_control_plane_owned_not_env_owned(self):
        """the five VAD knobs no longer have an env path.

        A VAD threshold is a clinical-accuracy tuning parameter — the archetypal
        value an operator must be able to move against a measured scorecard
        without a redeploy, which is precisely what an env var forbids.
        """
        env_vars = {
            "VAD_MODEL_PATH": "/custom/vad.onnx",
            "VAD_THRESHOLD": "0.6",
            "VAD_MIN_SPEECH_DURATION_MS": "300",
            "VAD_MIN_SILENCE_DURATION_MS": "600",
            "VAD_SPEECH_PAD_MS": "50",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            settings = Settings()
            assert settings.vad_threshold == 0.5
            assert settings.vad_min_speech_duration_ms == 100
            assert settings.vad_min_silence_duration_ms == 500
            # TASK-880 — `VAD_MODEL_PATH` and `VAD_SPEECH_PAD_MS` cannot land anywhere
            # at all now: their fields are gone, not merely un-settable from env.
            assert "vad_model_path" not in Settings.model_fields
            assert "vad_speech_pad_ms" not in Settings.model_fields

    def test_vad_is_no_longer_settable_from_the_control_plane(self):
        """TASK-880 — the VAD family has NO control-plane keys left.

        `stt.vad.threshold` / `minSpeechDurationMs` / `minSilenceDurationMs` went in
        TASK-872: the live path takes its VAD parameters from `ResolvedAsrSpec`, so
        those three could only move a bootstrap default the spec then overrode (the
        FIELDS survive as that default). TASK-880 took the last two outright —
        `stt.vad.modelPath`, because the weights are an `AiModel` row whose `localPath`
        already travels on the spec, and `stt.vad.speechPadMs`, because padding is an
        agent tuning knob beside the three above it.
        """
        from stt.core.control_plane import CONTROL_PLANE_KEYS

        assert [k for k in CONTROL_PLANE_KEYS.values() if k.startswith("stt.vad.")] == []

    def test_diarization_defaults(self):
        """TASK-887 — only DEVICE placement is left here.

        `diarization_hf_model_id` named THE platform speaker-embedding model. Diarization is
        now a declared ASR-agent option: the agent binds the `SPEAKER_EMBEDDING` row
        (`ResolvedAsrSpec.models.embedding`) for a session, and the gateway pushes the same
        model to `/internal/voice-profile/extract` at enrollment. Where the model RUNS is
        still a property of the box, so `diarization_device` stays.
        """
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            assert settings.diarization_device == "auto"

    def test_the_platform_embedding_model_and_similarity_floor_are_gone(self):
        """Both fields, and both control-plane keys, removed together (TASK-887).

        `stt.diarization.hfModelId` declared a single platform embedding SPACE; the owner
        replaced it with a per-agent declaration, so a profile now records the model that
        embedded it and nothing platform-wide describes the space. `stt.voiceProfile.
        minSimilarity` moved to the agent's `audioFrontEnd.diarization.matchThreshold` for the
        same reason — how confidently a clinic wants a real name attached to speech is an
        agent decision.
        """
        from stt.core.control_plane import CONTROL_PLANE_KEYS

        assert "diarization_hf_model_id" not in Settings.model_fields
        assert "voice_profile_min_similarity" not in Settings.model_fields
        assert "stt.diarization.hfModelId" not in CONTROL_PLANE_KEYS.values()
        assert "stt.voiceProfile.minSimilarity" not in CONTROL_PLANE_KEYS.values()
        # Device placement survives — it is the box's property, not the agent's.
        assert CONTROL_PLANE_KEYS["diarization_device"] == "stt.diarization.device"

    def test_diarization_device_is_settable_from_the_control_plane(self):
        from stt.core.control_plane import apply_control_plane

        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
            apply_control_plane(
                settings,
                {
                    "settings": {
                        "stt.diarization.device": {
                            "value": "cuda",
                            "dataType": "string",
                            "source": "db",
                        },
                    }
                },
            )
            assert settings.diarization_device == "cuda"


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
    """Credentials must never render in the clear.

    These fields become Vault-Agent-rendered files in the cloud, so a plain
    ``str`` here would put live credentials into any ``repr``, ``model_dump``
    or traceback that captures the settings object.
    """

    SECRET_ENV = {
        "MINIO_ACCESS_KEY": "leak-minio-access",
        "MINIO_SECRET_KEY": "leak-minio-secret",
        "AZURE_STORAGE_ACCOUNT_KEY": "leak-azure-account",
        "AZURE_STORAGE_CONNECTION_STRING": "leak-azure-conn",
        "API_GATEWAY_KEY": "leak-gateway",
        # AZURE_SPEECH_KEY and AZURE_FOUNDRY_API_KEY are no longer settings
        # fields (both BYOK-only), and HUGGINGFACE_TOKEN joined them in
        # its env path is closed, so it can no longer leak FROM env.
        # `test_huggingface_token_env_path_is_CLOSED` covers that directly.
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
