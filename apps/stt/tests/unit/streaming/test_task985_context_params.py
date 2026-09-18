"""TASK-985 (M-62, and N-6 on the other engine) — construction-time knobs.

Two small things that had nowhere to live.

**flash_attn is a whisper.cpp CONTEXT parameter, not a decode kwarg.** It is set
on ``whisper_context_params`` when the context is built, so the streaming adapter
— which only ever calls ``transcribe`` — cannot reach it at all. The CUDA image
already builds the flash-attention kernel, and whisper.cpp's own CLI now defaults
it ON, but this runtime never passed the field, so the row could not ask for it.
It is now a ROW-level knob with no default of our own: absent means the row has no
opinion and whisper.cpp's ``whisper_context_default_params()`` stands, which is
also why "is it already on?" stays a measurement rather than an assumption here.

The trap this closes twice over: the loader and the streaming adapter build the
SAME context from two independently-maintained kwarg dicts, and the adapter's is
the RECOVERY path. A context param applied at load and dropped on the rebuild
means the unhappy path quietly runs a configuration nobody chose — so the loader
records what it used and the recovery replays it.

**no_repeat_ngram_size reached neither engine.** whisper.cpp genuinely has no such
parameter (``whisper_full_params`` carries no n-gram-block or repetition-penalty
field), which is why its loop guard has to be a post-hoc string collapse. CTranslate2
does have it, and ``faster_whisper_asr`` simply never forwarded it although the
value was resolved, carried and landed on the config.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.models.whisper_cpp_loader import WhisperCppLoader
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming import whisper_cpp_asr
from stt.streaming.faster_whisper_asr import FasterWhisperAsrAdapter
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000


def _seg(text: str) -> SimpleNamespace:
    return SimpleNamespace(text=text, t0=0, t1=50, probability=0.9)


# --- flash_attn is a row-level knob, with no default of ours ----------------


def test_a_row_that_says_nothing_declares_no_context_params() -> None:
    """Absent is not False. A row with no opinion must leave whisper.cpp's own
    context defaults standing rather than have this file pick one."""
    assert WhisperCppLoader._row_context_params(SimpleNamespace()) == {}
    assert WhisperCppLoader._row_context_params(SimpleNamespace(flash_attn=None)) == {}


@pytest.mark.parametrize("declared", [True, False])
def test_a_row_that_declares_flash_attn_is_honoured(declared: bool) -> None:
    """Including an explicit ``false``: a row that has measured the kernel to be
    worse for it must be able to say so, and that is not the same as silence."""
    resolved = WhisperCppLoader._row_context_params(SimpleNamespace(flash_attn=declared))
    assert resolved == {"flash_attn": declared}


def test_use_gpu_is_not_a_row_context_param() -> None:
    """``use_gpu`` is derived from the row's DEVICE by the loader and stamped on
    ``LoadedModel.device``, which is a billing input (cuda/mps -> GPU_SECOND). A
    row able to set it independently could bill GPU seconds for a CPU run."""
    resolved = WhisperCppLoader._row_context_params(
        SimpleNamespace(flash_attn=True, use_gpu=False)
    )
    assert "use_gpu" not in resolved


# --- ...and the recovery path builds the SAME context -----------------------


def test_the_recreate_replays_the_context_params_the_loader_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """RED before the change: the rebuild passed ``{"use_gpu": ...}`` and nothing
    else, so a recovered context silently lost the row's construction-time knobs."""
    captured: dict[str, Any] = {}

    def _construct(
        model_path: str,
        num_threads: int | None,
        use_gpu: bool,
        context_params: dict[str, Any] | None = None,
    ) -> object:
        captured["context_params"] = context_params
        return SimpleNamespace(transcribe=lambda audio, **kw: [_seg(" hello")])

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _construct)

    class _PoisonModel:
        def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
            whisper_cpp_asr._dispatch_log(2, "whisper_full_with_state: failed to encode\n")
            return []

    loaded = LoadedModel(
        model_id="t985-ctx-replay",
        model_slug="t985-ctx-replay",
        model=_PoisonModel(),
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={
            "model_path": "/weights/model.gguf",
            "num_threads": 4,
            "context_params": {"flash_attn": True},
        },
    )
    adapter = WhisperCppAsrAdapter(loaded, SimpleNamespace(language=None))

    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)

    assert captured["context_params"] == {"flash_attn": True}


def test_an_undeclared_context_omits_the_argument_entirely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row with no opinion must not turn into ``context_params={}`` travelling
    down the call — the argument is simply not passed, so the library's own
    defaults apply and an older test seam taking three positional arguments still
    works."""
    seen: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def _construct(*args: Any, **kwargs: Any) -> object:
        seen.append((args, kwargs))
        return SimpleNamespace(transcribe=lambda audio, **kw: [_seg(" hello")])

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _construct)

    class _PoisonModel:
        def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
            whisper_cpp_asr._dispatch_log(2, "whisper_full_with_state: failed to encode\n")
            return []

    loaded = LoadedModel(
        model_id="t985-ctx-absent",
        model_slug="t985-ctx-absent",
        model=_PoisonModel(),
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )
    adapter = WhisperCppAsrAdapter(loaded, SimpleNamespace(language=None))

    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)

    args, kwargs = seen[0]
    assert len(args) == 3
    assert "context_params" not in kwargs


# --- the CT2 half of the same knob-honesty rule -----------------------------


class _FakeWhisperModel:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    def transcribe(self, audio: np.ndarray, **kwargs: Any) -> tuple[list[Any], Any]:
        self.kwargs = kwargs
        return [], SimpleNamespace(language="en")


def _ct2_adapter(config: Any) -> tuple[FasterWhisperAsrAdapter, _FakeWhisperModel]:
    model = _FakeWhisperModel()
    loaded = LoadedModel(
        model_id="t985-ct2",
        model_slug="t985-ct2",
        model=model,
        format=AiModelFormat.FASTER_WHISPER,
        device="cpu",
        extra={},
    )
    return FasterWhisperAsrAdapter(loaded, config), model


def test_no_repeat_ngram_size_reaches_ctranslate2() -> None:
    """RED before the change: the key was absent, so CT2 decoded at its own 0
    while the config declared 3 and ``sources`` named the tier that "chose" it.
    This is the decoder-level anti-repetition device whisper.cpp does not have."""
    adapter, model = _ct2_adapter(InferenceConfig(no_repeat_ngram_size=4))

    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)

    assert model.kwargs["no_repeat_ngram_size"] == 4


def test_zero_still_means_off() -> None:
    """``0`` is the wire's "disabled" and must survive as a real forwarded value,
    not be read as absence."""
    adapter, model = _ct2_adapter(InferenceConfig(no_repeat_ngram_size=0))

    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)

    assert model.kwargs["no_repeat_ngram_size"] == 0


def test_the_unsupported_map_is_per_engine_not_per_key() -> None:
    """The same wire block means a different set of live knobs on each adapter, so
    the refusal has to be reported per ENGINE. CT2 honours the compression-ratio
    gate and has no entropy gate; whisper.cpp is the exact mirror image."""
    adapter, _ = _ct2_adapter(SimpleNamespace(language=None, entropy_threshold=2.6))
    assert adapter.unsupported_decode_knobs == {"entropyThreshold": "unsupported:faster-whisper"}

    quiet, _ = _ct2_adapter(InferenceConfig())
    assert quiet.unsupported_decode_knobs == {}
