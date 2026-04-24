"""Unit tests for BatchTranscriptionService._run_nemo_inference (TASK-258 Phase C)."""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import numpy as np
import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import AiModelFormat, InferenceConfig
from stt_v2.transcription.batch_service import BatchTranscriptionService
from stt_v2.transcription.dto import RawTranscription


def _make_loaded_nemo(transcribe_return) -> LoadedModel:
    nemo_model = MagicMock()
    nemo_model.transcribe.return_value = transcribe_return
    return LoadedModel(
        model_id="m1",
        model_slug="parakeet",
        model=nemo_model,
        format=AiModelFormat.NEMO,
        device="cpu",
        extra={
            "model_class": "EncDecRNNTBPEModel",
            "target_lang": "en",
            "supports_word_timestamps": True,
            "supports_segment_timestamps": True,
        },
    )


def _make_hyp(text, words=None, segments=None):
    hyp = MagicMock(spec=["text", "timestamp", "language"])
    hyp.text = text
    ts = {}
    if words is not None:
        ts["word"] = [{"word": w, "start": s, "end": e} for (w, s, e) in words]
    if segments is not None:
        ts["segment"] = [{"segment": t, "start": s, "end": e} for (t, s, e) in segments]
    hyp.timestamp = ts or None
    hyp.language = None
    return hyp


class TestRunNemoInference:
    @pytest.mark.asyncio
    async def test_returns_full_raw_transcription(self):
        loaded = _make_loaded_nemo(
            [
                _make_hyp(
                    "hello world",
                    words=[("hello", 0.0, 0.5), ("world", 0.5, 1.0)],
                    segments=[("hello world", 0.0, 1.0)],
                )
            ]
        )
        svc = BatchTranscriptionService.__new__(BatchTranscriptionService)
        config = InferenceConfig()
        samples = np.zeros(16000, dtype=np.float32)

        raw = await svc._run_nemo_inference(samples, 16000, loaded, config)

        assert isinstance(raw, RawTranscription)
        assert raw.text == "hello world"
        assert raw.language == "en"
        assert len(raw.word_timestamps) == 2
        assert raw.word_timestamps[0]["word"] == "hello"
        assert len(raw.segments) == 1
        assert raw.segments[0]["text"] == "hello world"

    @pytest.mark.asyncio
    async def test_warns_on_code_switching(self, caplog):
        loaded = _make_loaded_nemo([_make_hyp("hi")])
        svc = BatchTranscriptionService.__new__(BatchTranscriptionService)
        config = InferenceConfig(code_switching=True)
        with caplog.at_level(logging.WARNING):
            await svc._run_nemo_inference(np.zeros(8000, dtype=np.float32), 16000, loaded, config)
        assert any("code-switching" in r.message.lower() for r in caplog.records)

    @pytest.mark.asyncio
    async def test_progress_callback_invoked(self):
        loaded = _make_loaded_nemo([_make_hyp("hi")])
        svc = BatchTranscriptionService.__new__(BatchTranscriptionService)
        config = InferenceConfig()
        progress = MagicMock()
        await svc._run_nemo_inference(
            np.zeros(8000, dtype=np.float32), 16000, loaded, config, progress
        )
        progress.assert_called_with(1.0)
