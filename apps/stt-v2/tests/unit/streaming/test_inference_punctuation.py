"""Tests for streaming punctuation behavior."""

from unittest.mock import AsyncMock, MagicMock

import numpy as np

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

    async def test_enabled_mode_returns_original_until_implemented(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        worker = _make_worker(punctuation_config=cfg)

        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"
        assert worker._punctuation_model is None

    async def test_multiple_calls_remain_passthrough(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        worker = _make_worker(punctuation_config=cfg)

        first = await worker._apply_punctuation("hello")
        second = await worker._apply_punctuation("world")

        assert first == "hello"
        assert second == "world"
        assert worker._punctuation_model is None

    async def test_enabled_mode_keeps_original_text(self):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

        worker = _make_worker(punctuation_config=cfg)

        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"


class TestProcessUtteranceWithPunctuation:
    async def test_process_utterance_keeps_asr_output_when_punctuation_noop(self):
        """process_utterance currently keeps ASR output unchanged."""
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "test-model"

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

        result = await worker.process_utterance("s1", utt)

        assert result.text == "hello world"
