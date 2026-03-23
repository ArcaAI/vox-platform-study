"""Unit tests for Azure Speech Loader and language normalization.

Tests cover:
- AzureSpeechLoader: credential validation, load/unload lifecycle, memory estimation
- normalize_language_for_azure: BCP-47 conversion, aliases, edge cases
- _resolve_region: region extraction from model config fields
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from stt_v2.core.exceptions import CloudASRAuthError
from stt_v2.models.azure_speech_loader import (
    _LANGUAGE_ALIASES,
    AzureSpeechLoader,
    normalize_language_for_azure,
)
from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)

# =============================================================================
# Fixtures
# =============================================================================


def create_azure_model_config(
    model_id: str = "m-azure-1",
    slug: str = "azure-speech",
    source_uri: str | None = "eastus",
    source_revision: str | None = None,
    compute_type: str | None = None,
) -> AiModelConfig:
    """Create a complete AiModelConfig for Azure Speech engine."""
    return AiModelConfig(
        id=model_id,
        tenant_id="t-456",
        slug=slug,
        name="Azure Speech",
        description="Azure Cognitive Services Speech engine",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,  # Cloud engines don't have a "source" in the HF sense
        source_uri=source_uri,
        source_revision=source_revision,
        format=AiModelFormat.AZURE_SPEECH,
        memory_size_mb=0,
        compute_type=compute_type,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=["cloud", "azure"],
    )


# =============================================================================
# normalize_language_for_azure
# =============================================================================


class TestNormalizeLanguageForAzure:
    """Tests for normalize_language_for_azure function."""

    def test_none_defaults_to_en_us(self):
        """Test that None language defaults to en-US."""
        assert normalize_language_for_azure(None) == "en-US"

    def test_empty_string_defaults_to_en_us(self):
        """Test that empty string defaults to en-US."""
        assert normalize_language_for_azure("") == "en-US"

    def test_bcp47_passthrough(self):
        """Test that BCP-47 codes with dash are passed through unchanged."""
        assert normalize_language_for_azure("en-US") == "en-US"
        assert normalize_language_for_azure("ml-IN") == "ml-IN"
        assert normalize_language_for_azure("zh-TW") == "zh-TW"
        assert normalize_language_for_azure("pt-PT") == "pt-PT"

    @pytest.mark.parametrize("short,expected", [
        ("en", "en-US"),
        ("ml", "ml-IN"),
        ("hi", "hi-IN"),
        ("ta", "ta-IN"),
        ("te", "te-IN"),
        ("kn", "kn-IN"),
        ("ar", "ar-SA"),
        ("fr", "fr-FR"),
        ("de", "de-DE"),
        ("es", "es-ES"),
        ("pt", "pt-BR"),
        ("ja", "ja-JP"),
        ("ko", "ko-KR"),
        ("zh", "zh-CN"),
    ])
    def test_all_known_aliases(self, short, expected):
        """Test all known language aliases map correctly."""
        assert normalize_language_for_azure(short) == expected

    def test_case_insensitive_aliases(self):
        """Test that aliases are case-insensitive."""
        assert normalize_language_for_azure("EN") == "en-US"
        assert normalize_language_for_azure("Fr") == "fr-FR"
        assert normalize_language_for_azure("ZH") == "zh-CN"

    def test_unknown_short_code_returned_as_is(self):
        """Test that unknown short codes are returned unchanged."""
        assert normalize_language_for_azure("xx") == "xx"
        assert normalize_language_for_azure("und") == "und"

    def test_aliases_dict_completeness(self):
        """Test that the aliases dict has at least the common languages."""
        expected_keys = {"en", "fr", "de", "es", "pt", "ja", "ko", "zh", "ar", "hi"}
        assert expected_keys.issubset(set(_LANGUAGE_ALIASES.keys()))


# =============================================================================
# AzureSpeechLoader — Supported Formats
# =============================================================================


class TestAzureSpeechLoaderFormats:
    """Tests for AzureSpeechLoader format support."""

    @pytest.fixture
    def loader(self):
        return AzureSpeechLoader()

    def test_supported_formats(self, loader):
        """Test that only AZURE_SPEECH format is supported."""
        formats = loader.supported_formats
        assert formats == [AiModelFormat.AZURE_SPEECH]

    def test_supports_azure_speech_format(self, loader):
        """Test supports_format for AZURE_SPEECH returns True."""
        assert loader.supports_format(AiModelFormat.AZURE_SPEECH) is True

    def test_does_not_support_other_formats(self, loader):
        """Test supports_format returns False for non-Azure formats."""
        assert loader.supports_format(AiModelFormat.SAFETENSOR) is False
        assert loader.supports_format(AiModelFormat.ONNX) is False
        assert loader.supports_format(AiModelFormat.NEMO) is False
        assert loader.supports_format(AiModelFormat.PYTORCH) is False


# =============================================================================
# AzureSpeechLoader — Memory Estimation
# =============================================================================


class TestAzureSpeechLoaderMemory:
    """Tests for AzureSpeechLoader memory estimation."""

    @pytest.fixture
    def loader(self):
        return AzureSpeechLoader()

    def test_estimate_memory_always_zero(self, loader):
        """Test that cloud engine always reports 0 memory."""
        config = create_azure_model_config()
        assert loader.estimate_memory(config) == 0

    def test_estimate_memory_ignores_stored_value(self, loader):
        """Test that even with a stored memory_size_mb, estimate returns 0."""
        config = create_azure_model_config()
        config.memory_size_mb = 500  # Shouldn't matter
        assert loader.estimate_memory(config) == 0


# =============================================================================
# AzureSpeechLoader — Load (Credential Validation)
# =============================================================================


class TestAzureSpeechLoaderLoad:
    """Tests for AzureSpeechLoader.load method."""

    @pytest.fixture
    def loader(self):
        return AzureSpeechLoader()

    @pytest.mark.asyncio
    async def test_load_with_env_credentials(self, loader):
        """Test successful load using environment credentials."""
        config = create_azure_model_config(source_uri="eastus")

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ) as mock_sc_class:
            mock_settings.return_value = MagicMock(
                azure_speech_key="test-key-123",
                azure_speech_region="westeurope",
            )

            result = await loader.load(config)

            # Verify SpeechConfig was created with correct args
            mock_sc_class.assert_called_once_with(
                subscription="test-key-123", region="eastus"
            )
            # region from source_uri takes priority over settings
            assert isinstance(result, LoadedModel)
            assert result.model_slug == "azure-speech"
            assert result.format == AiModelFormat.AZURE_SPEECH
            assert result.memory_mb == 0
            assert result.device == "cloud"
            assert result.extra["is_cloud"] is True
            assert result.extra["provider"] == "azure_speech"

    @pytest.mark.asyncio
    async def test_load_falls_back_to_settings_region(self, loader):
        """Test that region falls back to settings when not in config."""
        config = create_azure_model_config(
            source_uri="openai/whisper-large",  # URI, not a region
            source_revision=None,
        )

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ) as mock_sc_class:
            mock_settings.return_value = MagicMock(
                azure_speech_key="test-key",
                azure_speech_region="centralus",
            )

            _result = await loader.load(config)

            # Should use settings region since source_uri looks like a URL
            mock_sc_class.assert_called_once_with(
                subscription="test-key", region="centralus"
            )

    @pytest.mark.asyncio
    async def test_load_raises_when_no_key(self, loader):
        """Test that missing key raises CloudASRAuthError."""
        config = create_azure_model_config()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings:
            mock_settings.return_value = MagicMock(
                azure_speech_key=None,
                azure_speech_region="eastus",
            )

            with pytest.raises(CloudASRAuthError) as exc_info:
                await loader.load(config)

            assert "AZURE_SPEECH_KEY" in str(exc_info.value)
            assert exc_info.value.details["has_key"] is False
            assert exc_info.value.details["has_region"] is True

    @pytest.mark.asyncio
    async def test_load_raises_when_no_region(self, loader):
        """Test that missing region raises CloudASRAuthError."""
        config = create_azure_model_config(
            source_uri=None,
            source_revision=None,
        )

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings:
            mock_settings.return_value = MagicMock(
                azure_speech_key="valid-key",
                azure_speech_region=None,
            )

            with pytest.raises(CloudASRAuthError) as exc_info:
                await loader.load(config)

            assert "AZURE_SPEECH_REGION" in str(exc_info.value)
            assert exc_info.value.details["has_key"] is True
            assert exc_info.value.details["has_region"] is False

    @pytest.mark.asyncio
    async def test_load_raises_when_both_missing(self, loader):
        """Test that missing key and region raises CloudASRAuthError."""
        config = create_azure_model_config(source_uri=None, source_revision=None)

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings:
            mock_settings.return_value = MagicMock(
                azure_speech_key=None,
                azure_speech_region=None,
            )

            with pytest.raises(CloudASRAuthError) as exc_info:
                await loader.load(config)

            assert exc_info.value.details["has_key"] is False
            assert exc_info.value.details["has_region"] is False

    @pytest.mark.asyncio
    async def test_load_with_inline_key_override(self, loader):
        """Test that compute_type starting with 'key:' overrides env key."""
        config = create_azure_model_config(
            compute_type="key:inline-secret-key",
        )

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ) as mock_sc_class:
            mock_settings.return_value = MagicMock(
                azure_speech_key="env-key",
                azure_speech_region="westus",
            )

            await loader.load(config)

            # Should use inline key, not env key
            mock_sc_class.assert_called_once_with(
                subscription="key:inline-secret-key", region="eastus"
            )

    @pytest.mark.asyncio
    async def test_load_compute_type_not_key_prefix_uses_env(self, loader):
        """Test that compute_type without 'key:' prefix falls back to env."""
        config = create_azure_model_config(
            compute_type="float32",  # Not a key override
        )

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ) as mock_sc_class:
            mock_settings.return_value = MagicMock(
                azure_speech_key="env-key-123",
                azure_speech_region="westus",
            )

            await loader.load(config)

            mock_sc_class.assert_called_once_with(
                subscription="env-key-123", region="eastus"
            )

    @pytest.mark.asyncio
    async def test_load_enables_word_timestamps(self, loader):
        """Test that load enables word-level timestamps on SpeechConfig."""
        config = create_azure_model_config()

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ):
            mock_settings.return_value = MagicMock(
                azure_speech_key="key",
                azure_speech_region="eastus",
            )

            await loader.load(config)

            mock_speech_config.request_word_level_timestamps.assert_called_once()

    @pytest.mark.asyncio
    async def test_load_returns_correct_model_metadata(self, loader):
        """Test LoadedModel metadata fields are populated correctly."""
        config = create_azure_model_config(
            model_id="m-test-42",
            slug="my-azure-engine",
        )

        mock_speech_config = MagicMock()

        with patch(
            "stt_v2.models.azure_speech_loader.get_settings"
        ) as mock_settings, patch(
            "stt_v2.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ):
            mock_settings.return_value = MagicMock(
                azure_speech_key="key",
                azure_speech_region="westus2",
            )

            result = await loader.load(config)

            assert result.model_id == "m-test-42"
            assert result.model_slug == "my-azure-engine"
            assert result.model is mock_speech_config
            assert result.tokenizer is None
            assert result.processor is None
            assert result.feature_extractor is None
            assert result.extra["region"] == "eastus"  # from source_uri


# =============================================================================
# AzureSpeechLoader — Unload
# =============================================================================


class TestAzureSpeechLoaderUnload:
    """Tests for AzureSpeechLoader.unload method."""

    @pytest.fixture
    def loader(self):
        return AzureSpeechLoader()

    @pytest.mark.asyncio
    async def test_unload_clears_model_reference(self, loader):
        """Test that unload sets model to None."""
        loaded_model = LoadedModel(
            model_id="m-1",
            model_slug="azure-test",
            model=MagicMock(),  # SpeechConfig mock
            format=AiModelFormat.AZURE_SPEECH,
            memory_mb=0,
            device="cloud",
        )

        await loader.unload(loaded_model)

        assert loaded_model.model is None

    @pytest.mark.asyncio
    async def test_unload_handles_already_none_model(self, loader):
        """Test that unload is safe when model is already None."""
        loaded_model = LoadedModel(
            model_id="m-1",
            model_slug="azure-test",
            model=None,
            format=AiModelFormat.AZURE_SPEECH,
            memory_mb=0,
            device="cloud",
        )

        # Should not raise
        await loader.unload(loaded_model)
        assert loaded_model.model is None


# =============================================================================
# AzureSpeechLoader — _resolve_region
# =============================================================================


class TestResolveRegion:
    """Tests for AzureSpeechLoader._resolve_region static method."""

    def test_bare_region_string_from_source_uri(self):
        """Test that a bare region string in source_uri is detected."""
        config = create_azure_model_config(source_uri="eastus")
        result = AzureSpeechLoader._resolve_region(config)
        assert result == "eastus"

    def test_bare_region_westeurope(self):
        """Test another common region string."""
        config = create_azure_model_config(source_uri="westeurope")
        result = AzureSpeechLoader._resolve_region(config)
        assert result == "westeurope"

    def test_url_source_uri_falls_through(self):
        """Test that a URL-like source_uri is not treated as a region."""
        config = create_azure_model_config(source_uri="openai/whisper-large")
        result = AzureSpeechLoader._resolve_region(config)
        assert result is None  # Falls through to source_revision

    def test_dotted_source_uri_falls_through(self):
        """Test that a dotted URI is not treated as a region."""
        config = create_azure_model_config(source_uri="speech.cognitiveservices.azure.com")
        result = AzureSpeechLoader._resolve_region(config)
        assert result is None

    def test_source_revision_used_as_fallback(self):
        """Test that source_revision is used when source_uri is a URL."""
        config = create_azure_model_config(
            source_uri="openai/whisper-large",
            source_revision="centralindia",
        )
        result = AzureSpeechLoader._resolve_region(config)
        assert result == "centralindia"

    def test_empty_source_uri_uses_revision(self):
        """Test empty source_uri falls back to revision."""
        config = create_azure_model_config(
            source_uri=None,
            source_revision="japaneast",
        )
        result = AzureSpeechLoader._resolve_region(config)
        assert result == "japaneast"

    def test_both_none_returns_none(self):
        """Test that None uri and None revision returns None."""
        config = create_azure_model_config(
            source_uri=None,
            source_revision=None,
        )
        result = AzureSpeechLoader._resolve_region(config)
        assert result is None

    def test_empty_string_source_uri_returns_none(self):
        """Test empty string source_uri returns None (falsy)."""
        config = create_azure_model_config(source_uri="", source_revision=None)
        result = AzureSpeechLoader._resolve_region(config)
        assert result is None
