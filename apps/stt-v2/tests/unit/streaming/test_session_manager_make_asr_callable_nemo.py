"""Streaming dispatch tests for NeMo (TASK-258 Phase D)."""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import numpy as np
import pytest

from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import AiModelFormat, InferenceConfig
from stt_v2.streaming.session_manager import SessionManager


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


def _hyp(text, words=None):
    h = MagicMock(spec=["text", "timestamp", "language"])
    h.text = text
    h.timestamp = (
        {"word": [{"word": w, "start": s, "end": e} for (w, s, e) in words]}
        if words
        else None
    )
    h.language = None
    return h


class TestMakeAsrCallableNemo:
    @pytest.mark.asyncio
    async def test_returns_callable_for_nemo_format_without_processor(self):
        mgr = MagicMock(spec=SessionManager)
        loaded = _make_loaded_nemo(
            [_hyp("hello world", words=[("hello", 0.0, 0.5), ("world", 0.5, 1.0)])]
        )

        callable_ = SessionManager._make_asr_callable(
            mgr,
            asr_model=loaded,
            inference_config=InferenceConfig(),
        )

        out = await callable_(np.zeros(16000, dtype=np.float32), 16000)
        assert out["text"] == "hello world"
        assert len(out["word_timestamps"]) == 2

    @pytest.mark.asyncio
    async def test_initial_prompt_ignored_for_nemo(self, caplog):
        mgr = MagicMock(spec=SessionManager)
        loaded = _make_loaded_nemo([_hyp("hi")])

        callable_ = SessionManager._make_asr_callable(
            mgr,
            asr_model=loaded,
            inference_config=InferenceConfig(),
            initial_prompt="ignored prompt text",
        )

        with caplog.at_level(logging.WARNING):
            out = await callable_(np.zeros(8000, dtype=np.float32), 16000)
        assert out["text"] == "hi"
        # initial_prompt must never be forwarded to NeMo's transcribe()
        _args, kwargs = loaded.model.transcribe.call_args
        assert "initial_prompt" not in kwargs
        assert "prompt" not in kwargs
