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


class _CapturingModel_returning(_CapturingModel):
    """Records kwargs AND returns a fixed segment list from each transcribe."""

    def __init__(self, segments: list) -> None:
        super().__init__()
        self._segments = segments

    def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
        self.calls.append(kwargs)
        return self._segments


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


# --- Language pinning: single pinned, code-switch pair unpinned (auto) --------


def test_default_no_language_and_no_prompt() -> None:
    """No configured language + prompt OFF by default → clean decode with no
    ``language`` and no ``initial_prompt`` pinned."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg())

    adapter(_audio(), 16000)

    assert "language" not in model.calls[0]
    assert "initial_prompt" not in model.calls[0]


@pytest.mark.parametrize("language", ["ml", "en", "vi"])
def test_single_language_is_pinned(language: str) -> None:
    """A genuine single language is pinned as whisper.cpp's decode language."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg(language))

    adapter(_audio(), 16000)

    assert model.calls[0]["language"] == language


@pytest.mark.parametrize("pair", ["ml-en", "vi-en"])
def test_code_switch_pair_is_unpinned(pair: str) -> None:
    """A code-switch PAIR resolves to auto (no pinned language) — pinning the
    primary subtag over-biases toward its script and degrades the other
    language on the code-switch fine-tune (measured)."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg(pair))

    adapter(_audio(), 16000)

    assert "language" not in model.calls[0]


# --- Consultation prompt: OFF by default, opt-in via setting ------------------


def _settings(*, prompt_enabled: bool) -> SimpleNamespace:
    return SimpleNamespace(whisper_cpp_consultation_prompt_enabled=prompt_enabled)


def test_prompt_disabled_by_default_but_carry_forward_flows() -> None:
    """Default (setting OFF): no context ``initial_prompt``; a per-utterance
    carry-forward prompt still flows through on its own (no leading space)."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000)
    assert "initial_prompt" not in model.calls[0]

    adapter(_audio(), 16000, prompt="carry forward")
    assert model.calls[1]["initial_prompt"] == "carry forward"


def test_prompt_enabled_prepends_consultation_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the setting ON, the language-derived consultation context leads and a
    carry-forward prompt is appended after it."""
    monkeypatch.setattr(
        whisper_cpp_asr, "get_settings", lambda: _settings(prompt_enabled=True)
    )
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000)
    assert model.calls[0]["initial_prompt"] == _CONSULTATION_PROMPT_ML

    adapter(_audio(), 16000, prompt="previous transcript text")
    assert (
        model.calls[1]["initial_prompt"]
        == f"{_CONSULTATION_PROMPT_ML} previous transcript text"
    )


# --- Decode mode: clean (default) vs word-timestamp -------------------------


def test_clean_decode_omits_word_split_kwargs() -> None:
    """Default (no word timestamps requested) → clean sentence-level decode:
    the lossy ``max_len=1``/``split_on_word``/``token_timestamps`` params are NOT
    passed."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))

    adapter(_audio(), 16000)

    kw = model.calls[0]
    assert "max_len" not in kw
    assert "split_on_word" not in kw
    assert "token_timestamps" not in kw


def test_word_timestamp_mode_splits_and_space_joins() -> None:
    """When word timestamps ARE requested: word-split decode is used, per-word
    timings are emitted, and the transcript is SPACE-joined (correct for the
    space-trimmed word segments)."""
    model = _CapturingModel_returning(
        [_seg("Hello", 0, 40, 0.9), _seg("there", 40, 80, 0.8)]
    )
    adapter = WhisperCppAsrAdapter(
        _loaded_model(model), _cfg("en"), want_word_timestamps=True
    )

    result = adapter(_audio(), 16000)

    assert model.calls[0]["max_len"] == 1
    assert model.calls[0]["split_on_word"] is True
    assert result["text"] == "Hello there"
    assert [w["word"] for w in result["word_timestamps"]] == ["Hello", "there"]
    assert result["word_timestamps"][0]["start"] == 0.0


# --- Native-spacing text reconstruction (Malayalam corruption fix) ------------


def test_malayalam_clean_decode_preserves_native_spacing() -> None:
    """Clean-decode (default) Malayalam: native concatenation of segment text
    preserves whisper's own (near-zero) inter-word spacing — no spurious spaces,
    grapheme clusters intact. Space-joining would corrupt it."""
    # A clean sentence-level decode of "നമസ്കാരം ഡോക്ടർ" — Malayalam word has no
    # internal spaces; whisper attaches a leading space at the real word break.
    segments = [_seg("നമസ്കാരം", 0, 60, 0.9), _seg(" ഡോക്ടർ", 60, 90, 0.9)]
    model = _CapturingModel_returning(segments)
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))

    result = adapter(_audio(), 16000)

    assert result["text"] == "നമസ്കാരം ഡോക്ടർ"
    assert result["word_timestamps"] == []  # no word timings in clean mode


def test_english_segments_preserve_native_word_spacing() -> None:
    """English word segments carry whisper's leading-space byte; native
    concatenation therefore yields correctly-spaced text (and whitespace is
    normalized to single spaces, stripped)."""
    segments = [
        _seg(" Hello", 0, 40, 0.9),
        _seg(" there", 40, 80, 0.9),
        _seg(" doctor", 80, 120, 0.9),
    ]
    model = SimpleNamespace(transcribe=lambda audio, **kw: segments)
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("en"))

    result = adapter(_audio(), 16000)

    assert result["text"] == "Hello there doctor"


def _seg(text: str, t0: int, t1: int, prob: float) -> SimpleNamespace:
    return SimpleNamespace(text=text, t0=t0, t1=t1, probability=prob)


def _audio() -> np.ndarray:
    return np.zeros(16000, dtype=np.float32)


# --- Length guard: chunk long audio at silence troughs -----------------------


def test_short_audio_is_not_chunked() -> None:
    """Audio within the stable window is decoded in a single pass."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))
    adapter._max_audio_seconds = 7.0

    adapter(np.zeros(5 * 16000, dtype=np.float32), 16000)  # 5 s < 7 s

    assert len(model.calls) == 1


def test_long_audio_is_split_into_multiple_decodes() -> None:
    """Audio beyond the stable window is split into multiple bounded decodes and
    the per-chunk transcripts are stitched together."""
    model = _CapturingModel_returning([_seg(" piece", 0, 40, 0.9)])
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))
    adapter._max_audio_seconds = 3.0

    result = adapter(np.zeros(10 * 16000, dtype=np.float32), 16000)  # 10 s

    assert len(model.calls) >= 3  # ~ceil(10/3)
    assert "piece" in result["text"]


def test_chunking_disabled_when_setting_zero() -> None:
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))
    adapter._max_audio_seconds = 0.0

    adapter(np.zeros(30 * 16000, dtype=np.float32), 16000)

    assert len(model.calls) == 1


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("അത് അത് അത് അത് അത് അത്", "അത്"),  # degenerate loop -> one
        ("no no no", "no no no"),  # genuine triple survives (run == limit)
        ("the patient has a fever", "the patient has a fever"),  # normal untouched
        ("", ""),
    ],
)
def test_collapse_repeats_loop_guard(text: str, expected: str) -> None:
    assert whisper_cpp_asr._collapse_repeats(text) == expected


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
