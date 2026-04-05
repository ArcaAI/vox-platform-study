"""RED tests for S5 -- streaming punctuation restoration."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance


def _make_worker(punctuation_config=None, **kwargs):
    return StreamingInferenceWorker(
        result_publisher=None,
        asr_pipeline=lambda samples, sr: {"text": "hello world", "word_timestamps": []},
        punctuation_config=punctuation_config,
        **kwargs,
    )


class TestApplyPunctuationDisabled:
    async def test_returns_unchanged_when_disabled(self):
        worker = _make_worker(punctuation_config=None)
        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"

    async def test_returns_unchanged_when_config_not_enabled(self):
        cfg = MagicMock()
        cfg.enabled = False
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"


class TestApplyPunctuationEnabled:
    async def test_empty_text_returns_empty(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "kredor/punctuate-all"
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("")
        assert result == ""

    async def test_whitespace_only_returns_as_is(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "kredor/punctuate-all"
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("   ")
        assert result == "   "

    @pytest.mark.skip(reason="Punctuation restoration not yet implemented (TODO in inference.py)")
    async def test_restores_punctuation(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        mock_model = MagicMock()
        mock_model.restore_punctuation.return_value = "Hello world."

        worker = _make_worker(punctuation_config=cfg)

        with patch(
            "stt_v2.streaming.inference.PunctuationModel", return_value=mock_model
        ) as mock_cls:
            result = await worker._apply_punctuation("hello world")
            assert result == "Hello world."
            mock_cls.assert_called_once_with(model="test-model")

    @pytest.mark.skip(reason="Punctuation restoration not yet implemented (TODO in inference.py)")
    async def test_lazy_loads_model_once(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        mock_model = MagicMock()
        mock_model.restore_punctuation.return_value = "Hello."

        worker = _make_worker(punctuation_config=cfg)

        with patch(
            "stt_v2.streaming.inference.PunctuationModel", return_value=mock_model
        ) as mock_cls:
            await worker._apply_punctuation("hello")
            await worker._apply_punctuation("world")
            # Should load model only once
            assert mock_cls.call_count == 1

    @pytest.mark.skip(reason="Punctuation restoration not yet implemented (TODO in inference.py)")
    async def test_model_failure_returns_original(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        mock_model = MagicMock()
        mock_model.restore_punctuation.side_effect = RuntimeError("boom")

        worker = _make_worker(punctuation_config=cfg)

        with patch("stt_v2.streaming.inference.PunctuationModel", return_value=mock_model):
            result = await worker._apply_punctuation("hello world")
            assert result == "hello world"


class TestProcessUtteranceWithPunctuation:
    @pytest.mark.skip(reason="Punctuation restoration not yet implemented (TODO in inference.py)")
    async def test_punctuation_applied_to_asr_output(self):
        """process_utterance should apply punctuation after ASR."""
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        mock_model = MagicMock()
        mock_model.restore_punctuation.return_value = "Hello world."

        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {"text": "hello world", "word_timestamps": []},
            punctuation_config=cfg,
        )

        utt = AudioUtterance(
            samples=np.random.randn(16000).astype(np.float32) * 0.1,
            sample_rate=16000,
            start_time=0.0,
            end_time=1.0,
            utterance_index=0,
        )

        with patch("stt_v2.streaming.inference.PunctuationModel", return_value=mock_model):
            result = await worker.process_utterance("s1", utt)

        assert result.text == "Hello world."
