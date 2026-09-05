"""Unit tests for the Sarvam speech-to-text loader.

Covers connection-row credential resolution, the CloudASRAuthError when the row is
missing either half, and the security invariant that key material never appears in
repr or logs.

TASK-880 — there is no env half left to fall back to. `stt.sarvam.baseUrl` is deleted
along with the key: an override entry exists ONLY behind an enabled, keyed
`AiProviderConnection(stt, sarvam)` row, and that row carries `baseUrl`. The deleted
key's default was the PUBLIC api.sarvam.ai, which carries no BAA and must not be a
silent default on a PHI platform.
"""

from datetime import datetime

import pytest

from stt.core.exceptions import CloudASRAuthError, ModelNotFoundError
from stt.models.base_loader import LoadedModel
from stt.models.cloud_asr import CloudRestConfig
from stt.models.sarvam_loader import SarvamLoader
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


#: A complete connection row on the wire: credential AND endpoint, as
#: `toOverrideEntry` emits them (`base_url` from `AiProviderConnection.baseUrl`).
_BASE_URL = "https://api.sarvam.ai"


def _entry(**extra: object) -> dict[str, dict[str, object]]:
    return {"sarvam": {"api_key": "byok-sarvam-key", "base_url": _BASE_URL, **extra}}


class TestSarvamLoaderFormats:
    def test_supported_formats(self):
        assert SarvamLoader().supported_formats == [AiModelFormat.SARVAM]

    def test_estimate_memory_zero(self):
        assert SarvamLoader().estimate_memory(_config()) == 0


class TestSarvamLoaderLoad:
    @pytest.mark.asyncio
    async def test_load_with_override_key(self):
        loader = SarvamLoader()
        result = await loader.load(_config(), provider_overrides=_entry())
        assert isinstance(result, LoadedModel)
        assert result.format == AiModelFormat.SARVAM
        assert result.device == "cloud"
        assert result.memory_mb == 0
        assert result.extra["provider"] == "sarvam"
        cfg = result.model
        assert isinstance(cfg, CloudRestConfig)
        assert cfg.api_key.get_secret_value() == "byok-sarvam-key"
        assert cfg.base_url == _BASE_URL
        assert cfg.model_name == "saaras:v4"

    @pytest.mark.asyncio
    async def test_no_connection_row_fails_closed(self):
        """With no override entry the loader fails closed. TASK-880 — there is no
        env half left at all: the loader no longer reads `Settings`."""
        loader = SarvamLoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["has_base_url"] is False

    @pytest.mark.asyncio
    async def test_a_row_with_a_key_but_no_base_url_fails_closed(self):
        """TASK-880 — the endpoint is not optional now that no platform default backs
        it. A keyed row with no `baseUrl` is a misconfigured row, and it says so."""
        loader = SarvamLoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config(), provider_overrides={"sarvam": {"api_key": "k"}})
        assert exc.value.details["has_key"] is True
        assert exc.value.details["has_base_url"] is False

    @pytest.mark.asyncio
    async def test_the_rows_model_override_wins(self):
        loader = SarvamLoader()
        result = await loader.load(
            _config(), provider_overrides=_entry(api_key="byok-key", model="saaras:v2")
        )
        cfg = result.model
        assert cfg.api_key.get_secret_value() == "byok-key"
        assert cfg.model_name == "saaras:v2"

    @pytest.mark.asyncio
    async def test_override_without_key_raises(self):
        """An override carrying no api_key fails closed (BYOK-only); there is no
        other source to fall back to."""
        loader = SarvamLoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(
                _config(),
                provider_overrides={"sarvam": {"model": "saaras:v2", "base_url": _BASE_URL}},
            )
        assert exc.value.details["has_key"] is False

    @pytest.mark.asyncio
    async def test_raises_when_no_key_anywhere(self):
        loader = SarvamLoader()
        with pytest.raises(CloudASRAuthError) as exc:
            await loader.load(_config())
        assert exc.value.details["has_key"] is False
        assert exc.value.details["provider"] == "sarvam"

    @pytest.mark.asyncio
    async def test_model_selection_fails_closed_when_no_source_uri(self):
        """/ F-11: an unresolved model SELECTION must raise, not default.

        This loader used to fall back to a hardcoded `"saaras:v4"` when the
        `AiModel` row carried no `source_uri`. That is the failure mode rule 09
        names outright — "provider/model SELECTION is fail-closed (503, never an
        env fallback)" — and it is worse than a plain outage: the caller gets a
        successful load of a model NOBODY selected, billed to the tenant's own
        Sarvam key, with nothing in the response saying which model ran.

        The credential is present here on purpose, so the failure can only be
        attributed to the missing selection.
        """
        loader = SarvamLoader()
        with pytest.raises(ModelNotFoundError) as exc:
            await loader.load(_config(source_uri=None), provider_overrides=_entry())
        assert exc.value.details["provider"] == "sarvam"
        assert exc.value.details["slug"] == "sarvam-stt"

    @pytest.mark.asyncio
    async def test_a_resolved_selection_reaches_the_wire(self):
        loader = SarvamLoader()
        result = await loader.load(_config(source_uri="saaras:v4"), provider_overrides=_entry())
        assert result.model.model_name == "saaras:v4"

    @pytest.mark.asyncio
    async def test_key_absent_from_repr_and_logs(self, caplog):
        loader = SarvamLoader()
        with caplog.at_level("DEBUG"):
            result = await loader.load(
                _config(), provider_overrides=_entry(api_key="super-secret-sarvam")
            )
        assert "super-secret-sarvam" not in repr(result.model)
        assert "super-secret-sarvam" not in caplog.text
