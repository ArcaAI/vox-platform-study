"""Integration tests for Azure Speech pipeline flow.

Tests the full pipeline chain: ModelCache → AzureSpeechLoader → BatchTranscriptionService
with realistic (but mocked-at-boundary) Azure SDK interactions.

These tests verify that components integrate correctly:
- ModelCache correctly dispatches to AzureSpeechLoader for AZURE_SPEECH format
- AzureSpeechLoader produces a LoadedModel compatible with BatchTranscriptionService
- BatchTranscriptionService correctly routes AZURE_SPEECH models to the right inference path
- Language normalization flows from pipeline config through to Azure API call
- Error propagation from Azure SDK surfaces as the correct custom exception

Anti-pattern prevention:
- #1: Tests drive real code paths (ModelCache.load_model, BatchTranscriptionService._run_inference)
      rather than verifying mocks were called.
- #3: Azure SDK is mocked only at the external boundary (SpeechConfig, ConversationTranscriber).
      All internal code (cache, loader, batch service) runs for real.
- #4: Azure response mocks include all fields accessed in production code.

NOTE: These tests do NOT require Docker/external services. They only mock the Azure
SDK boundary and the settings lookup.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
)
from stt.models.azure_speech_loader import AzureSpeechLoader
from stt.models.base_loader import LoadedModel
from stt.models.cache import ModelCache
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)
from stt.transcription.batch_service import BatchTranscriptionService
from stt.transcription.dto import RawTranscription

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def azure_model_config():
    """Create a realistic Azure Speech model configuration."""
    return AiModelConfig(
        id="m-azure-integration",
        tenant_id="t-integration",
        slug="azure-speech-integration",
        name="Azure Speech (Integration Test)",
        description="Azure Cognitive Services Speech engine for integration testing",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri="eastus",
        source_revision=None,
        format=AiModelFormat.AZURE_SPEECH,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=["cloud", "azure", "integration-test"],
    )


# Azure Speech is BYOK-only — the key comes from the gateway-injected
# provider override, never env. TASK-880 — so is the REGION: `stt.azureSpeech.region`
# is deleted, and an override entry exists only behind an enabled, keyed
# `AiProviderConnection(stt, azure-speech)` row, which is what carries `region`.
_BYOK_OVERRIDE = {"azure-speech": {"api_key": "integration-test-key-12345"}}

# TASK-880 — the `mock_azure_settings` fixture that lived here patched
# `azure_speech_loader.get_settings` to supply the non-secret REGION. The loader no
# longer imports `get_settings` at all: every case below takes its region from the model
# config, and the connection-row path is covered in `tests/unit/test_azure_speech_loader.py`.


@pytest.fixture
def mock_speech_config_class():
    """Patch Azure SpeechConfig class to return a mock without real SDK."""
    mock_config = MagicMock()
    mock_config.request_word_level_timestamps = MagicMock()
    with patch(
        "stt.models.azure_speech_loader.SpeechConfig",
        return_value=mock_config,
    ) as mock_class:
        yield mock_class, mock_config


# =============================================================================
# ModelCache → AzureSpeechLoader Integration
# =============================================================================


@pytest.mark.integration
class TestModelCacheAzureLoaderIntegration:
    """Test that ModelCache correctly dispatches to AzureSpeechLoader."""

    def test_cache_has_azure_speech_loader_registered(self):
        """Verify ModelCache registers AzureSpeechLoader for AZURE_SPEECH."""
        cache = ModelCache(max_models=5, max_memory_mb=5000, ttl_seconds=3600)
        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)

        assert loader is not None
        assert isinstance(loader, AzureSpeechLoader)

    @pytest.mark.asyncio
    async def test_cache_loads_azure_model_through_loader(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test full cache → loader → LoadedModel flow with real objects."""
        _, mock_config = mock_speech_config_class
        cache = ModelCache(max_models=5, max_memory_mb=5000, ttl_seconds=3600)

        # Load through cache (drives real AzureSpeechLoader.load)
        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)

        # Verify the loaded model is compatible with batch service expectations
        assert isinstance(loaded_model, LoadedModel)
        assert loaded_model.model is mock_config
        assert loaded_model.format == AiModelFormat.AZURE_SPEECH
        assert loaded_model.device == "cloud"
        assert loaded_model.memory_mb == 0
        assert loaded_model.extra["is_cloud"] is True
        assert loaded_model.extra["provider"] == "azure_speech"
        assert loaded_model.extra["region"] == "eastus"

    @pytest.mark.asyncio
    async def test_cache_put_and_get_azure_model(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test caching an Azure model and retrieving it."""
        _, mock_config = mock_speech_config_class
        cache = ModelCache(max_models=5, max_memory_mb=5000, ttl_seconds=3600)

        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)

        # Put in cache
        await cache.put("azure-speech-integration", loaded_model)

        # Retrieve from cache
        cached = await cache.get("azure-speech-integration")
        assert cached is not None
        assert cached.model_slug == "azure-speech-integration"
        assert cached.model is mock_config

        # Stats should reflect the hit
        stats = cache.stats()
        assert stats.hits >= 1

    @pytest.mark.asyncio
    async def test_cache_evict_azure_model_calls_unload(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test that evicting triggers unload which clears the SpeechConfig handle."""
        _, mock_config = mock_speech_config_class
        cache = ModelCache(max_models=5, max_memory_mb=5000, ttl_seconds=3600)

        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)
        await cache.put("azure-speech-integration", loaded_model)

        # Evict
        await cache.evict("azure-speech-integration")

        # Model reference should be cleared after eviction
        assert loaded_model.model is None

        # Cache should be empty
        cached = await cache.get("azure-speech-integration")
        assert cached is None


