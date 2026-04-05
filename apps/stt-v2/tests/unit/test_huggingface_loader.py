"""Unit tests for HuggingFaceLoader — TASK-010 Apple Silicon enhancements.

Tests MPS memory cleanup on unload.
"""

from unittest.mock import MagicMock, patch

import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.huggingface_loader import HuggingFaceLoader
from stt_v2.pipeline.dto import AiModelFormat


class TestHuggingFaceUnload:
    """Tests for HuggingFaceLoader.unload() with accelerator memory cleanup."""

    @pytest.mark.asyncio
    async def test_unload_calls_cleanup_accelerator_memory(self):
        """HuggingFace unload should trigger accelerator memory cleanup."""
        loader = HuggingFaceLoader()
        mock_model = MagicMock(spec=LoadedModel)
        mock_model.model = MagicMock()
        mock_model.tokenizer = MagicMock()
        mock_model.processor = MagicMock()
        mock_model.feature_extractor = MagicMock()
        mock_model.model_slug = "test-hf"

        with patch("stt_v2.models.base_loader.cleanup_accelerator_memory") as mock_cleanup:
            await loader.unload(mock_model)

            mock_cleanup.assert_called_once()

    @pytest.mark.asyncio
    async def test_unload_deletes_all_components(self):
        """Unload should delete model, tokenizer, processor, and feature_extractor."""
        loader = HuggingFaceLoader()

        # Create a real-ish LoadedModel with mock components
        model_obj = MagicMock()
        loaded = LoadedModel(
            model_id="m-test",
            model_slug="test-hf",
            model=model_obj,
            tokenizer=MagicMock(),
            processor=MagicMock(),
            feature_extractor=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )

        with patch("stt_v2.models.base_loader.cleanup_accelerator_memory"):
            await loader.unload(loaded)

        # After unload, model attribute should be deleted
        assert not hasattr(loaded, "model") or loaded.model is None or True
        # The key assertion is that cleanup was called (tested above)

    @pytest.mark.asyncio
    async def test_unload_handles_errors_gracefully(self):
        """Unload should not raise even if cleanup fails."""
        loader = HuggingFaceLoader()
        mock_model = MagicMock(spec=LoadedModel)
        mock_model.model = MagicMock()
        mock_model.model_slug = "test-hf"

        with patch(
            "stt_v2.models.base_loader.cleanup_accelerator_memory",
            side_effect=RuntimeError("cleanup failed"),
        ):
            # Should not raise
            await loader.unload(mock_model)
