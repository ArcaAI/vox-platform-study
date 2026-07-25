"""Preprocessor ↔ semantic-endpointer integration.

Proves the safety-critical contract at the silence→final cut
(``preprocessor.py`` ``_min_silence_frames`` gate):

* a complete turn cuts EARLIER than the fixed silence timer (latency win);
* a mid-utterance pause NEVER cuts early (no truncation — the guardrail);
* a disabled/absent endpointer reproduces the EXACT fixed-offset behavior;
* the ``force_emit_after_ms`` oversize cap still fires;
* an endpointer error degrades to the fixed timer (feed never crashes).

All hermetic: a mocked VAD drives speech/silence by frame, and the endpointer is
either a tiny stub or the real (model-free) ``SemanticEndpointer``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from stt.pipeline.dto import EndpointConfig
from stt.streaming.preprocessor import StreamingPreprocessor
from stt.streaming.semantic_endpointer import EndpointDecision, SemanticEndpointer

_FRAME_MS = 32.0  # 512 samples @ 16 kHz


def _frames_pcm(n_frames: int, sample_rate: int = 16000) -> bytes:
    """PCM bytes covering exactly ``n_frames`` VAD frames (content irrelevant —
    the mocked VAD decides speech/silence by call count)."""
    return np.zeros(n_frames * 512, dtype=np.int16).tobytes()


def _pattern_vad(*, segments: list[tuple[float, int]]) -> Any:
    """Mock VAD returning ``prob`` for ``count`` frames per segment, then 0.0."""
    from unittest.mock import MagicMock

    schedule: list[float] = []
    for prob, count in segments:
        schedule.extend([prob] * count)

    idx = {"i": 0}

    def _process_chunk(chunk: Any, session_state: Any, threshold: float | None = None) -> float:
        i = idx["i"]
        idx["i"] += 1
        return schedule[i] if i < len(schedule) else 0.0

    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(side_effect=_process_chunk)
    return svc


class _StubEndpointer:
    """Minimal endpointer stub to isolate the preprocessor wiring."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        cut_at_silence_ms: float | None = None,
        raises: bool = False,
    ) -> None:
        self.enabled = enabled
        self._cut_at = cut_at_silence_ms
        self._raises = raises
        self.observed: list[str] = []
        self.reset_count = 0

    def observe_hypothesis(self, text: str) -> None:
        self.observed.append(text)

    def reset(self) -> None:
        self.reset_count += 1

    def decide(self, *, trailing_silence_ms: float, min_silence_ms: float) -> EndpointDecision:
        if self._raises:
            raise RuntimeError("boom")
        should = self._cut_at is not None and trailing_silence_ms >= self._cut_at
        return EndpointDecision(should, 1.0 if should else 0.0, "stub")


def _finals(utts: list[Any]) -> list[Any]:
    return [u for u in utts if u.is_final]


# ---------------------------------------------------------------------------
# Latency win — cut earlier than the fixed silence timer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpointer_cuts_earlier_than_fixed_timer() -> None:
    # Fixed backstop = 512 ms (16 frames); endpointer cuts at 200 ms (~7 frames).
    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 12)])
    pp = StreamingPreprocessor(
        session_id="early",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,  # 2 frames onset
        min_silence_duration_ms=512,  # 16 frames fixed backstop
        endpointer=_StubEndpointer(cut_at_silence_ms=200.0),
    )
    utts = await pp.feed(_frames_pcm(18))
    # Only ~12 silence frames fed (< 16 fixed) — a final can appear ONLY via the
    # earlier semantic cut.
    assert len(_finals(utts)) == 1


@pytest.mark.asyncio
async def test_fixed_timer_alone_does_not_cut_within_the_same_window() -> None:
    # Control: same audio, NO endpointer → the fixed 16-frame timer is not
    # reached within 12 silence frames, so no final.
    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 12)])
    pp = StreamingPreprocessor(
        session_id="ctrl",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,
        endpointer=None,
    )
    utts = await pp.feed(_frames_pcm(18))
    assert len(_finals(utts)) == 0


# ---------------------------------------------------------------------------
# The guardrail — a mid-utterance pause NEVER cuts early (no truncation)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mid_utterance_pause_no_early_cut_real_endpointer() -> None:
    # Real endpointer with an INCOMPLETE running hypothesis ("…uh"): a natural
    # mid-utterance pause (8 silence frames < 16 fixed) must NOT be truncated.
    endpointer = SemanticEndpointer(
        EndpointConfig(enabled=True, min_endpoint_silence_ms=200, min_words=3)
    )
    endpointer.observe_hypothesis("The patient is uh")

    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 8), (0.9, 6)])
    pp = StreamingPreprocessor(
        session_id="pause",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,  # 16 frames — the pause (8) never reaches it
        endpointer=endpointer,
    )
    utts = await pp.feed(_frames_pcm(20))
    # No final: the endpointer refused (incomplete hypothesis) AND the fixed
    # timer was never reached — the utterance is not cut across the pause.
    assert len(_finals(utts)) == 0


# ---------------------------------------------------------------------------
# Disabled / absent endpointer → EXACT fixed-offset behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disabled_endpointer_waits_full_fixed_timer() -> None:
    endpointer = SemanticEndpointer(EndpointConfig(enabled=False))
    endpointer.observe_hypothesis("We should stop the metformin.")  # complete, but disabled

    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 15)])
    pp = StreamingPreprocessor(
        session_id="disabled",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,  # 16 frames
        endpointer=endpointer,
    )
    # 15 silence frames < 16 → no early cut (disabled) and no fixed cut yet.
    utts = await pp.feed(_frames_pcm(21))
    assert len(_finals(utts)) == 0
    # One more silence frame → the fixed timer fires at exactly 16 frames.
    more = await pp.feed(_frames_pcm(1))
    assert len(_finals(more)) == 1


# ---------------------------------------------------------------------------
# The force_emit_after_ms oversize cap still fires with an endpointer attached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_force_emit_cap_still_fires_with_endpointer() -> None:
    # Endpointer that never cuts; continuous speech must still be force-emitted.
    vad = _pattern_vad(segments=[(0.9, 40)])
    pp = StreamingPreprocessor(
        session_id="cap",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,
        max_utterance_duration_ms=320,  # 10 frames → force-emit
        endpointer=_StubEndpointer(cut_at_silence_ms=None),  # never cuts
    )
    utts = await pp.feed(_frames_pcm(40))
    assert len(_finals(utts)) >= 1


# ---------------------------------------------------------------------------
# Endpointer error degrades to the fixed timer (feed never crashes)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpointer_error_degrades_to_fixed_timer() -> None:
    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 16)])
    pp = StreamingPreprocessor(
        session_id="err",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,  # 16 frames
        endpointer=_StubEndpointer(raises=True),
    )
    # decide() raises every frame — must not propagate; the fixed 16-frame timer
    # still cuts the final.
    utts = await pp.feed(_frames_pcm(22))
    assert len(_finals(utts)) == 1


# ---------------------------------------------------------------------------
# The endpointer is reset at the utterance boundary
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_endpointer_reset_on_final() -> None:
    stub = _StubEndpointer(cut_at_silence_ms=200.0)
    vad = _pattern_vad(segments=[(0.9, 6), (0.1, 12)])
    pp = StreamingPreprocessor(
        session_id="reset",
        sample_rate=16000,
        vad_service=vad,
        threshold=0.6,
        min_speech_duration_ms=64,
        min_silence_duration_ms=512,
        endpointer=stub,
    )
    await pp.feed(_frames_pcm(18))
    assert stub.reset_count >= 1
