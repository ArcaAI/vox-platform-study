"""Unit tests for BaseModelLoader — Apple Silicon enhancements.

Tests float16 auto-detection for MPS and the cleanup_accelerator_memory utility.
"""

import sys
from unittest.mock import MagicMock, patch

import pytest

from stt.models.base_loader import cleanup_accelerator_memory
from stt.models.huggingface_loader import HuggingFaceLoader


def _make_mock_torch():
    """Build a mock torch module with realistic dtype sentinels and backends.

    Each dtype is a unique string so equality checks work correctly
    without needing the real torch package.
    """
    mock = MagicMock()

    mock.float16 = "torch.float16"
    mock.float32 = "torch.float32"
    mock.bfloat16 = "torch.bfloat16"
    mock.int8 = "torch.int8"

    mock.cuda = MagicMock()
    mock.backends = MagicMock()
    mock.mps = MagicMock()

    return mock


# =============================================================================
# Auto dtype on MPS
# =============================================================================


class TestGetTorchDtype:
    """Tests for _get_torch_dtype() with MPS float16 support."""

    @pytest.fixture
    def loader(self):
        """Use HuggingFaceLoader as concrete implementation of BaseModelLoader."""
        return HuggingFaceLoader()

    def test_auto_returns_float16_on_mps(self, loader):
        """Auto dtype should return float16 when MPS is available."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = True
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == mock_torch.float16

    def test_auto_returns_float32_on_cpu(self, loader):
        """Auto dtype should return float32 when only CPU is available."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = False
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == mock_torch.float32

    def test_auto_returns_float16_on_cuda(self, loader):
        """Auto dtype should still return float16 for CUDA (no regression)."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == mock_torch.float16

    def test_explicit_float32_overrides_auto(self, loader):
        """Explicit float32 request should override auto-detection."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("float32")
            assert dtype == mock_torch.float32

    def test_explicit_float16(self, loader):
        """Explicit float16 should always return float16."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("float16")
            assert dtype == mock_torch.float16

    def test_unknown_type_defaults_to_float32(self, loader):
        """Unknown compute type should fall back to float32."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = False
        with patch.dict(sys.modules, {"torch": mock_torch}):
            dtype = loader._get_torch_dtype("unknown_type")
            assert dtype == mock_torch.float32


# =============================================================================
# Accelerator Memory Cleanup
# =============================================================================


class TestCleanupAcceleratorMemory:
    """Tests for cleanup_accelerator_memory() utility."""

    def test_calls_cuda_empty_cache_when_cuda_available(self):
        """Should call torch.cuda.empty_cache() on NVIDIA GPU."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = True
        with patch.dict(sys.modules, {"torch": mock_torch}):
            cleanup_accelerator_memory()
            mock_torch.cuda.empty_cache.assert_called_once()

    def test_calls_mps_empty_cache_when_mps_available(self):
        """Should call torch.mps.empty_cache() on Apple Silicon."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = False
        with patch.dict(sys.modules, {"torch": mock_torch}):
            cleanup_accelerator_memory()
            mock_torch.mps.empty_cache.assert_called_once()

    def test_noop_on_cpu_only(self):
        """Should be a no-op when only CPU is available."""
        mock_torch = _make_mock_torch()
        mock_torch.cuda.is_available.return_value = False
        mock_torch.mps = MagicMock(spec=[])
        with patch.dict(sys.modules, {"torch": mock_torch}):
            cleanup_accelerator_memory()

    def test_handles_import_error_gracefully(self):
        """Should not raise when torch is not installed."""
        with patch.dict(sys.modules, {"torch": None}):
            cleanup_accelerator_memory()
