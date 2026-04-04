"""Unit tests for Model Loaders.

Note: Tests that require torch/ML dependencies are marked with @pytest.mark.slow
and will be skipped if torch is not installed.
"""

import os
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

_MODEL_BASE = (
    os.environ.get("HUGGINGFACE_CACHE_DIR")
    or os.environ.get("HF_HOME")
    or os.path.join(os.sep, "models", "hf-cache")
)

from stt_v2.models.azure_speech_loader import AzureSpeechLoader
from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.huggingface_loader import HuggingFaceLoader
from stt_v2.models.nemo_loader import NeMoLoader
from stt_v2.models.onnx_loader import ONNXLoader
from stt_v2.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)

# Check if torch is available for tests that need it
try:
    import torch  # noqa: F401

    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

# Marker for tests that require torch - combines skipif with ml marker
# These tests will:
# 1. Skip if torch is not installed (requires_torch)
# 2. Be excluded when TEST_PLATFORM=cpu (ml marker in conftest.py)
requires_torch = pytest.mark.skipif(not HAS_TORCH, reason="torch not installed")
ml_test = pytest.mark.ml  # Mark as ML test for platform-aware filtering


class TestBaseModelLoader:
    """Tests for BaseModelLoader."""

    @ml_test
    @requires_torch
    def test_get_device_auto_no_cuda(self):
        """Test device selection without CUDA."""
        loader = HuggingFaceLoader()  # Use concrete implementation

        with patch("torch.cuda.is_available", return_value=False):
            with patch.object(loader, "_get_device", wraps=loader._get_device):
                device = loader._get_device("auto")
                assert device in ["cpu", "mps"]

    def test_get_device_explicit_cuda(self):
        """Test explicit CUDA device selection."""
        loader = HuggingFaceLoader()
        device = loader._get_device("cuda")
        assert device == "cuda"

    def test_get_device_explicit_cpu(self):
        """Test explicit CPU device selection."""
        loader = HuggingFaceLoader()
        device = loader._get_device("cpu")
        assert device == "cpu"


