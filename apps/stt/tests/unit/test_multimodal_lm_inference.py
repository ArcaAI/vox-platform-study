"""Unit tests for multimodal LLM (Gemma 4) inference.

Tests batch transcription branching and _run_multimodal_lm_inference().
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
import torch

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.transcription.batch_service import BatchTranscriptionService
from stt.transcription.dto import RawTranscription


def _make_multimodal_loaded_model() -> LoadedModel:
    """Create a LoadedModel with multimodal_lm flag set."""
    mock_model = MagicMock()
    mock_model.device = torch.device("cpu")
    mock_model.dtype = torch.float32

    mock_processor = MagicMock()

    return LoadedModel(
        model_id="m-gemma",
        model_slug="gemma-4-e4b",
        model=mock_model,
        processor=mock_processor,
        format=AiModelFormat.SAFETENSOR,
        memory_mb=4000,
        device="cpu",
        loaded_at=datetime.now(UTC),
        extra={"multimodal_lm": True, "max_audio_seconds": 30},
    )


def _setup_generate_mocks(model: LoadedModel, decode_return: str | list[str] = "test text"):
    """Configure model + processor mocks for a successful generate cycle."""
    mock_output_tensor = MagicMock()
    mock_generated_tokens = MagicMock()
    mock_output_tensor.__getitem__ = MagicMock(return_value=mock_generated_tokens)
    model.model.generate.return_value = mock_output_tensor

    mock_input_ids = MagicMock()
    mock_input_ids.shape = [1, 10]
    mock_template_result = {"input_ids": mock_input_ids}
    for v in mock_template_result.values():
        v.to = MagicMock(return_value=v)
    model.processor.apply_chat_template.return_value = mock_template_result

    if isinstance(decode_return, list):
        call_count = [0]

        def decode_side_effect(tokens, skip_special_tokens=True):
            idx = min(call_count[0], len(decode_return) - 1)
            call_count[0] += 1
            return decode_return[idx]

        model.processor.decode.side_effect = decode_side_effect
    else:
        model.processor.decode.return_value = decode_return


def _make_whisper_loaded_model() -> LoadedModel:
    """Create a standard Whisper LoadedModel (no multimodal flag)."""
    return LoadedModel(
        model_id="m-whisper",
        model_slug="whisper-tiny",
        model=MagicMock(),
        processor=MagicMock(),
        format=AiModelFormat.SAFETENSOR,
        memory_mb=80,
        device="cpu",
        loaded_at=datetime.now(UTC),
        extra={},
    )


class TestMultimodalLMInferenceBranching:
    """Tests for _run_transformers_inference() dispatching to multimodal path."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_transformers_inference_branches_to_multimodal(self, service):
        """extra['multimodal_lm']=True causes _run_multimodal_lm_inference to be called."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = "en"
        samples = np.zeros(16000, dtype=np.float32)

        with patch.object(
            service,
            "_run_multimodal_lm_inference",
            new_callable=AsyncMock,
            return_value=RawTranscription(text="test"),
        ) as mock_multimodal:
            result = await service._run_transformers_inference(
                samples, 16000, model, config, prompt="transcribe this",
            )

        mock_multimodal.assert_called_once()
        assert result.text == "test"

    @pytest.mark.asyncio
    async def test_transformers_inference_whisper_unchanged(self, service):
        """Standard Whisper model does NOT branch to multimodal path."""
        model = _make_whisper_loaded_model()
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = 1
        config.temperature = 0.0
        samples = np.zeros(16000, dtype=np.float32)

        with patch.object(
            service,
            "_run_multimodal_lm_inference",
            new_callable=AsyncMock,
        ) as mock_multimodal:
            try:
                await service._run_transformers_inference(
                    samples, 16000, model, config,
                )
            except Exception:
                pass

        mock_multimodal.assert_not_called()


class TestMultimodalLMInference:
    """Tests for _run_multimodal_lm_inference() method."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_empty_audio(self, service):
        """0-length audio returns empty RawTranscription immediately."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None

        result = await service._run_multimodal_lm_inference(
            np.array([], dtype=np.float32), 16000, model, config,
        )

        assert isinstance(result, RawTranscription)
        assert result.text == ""
        assert result.word_timestamps == []

    @pytest.mark.asyncio
    async def test_single_chunk(self, service):
        """Audio < 28s: single generate call, chat template used."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None
        _setup_generate_mocks(model, decode_return="Hello world")

        result = await service._run_multimodal_lm_inference(
            np.random.randn(80000).astype(np.float32), 16000, model, config,
        )

        assert isinstance(result, RawTranscription)
        assert "Hello world" in result.text
        model.processor.apply_chat_template.assert_called_once()

    @pytest.mark.asyncio
    async def test_multi_chunk(self, service):
        """Audio 60s: 3 chunks (28s + 28s + 4s) with context carry-forward."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None
        _setup_generate_mocks(
            model,
            decode_return=["First chunk text", "Second chunk text", "Third chunk text"],
        )

        result = await service._run_multimodal_lm_inference(
            np.random.randn(960000).astype(np.float32), 16000, model, config,
        )

        assert model.processor.apply_chat_template.call_count == 3
        assert "First chunk text" in result.text
        assert "Third chunk text" in result.text

    @pytest.mark.asyncio
    async def test_no_word_timestamps(self, service):
        """word_timestamps is always [] for multimodal LLM."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None
        _setup_generate_mocks(model, decode_return="Some text")

        result = await service._run_multimodal_lm_inference(
            np.random.randn(16000).astype(np.float32), 16000, model, config,
        )

        assert result.word_timestamps == []

    @pytest.mark.asyncio
    async def test_progress_callback(self, service):
        """Progress callback called per chunk."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None
        _setup_generate_mocks(model, decode_return="chunk text")

        progress_values = []
        await service._run_multimodal_lm_inference(
            np.random.randn(960000).astype(np.float32), 16000, model, config,
            progress_callback=lambda v: progress_values.append(v),
        )

        assert len(progress_values) == 3
        assert progress_values[-1] == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_with_language(self, service):
        """Language alone does not inject a text prompt into multimodal content."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = "vi"
        _setup_generate_mocks(model, decode_return="transcription")

        await service._run_multimodal_lm_inference(
            np.random.randn(16000).astype(np.float32), 16000, model, config,
        )

        call_args = model.processor.apply_chat_template.call_args
        messages = call_args[0][0]
        content = messages[0]["content"]
        assert len(content) == 1
        assert content[0]["type"] == "audio"

    @pytest.mark.asyncio
    async def test_with_custom_prompt(self, service):
        """Custom prompt is used instead of default."""
        model = _make_multimodal_loaded_model()
        config = MagicMock()
        config.language = None
        _setup_generate_mocks(model, decode_return="result")

        custom_prompt = "Transcribe this medical audio verbatim."
        await service._run_multimodal_lm_inference(
            np.random.randn(16000).astype(np.float32), 16000, model, config,
            prompt=custom_prompt,
        )

        call_args = model.processor.apply_chat_template.call_args
        messages = call_args[0][0]
        text_content = next(
            item["text"]
            for item in messages[0]["content"]
            if item.get("type") == "text"
        )
        assert custom_prompt in text_content

