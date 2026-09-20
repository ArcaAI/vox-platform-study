"""TASK-994 — the row-level decode block and the per-pass thresholds actually reach whisper.cpp.

Found while building the chunk-geometry sweep (TASK-994 §2):

1. ``spec.py`` folds a row's ``decoding.{singleSegment, suppressBlank, suppressNonSpeechTokens,
   maxTokens, audioCtx}`` into ``InferenceConfig.decode_base`` — and the adapter never read that
   field, so a ROW-level recommendation was inert unless the same key was repeated inside a
   ``partial`` / ``final`` block.
2. ``spec.py`` writes the per-pass thresholds under the ENGINE spelling (``logprob_thold``,
   ``entropy_thold``, ``no_speech_thold``) and the adapter's translator only knew the WIRE
   spelling (``logprobThreshold`` …), so a per-pass threshold was dropped with a WARN.

Every test below fails on the pre-change adapter. Precedence stays the documented one:
pass block -> base block -> flat field -> neutral.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from stt.models.base_loader import LoadedModel
from stt.pipeline import spec as spec_module
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming.whisper_cpp_asr import _WIRE_TO_ENGINE_PARAM, WhisperCppAsrAdapter, _flatten_key


class _CapturingModel:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: np.ndarray, **kwargs: Any) -> list[Any]:
        self.calls.append(kwargs)
        return []


def _adapter(config: InferenceConfig, model_id: str) -> WhisperCppAsrAdapter:
    loaded = LoadedModel(
        model_id=model_id,
        model_slug=model_id,
        model=_CapturingModel(),
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/nonexistent.bin", "num_threads": 1},
    )
    return WhisperCppAsrAdapter(loaded, config, want_word_timestamps=False)


def test_row_level_decode_base_reaches_every_pass() -> None:
    config = InferenceConfig(
        decode_base={
            "single_segment": True,
            "max_tokens": 64,
            "audio_ctx": 768,
            "suppress_nst": True,
        }
    )
    adapter = _adapter(config, "t994-base")
    for pass_kind in ("partial", "final", None):
        kwargs = adapter._decode_kwargs(pass_kind)
        assert kwargs["single_segment"] is True, pass_kind
        assert kwargs["max_tokens"] == 64, pass_kind
        assert kwargs["audio_ctx"] == 768, pass_kind
        assert kwargs["suppress_nst"] is True, pass_kind


def test_pass_block_accepts_the_engine_spelling_of_the_thresholds() -> None:
    config = InferenceConfig(
        decode_final={"logprob_thold": -1.25, "entropy_thold": 2.6, "no_speech_thold": 0.4}
    )
    adapter = _adapter(config, "t994-engine-spelling")
    final = adapter._decode_kwargs("final")
    assert final["logprob_thold"] == -1.25
    assert final["entropy_thold"] == 2.6
    assert final["no_speech_thold"] == 0.4
    partial = adapter._decode_kwargs("partial")
    assert partial["logprob_thold"] == -1.0  # neutral: the block named only the final pass


def test_precedence_is_pass_over_base_over_flat() -> None:
    config = InferenceConfig(
        logprob_threshold=-1.0,
        decode_base={"logprob_thold": -1.1, "max_tokens": 32},
        decode_final={"max_tokens": 64},
    )
    adapter = _adapter(config, "t994-precedence")
    final = adapter._decode_kwargs("final")
    partial = adapter._decode_kwargs("partial")
    assert final["logprob_thold"] == -1.1 and partial["logprob_thold"] == -1.1
    assert final["max_tokens"] == 64
    assert partial["max_tokens"] == 32


def test_every_spelling_the_spec_layer_emits_is_one_the_adapter_accepts() -> None:
    """The two halves of the wire must agree, or a knob is dropped between them."""
    emitted = {engine for _wire, engine in spec_module._TASK985_DECODE_EXTRA_FIELDS}
    emitted |= {engine for _wire, engine in spec_module._TASK985_PASS_FIELDS}
    emitted.discard("beam_size")  # unsupported on whisper.cpp by design; reported, never passed
    unknown = sorted(e for e in emitted if _flatten_key(e) not in _WIRE_TO_ENGINE_PARAM)
    assert unknown == [], unknown