class TestHuggingFaceLoader:
    """Tests for HuggingFaceLoader."""

    @pytest.fixture
    def loader(self):
        return HuggingFaceLoader()

    @pytest.fixture
    def sample_asr_config(self):
        """Sample ASR model config."""
        return AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-test",
            name="Whisper Test",
            description="Test model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-tiny",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=80,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=80,
            checksum=None,
            tags=[],
        )

    def test_supported_formats(self, loader):
        """Test supported formats."""
        formats = loader.supported_formats

        assert AiModelFormat.SAFETENSOR in formats
        assert AiModelFormat.PYTORCH in formats
        assert AiModelFormat.ONNX not in formats
        assert AiModelFormat.NEMO not in formats

    def test_supports_format(self, loader):
        """Test format support check."""
        assert loader.supports_format(AiModelFormat.SAFETENSOR) is True
        assert loader.supports_format(AiModelFormat.PYTORCH) is True
        assert loader.supports_format(AiModelFormat.ONNX) is False

    def test_estimate_memory_whisper_large(self, loader, sample_asr_config):
        """Test memory estimation for Whisper Large."""
        sample_asr_config.source_uri = "openai/whisper-large-v3"
        sample_asr_config.memory_size_mb = None  # Force estimation

        memory = loader.estimate_memory(sample_asr_config)

        assert memory == 3000  # ~3GB for large model

    def test_estimate_memory_whisper_tiny(self, loader, sample_asr_config):
        """Test memory estimation for Whisper Tiny."""
        sample_asr_config.source_uri = "openai/whisper-tiny"
        sample_asr_config.memory_size_mb = None

        memory = loader.estimate_memory(sample_asr_config)

        assert memory == 80  # ~80MB for tiny model

    def test_estimate_memory_uses_stored_value(self, loader, sample_asr_config):
        """Test that stored memory value is used when available."""
        sample_asr_config.memory_size_mb = 500

        memory = loader.estimate_memory(sample_asr_config)

        assert memory == 500

    def test_estimate_memory_wav2vec2(self, loader, sample_asr_config):
        """Test memory estimation for Wav2Vec2."""
        sample_asr_config.source_uri = "facebook/wav2vec2-large-960h"
        sample_asr_config.memory_size_mb = None

        memory = loader.estimate_memory(sample_asr_config)

        assert memory == 1200  # ~1.2GB for large Wav2Vec2

    def test_estimate_memory_silero_vad(self, loader, sample_asr_config):
        """Test memory estimation for Silero VAD."""
        sample_asr_config.source_uri = "snakers4/silero-vad"
        sample_asr_config.memory_size_mb = None

        memory = loader.estimate_memory(sample_asr_config)

        assert memory == 50  # ~50MB for VAD model

    @ml_test
    @requires_torch
    @pytest.mark.asyncio
    async def test_unload_cleans_up(self, loader):
        """Test that unload cleans up model resources."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            tokenizer=MagicMock(),
            processor=MagicMock(),
            feature_extractor=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )

        with patch("gc.collect") as mock_gc:
            await loader.unload(model)
            mock_gc.assert_called_once()


class TestONNXLoader:
    """Tests for ONNXLoader."""

    @pytest.fixture
    def loader(self):
        return ONNXLoader()

    @pytest.fixture
    def sample_onnx_config(self):
        """Sample ONNX model config."""
        return AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-onnx",
            name="Whisper ONNX",
            description="Test ONNX model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.LOCAL,
            source_uri=os.path.join(_MODEL_BASE, "whisper.onnx"),
            source_revision=None,
            format=AiModelFormat.ONNX,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "whisper.onnx"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=500,
            checksum=None,
            tags=[],
        )

    @pytest.fixture
    def sample_onnx_community_config(self):
        """Sample ONNX-community model config from HuggingFace."""
        return AiModelConfig(
            id="m-2",
            tenant_id="t-1",
            slug="whisper-turbo-onnx",
            name="Whisper Turbo ONNX",
            description="ONNX-community Whisper model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="onnx-community/whisper-large-v3-turbo",
            source_revision="main",
            format=AiModelFormat.ONNX,
            memory_size_mb=None,
            compute_type="float16",
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

    def test_supported_formats(self, loader):
        """Test supported formats."""
        formats = loader.supported_formats

        assert AiModelFormat.ONNX in formats
        assert AiModelFormat.ONNX_OPTIMUM in formats
        assert len(formats) == 2

    def test_supports_format(self, loader):
        """Test format support check."""
        assert loader.supports_format(AiModelFormat.ONNX) is True
        assert loader.supports_format(AiModelFormat.ONNX_OPTIMUM) is True
        assert loader.supports_format(AiModelFormat.SAFETENSOR) is False

    def test_estimate_memory_uses_file_size(self, loader, sample_onnx_config):
        """Test memory estimation from file size."""
        sample_onnx_config.file_size_mb = 500
        sample_onnx_config.memory_size_mb = None

        memory = loader.estimate_memory(sample_onnx_config)

        # Should be ~20% more than file size
        assert memory == 600

    def test_estimate_memory_default(self, loader, sample_onnx_config):
        """Test default memory estimation."""
        sample_onnx_config.file_size_mb = None
        sample_onnx_config.memory_size_mb = None

        memory = loader.estimate_memory(sample_onnx_config)

        assert memory == 500  # Default


class TestONNXLoaderOptimumDetection:
    """Tests for ONNX loader Optimum detection logic."""

    @pytest.fixture
    def loader(self):
        return ONNXLoader()

    @pytest.fixture
    def onnx_community_config(self):
        """ONNX-community model config."""
        return AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-turbo-onnx",
            name="Whisper Turbo ONNX",
            description="ONNX-community model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="onnx-community/whisper-large-v3-turbo",
            source_revision="main",
            format=AiModelFormat.ONNX,
            memory_size_mb=None,
            compute_type="float16",
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

    @pytest.fixture
    def local_onnx_config(self):
        """Local ONNX model config."""
        return AiModelConfig(
            id="m-2",
            tenant_id="t-1",
            slug="local-onnx",
            name="Local ONNX",
            description="Local ONNX model",
            task_type=ModelTaskType.VOICE_ACTIVITY_DETECTION,
            source=AiModelSource.LOCAL,
            source_uri=os.path.join(_MODEL_BASE, "silero-vad.onnx"),
            source_revision=None,
            format=AiModelFormat.ONNX,
            memory_size_mb=64,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "silero-vad.onnx"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=64,
            checksum=None,
            tags=[],
        )

    @pytest.fixture
    def onnx_optimum_config(self):
        """Explicit ONNX_OPTIMUM format config."""
        return AiModelConfig(
            id="m-3",
            tenant_id="t-1",
            slug="optimum-model",
            name="Optimum Model",
            description="Model with ONNX_OPTIMUM format",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="some/model",
            source_revision=None,
            format=AiModelFormat.ONNX_OPTIMUM,
            memory_size_mb=None,
            compute_type="float16",
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

    def test_should_use_optimum_for_onnx_community(self, loader, onnx_community_config):
        """Test that ONNX-community models use Optimum."""
        result = loader._should_use_optimum(onnx_community_config)
        assert result is True

    def test_should_not_use_optimum_for_local_vad(self, loader, local_onnx_config):
        """Test that local VAD models don't use Optimum."""
        result = loader._should_use_optimum(local_onnx_config)
        assert result is False

    def test_should_use_optimum_for_onnx_optimum_format(self, loader, onnx_optimum_config):
        """Test that explicit ONNX_OPTIMUM format uses Optimum."""
        result = loader._should_use_optimum(onnx_optimum_config)
        assert result is True

    def test_should_use_optimum_for_whisper_onnx(self, loader, local_onnx_config):
        """Test that Whisper ONNX models use Optimum."""
        local_onnx_config.source_uri = "some-org/whisper-model-onnx"
        local_onnx_config.task_type = ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        result = loader._should_use_optimum(local_onnx_config)
        assert result is True

    def test_should_not_use_optimum_for_non_whisper_non_onnx_community(
        self, loader, local_onnx_config
    ):
        """Test that non-Whisper, non-ONNX-community models don't use Optimum."""
        local_onnx_config.source_uri = "some-org/vad-model"
        result = loader._should_use_optimum(local_onnx_config)
        assert result is False


