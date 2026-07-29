"""Unit tests for the OpenAI speech-to-text loader (TASK-567).

Mirrors ``test_sarvam_loader.py``: BYOK-override-first / env-fallback, the
CloudASRAuthError when neither source has a key, base_url override, and the
never-log-the-key invariant.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from stt.core.exceptions import CloudASRAuthError
from stt.models.base_loader import LoadedModel
from stt.models.cloud_asr import CloudRestConfig
from stt.models.openai_loader import DEFAULT_OPENAI_MODEL, OpenAILoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(source_uri: str | None = "gpt-4o-transcribe") -> AiModelConfig:
    return AiModelConfig(
        id="m-openai-1",
        tenant_id="t-1",
        slug="openai-stt",
        name="OpenAI STT",
        description="OpenAI speech-to-text",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri=source_uri,
        source_revision=None,
        format=AiModelFormat.OPENAI,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
    )


def _settings(openai_key: SecretStr | None) -> MagicMock:
    return MagicMock(
        openai_api_key=openai_key,
        openai_base_url="https://api.openai.com/v1",
    )


class TestOpenAILoaderFormats:
    def test_supported_formats(self):
        assert OpenAILoader().supported_formats == [AiModelFormat.OPENAI]

    def test_estimate_memory_zero(self):
        assert OpenAILoader().estimate_memory(_config()) == 0


class TestOpenAILoaderLoad:
    @pytest.mark.asyncio
    async def test_load_with_env_key(self):
        loader = OpenAILoader()
        with patch("stt.models.openai_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("env-openai-key"))
            result = await loader.load(_config())
        assert isinstance(result, LoadedModel)
        assert result.format == AiModelFormat.OPENAI
        assert result.device == "cloud"
        assert result.extra["provider"] == "openai"
        cfg = result.model
        assert isinstance(cfg, CloudRestConfig)
        assert cfg.api_key.get_secret_value() == "env-openai-key"
        assert cfg.model_name == "gpt-4o-transcribe"
        assert cfg.base_url == "https://api.openai.com/v1"

    @pytest.mark.asyncio
    async def test_override_key_and_base_url_win(self):
        loader = OpenAILoader()
        with patch("stt.models.openai_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("env-key"))
            result = await loader.load(
                _config(),
                provider_overrides={
                    "openai": {
                        "api_key": "byok-key",
                        "base_url": "https://my-azure.openai.azure.com/v1",
                        "model": "gpt-4o-mini-transcribe",
                    }
                },
            )
        cfg = result.model
        assert cfg.api_key.get_secret_value() == "byok-key"
        assert cfg.base_url == "https://my-azure.openai.azure.com/v1"
        assert cfg.model_name == "gpt-4o-mini-transcribe"

    @pytest.mark.asyncio
    async def test_raises_when_no_key_anywhere(self):
        loader = OpenAILoader()
        with patch("stt.models.openai_loader.get_settings") as gs:
            gs.return_value = _settings(None)
            with pytest.raises(CloudASRAuthError) as exc:
                await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["provider"] == "openai"

    @pytest.mark.asyncio
    async def test_default_model_when_no_source_uri(self):
        loader = OpenAILoader()
        with patch("stt.models.openai_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("k"))
            result = await loader.load(_config(source_uri=None))
        assert result.model.model_name == DEFAULT_OPENAI_MODEL

    @pytest.mark.asyncio
    async def test_key_absent_from_repr_and_logs(self, caplog):
        loader = OpenAILoader()
        with patch("stt.models.openai_loader.get_settings") as gs:
            gs.return_value = _settings(SecretStr("super-secret-openai"))
            with caplog.at_level("DEBUG"):
                result = await loader.load(
                    _config(),
                    provider_overrides={"openai": {"api_key": "super-secret-openai"}},
                )
        assert "super-secret-openai" not in repr(result.model)
        assert "super-secret-openai" not in caplog.text
