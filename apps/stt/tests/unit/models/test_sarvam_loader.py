"""Unit tests for the Sarvam speech-to-text loader (TASK-567).

Covers BYOK-override-first / env-fallback credential resolution, the
CloudASRAuthError when neither source has a key, and the security invariant
that key material never appears in repr or logs.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from stt.core.exceptions import CloudASRAuthError
from stt.models.base_loader import LoadedModel
from stt.models.cloud_asr import CloudRestConfig
from stt.models.sarvam_loader import DEFAULT_SARVAM_MODEL, SarvamLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(source_uri: str | None = "saaras:v4") -> AiModelConfig:
    return AiModelConfig(
        id="m-sarvam-1",
        tenant_id="t-1",
        slug="sarvam-stt",
        name="Sarvam STT",
        description="Sarvam speech-to-text",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri=source_uri,
        source_revision=None,
        format=AiModelFormat.SARVAM,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
    )


def _settings(sarvam_key: SecretStr | None) -> MagicMock:
    return MagicMock(
        sarvam_api_key=sarvam_key,
        sarvam_base_url="https://api.sarvam.ai",
    )


class TestSarvamLoaderFormats:
    def test_supported_formats(self):
        assert SarvamLoader().supported_formats == [AiModelFormat.SARVAM]

    def test_estimate_memory_zero(self):
        assert SarvamLoader().estimate_memory(_config()) == 0


class TestSarvamLoaderLoad:
    @pytest.mark.asyncio
    async def test_load_with_env_key(self):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("env-sarvam-key"))
            result = await loader.load(_config())
        assert isinstance(result, LoadedModel)
        assert result.format == AiModelFormat.SARVAM
        assert result.device == "cloud"
        assert result.memory_mb == 0
        assert result.extra["provider"] == "sarvam"
        cfg = result.model
        assert isinstance(cfg, CloudRestConfig)
        assert cfg.api_key.get_secret_value() == "env-sarvam-key"
        assert cfg.model_name == "saaras:v4"

    @pytest.mark.asyncio
    async def test_override_key_wins_over_env(self):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("env-key"))
            result = await loader.load(
                _config(),
                provider_overrides={"sarvam": {"api_key": "byok-key", "model": "saaras:v2"}},
            )
        cfg = result.model
        assert cfg.api_key.get_secret_value() == "byok-key"
        assert cfg.model_name == "saaras:v2"

    @pytest.mark.asyncio
    async def test_override_without_key_falls_back_to_env(self):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("env-key"))
            result = await loader.load(
                _config(),
                provider_overrides={"sarvam": {"model": "saaras:v2"}},
            )
        cfg = result.model
        assert cfg.api_key.get_secret_value() == "env-key"
        assert cfg.model_name == "saaras:v2"

    @pytest.mark.asyncio
    async def test_raises_when_no_key_anywhere(self):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(None)
            with pytest.raises(CloudASRAuthError) as exc:
                await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["provider"] == "sarvam"

    @pytest.mark.asyncio
    async def test_default_model_when_no_source_uri(self):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("k"))
            result = await loader.load(_config(source_uri=None))
        assert result.model.model_name == DEFAULT_SARVAM_MODEL

    @pytest.mark.asyncio
    async def test_key_absent_from_repr_and_logs(self, caplog):
        loader = SarvamLoader()
        with patch("stt.models.sarvam_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("super-secret-sarvam"))
            with caplog.at_level("DEBUG"):
                result = await loader.load(
                    _config(),
                    provider_overrides={"sarvam": {"api_key": "super-secret-sarvam"}},
                )
        assert "super-secret-sarvam" not in repr(result.model)
        assert "super-secret-sarvam" not in caplog.text