class TestNeMoLoader:
    """Tests for NeMoLoader."""

    @pytest.fixture
    def loader(self):
        return NeMoLoader()

    @pytest.fixture
    def sample_nemo_config(self):
        """Sample NeMo model config."""
        return AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="nemo-conformer",
            name="NeMo Conformer",
            description="Test NeMo model",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.LOCAL,
            source_uri="nvidia/stt_en_conformer_ctc_large",
            source_revision=None,
            format=AiModelFormat.NEMO,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "conformer.nemo"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=1000,
            checksum=None,
            tags=[],
        )

    def test_supported_formats(self, loader):
        """Test supported formats."""
        formats = loader.supported_formats

        assert AiModelFormat.NEMO in formats
        assert len(formats) == 1

    def test_supports_format(self, loader):
        """Test format support check."""
        assert loader.supports_format(AiModelFormat.NEMO) is True
        assert loader.supports_format(AiModelFormat.SAFETENSOR) is False

    def test_estimate_memory_large_model(self, loader, sample_nemo_config):
        """Test memory estimation for large model."""
        sample_nemo_config.source_uri = "nvidia/stt_en_conformer_ctc_large"
        sample_nemo_config.memory_size_mb = None
        sample_nemo_config.file_size_mb = None

        memory = loader.estimate_memory(sample_nemo_config)

        assert memory == 2000  # ~2GB for large

    def test_estimate_memory_small_model(self, loader, sample_nemo_config):
        """Test memory estimation for small model."""
        sample_nemo_config.source_uri = "nvidia/stt_en_conformer_ctc_small"
        sample_nemo_config.memory_size_mb = None
        sample_nemo_config.file_size_mb = None

        memory = loader.estimate_memory(sample_nemo_config)

        assert memory == 500  # ~500MB for small

    def test_estimate_memory_uses_stored_value(self, loader, sample_nemo_config):
        """Test that stored memory value is used."""
        sample_nemo_config.memory_size_mb = 1500

        memory = loader.estimate_memory(sample_nemo_config)

        assert memory == 1500


