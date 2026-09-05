"""Unit tests for the whisper.cpp streaming adapter — concurrency
serialization and Metal-backend poison recovery.

Regression coverage for the "backend is in error state from a previous
command buffer failure" fault: concurrent decodes on one shared ggml/Metal
context corrupt its command buffer, after which every ``whisper_full`` returns
zero segments (empty text) forever. The adapter must (1) serialize decodes on a
shared context and (2) detect the poisoned state and recreate the backend.
"""

from __future__ import annotations

import sys
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming import whisper_cpp_asr
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter


def _loaded_model(model: object, model_id: str = "m1") -> LoadedModel:
    return LoadedModel(
        model_id=model_id,
        model_slug="whisper-large-v3-turbo",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )


def _cfg(language: str | None = None, max_decode_window_sec: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(language=language, max_decode_window_sec=max_decode_window_sec)


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


# --- Language pinning: single pinned, code-switch pair unpinned (auto) --------


def test_default_no_language_and_no_prompt() -> None:
    """No configured language + prompt OFF by default → clean decode with
    ``language`` explicitly neutral (None → binding auto-detect) and
    ``initial_prompt`` explicitly empty. The kwargs must be PRESENT: pywhispercpp
    persists params across calls on the shared context, so an omitted kwarg
    would inherit whatever a sibling adapter set last."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg())

    adapter(_audio(), 16000)

    assert model.calls[0]["language"] is None
    assert model.calls[0]["initial_prompt"] == ""


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

    assert model.calls[0]["language"] is None


# --- Prompt: ONE channel, the agent's (TASK-880) ------------------------------


def test_no_prompt_decodes_with_the_binding_neutral() -> None:
    """No caller prompt → ``initial_prompt`` is explicitly empty (the binding rejects
    None, and the shared context persists params across calls, so it must be PRESENT)."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000)
    assert model.calls[0]["initial_prompt"] == ""


def test_the_callers_prompt_is_passed_verbatim() -> None:
    """The adapter adds nothing of its own. TASK-880 deleted the language-derived
    consultation line and the `stt.whisperCpp.consultationPromptEnabled` flag that gated
    it: the agent's `instruction.initialPrompt`, already composed with the per-utterance
    carry-forward by the caller, is the whole prompt — never a platform line prepended to
    it, and never the agent's own instruction applied twice."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))

    adapter(_audio(), 16000, prompt="Clinical consultation. previous transcript text")
    assert model.calls[0]["initial_prompt"] == "Clinical consultation. previous transcript text"


def test_the_decode_window_comes_from_the_model_row_not_a_platform_setting() -> None:
    """`InferenceConfig.max_decode_window_sec` carries
    `ResolvedAsrSpec.models.asr.metadata.maxDecodeWindowSec`; a row that declares none
    disables the split guard rather than inheriting another engine's window."""
    model = _CapturingModel()
    assert WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml", 7.0))._max_audio_seconds == 7.0
    assert WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml"))._max_audio_seconds == 0.0
    # A config predating the field (the deprecated pipeline path) must not explode.
    assert WhisperCppAsrAdapter(_loaded_model(model), SimpleNamespace(language="ml"))._max_audio_seconds == 0.0


# --- Decode mode: clean (default) vs word-timestamp -------------------------


def test_clean_decode_passes_neutral_word_split_kwargs() -> None:
    """Default (no word timestamps requested) → clean sentence-level decode:
    the ``max_len``/``split_on_word``/``token_timestamps`` params are passed
    EXPLICITLY at their neutral values. Omitting them would let a sibling
    adapter's word-split settings (``max_len=1``) leak into this decode via the
    shared, param-persisting whisper context."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("ml-en"))

    adapter(_audio(), 16000)

    kw = model.calls[0]
    assert kw["max_len"] == 0
    assert kw["split_on_word"] is False
    assert kw["token_timestamps"] is False


@pytest.mark.parametrize("want_word_ts", [False, True])
def test_leak_prone_params_always_passed_explicitly(want_word_ts: bool) -> None:
    """Every param the adapter relies on at a neutral/auto value must be in the
    kwargs of EVERY transcribe call, in both decode modes — pywhispercpp's
    ``_set_params`` only setattrs the kwargs it receives, and the params object
    persists across calls on a context shared with the batch/gloss adapters."""
    model = _CapturingModel()
    adapter = WhisperCppAsrAdapter(
        _loaded_model(model), _cfg("ml-en"), want_word_timestamps=want_word_ts
    )

    adapter(_audio(), 16000)

    kw = model.calls[0]
    for key in ("language", "initial_prompt", "token_timestamps", "split_on_word", "max_len"):
        assert key in kw, f"{key} omitted — would inherit a sibling adapter's value"


def test_word_timestamp_mode_splits_and_space_joins() -> None:
    """When word timestamps ARE requested: word-split decode is used, per-word
    timings are emitted, and the transcript is SPACE-joined (correct for the
    space-trimmed word segments)."""
    model = _CapturingModel_returning([_seg("Hello", 0, 40, 0.9), _seg("there", 40, 80, 0.8)])
    adapter = WhisperCppAsrAdapter(_loaded_model(model), _cfg("en"), want_word_timestamps=True)

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
        ("അത് അത് അത് അത് അത് അത്", "അത്"),  # spaced degenerate loop -> one
        ("ക്രക്രക്രക്രക്രക്ര", "ക്ര"),  # NO-space Malayalam loop -> one
        ("നല്ലത് ക്രക്രക്രക്രക്ര വരും", "നല്ലത് ക്ര വരും"),  # loop inside real text
        ("no no no", "no no no"),  # genuine triple survives (run == limit)
        ("the patient has a fever", "the patient has a fever"),  # normal untouched
        ("", ""),
    ],
)
def test_collapse_repeats_loop_guard(text: str, expected: str) -> None:
    assert whisper_cpp_asr._collapse_repeats(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (", ഞാൻ നേരത്തെ", "ഞാൻ നേരത്തെ"),  # strip whisper's leading comma
        (". അപ്പോ ഇത്", "അപ്പോ ഇത്"),  # leading period
        ("Hello there,", "Hello there"),  # trailing comma
        ("ഒരു അത് അത് അത് അത് അത്", "ഒരു അത്"),  # loop-guard still runs via _polish
        # U+FFFD: whisper.cpp split a multi-byte char across segments — the marker
        # is never meaningful text and must not reach the transcript.
        ("ചെയ്യുന്നതി�", "ചെയ്യുന്നതി"),
    ],
)
def test_polish_strips_edge_junk_and_collapses(text: str, expected: str) -> None:
    assert whisper_cpp_asr._polish(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Verbatim from a live compat session: a 3-token phrase looping 3x.
        (
            "muscle development ചെയ്യുന്നതിന് നമുക്ക് protein ചെയ്യുന്നതിന് നമുക്ക് "
            "protein ചെയ്യുന്നതിന് നമുക്ക് protein",
            "muscle development ചെയ്യുന്നതിന് നമുക്ക് protein",
        ),
        # 2-token phrase looping.
        (
            "പലതാരം പ്രധാനമായിട്ട് പലതാരം പ്രധാനമായിട്ട് കൂടുതൽ",
            "പലതാരം പ്രധാനമായിട്ട് കൂടുതൽ",
        ),
        # Must NOT damage legitimate text (no back-to-back phrase repeat).
        (
            "protein powder and gym കാര്യങ്ങളൊക്കെ ചെയ്യുന്നുണ്ട്",
            "protein powder and gym കാര്യങ്ങളൊക്കെ ചെയ്യുന്നുണ്ട്",
        ),
        # A doubled SINGLE token is natural speech — left alone.
        ("പറയുന്ന പറയുന്ന പോകുന്നത്", "പറയുന്ന പറയുന്ന പോകുന്നത്"),
    ],
)
def test_phrase_level_loop_guard(text: str, expected: str) -> None:
    """Greedy decoding loops on multi-word PHRASES, which neither the
    single-token run guard nor the character guard can see."""
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
        threading.Thread(target=call, args=(adapter_a if i % 2 else adapter_b,)) for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state.max_active == 1


def test_recovers_from_poisoned_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """When whisper.cpp logs a poison marker and returns no segments, the
    adapter recreates the context in place and retries once."""

    healthy = SimpleNamespace(transcribe=lambda audio, **kw: [_seg("hello", 0, 50, 0.9)])

    rebuilt = SimpleNamespace(count=0)

    def _fake_construct(path: str, n_threads: int, use_gpu: bool) -> object:
        rebuilt.count += 1
        return healthy

    monkeypatch.setattr(whisper_cpp_asr, "_construct_whisper_model", _fake_construct)

    class _PoisonModel:
        def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
            # Mimic whisper.cpp's native log on a poisoned Metal backend.
            whisper_cpp_asr._dispatch_log(2, "whisper_full_with_state: failed to encode\n")
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


# --- Native log-callback teardown (interpreter-shutdown safety) ---------------
#
# ``whisper_log_set`` parks ``_dispatch_log`` in a pybind11 static inside
# ``_pywhispercpp``. That static is destroyed by ``__cxa_finalize_ranges`` at
# ``exit()`` — AFTER ``Py_Finalize`` — so the trailing ``Py_DECREF`` runs with no
# thread state and aborts the process ("PyThreadState_Get: ... the GIL is
# released", ``Abort trap: 6``, exit 134) on an otherwise fully green run. The
# adapter must therefore hand the callback back while the interpreter is alive.


def test_install_registers_atexit_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    """Installing the log sink must also arm an ``atexit`` teardown."""

    calls: list[object] = []
    registered: list[object] = []
    fake_pw = SimpleNamespace(whisper_log_set=calls.append)

    monkeypatch.setitem(sys.modules, "_pywhispercpp", fake_pw)
    monkeypatch.setattr(whisper_cpp_asr, "_log_installed", False)
    monkeypatch.setattr(whisper_cpp_asr, "_log_module", None)
    monkeypatch.setattr(whisper_cpp_asr.atexit, "register", registered.append)

    whisper_cpp_asr._ensure_log_capture_installed()

    assert calls == [whisper_cpp_asr._dispatch_log]
    assert whisper_cpp_asr._log_module is fake_pw
    assert whisper_cpp_asr._uninstall_log_capture in registered


def test_uninstall_releases_the_python_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Teardown hands the sink back to whisper.cpp's default logger, dropping
    the extension's reference to ``_dispatch_log``."""

    calls: list[object] = []
    fake_pw = SimpleNamespace(whisper_log_set=calls.append)
    monkeypatch.setattr(whisper_cpp_asr, "_log_module", fake_pw)

    whisper_cpp_asr._uninstall_log_capture()

    assert calls == [None]


def test_uninstall_is_a_noop_when_never_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    """No registration means nothing to release — teardown must not import or
    touch the extension."""

    monkeypatch.setattr(whisper_cpp_asr, "_log_module", None)

    whisper_cpp_asr._uninstall_log_capture()  # must not raise


def test_uninstall_swallows_extension_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failure during teardown must never change the process exit status."""

    def _boom(_callback: object) -> None:
        raise RuntimeError("extension already torn down")

    monkeypatch.setattr(whisper_cpp_asr, "_log_module", SimpleNamespace(whisper_log_set=_boom))

    whisper_cpp_asr._uninstall_log_capture()  # must not raise
