"""TASK-985 (M-24) — a failed whisper.cpp decode raises instead of answering "silence".

pywhispercpp discards ``whisper_full``'s return code, so at the Python level a
poisoned ggml/Metal backend is indistinguishable from a quiet clinician: both come
back as zero segments. The adapter's recovery path made that worse by returning
``[]`` when the recreate failed, or when the retry was still poisoned — so a dead
engine published an empty transcript, over and over, and looked like a silent room.

That is what made the DECLARED fallback chain unreachable for the primary engine
class. ``EngineSwitchController`` arms on ``CloudASR*`` and ``ModelError`` and on
nothing else (``engine_switch.py``: ``_THRESHOLD_SWITCH_ERRORS``), and the
inference loop re-raises exactly ``SWITCHABLE_ASR_ERRORS``; an empty string is not
a failure to anyone. So the self-hosted engine — the one HOPE actually serves —
could never trigger the auto-switch that exists for it.

The distinction these tests exist to protect: an empty decode with NO poison
marker is a genuinely silent utterance and must still return empty text. Only a
decode whose native log says the backend failed is a failure, and only after the
one in-place recovery has been tried.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from stt.core.exceptions import ModelError, ModelInferenceError
from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming import whisper_cpp_asr
from stt.streaming.engine_switch import SWITCHABLE_ASR_ERRORS
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000
_POISON_LINE = "whisper_full_with_state: failed to encode\n"


def _seg(text: str, t0: int = 0, t1: int = 50, probability: float = 0.9) -> SimpleNamespace:
    return SimpleNamespace(text=text, t0=t0, t1=t1, probability=probability)


class _PoisonModel:
    """Emits whisper.cpp's native poison marker and returns nothing, forever."""

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
        self.calls += 1
        whisper_cpp_asr._dispatch_log(2, _POISON_LINE)
        return []


def _loaded(model: object, model_id: str, *, extra: dict[str, Any] | None = None) -> LoadedModel:
    return LoadedModel(
        model_id=model_id,
        model_slug=model_id,
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4} if extra is None else extra,
    )


def _adapter(loaded: LoadedModel) -> WhisperCppAsrAdapter:
    return WhisperCppAsrAdapter(loaded, SimpleNamespace(language=None))


def _audio() -> np.ndarray:
    return np.zeros(SAMPLE_RATE, dtype=np.float32)


# --- The failure now propagates ---------------------------------------------


def test_a_failed_recreate_raises_rather_than_reporting_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """RED before the change: this returned ``{"text": ""}`` and the session went
    quiet with no error anywhere."""

    def _boom(*_args: Any, **_kwargs: Any) -> object:
        raise RuntimeError("no GPU left")

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _boom)
    adapter = _adapter(_loaded(_PoisonModel(), "t985-fail-construct"))

    with pytest.raises(ModelInferenceError):
        adapter(_audio(), SAMPLE_RATE)


def test_a_missing_model_path_raises() -> None:
    """A ``LoadedModel`` with no recorded weights path cannot be recreated at all.
    That is a permanent fault, so it must not masquerade as silence either."""
    adapter = _adapter(_loaded(_PoisonModel(), "t985-fail-nopath", extra={}))

    with pytest.raises(ModelInferenceError):
        adapter(_audio(), SAMPLE_RATE)


def test_still_poisoned_after_the_recreate_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """The recreate succeeded and the retry is STILL failing: the backend is gone
    for this process and another decode on it will not help. Hand the session's
    engine-switch controller a real failure."""
    monkeypatch.setattr(
        whisper_cpp_asr, "_construct_whisper_model", lambda *a, **k: _PoisonModel()
    )
    adapter = _adapter(_loaded(_PoisonModel(), "t985-fail-retry"))

    with pytest.raises(ModelInferenceError):
        adapter(_audio(), SAMPLE_RATE)


def test_the_raised_error_is_one_the_engine_switch_arms_on() -> None:
    """The whole point. If this class ever stops being a ``ModelError`` the
    auto-fallback silently goes deaf again, exactly as it was."""
    assert issubclass(ModelInferenceError, ModelError)
    assert issubclass(ModelInferenceError, SWITCHABLE_ASR_ERRORS)


# --- ...but silence is still silence ----------------------------------------