# =============================================================================
# COMPREHENSIVE LOADER TESTS FOR COVERAGE
# =============================================================================


class TestHuggingFaceLoaderLoad:
    """Tests for HuggingFace loader load method."""

    @pytest.fixture
    def loader(self):
        return HuggingFaceLoader()

    @pytest.fixture
    def sample_config(self):
        return AiModelConfig(
            id="m-test",
            tenant_id="t-1",
            slug="whisper-test",
            name="Test Model",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-tiny",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=80,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=80,
            checksum=None,
            tags=[],
        )

    @ml_test
    @requires_torch
    @pytest.mark.asyncio
    async def test_load_with_mock_transformers(self, loader, sample_config):
        """Test load with fully mocked transformers."""

        mock_model = MagicMock()
        mock_model.num_parameters.return_value = 10_000_000
        mock_model.dtype = MagicMock()
        mock_processor = MagicMock()

        with (
            patch("stt_v2.models.huggingface_loader.get_settings") as mock_settings,
            patch("stt_v2.models.huggingface_loader.os.makedirs"),
            patch.object(loader, "_load_by_task") as mock_load_task,
            patch.object(loader, "_estimate_model_memory", return_value=100),
        ):

            mock_settings.return_value = MagicMock(
                huggingface_cache_dir=_MODEL_BASE,
                huggingface_token=None,
            )
            mock_load_task.return_value = (mock_model, None, mock_processor, None)

            result = await loader.load(sample_config)

            assert result.model_slug == "whisper-test"
            assert result.model is mock_model
            assert result.processor is mock_processor

    def test_estimate_model_memory_error(self, loader):
        """Test memory estimation returns 0 on error."""
        mock_model = MagicMock()
        mock_model.num_parameters.side_effect = Exception("Error")

        memory = loader._estimate_model_memory(mock_model)

        assert memory == 0

    def test_estimate_memory_medium_model(self, loader):
        """Test memory estimation for medium model."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-medium",
            name="Whisper Medium",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-medium",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 1500  # ~1.5GB

    def test_estimate_memory_small_model(self, loader):
        """Test memory estimation for small model."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-small",
            name="Whisper Small",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-small",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 500  # ~500MB

    def test_estimate_memory_base_model(self, loader):
        """Test memory estimation for base model."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper-base",
            name="Whisper Base",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-base",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 150  # ~150MB

    def test_estimate_memory_wav2vec2_base(self, loader):
        """Test memory estimation for wav2vec2-base."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="wav2vec2-base",
            name="Wav2Vec2 Base",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="facebook/wav2vec2-base-960h",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 400  # ~400MB

    def test_estimate_memory_unknown_model(self, loader):
        """Test memory estimation for unknown model."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="unknown",
            name="Unknown Model",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="some/unknown-model",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 1000  # Default 1GB


class TestONNXLoaderLoad:
    """Tests for ONNX loader load method."""

    @pytest.fixture
    def loader(self):
        return ONNXLoader()

    @pytest.fixture
    def sample_config(self):
        return AiModelConfig(
            id="m-test",
            tenant_id="t-1",
            slug="silero-vad",
            name="Silero VAD",
            description="Test VAD",
            task_type=ModelTaskType.VOICE_ACTIVITY_DETECTION,
            source=AiModelSource.LOCAL,
            source_uri=os.path.join(_MODEL_BASE, "silero-vad.onnx"),
            source_revision=None,
            format=AiModelFormat.ONNX,
            memory_size_mb=64,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "silero-vad.onnx"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=64,
            checksum=None,
            tags=[],
        )

    @pytest.mark.asyncio
    async def test_unload_onnx(self, loader):
        """Test unloading ONNX model."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            format=AiModelFormat.ONNX,
            memory_mb=64,
            device="cpu",
        )

        with patch("gc.collect") as mock_gc:
            await loader.unload(model)
            mock_gc.assert_called_once()


