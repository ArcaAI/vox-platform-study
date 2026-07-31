"""Unit tests for the whisper.cpp streaming adapter — concurrency
serialization and Metal-backend poison recovery.

Regression coverage for the "backend is in error state from a previous
command buffer failure" fault: concurrent decodes on one shared ggml/Metal
context corrupt its command buffer, after which every ``whisper_full`` returns
zero segments (empty text) forever. The adapter must (1) serialize decodes on a
shared context and (2) detect the poisoned state and recreate the backend.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming import whisper_cpp_asr
from stt.streaming.whisper_cpp_asr import (
    _CONSULTATION_PROMPT_EN,
    _CONSULTATION_PROMPT_ML,
    WhisperCppAsrAdapter,
    consultation_prompt_for_language,
)


def _loaded_model(model: object, model_id: str = "m1") -> LoadedModel:
    return LoadedModel(
        model_id=model_id,
        model_slug="whisper-large-v3-turbo",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )


def _cfg(language: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(language=language)


class _CapturingModel:
    """Fake pywhispercpp model that records the kwargs of each transcribe call."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
        self.calls.append(kwargs)
        return []


@pytest.mark.parametrize(
    ("language", "expected"),
    [
        ("ml", _CONSULTATION_PROMPT_ML),
        ("ML", _CONSULTATION_PROMPT_ML),
        ("ml-en", _CONSULTATION_PROMPT_ML),
        ("en", _CONSULTATION_PROMPT_EN),
        ("vi", _CONSULTATION_PROMPT_EN),
        (None, _CONSULTATION_PROMPT_EN),
        ("", _CONSULTATION_PROMPT_EN),
    ],
)
def test_consultation_prompt_for_language(language: str | None, expected: str) -> None:
    """Malayalam pins the Malayalam line; everything else (incl. unset) is English."""
    assert consultation_prompt_for_language(language) == expected


def test_default_language_feeds_english_consultation_prompt() -> None:
    """With no configured language, whisper.cpp is primed with the English
    consultation context as ``initial_prompt``."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg())

    adapter(_audio(), 16000)

    assert model.calls[0]["initial_prompt"] == _CONSULTATION_PROMPT_EN
    # No language pinned when the pipeline leaves it null.
    assert "language" not in model.calls[0]


def test_ml_language_feeds_malayalam_prompt_and_pins_language() -> None:
    """A ``language: "ml"`` pipeline pins ml AND primes the Malayalam context."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000)

    assert model.calls[0]["initial_prompt"] == _CONSULTATION_PROMPT_ML
    assert model.calls[0]["language"] == "ml"


def test_carry_forward_prompt_follows_consultation_context() -> None:
    """A per-utterance carry-forward prompt is appended AFTER the context line."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000, prompt="previous transcript text")

    assert (
        model.calls[0]["initial_prompt"]
        == f"{_CONSULTATION_PROMPT_ML} previous transcript text"
    )


def _seg(text: str, t0: int, t1: int, prob: float) -> SimpleNamespace:
    return SimpleNamespace(text=text, t0=t0, t1=t1, probability=prob)


def _audio() -> np.ndarray:
    return np.zeros(16000, dtype=np.float32)


def test_serializes_concurrent_decode_on_shared_context() -> None:
    """Two adapters over the SAME loaded model must never run
    ``transcribe`` concurrently — that is what corrupts the Metal command
    buffer."""

    state = SimpleNamespace(active=0, max_active=0)
    guard = threading.Lock()

    class _FakeModel:
        def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
            with guard:
                state.active += 1
                state.max_active = max(state.max_active, state.active)
            time.sleep(0.02)
            with guard:
                state.active -= 1
            return []

    loaded = _loaded_model(_FakeModel())
    # Two distinct adapters (e.g. main + english-gloss) over one context.
    adapter_a = WhisperCppAsrAdapter(loaded, _cfg())
    adapter_b = WhisperCppAsrAdapter(loaded, _cfg())

    def call(adapter: WhisperCppAsrAdapter) -> None:
        adapter(_audio(), 16000)

    threads = [
        threading.Thread(target=call, args=(adapter_a if i % 2 else adapter_b,))
        for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state.max_active == 1


def test_recovers_from_poisoned_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """When whisper.cpp logs a poison marker and returns no segments, the
    adapter recreates the context in place and retries once."""

    healthy = SimpleNamespace(
        transcribe=lambda audio, **kw: [_seg("hello", 0, 50, 0.9)]
    )

    rebuilt = SimpleNamespace(count=0)

    def _fake_construct(path: str, n_threads: int, use_gpu: bool) -> object:
        rebuilt.count += 1
        return healthy

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _fake_construct)

    class _PoisonModel:
        def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
            # Mimic whisper.cpp's native log on a poisoned Metal backend.
            whisper_cpp_asr._dispatch_log(
                2, "whisper_full_with_state: failed to encode\n"
            )
            return []

    loaded = _loaded_model(_PoisonModel())
    adapter = WhisperCppAsrAdapter(loaded, _cfg())

    result = adapter(_audio(), 16000)

    assert result["text"] == "hello"
    assert rebuilt.count == 1
    # Reloaded in place so every adapter sharing this LoadedModel recovers.
    assert loaded.model is healthy


def test_no_reload_on_genuine_silence(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty result with NO poison marker is genuine silence — the
    adapter must NOT recreate the backend."""

    rebuilt = SimpleNamespace(count=0)

    def _fake_construct(path: str, n_threads: int, use_gpu: bool) -> object:
        rebuilt.count += 1
        return SimpleNamespace(transcribe=lambda audio, **kw: [])

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _fake_construct)

    silent = SimpleNamespace(transcribe=lambda audio, **kw: [])
    loaded = _loaded_model(silent)
    adapter = WhisperCppAsrAdapter(loaded, _cfg())

    result = adapter(_audio(), 16000)

    assert result["text"] == ""
    assert rebuilt.count == 0