def test_genuine_silence_is_not_a_failure() -> None:
    """An empty decode with NO poison marker is a quiet utterance. Raising here
    would turn every pause in a consultation into an engine failure and switch the
    session onto the fallback engine for nothing."""
    silent = SimpleNamespace(transcribe=lambda audio, **kw: [])
    adapter = _adapter(_loaded(silent, "t985-silence"))

    result = adapter(_audio(), SAMPLE_RATE)

    assert result["text"] == ""
    assert result["segments"] == []


def test_a_successful_recovery_still_returns_the_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The recovery path itself is unchanged and must stay unchanged: poison ->
    recreate -> retry -> text, with no exception and with the shared handle swapped
    so every adapter over this ``LoadedModel`` recovers together."""
    healthy = SimpleNamespace(transcribe=lambda audio, **kw: [_seg(" hello")])
    built: list[object] = []

    def _construct(*_args: Any, **_kwargs: Any) -> object:
        built.append(healthy)
        return healthy

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _construct)
    loaded = _loaded(_PoisonModel(), "t985-recover-ok")
    adapter = _adapter(loaded)

    result = adapter(_audio(), SAMPLE_RATE)

    assert result["text"] == "hello"
    assert len(built) == 1
    assert loaded.model is healthy


# --- The reload no longer stalls every session on this model ----------------


def test_the_recreate_runs_with_the_decode_lock_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reloading a GGUF is seconds of mmap and backend init. Holding the per-context
    DECODE lock across it stalls every session sharing these weights for that whole
    time — on the one engine whose failure mode is already a stall.

    Asserted from inside the construction: the lock the decode path serializes on
    must be free right then, and re-held by the time the call returns.
    """
    healthy = SimpleNamespace(transcribe=lambda audio, **kw: [_seg(" hello")])
    observed: dict[str, bool] = {}
    loaded = _loaded(_PoisonModel(), "t985-lock-released")
    adapter = _adapter(loaded)

    def _construct(*_args: Any, **_kwargs: Any) -> object:
        # `acquire(blocking=False)` succeeds only if nobody holds it.
        free = adapter._lock.acquire(blocking=False)
        observed["lock_was_free"] = free
        if free:
            adapter._lock.release()
        return healthy

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _construct)

    adapter(_audio(), SAMPLE_RATE)

    assert observed["lock_was_free"] is True
    # ...and the decode that follows the recreate ran under it again, so the
    # context is still serialized: the lock is free once the call has returned.
    assert adapter._lock.acquire(blocking=False) is True
    adapter._lock.release()


def test_a_sibling_that_already_recreated_the_context_is_adopted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two adapters share one whisper context (the main and the english-gloss
    callables, and every concurrent session on the same weights). When the backend
    dies they ALL see poison. Without the generation check each would reload the
    same multi-hundred-megabyte GGUF in turn.

    Simulated at the seam rather than with threads, so the branch is asserted
    deterministically: the generation moves between the snapshot taken before the
    rebuild guard and the read taken inside it — which is exactly "a sibling
    finished while we were queued".
    """
    healthy = SimpleNamespace(transcribe=lambda audio, **kw: [_seg(" hello")])
    loaded = _loaded(_PoisonModel(), "t985-adopt")
    adapter = _adapter(loaded)

    generations = iter([0, 1])
    monkeypatch.setattr(whisper_cpp_asr, "_rebuild_generation", lambda _id: next(generations))

    def _must_not_construct(*_args: Any, **_kwargs: Any) -> object:
        raise AssertionError("reloaded the GGUF although a sibling had already recreated it")

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _must_not_construct)
    # The sibling's swap, which the generation bump stands for.
    loaded.model = healthy

    result = adapter(_audio(), SAMPLE_RATE)

    assert result["text"] == "hello"


def test_concurrent_decodes_on_one_context_are_still_serialized() -> None:
    """Regression guard on the fix that started all of this. Releasing the decode
    lock around the RECREATE must not have loosened the lock around the DECODE:
    two ``whisper_full`` calls on one ggml context at the same time are what
    corrupts the Metal command buffer in the first place."""
    state = SimpleNamespace(active=0, max_active=0)
    guard = threading.Lock()

    class _SlowModel:
        def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
            with guard:
                state.active += 1
                state.max_active = max(state.max_active, state.active)
            time.sleep(0.01)
            with guard:
                state.active -= 1
            return []

    loaded = _loaded(_SlowModel(), "t985-serialized")
    adapters = [_adapter(loaded), _adapter(loaded)]
    threads = [
        threading.Thread(target=lambda a=adapters[i % 2]: a(_audio(), SAMPLE_RATE))
        for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state.max_active == 1