class TestNeMoLoaderLoad:
    """Tests for NeMo loader load method."""

    @pytest.fixture
    def loader(self):
        return NeMoLoader()

    @pytest.fixture
    def sample_config(self):
        return AiModelConfig(
            id="m-nemo",
            tenant_id="t-1",
            slug="conformer-ctc",
            name="Conformer CTC",
            description="Test NeMo",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.LOCAL,
            source_uri="nvidia/stt_en_conformer_ctc_large",
            source_revision=None,
            format=AiModelFormat.NEMO,
            memory_size_mb=2000,
            compute_type="float32",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "conformer.nemo"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=1500,
            checksum=None,
            tags=[],
        )

    @ml_test
    @requires_torch
    @pytest.mark.asyncio
    async def test_unload_nemo(self, loader):
        """Test unloading NeMo model."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="test",
            model=MagicMock(),
            format=AiModelFormat.NEMO,
            memory_mb=2000,
            device="cuda",
        )

        with patch("gc.collect") as mock_gc:
            await loader.unload(model)
            mock_gc.assert_called_once()

    def test_estimate_memory_medium_model(self, loader):
        """Test memory estimation for medium model."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="conformer-medium",
            name="Conformer Medium",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="nvidia/stt_en_conformer_ctc_medium",
            source_revision=None,
            format=AiModelFormat.NEMO,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        assert memory == 1000  # ~1GB for medium

    def test_estimate_memory_from_file_size(self, loader):
        """Test memory estimation from file size (1.5x multiplier)."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="custom",
            name="Custom Model",
            description="Test",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.LOCAL,
            source_uri=os.path.join(_MODEL_BASE, "custom.nemo"),
            source_revision=None,
            format=AiModelFormat.NEMO,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "custom.nemo"),
            downloaded_at=datetime.utcnow(),
            file_size_mb=800,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)

        # Should be ~1.5x file size = 1200MB
        assert memory == 1200


# =============================================================================
# AZURE SPEECH LOADER TESTS (in model_loaders for consistency)
# =============================================================================


class TestAzureSpeechLoaderBasic:
    """Basic tests for AzureSpeechLoader in the model loaders suite."""

    @pytest.fixture
    def loader(self):
        return AzureSpeechLoader()

    def test_supported_formats(self, loader):
        """Test supported formats."""
        formats = loader.supported_formats

        assert AiModelFormat.AZURE_SPEECH in formats
        assert len(formats) == 1

    def test_supports_format(self, loader):
        """Test format support check."""
        assert loader.supports_format(AiModelFormat.AZURE_SPEECH) is True
        assert loader.supports_format(AiModelFormat.SAFETENSOR) is False
        assert loader.supports_format(AiModelFormat.ONNX) is False
        assert loader.supports_format(AiModelFormat.NEMO) is False

    def test_estimate_memory_zero(self, loader):
        """Test memory estimation is 0 for cloud engine."""
        config = AiModelConfig(
            id="m-azure",
            tenant_id="t-1",
            slug="azure-speech",
            name="Azure Speech",
            description="Cloud ASR",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.LOCAL,
            source_uri="eastus",
            source_revision=None,
            format=AiModelFormat.AZURE_SPEECH,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        memory = loader.estimate_memory(config)
        assert memory == 0

    @pytest.mark.asyncio
    async def test_unload_clears_model(self, loader):
        """Test that unload clears the model reference."""
        model = LoadedModel(
            model_id="m-1",
            model_slug="azure-test",
            model=MagicMock(),
            format=AiModelFormat.AZURE_SPEECH,
            memory_mb=0,
            device="cloud",
        )

        await loader.unload(model)
        assert model.model is None
