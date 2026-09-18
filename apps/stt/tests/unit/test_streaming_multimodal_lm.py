"""Unit tests for multimodal LLM streaming callable.

Tests _make_asr_callable() branching for multimodal LLM models (Gemma 4).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
import torch

from stt.pipeline.dto import AiModelFormat
from stt.streaming.execution_profile import ExecutionProfile, PlatformType


def _make_profile():
    return ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )


def _make_manager():
    from stt.streaming.session_manager import SessionManager

    redis_mock = AsyncMock()
    redis_mock.hset = AsyncMock()
    redis_mock.expire = AsyncMock()
    redis_mock.delete = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=_make_profile(), worker_id="test-worker")


def _mock_multimodal_model():
    """Build a LoadedModel mock with multimodal_lm extra flag."""
    mock_model = MagicMock()
    mock_model.device = torch.device("cpu")
    mock_model.dtype = torch.float32

    mock_output = MagicMock()
    mock_generated = MagicMock()
    mock_output.__getitem__ = MagicMock(return_value=mock_generated)
    mock_model.generate.return_value = mock_output

    mock_processor = MagicMock()
    mock_processor.decode.return_value = "transcribed text"

    mock_input_ids = MagicMock()
    mock_input_ids.shape = [1, 10]
    mock_template_result = {"input_ids": mock_input_ids}
    for v in mock_template_result.values():
        v.to = MagicMock(return_value=v)
    mock_processor.apply_chat_template.return_value = mock_template_result

    loaded = MagicMock()
    loaded.model = mock_model
    loaded.processor = mock_processor
    loaded.feature_extractor = None
    loaded.format = AiModelFormat.SAFETENSOR
    loaded.device = torch.device("cpu")
    loaded.extra = {"multimodal_lm": True, "max_audio_seconds": 30}
    return loaded


def _mock_inference_config(**overrides):
    defaults = {"beam_size": 1, "code_switching": False, "language": "en", "temperature": None}
    defaults.update(overrides)
    return MagicMock(**defaults)


class TestMakeAsrCallableMultimodalLLM:
    """Tests for _make_asr_callable() with multimodal LLM models."""

    @pytest.mark.asyncio
    async def test_multimodal_returns_callable(self):
        """extra['multimodal_lm']=True returns a callable that works."""
        mgr = _make_manager()
        loaded = _mock_multimodal_model()
        fn = mgr._make_asr_callable(loaded, _mock_inference_config())

        assert callable(fn)
        samples = np.zeros(16000, dtype=np.float32)
        result = await fn(samples, 16000)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_multimodal_returns_expected_shape(self):
        """Returns dict with 'text' and 'word_timestamps' keys."""
        mgr = _make_manager()
        loaded = _mock_multimodal_model()
        fn = mgr._make_asr_callable(loaded, _mock_inference_config())

        result = await fn(np.zeros(16000, dtype=np.float32), 16000)

        assert isinstance(result, dict)
        assert "text" in result
        assert "word_timestamps" in result
        assert result["word_timestamps"] == []

    @pytest.mark.asyncio
    async def test_multimodal_uses_chat_template(self):
        """processor.apply_chat_template is called for multimodal models."""
        mgr = _make_manager()
        loaded = _mock_multimodal_model()
        fn = mgr._make_asr_callable(loaded, _mock_inference_config())

        await fn(np.zeros(16000, dtype=np.float32), 16000)

        loaded.processor.apply_chat_template.assert_called_once()

    @pytest.mark.asyncio
    async def test_multimodal_passes_prompt(self):
        """Initial prompt is included in the chat message text content."""
        mgr = _make_manager()
        loaded = _mock_multimodal_model()
        custom_prompt = "Transcribe medical speech verbatim."
        fn = mgr._make_asr_callable(loaded, _mock_inference_config(), initial_prompt=custom_prompt)
        await fn(np.zeros(16000, dtype=np.float32), 16000)

        call_args = loaded.processor.apply_chat_template.call_args
        messages = call_args[0][0]
        text_content = next(
            item["text"] for item in messages[0]["content"] if item.get("type") == "text"
        )
        assert custom_prompt in text_content

    @pytest.mark.asyncio
    async def test_multimodal_does_not_call_processor_as_whisper(self):
        """Multimodal path should NOT call processor(samples, ...) like Whisper does."""
        mgr = _make_manager()
        loaded = _mock_multimodal_model()
        fn = mgr._make_asr_callable(loaded, _mock_inference_config())

        await fn(np.zeros(16000, dtype=np.float32), 16000)

        # The processor should NOT be called as a function (Whisper path)
        # It should only be called via apply_chat_template
        loaded.processor.assert_not_called()
        loaded.processor.apply_chat_template.assert_called_once()