# =============================================================================
# AzureSpeechLoader → BatchTranscriptionService Integration
# =============================================================================


@pytest.mark.integration
class TestLoaderBatchServiceIntegration:
    """Test that LoadedModel from AzureSpeechLoader works with BatchTranscriptionService."""

    @pytest.mark.asyncio
    async def test_batch_service_dispatches_azure_model_to_correct_path(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test that _run_inference correctly routes AZURE_SPEECH to Azure inference."""
        _, mock_config = mock_speech_config_class
        loader = AzureSpeechLoader()
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)
        service = BatchTranscriptionService()

        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"

        # Patch only the sync Azure transcription boundary (not the dispatch logic)
        with patch.object(
            service,
            "_azure_transcribe_sync",
            return_value=RawTranscription(
                text="Integration test transcription",
                language="en-US",
                language_probability=0.95,
                segments=[{"text": "Integration test transcription", "start": 0.0, "end": 2.0}],
            ),
        ) as mock_sync:
            result = await service._run_inference(samples, 16000, loaded_model, config)

            # Verify the sync method received the real SpeechConfig from the loader
            assert mock_sync.call_args[0][0] is mock_config
            # Verify language was normalized
            assert mock_sync.call_args[0][3] == "en-US"

        assert result.text == "Integration test transcription"
        assert result.language == "en-US"

    @pytest.mark.asyncio
    async def test_language_normalization_flows_through_pipeline(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test that language normalization works end-to-end from config to Azure."""
        _, mock_config = mock_speech_config_class
        loader = AzureSpeechLoader()
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)
        service = BatchTranscriptionService()

        samples = np.zeros(16000, dtype=np.float32)

        # Test various language inputs
        test_cases = [
            ("ml", "ml-IN"),  # Malayalam short code
            ("en", "en-US"),  # English short code
            ("zh", "zh-CN"),  # Chinese short code
            ("fr-FR", "fr-FR"),  # Already BCP-47
            (None, "en-US"),  # None defaults to en-US
        ]

        for input_lang, expected_lang in test_cases:
            config = MagicMock()
            config.language = input_lang

            with patch.object(
                service,
                "_azure_transcribe_sync",
                return_value=RawTranscription(text="Test", language=expected_lang),
            ) as mock_sync:
                await service._run_inference(samples, 16000, loaded_model, config)

                actual_lang = mock_sync.call_args[0][3]
                assert actual_lang == expected_lang, (
                    f"Language '{input_lang}' should normalize to '{expected_lang}', "
                    f"got '{actual_lang}'"
                )

    @pytest.mark.asyncio
    async def test_auth_error_propagates_from_loader_to_caller(self):
        """Test that missing credentials raise CloudASRAuthError at load time.

        TASK-880 — no settings patch is needed (or possible): with no override entry
        there is no credential and no region from anywhere.
        """
        if True:
            loader = AzureSpeechLoader()
            config = AiModelConfig(
                id="m-fail",
                tenant_id="t-fail",
                slug="azure-fail",
                name="Azure Fail",
                description="Should fail",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                source=AiModelSource.LOCAL,
                source_uri=None,
                source_revision=None,
                format=AiModelFormat.AZURE_SPEECH,
                memory_size_mb=0,
                compute_type=None,
                download_status=AiModelDownloadStatus.DOWNLOADED,
                local_path=None,
                downloaded_at=datetime.utcnow(),
                file_size_mb=0,
                checksum=None,
                tags=[],
            )

            with pytest.raises(CloudASRAuthError) as exc_info:
                await loader.load(config)

            assert exc_info.value.details["has_key"] is False
            assert exc_info.value.details["has_region"] is False

    @pytest.mark.asyncio
    async def test_transcription_error_propagates_from_sync_to_async(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test that errors in _azure_transcribe_sync propagate through to_thread."""
        _, mock_config = mock_speech_config_class
        loader = AzureSpeechLoader()
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)
        service = BatchTranscriptionService()

        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"

        with patch.object(
            service,
            "_azure_transcribe_sync",
            side_effect=CloudASRQuotaError("Rate limited by Azure"),
        ):
            with pytest.raises(CloudASRQuotaError, match="Rate limited"):
                await service._run_inference(samples, 16000, loaded_model, config)


# =============================================================================
# Full Pipeline Flow (Cache → Load → Inference)
# =============================================================================


@pytest.mark.integration
class TestFullAzurePipelineFlow:
    """Integration test for the complete Azure Speech pipeline."""

    @pytest.mark.asyncio
    async def test_complete_flow_cache_to_transcription(
        self,
        azure_model_config,
        mock_speech_config_class,
    ):
        """Test complete flow: cache lookup → load → inference → result.

        This test drives real code through ModelCache, AzureSpeechLoader,
        and BatchTranscriptionService, only mocking the Azure SDK at the
        network boundary.
        """
        _, mock_config = mock_speech_config_class
        cache = ModelCache(max_models=5, max_memory_mb=5000, ttl_seconds=3600)
        service = BatchTranscriptionService()

        # Step 1: Load model through cache's loader
        loader = cache._get_loader(AiModelFormat.AZURE_SPEECH)
        loaded_model = await loader.load(azure_model_config, provider_overrides=_BYOK_OVERRIDE)
        await cache.put(azure_model_config.slug, loaded_model)

        # Step 2: Retrieve from cache (simulates real usage)
        cached_model = await cache.get(azure_model_config.slug)
        assert cached_model is not None
        assert cached_model.format == AiModelFormat.AZURE_SPEECH

        # Step 3: Run inference with the cached model
        samples = np.sin(2 * np.pi * 440 * np.linspace(0, 2.0, 32000)).astype(np.float32) * 0.8
        config = MagicMock()
        config.language = "ml"  # Malayalam short code

        with patch.object(
            service,
            "_azure_transcribe_sync",
            return_value=RawTranscription(
                text="Test transcription result",
                language="ml-IN",
                language_probability=0.88,
                segments=[
                    {
                        "text": "Test transcription result",
                        "start": 0.0,
                        "end": 2.0,
                        "speaker_id": None,
                        "confidence": 0.88,
                    }
                ],
                word_timestamps=[
                    {"text": "Test", "word": "Test", "start": 0.0, "end": 0.3, "confidence": 0.9},
                    {
                        "text": "transcription",
                        "word": "transcription",
                        "start": 0.35,
                        "end": 0.9,
                        "confidence": 0.85,
                    },
                    {
                        "text": "result",
                        "word": "result",
                        "start": 0.95,
                        "end": 1.3,
                        "confidence": 0.88,
                    },
                ],
            ),
        ) as mock_sync:
            result = await service._run_inference(samples, 16000, cached_model, config)

            # Verify the SpeechConfig from cache was used
            assert mock_sync.call_args[0][0] is mock_config
            # Verify language was normalized: "ml" → "ml-IN"
            assert mock_sync.call_args[0][3] == "ml-IN"

        # Step 4: Verify result structure
        assert result.text == "Test transcription result"
        assert result.language == "ml-IN"
        assert result.language_probability == pytest.approx(0.88)
        assert len(result.segments) == 1
        assert len(result.word_timestamps) == 3
        assert result.word_timestamps[0]["text"] == "Test"

        # Step 5: Cleanup
        await cache.evict(azure_model_config.slug)
        assert cached_model.model is None
