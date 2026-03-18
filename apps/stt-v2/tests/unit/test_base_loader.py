"""Unit tests for BaseModelLoader — TASK-010 Apple Silicon enhancements.

Tests float16 auto-detection for MPS and the cleanup_accelerator_memory utility.
"""

from unittest.mock import MagicMock, patch

import pytest

from stt_v2.models.base_loader import BaseModelLoader, LoadedModel, cleanup_accelerator_memory
from stt_v2.models.huggingface_loader import HuggingFaceLoader
from stt_v2.pipeline.dto import AiModelFormat


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
        import torch
        with patch("torch.cuda.is_available", return_value=False), \
             patch("torch.backends.mps.is_available", return_value=True):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == torch.float16

    def test_auto_returns_float32_on_cpu(self, loader):
        """Auto dtype should return float32 when only CPU is available."""
        import torch
        with patch("torch.cuda.is_available", return_value=False), \
             patch("torch.backends.mps.is_available", return_value=False):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == torch.float32

    def test_auto_returns_float16_on_cuda(self, loader):
        """Auto dtype should still return float16 for CUDA (no regression)."""
        import torch
        with patch("torch.cuda.is_available", return_value=True):
            dtype = loader._get_torch_dtype("auto")
            assert dtype == torch.float16

    def test_explicit_float32_overrides_auto(self, loader):
        """Explicit float32 request should override auto-detection."""
        import torch
        with patch("torch.cuda.is_available", return_value=True):
            dtype = loader._get_torch_dtype("float32")
            assert dtype == torch.float32

    def test_explicit_float16(self, loader):
        """Explicit float16 should always return float16."""
        import torch
        dtype = loader._get_torch_dtype("float16")
        assert dtype == torch.float16

    def test_unknown_type_defaults_to_float32(self, loader):
        """Unknown compute type should fall back to float32."""
        import torch
        dtype = loader._get_torch_dtype("unknown_type")
        assert dtype == torch.float32


# =============================================================================
# Accelerator Memory Cleanup
# =============================================================================


class TestCleanupAcceleratorMemory:
    """Tests for cleanup_accelerator_memory() utility."""

    def test_calls_cuda_empty_cache_when_cuda_available(self):
        """Should call torch.cuda.empty_cache() on NVIDIA GPU."""
        import torch
        with patch("torch.cuda.is_available", return_value=True), \
             patch("torch.cuda.empty_cache") as mock_empty:
            cleanup_accelerator_memory()
            mock_empty.assert_called_once()

    def test_calls_mps_empty_cache_when_mps_available(self):
        """Should call torch.mps.empty_cache() on Apple Silicon."""
        import torch
        with patch("torch.cuda.is_available", return_value=False), \
             patch.object(torch.mps, "empty_cache") as mock_empty:
            cleanup_accelerator_memory()
            mock_empty.assert_called_once()

    def test_noop_on_cpu_only(self):
        """Should be a no-op when only CPU is available."""
        import torch
        with patch("torch.cuda.is_available", return_value=False), \
             patch("torch.mps.empty_cache", side_effect=AttributeError):
            # Should not raise — gracefully handles missing MPS
            cleanup_accelerator_memory()

    def test_handles_import_error_gracefully(self):
        """Should not raise when torch is not installed."""
        with patch.dict("sys.modules", {"torch": None}):
            # Force reimport failure
            cleanup_accelerator_memory()  # Should not raise
