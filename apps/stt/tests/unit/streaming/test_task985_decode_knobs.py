"""TASK-985 — the whisper.cpp decode call says what it means.

Three faults are pinned here, and they are one fault seen from three sides.

1. **The call was eight kwargs wide.** ``_decode_capturing`` passed
   ``extract_probability, temperature, temperature_inc, token_timestamps,
   split_on_word, max_len, language, initial_prompt`` and nothing else, although
   the module's own comment claimed "every param below is passed EXPLICITLY on
   every call, never omitted". Fourteen honoured params were omitted, each
   silently inheriting whatever was last set on a params object that pywhispercpp
   PERSISTS across calls, on a whisper context this adapter SHARES with the batch
   and english-gloss adapters. So an omitted kwarg never meant "the library
   default": it meant "whatever a sibling set last".

2. **Six configured knobs reached nothing.** ``beamSize``, the three thresholds,
   ``noRepeatNgramSize`` and ``conditionOnPrevTokens`` are resolved by the
   gateway, carried on the wire and landed on ``InferenceConfig`` — and then never
   read on this engine, while ``decoding.sources`` went on naming the tier that
   "decided" them. Two of them CAN be honoured here and now are; the rest say so.

3. **There was no per-pass decode.** A partial and a final decode the same way,
   although a partial wants a cheap bounded single-segment pass and a final wants
   the full one.

Every test below fails on the pre-change adapter, and the DEFAULT behaviour is
deliberately unchanged: every neutral value is the library's own except
``temperature_inc``, which stays at the measured 0.0 (fallback OFF).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming import whisper_cpp_asr
from stt.streaming.whisper_cpp_asr import UNSUPPORTED_SOURCE, WhisperCppAsrAdapter

SAMPLE_RATE = 16000


class _CapturingModel:
    """Fake pywhispercpp model recording the kwargs of each transcribe call."""

    def __init__(self, segments: list[Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._segments = segments or []

    def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
        self.calls.append(kwargs)
        return self._segments


def _adapter(
    model: _CapturingModel,
    config: Any,
    *,
    model_id: str,
    want_word_timestamps: bool = False,
) -> WhisperCppAsrAdapter:
    loaded = LoadedModel(
        model_id=model_id,
        model_slug=model_id,
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )
    return WhisperCppAsrAdapter(loaded, config, want_word_timestamps=want_word_timestamps)


def _audio() -> np.ndarray:
    return np.zeros(SAMPLE_RATE, dtype=np.float32)


# --- 1. Nothing is inherited -------------------------------------------------


def test_every_honoured_param_is_passed_explicitly() -> None:
    """The kwargs of every call carry the WHOLE neutral set.

    RED before the change: only ``temperature`` and ``temperature_inc`` of these
    eleven were passed, so nine params inherited a sibling adapter's value.
    """
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(), model_id="t985-explicit")

    adapter(_audio(), SAMPLE_RATE)

    kwargs = model.calls[0]
    missing = sorted(set(whisper_cpp_asr._NEUTRAL_DECODE_PARAMS) - set(kwargs))
    assert not missing, f"omitted — would inherit a sibling adapter's value: {missing}"


def test_neutral_values_are_the_librarys_own_defaults() -> None:
    """``_NEUTRAL_DECODE_PARAMS`` restates the ENGINE default, it does not invent one.

    A library bump that renames a param or moves a default must fail here rather
    than raise ``AttributeError`` inside a live decode — ``_set_params`` is a bare
    ``setattr`` loop, so an unknown name is a runtime fault, not an import fault.
    ``temperature_inc`` is the one declared departure (0.2 -> 0.0, fallback OFF),
    and it is declared so this test can keep checking everything else.
    """
    constants = pytest.importorskip("pywhispercpp.constants")
    schema = constants.PARAMS_SCHEMA

    unknown = sorted(set(whisper_cpp_asr._NEUTRAL_DECODE_PARAMS) - set(schema))
    assert not unknown, f"not params of the installed binding: {unknown}"

    for param, neutral in whisper_cpp_asr._NEUTRAL_DECODE_PARAMS.items():
        if param in whisper_cpp_asr._NEUTRAL_DEPARTURES_FROM_LIBRARY:
            continue
        assert neutral == schema[param]["default"], (
            f"{param} is not the library default; either it is a hidden hardcoded "
            "configuration value or the library changed under us"
        )


def test_temperature_fallback_stays_off() -> None:
    """``temperature_inc`` is 0.0 on every call, whatever the config says.

    whisper.cpp's default 0.2 re-decodes at rising temperature when a segment
    fails its entropy/logprob check; on the served code-switch fine-tune that was
    measured to spiral into sampled garbage rather than recover. It is the one
    deliberate departure from the library default and it must not drift back.
    """
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(), model_id="t985-nofallback")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["temperature_inc"] == 0.0


def test_audio_ctx_defaults_to_the_full_encoder_context() -> None:
    """``audio_ctx`` is 0 (full 1500 frames), not a truncated 768.

    Truncating below the trained encoder context is a documented cause of endless
    token repetition, and repetition is already this pipeline's dominant error
    class — so the ~2x encoder speedup is a measured arm on a row, never the
    default. A row that wants it says so.
    """
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(), model_id="t985-audioctx")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["audio_ctx"] == 0


def test_engine_side_context_carry_is_pinned_off() -> None:
    """``no_context`` is passed True: whisper.cpp must not carry its OWN
    ``prompt_past`` across calls on a context shared with sibling adapters, which
    would bleed one session's decoded text into another's prompt. Our carry-forward
    travels inside ``initial_prompt`` and is unaffected."""
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(), model_id="t985-nocontext")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["no_context"] is True


# --- 2. The knobs that DO reach the engine ----------------------------------


def test_logprob_and_no_speech_thresholds_reach_the_engine() -> None:
    """Two knobs that were already resolved, already cascaded and already on the
    config — and simply never read by this adapter. RED before the change: the
    keys were absent from the call."""
    model = _CapturingModel()
    config = InferenceConfig(logprob_threshold=-1.25, no_speech_threshold=0.45)
    adapter = _adapter(model, config, model_id="t985-thresholds")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["logprob_thold"] == -1.25
    assert model.calls[0]["no_speech_thold"] == 0.45


def test_entropy_threshold_is_its_own_knob() -> None:
    """``entropyThreshold`` is a DISTINCT field, never an alias of
    ``compressionRatioThreshold``."""
    model = _CapturingModel()
    config = SimpleNamespace(language=None, entropy_threshold=2.6)
    adapter = _adapter(model, config, model_id="t985-entropy")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["entropy_thold"] == 2.6


def test_temperature_takes_the_base_rung_of_the_ladder() -> None:
    """``InferenceConfig.temperature`` is a LIST because faster-whisper takes a
    fallback ladder. whisper.cpp takes a scalar, so only the base rung is
    expressible — and with ``temperature_inc`` at 0.0 that is the whole decode.
    The dataclass default ladder starts at 0.0, which is exactly the value this
    adapter used to hardcode, so nothing moves by default."""
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(), model_id="t985-temp-default")
    adapter(_audio(), SAMPLE_RATE)
    assert model.calls[0]["temperature"] == 0.0

    model2 = _CapturingModel()
    adapter2 = _adapter(model2, InferenceConfig(temperature=[0.2]), model_id="t985-temp-row")
    adapter2(_audio(), SAMPLE_RATE)
    assert model2.calls[0]["temperature"] == 0.2


# --- 3. The knobs that do NOT, and now say so -------------------------------


def test_unsupported_knobs_are_named_not_silently_dropped() -> None:
    """A greedy whisper context cannot beam-search (the sampling strategy is frozen
    at construction), whisper.cpp has no compression-ratio gate and no n-gram
    block. The seeded ml-en agent sets ``beamSize: 5`` and the config defaults
    carry the other two, so all three are configured on every session — and were
    dropped without a word while ``sources`` named a tier that decided them.

    RED before the change: the attribute did not exist.
    """
    model = _CapturingModel()
    adapter = _adapter(model, InferenceConfig(beam_size=5), model_id="t985-unsupported")

    assert adapter.unsupported_decode_knobs == {
        "beamSize": UNSUPPORTED_SOURCE,
        "compressionRatioThreshold": UNSUPPORTED_SOURCE,
        "noRepeatNgramSize": UNSUPPORTED_SOURCE,
    }


def test_compression_ratio_threshold_is_never_aliased_to_entropy() -> None:
    """The trap this test exists for: the two share the default 2.4 and
    pywhispercpp's own text calls entropy_thold "similar to OpenAI's
    compression_ratio_threshold". They are different quantities gating in OPPOSITE
    directions — OpenAI's rejects ABOVE the threshold on the gzip ratio of the
    decoded text, whisper.cpp's rejects BELOW it on token entropy. A row that sets
    one must never silently get the other."""
    model = _CapturingModel()
    config = InferenceConfig(compression_ratio_threshold=1.8)
    adapter = _adapter(model, config, model_id="t985-no-alias")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["entropy_thold"] == 2.4  # the neutral, untouched
    assert adapter.unsupported_decode_knobs["compressionRatioThreshold"] == UNSUPPORTED_SOURCE


def test_condition_on_prev_tokens_is_unsupported_only_when_asked_for() -> None:
    """Silence is not an opinion. The knob is reported unsupported when a tier
    actually turned it ON — mapping it onto ``no_context`` would enable engine-side
    context carry on a SHARED whisper context, which is a cross-session prompt
    leak, so it is refused rather than aliased."""
    quiet = _adapter(_CapturingModel(), InferenceConfig(), model_id="t985-cond-off")
    assert "conditionOnPrevTokens" not in quiet.unsupported_decode_knobs

    asked = _adapter(
        _CapturingModel(),
        InferenceConfig(condition_on_prev_tokens=True),
        model_id="t985-cond-on",
    )
    assert asked.unsupported_decode_knobs["conditionOnPrevTokens"] == UNSUPPORTED_SOURCE


# --- 4. Per-pass decode blocks ----------------------------------------------


def test_partial_and_final_get_their_own_kwargs() -> None:
    """A partial may bound itself at the decoder (upstream's own streaming example
    ships ``max_tokens = 32``) and force one segment; a final may legitimately span
    sentences and takes no cap. RED before the change: ``__call__`` had no
    ``pass_kind`` parameter at all."""
    model = _CapturingModel()
    config = SimpleNamespace(
        language=None,
        decode_partial={"singleSegment": True, "maxTokens": 32, "suppressNonSpeechTokens": True},
        decode_final={"singleSegment": False, "maxTokens": 0},
    )
    adapter = _adapter(model, config, model_id="t985-pass")

    adapter(_audio(), SAMPLE_RATE, pass_kind="partial")
    adapter(_audio(), SAMPLE_RATE, pass_kind="final")

    partial, final = model.calls
    assert partial["single_segment"] is True
    assert partial["max_tokens"] == 32
    assert partial["suppress_nst"] is True
    assert final["single_segment"] is False
    assert final["max_tokens"] == 0
    # A pass that says nothing about a knob inherits the flat/neutral value, not
    # the OTHER pass's value.
    assert final["suppress_nst"] is False


def test_pass_block_narrows_the_flat_block() -> None:
    """Precedence is pass -> flat -> neutral, and only that."""
    model = _CapturingModel()
    config = SimpleNamespace(
        language=None,
        logprob_threshold=-1.0,
        decode_final={"logprobThreshold": -1.25},
    )
    adapter = _adapter(model, config, model_id="t985-narrow")

    adapter(_audio(), SAMPLE_RATE, pass_kind="partial")
    adapter(_audio(), SAMPLE_RATE, pass_kind="final")

    assert model.calls[0]["logprob_thold"] == -1.0  # flat block
    assert model.calls[1]["logprob_thold"] == -1.25  # pass block wins


def test_absent_pass_kind_decodes_at_the_flat_block() -> None:
    """Every caller that predates the parameter keeps its behaviour exactly."""
    model = _CapturingModel()
    config = SimpleNamespace(language=None, decode_partial={"maxTokens": 32})
    adapter = _adapter(model, config, model_id="t985-nopass")

    adapter(_audio(), SAMPLE_RATE)

    assert model.calls[0]["max_tokens"] == 0


@pytest.mark.parametrize("spelling", ["maxTokens", "max_tokens", "MAX_TOKENS"])
def test_pass_block_keys_resolve_in_either_spelling(spelling: str) -> None:
    """The wire spells camelCase and the Python spec layer spells snake_case.
    Neither should be able to silently miss."""
    model = _CapturingModel()
    config = SimpleNamespace(language=None, decode_partial={spelling: 48})
    adapter = _adapter(model, config, model_id=f"t985-spelling-{spelling}")

    adapter(_audio(), SAMPLE_RATE, pass_kind="partial")

    assert model.calls[0]["max_tokens"] == 48


def test_unusable_pass_block_keys_are_dropped_never_forwarded() -> None:
    """Every kwarg this adapter passes is ``setattr``-ed straight onto a native
    params struct, where an unknown name or a wrong type is a crash rather than an
    error. An unrecognised key and a mistyped value are therefore dropped — and the
    rest of the block still applies."""
    model = _CapturingModel()
    config = SimpleNamespace(
        language=None,
        decode_partial={"maxTokens": "thirty-two", "notAKnob": 1, "singleSegment": True},
    )
    adapter = _adapter(model, config, model_id="t985-rejected")

    adapter(_audio(), SAMPLE_RATE, pass_kind="partial")

    kwargs = model.calls[0]
    assert kwargs["max_tokens"] == 0  # mistyped -> neutral
    assert "notAKnob" not in kwargs
    assert kwargs["single_segment"] is True  # the usable key still applied


def test_a_pass_may_turn_word_timestamps_off_but_never_on() -> None:
    """Narrowing only. A partial can skip the word-split decode to save the
    timestamp-token machinery; a pass block must NOT be able to re-enable a mode
    ``__init__`` refused because the decode may emit a script that word-splitting
    corrupts."""
    model = _CapturingModel()
    config = SimpleNamespace(
        language="en",
        decode_partial={"wordTimestamps": False},
    )
    adapter = _adapter(model, config, model_id="t985-wts-off", want_word_timestamps=True)

    adapter(_audio(), SAMPLE_RATE, pass_kind="partial")
    adapter(_audio(), SAMPLE_RATE, pass_kind="final")

    assert model.calls[0]["max_len"] == 0
    assert model.calls[0]["split_on_word"] is False
    assert model.calls[1]["max_len"] == 1  # the final still gets them

    # ...and the refusal cannot be undone from a row.
    refused = _adapter(
        _CapturingModel(),
        SimpleNamespace(language="ml-en", decode_partial={"wordTimestamps": True}),
        model_id="t985-wts-on",
        want_word_timestamps=True,
    )
    assert refused._word_timestamps_for("partial") is False
