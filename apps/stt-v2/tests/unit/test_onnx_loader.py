"""Unit tests for ONNXLoader — provider configuration, thread count resolution,
and MPS memory cleanup on unload.
"""

from unittest.mock import MagicMock, patch

import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.onnx_loader import ONNXLoader


# =============================================================================
# Standard ONNX Loader — _get_providers()
# =============================================================================


class TestGetProviders:
    """Tests for _get_providers() execution provider selection."""

    def test_cuda_returns_string_format(self):
        """CUDA provider should be returned as a plain string."""
        loader = ONNXLoader()

        with patch("onnxruntime.get_available_providers", return_value=[
            "CUDAExecutionProvider", "CPUExecutionProvider",
        ]):
            providers = loader._get_providers()

        assert providers[0] == "CUDAExecutionProvider"
        assert providers[1] == "CPUExecutionProvider"

    def test_cpu_only_fallback(self):
        """When only CPU is available, return simple string list."""
        loader = ONNXLoader()

        with patch("onnxruntime.get_available_providers", return_value=[
            "CPUExecutionProvider",
        ]):
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

        with patch(
            "stt_v2.models.base_loader.cleanup_accelerator_memory"
        ) as mock_cleanup:
            await loader.unload(mock_model)

            mock_cleanup.assert_called_once()
