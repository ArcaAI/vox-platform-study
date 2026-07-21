"""Unit tests for NemoAsrAdapter."""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.nemo_adapter import NemoAsrAdapter
from stt_v2.pipeline.dto import AiModelFormat, InferenceConfig


def _make_loaded_model(
    *,
    nemo_model: MagicMock,
    target_lang: str | None = "en",
    supports_word_ts: bool = True,
    model_class: str = "EncDecRNNTBPEModel",
) -> LoadedModel:
    return LoadedModel(
        model_id="m-nemo",
        model_slug="parakeet",
        model=nemo_model,
        format=AiModelFormat.NEMO,
        device="cpu",
        extra={
            "model_class": model_class,
            "target_lang": target_lang,
            "supports_word_timestamps": supports_word_ts,
            "supports_segment_timestamps": True,
        },
    )


def _make_hyp(
    *,
    text: str,
    words: list[tuple[str, float, float]] | None = None,
    segments: list[tuple[str, float, float]] | None = None,
) -> MagicMock:
    """Mimic a NeMo Hypothesis with timestamp dict."""
    hyp = MagicMock(spec=["text", "timestamp", "language"])
    hyp.text = text
    ts: dict = {}
    if words is not None:
        ts["word"] = [
            {"word": w, "start": s, "end": e} for (w, s, e) in words
        ]
    if segments is not None:
        ts["segment"] = [
            {"segment": t, "start": s, "end": e} for (t, s, e) in segments
        ]
    hyp.timestamp = ts or None
    hyp.language = None
    return hyp


class TestNemoAsrAdapter:
    def test_call_returns_text_word_timestamps_segments_and_language(self):
        nemo_model = MagicMock()
        nemo_model.transcribe.return_value = [
            _make_hyp(
                text="hello world",
                words=[("hello", 0.0, 0.5), ("world", 0.5, 1.0)],
                segments=[("hello world", 0.0, 1.0)],
            )
        ]
        loaded = _make_loaded_model(nemo_model=nemo_model)
        adapter = NemoAsrAdapter(loaded, InferenceConfig())

        samples = np.zeros(16000, dtype=np.float32)
        out = adapter(samples, 16000)

        assert out["text"] == "hello world"
        assert out["language"] == "en"
        assert out["word_timestamps"] == [
            {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 1.0},
            {"word": "world", "start": 0.5, "end": 1.0, "confidence": 1.0},
        ]
        assert out["segments"] == [
            {"text": "hello world", "start": 0.0, "end": 1.0}
        ]
        # Verify transcribe called with timestamps=True and a list batch
        _args, kwargs = nemo_model.transcribe.call_args
        assert kwargs.get("timestamps") is True
        assert kwargs.get("return_hypotheses") is True
        passed_audio = kwargs.get("audio") or _args[0]
        assert isinstance(passed_audio, list)
        assert len(passed_audio) == 1

    def test_call_ignores_prompt_when_supplied(self, caplog):
        nemo_model = MagicMock()
        nemo_model.transcribe.return_value = [_make_hyp(text="hi")]
        loaded = _make_loaded_model(nemo_model=nemo_model)
        adapter = NemoAsrAdapter(loaded, InferenceConfig())

        out = adapter(np.zeros(8000, dtype=np.float32), 16000, prompt="ignored")
        assert out["text"] == "hi"
        # transcribe must not receive an initial_prompt kwarg
        _args, kwargs = nemo_model.transcribe.call_args
        assert "initial_prompt" not in kwargs
        assert "prompt" not in kwargs

    def test_call_handles_model_without_word_timestamps(self):
        nemo_model = MagicMock()
        # Hypothesis with no timestamp dict (small CTC variant)
        hyp = MagicMock(spec=["text", "timestamp", "language"])
        hyp.text = "ok"
        hyp.timestamp = None
        hyp.language = None
        nemo_model.transcribe.return_value = [hyp]
        loaded = _make_loaded_model(
            nemo_model=nemo_model,
            supports_word_ts=False,
            model_class="EncDecCTCModelBPE",
        )
        adapter = NemoAsrAdapter(loaded, InferenceConfig())

        out = adapter(np.zeros(8000, dtype=np.float32), 16000)
        assert out["text"] == "ok"
        assert out["word_timestamps"] == []
        assert out["segments"] == []

    def test_call_returns_empty_text_when_transcribe_returns_empty(self):
        nemo_model = MagicMock()
        nemo_model.transcribe.return_value = []
        loaded = _make_loaded_model(nemo_model=nemo_model)
        adapter = NemoAsrAdapter(loaded, InferenceConfig())

        out = adapter(np.zeros(8000, dtype=np.float32), 16000)
        assert out["text"] == ""
        assert out["word_timestamps"] == []
        assert out["segments"] == []
