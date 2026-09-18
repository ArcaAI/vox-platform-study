"""TASK-985 (D4-N6) — the clean whisper.cpp decode stops discarding its timestamps.

``pywhispercpp``'s ``Model.transcribe()`` returns ``Segment(t0, t1, text,
probability)`` — the adapter's own module docstring has always said so — and
``_build_result``'s clean-decode branch threw every one of those timings away
three lines before use, emitting ONE synthetic span ``{text, 0.0, duration}``
over the whole buffer with ``word_timestamps: []``. ``_merge_results`` repeated it
on both the single- and multi-span paths.

That mattered most on the model HOPE actually serves. Word timestamps are
(correctly) REFUSED for the ml-en code-switch pair, because the ``max_len=1``
word-splitting technique shatters Malayalam grapheme clusters — a word-level
LocalAgreement over these clips scored CER ~0.59 against ~0.32 for the shipped
path. So on the served engine the clean decode was the only decode, and it
answered with no usable time anywhere: every timestamp-anchored consumer
downstream (incremental commit, timestamp-guided buffer trimming, per-segment
confidence gating, diarization alignment) was blocked on data the engine had
already returned and paid for.

The fix is to emit what came back, and NOTHING else: the clean decode is
unchanged — no ``max_len=1``, no word splitting, no second pass — and the
utterance ``text`` is byte-identical to what this adapter produced before.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000


def _seg(text: str, t0: int, t1: int, probability: float = 0.9) -> SimpleNamespace:
    """A pywhispercpp ``Segment``. ``t0``/``t1`` are whisper.cpp's raw 10 ms units."""
    return SimpleNamespace(text=text, t0=t0, t1=t1, probability=probability)


def _adapter(segments: list[Any], *, model_id: str, language: str | None = "ml-en"):
    model = SimpleNamespace(transcribe=lambda audio, **kw: segments)
    loaded = LoadedModel(
        model_id=model_id,
        model_slug=model_id,
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )
    return WhisperCppAsrAdapter(loaded, SimpleNamespace(language=language))


def _audio(seconds: float = 1.0) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def test_clean_decode_emits_one_entry_per_whisper_segment() -> None:
    """RED before the change: ONE entry, ``{whole text, 0.0, duration}``."""
    adapter = _adapter(
        [_seg(" Hello there", 0, 120, 0.91), _seg(" doctor", 120, 180, 0.77)],
        model_id="t985-seg-basic",
    )

    result = adapter(_audio(3.0), SAMPLE_RATE)

    assert result["segments"] == [
        {"text": "Hello there", "start": 0.0, "end": 1.2, "probability": 0.91},
        {"text": "doctor", "start": 1.2, "end": 1.8, "probability": 0.77},
    ]


def test_the_transcript_itself_is_unchanged() -> None:
    """The whole point of keeping the CLEAN decode: Malayalam is rebuilt by NATIVE
    concatenation of segment text, never space-joined, and the segment spans are
    additive to that — they do not change a character of it."""
    adapter = _adapter(
        [_seg("നമസ്കാരം", 0, 60), _seg(" ഡോക്ടർ", 60, 90)],
        model_id="t985-seg-malayalam",
    )

    result = adapter(_audio(1.0), SAMPLE_RATE)

    assert result["text"] == "നമസ്കാരം ഡോക്ടർ"
    assert result["word_timestamps"] == []  # still no word timings in clean mode
    assert [s["text"] for s in result["segments"]] == ["നമസ്കാരം", "ഡോക്ടർ"]
    assert [s["start"] for s in result["segments"]] == [0.0, 0.6]


def test_a_silent_decode_still_reports_no_segments() -> None:
    """Empty text means nothing was said. It must not become a zero-length span
    that a commit policy would treat as a unit."""
    adapter = _adapter([], model_id="t985-seg-silent")

    result = adapter(_audio(1.0), SAMPLE_RATE)

    assert result["text"] == ""
    assert result["segments"] == []


def test_blank_segments_are_dropped() -> None:
    """whisper emits a stray punctuation-only or whitespace-only segment often
    enough that it must not become a phantom commit unit."""
    adapter = _adapter(
        [_seg(" ", 0, 10), _seg(",", 10, 20), _seg(" Hello", 20, 60)],
        model_id="t985-seg-blank",
    )

    result = adapter(_audio(1.0), SAMPLE_RATE)

    assert [s["text"] for s in result["segments"]] == ["Hello"]


def test_probability_degrades_to_unknown_not_to_zero() -> None:
    """``Segment.probability`` is NaN when ``extract_probability`` did not run. A
    missing confidence reads as "unknown", never as "certainly wrong" — 0.0 would
    make a downstream confidence gate drop good text."""
    adapter = _adapter(
        [_seg(" Hello", 0, 60, float("nan")), _seg(" there", 60, 90, None)],
        model_id="t985-seg-nan",
    )

    result = adapter(_audio(1.0), SAMPLE_RATE)

    assert [s["probability"] for s in result["segments"]] == [1.0, 1.0]


def test_merged_spans_carry_buffer_relative_times() -> None:
    """The single easiest thing to get wrong. whisper.cpp times EVERY decode from
    zero, so a long utterance split into spans returns several segments all
    starting at 0.0. Merging must shift each span's segments by that span's own
    start, or a consumer reading them as one timeline sees time run backwards.

    Exercised directly on ``_merge_results`` so the geometry is asserted without
    depending on where the silence-trough splitter happens to cut.
    """
    adapter = _adapter([], model_id="t985-seg-merge")
    sub_results = [
        {
            "text": "first span",
            "language": None,
            "word_timestamps": [],
            "segments": [{"text": "first span", "start": 0.0, "end": 2.5, "probability": 0.9}],
        },
        {
            "text": "second span",
            "language": None,
            "word_timestamps": [],
            "segments": [
                {"text": "second", "start": 0.0, "end": 1.0, "probability": 0.8},
                {"text": "span", "start": 1.0, "end": 2.0, "probability": 0.7},
            ],
        },
    ]
    spans = [(0, 3 * SAMPLE_RATE), (3 * SAMPLE_RATE, 6 * SAMPLE_RATE)]

    merged = adapter._merge_results(sub_results, spans, _audio(6.0), SAMPLE_RATE)

    assert merged["text"] == "first span second span"
    assert merged["segments"] == [
        {"text": "first span", "start": 0.0, "end": 2.5, "probability": 0.9},
        {"text": "second", "start": 3.0, "end": 4.0, "probability": 0.8},
        {"text": "span", "start": 4.0, "end": 5.0, "probability": 0.7},
    ]
    # Monotone, non-overlapping, and ordered — what a commit policy relies on.
    starts = [s["start"] for s in merged["segments"]]
    assert starts == sorted(starts)


def test_word_timestamp_mode_still_reports_one_coarse_envelope() -> None:
    """Untouched. When word timings ARE available they are the anchor, and the
    single span around them is the envelope it has always been — this change is
    about the branch that had no anchor at all."""
    adapter = _adapter(
        [_seg("Hello", 0, 40), _seg("there", 40, 80)],
        model_id="t985-seg-words",
        language="en",
    )
    adapter._want_word_timestamps = True

    result = adapter(_audio(1.0), SAMPLE_RATE)

    assert result["text"] == "Hello there"
    assert len(result["word_timestamps"]) == 2
    assert result["segments"] == [{"text": "Hello there", "start": 0.0, "end": 0.8}]
