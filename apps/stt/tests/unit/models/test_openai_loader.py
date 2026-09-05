"""Unit tests for the OpenAI speech-to-text loader.

Mirrors ``test_sarvam_loader.py``: the connection row supplies BOTH halves, the
CloudASRAuthError when either is missing, and the never-log-the-key invariant.

TASK-880 — ``stt.openai.baseUrl`` is deleted with the key. An override entry exists
only behind an enabled, keyed ``AiProviderConnection(stt, openai)`` row, and that row
carries ``baseUrl`` — including the Azure-OpenAI-compatible endpoints this loader
exists to reach.
"""

from datetime import datetime

import pytest

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


_BASE_URL = "https://api.openai.com/v1"


def _entry(**extra: object) -> dict[str, dict[str, object]]:
    """A complete connection row on the wire (`base_url` from `AiProviderConnection.baseUrl`)."""
    return {"openai": {"api_key": "byok-openai-key", "base_url": _BASE_URL, **extra}}


class TestOpenAILoaderFormats:
    def test_supported_formats(self):
        assert OpenAILoader().supported_formats == [AiModelFormat.OPENAI]

    def test_estimate_memory_zero(self):
        assert OpenAILoader().estimate_memory(_config()) == 0


class TestOpenAILoaderLoad:
    @pytest.mark.asyncio
    async def test_load_with_override_key(self):
        loader = OpenAILoader()
        result = await loader.load(_config(), provider_overrides=_entry())
        assert isinstance(result, LoadedModel)
        assert result.format == AiModelFormat.OPENAI
        assert result.device == "cloud"
        assert result.extra["provider"] == "openai"
        cfg = result.model
        assert isinstance(cfg, CloudRestConfig)
        assert cfg.api_key.get_secret_value() == "byok-openai-key"
        assert cfg.model_name == "gpt-4o-transcribe"
        assert cfg.base_url == _BASE_URL

    @pytest.mark.asyncio
    async def test_no_connection_row_fails_closed(self):
        """With no override entry the loader fails closed. TASK-880 — there is no env
        half left at all: the loader no longer reads `Settings`."""
        loader = OpenAILoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["has_base_url"] is False

    @pytest.mark.asyncio
    async def test_a_row_with_a_key_but_no_base_url_fails_closed(self):
        """TASK-880 — a keyed row with no `baseUrl` is a misconfigured row. It used to
        silently inherit the platform key's hardcoded api.openai.com."""
        loader = OpenAILoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config(), provider_overrides={"openai": {"api_key": "k"}})
        assert exc.value.details["has_key"] is True
        assert exc.value.details["has_base_url"] is False

    @pytest.mark.asyncio
    async def test_the_rows_base_url_and_model_reach_the_wire(self):
        loader = OpenAILoader()
        result = await loader.load(
            _config(),
            provider_overrides=_entry(
                api_key="byok-key",
                base_url="https://my-azure.openai.azure.com/v1",
                model="gpt-4o-mini-transcribe",
            ),
        )
        cfg = result.model
        assert cfg.api_key.get_secret_value() == "byok-key"
        assert cfg.base_url == "https://my-azure.openai.azure.com/v1"
        assert cfg.model_name == "gpt-4o-mini-transcribe"

    @pytest.mark.asyncio
    async def test_raises_when_no_key_anywhere(self):
        loader = OpenAILoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["provider"] == "openai"

    @pytest.mark.asyncio
    async def test_default_model_when_no_source_uri(self):
        loader = OpenAILoader()
        result = await loader.load(_config(source_uri=None), provider_overrides=_entry())
        assert result.model.model_name == DEFAULT_OPENAI_MODEL

    @pytest.mark.asyncio
    async def test_key_absent_from_repr_and_logs(self, caplog):
        loader = OpenAILoader()
        with caplog.at_level("DEBUG"):
            result = await loader.load(
                _config(), provider_overrides=_entry(api_key="super-secret-openai")
            )
        assert "super-secret-openai" not in repr(result.model)
        assert "super-secret-openai" not in caplog.text
