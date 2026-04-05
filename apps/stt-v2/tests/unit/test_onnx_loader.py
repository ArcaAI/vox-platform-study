"""Unit tests for ONNXLoader — provider configuration, thread count resolution,
and MPS memory cleanup on unload.
"""

import sys
import types
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.onnx_loader import ONNXLoader
from stt_v2.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


@pytest.fixture(autouse=True)
def _stub_onnxruntime():
    """Ensure an ``onnxruntime`` module is importable for every test.

    If the real package is installed it is used as-is.  Otherwise a
    lightweight stub is injected into ``sys.modules`` so that
    ``patch("onnxruntime.get_available_providers", ...)`` can resolve
    the attribute without raising ``ModuleNotFoundError``.
    """
    if "onnxruntime" in sys.modules:
        yield
        return

    stub = types.ModuleType("onnxruntime")
    stub.get_available_providers = lambda: ["CPUExecutionProvider"]
    sys.modules["onnxruntime"] = stub
    try:
        yield
    finally:
        sys.modules.pop("onnxruntime", None)


# =============================================================================
# Standard ONNX Loader — _get_providers()
# =============================================================================


class TestGetProviders:
    """Tests for _get_providers() execution provider selection."""

    def test_cuda_returns_string_format(self):
        """CUDA provider should be returned as a plain string."""
        loader = ONNXLoader()

        with patch(
            "onnxruntime.get_available_providers",
            return_value=[
                "CUDAExecutionProvider",
                "CPUExecutionProvider",
            ],
        ):
            providers = loader._get_providers()

        assert providers[0] == "CUDAExecutionProvider"
        assert providers[1] == "CPUExecutionProvider"

    def test_cpu_only_fallback(self):
        """When only CPU is available, return simple string list."""
        loader = ONNXLoader()

        with patch(
            "onnxruntime.get_available_providers",
            return_value=[
                "CPUExecutionProvider",
            ],
        ):
            providers = loader._get_providers()

        assert providers == ["CPUExecutionProvider"]


# =============================================================================
# Thread Count Resolution
# =============================================================================


class TestResolveNumThreads:
    """Tests for _resolve_num_threads() static method."""

    def test_returns_configured_value_when_positive(self):
        """Should use settings value when ONNX_NUM_THREADS > 0."""
        with patch("stt_v2.models.onnx_loader.get_settings") as mock_settings:
            settings = MagicMock()
            settings.onnx_num_threads = 6
            mock_settings.return_value = settings

            assert ONNXLoader._resolve_num_threads() == 6

    def test_returns_zero_for_auto(self):
        """Should return 0 (ONNX Runtime auto) when ONNX_NUM_THREADS is 0."""
        with patch("stt_v2.models.onnx_loader.get_settings") as mock_settings:
            settings = MagicMock()
            settings.onnx_num_threads = 0
            mock_settings.return_value = settings

            assert ONNXLoader._resolve_num_threads() == 0


# =============================================================================
# ONNX Unload with MPS Cleanup
# =============================================================================


class TestONNXUnload:
    """Tests for ONNX unload with accelerator memory cleanup."""

    @pytest.mark.asyncio
    async def test_unload_calls_cleanup_accelerator_memory(self):
        """ONNX unload should trigger accelerator memory cleanup."""
        loader = ONNXLoader()
        mock_model = MagicMock(spec=LoadedModel)
        mock_model.model = MagicMock()
        mock_model.model_slug = "test-onnx"

        with patch("stt_v2.models.base_loader.cleanup_accelerator_memory") as mock_cleanup:
            await loader.unload(mock_model)

            mock_cleanup.assert_called_once()


# =============================================================================
# ONNX Snapshot Directory Resolution
# =============================================================================


class TestResolveOnnxModelFile:
    """Tests for resolving concrete .onnx files from snapshot directories."""

    def test_prefers_onnx_subfolder_model_file(self, tmp_path):
        """Should resolve to onnx/model.onnx when directory path is provided."""
        snapshot_dir = tmp_path / "snapshot"
        model_file = snapshot_dir / "onnx" / "model.onnx"
        model_file.parent.mkdir(parents=True)
        model_file.write_bytes(b"dummy")

        resolved = ONNXLoader._resolve_onnx_model_file(snapshot_dir)

        assert resolved == model_file

    def test_returns_none_when_no_onnx_file_found(self, tmp_path):
        """Should return None if snapshot directory has no usable ONNX file."""
        snapshot_dir = tmp_path / "snapshot"
        snapshot_dir.mkdir(parents=True)

        resolved = ONNXLoader._resolve_onnx_model_file(snapshot_dir)

        assert resolved is None


class TestDownloadOnnxModelAllowPatterns:
    """Tests for ONNX download allow-pattern selection."""

    @pytest.mark.asyncio
    async def test_includes_single_file_onnx_patterns_for_onnx_community_models(self):
        """onnx-community VAD repos should include onnx/model.onnx patterns."""
        loader = ONNXLoader()
        model_config = AiModelConfig(
            id="m-vad",
            tenant_id="t-1",
            slug="onnx-community--silero-vad",
            name="Silero VAD",
            description="VAD model",
            task_type=ModelTaskType.VOICE_ACTIVITY_DETECTION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="onnx-community/silero-vad",
            source_revision="main",
            format=AiModelFormat.ONNX,
            memory_size_mb=None,
            compute_type="float32",
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=datetime.utcnow(),
            file_size_mb=None,
            checksum=None,
            tags=[],
        )

        with (
            patch("stt_v2.models.onnx_loader.get_settings") as mock_settings,
            patch(
                "huggingface_hub.snapshot_download",
                return_value="/tmp/model-cache",
            ) as mock_snapshot,
            patch("os.makedirs"),
        ):
            settings = MagicMock()
            settings.huggingface_cache_dir = "/tmp/hf-cache"
            mock_settings.return_value = settings

            _ = await loader._download_onnx_model(model_config)

        allow_patterns = mock_snapshot.call_args.kwargs["allow_patterns"]
        assert "onnx/model.onnx" in allow_patterns
        assert "onnx/model.onnx_data" in allow_patterns
