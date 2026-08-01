"""Unit tests for the LocalAgreement-2 streaming processor.

The decode step is injected, so the whisper_streaming commit/agreement/trim logic
is verified deterministically offline (the live partial cadence is wall-clock-gated
and cannot be exercised by fast replay).
"""

from __future__ import annotations

import numpy as np

from stt.streaming.local_agreement_streamer import (
    HypothesisBuffer,
    LocalAgreementStreamer,
    TsWord,
    join_words,
)


def _w(text: str, start: float, end: float) -> TsWord:
    return TsWord(start, end, text)


# --- HypothesisBuffer: LocalAgreement-2 commits only twice-agreed prefix -------


def test_commits_only_prefix_agreed_by_two_hypotheses() -> None:
    buf = HypothesisBuffer()
    # First hypothesis: nothing to agree with yet -> commits nothing.
    buf.insert([_w("the", 0.0, 0.3), _w("patient", 0.3, 0.7)], offset=0.0)
    assert buf.flush() == []
    # Second hypothesis agrees on "the patient", extends with "has".
    buf.insert([_w("the", 0.0, 0.3), _w("patient", 0.3, 0.7), _w("has", 0.7, 1.0)], offset=0.0)
    committed = buf.flush()
    assert [w.text for w in committed] == ["the", "patient"]  # "has" not yet agreed


def test_committed_prefix_is_never_rewritten_on_later_disagreement() -> None:
    buf = HypothesisBuffer()
    buf.insert([_w("blood", 0.0, 0.4), _w("test", 0.4, 0.8)], 0.0)
    buf.flush()
    buf.insert([_w("blood", 0.0, 0.4), _w("test", 0.4, 0.8)], 0.0)
    buf.flush()  # second agreeing hypothesis commits "blood test"
    assert [w.text for w in buf.committed] == ["blood", "test"]
    # A later hypothesis transliterates the tail — committed prefix stays intact,
    # and the already-committed words are not re-emitted.
    buf.insert([_w("blood", 0.0, 0.4), _w("test", 0.4, 0.8), _w("ലൂടെ", 0.8, 1.1)], 0.0)
    buf.flush()
    assert [w.text for w in buf.committed][:2] == ["blood", "test"]


def test_seam_ngram_dedup_prevents_recommitting_committed_words() -> None:
    buf = HypothesisBuffer()
    buf.insert([_w("a", 0.0, 0.3), _w("b", 0.3, 0.6)], 0.0)
    buf.flush()
    buf.insert([_w("a", 0.0, 0.3), _w("b", 0.3, 0.6)], 0.0)
    buf.flush()  # commits a, b
    # Re-decode re-emits the committed tail "b" then new "c" — proper insert→flush
    # cadence each step; the already-committed "b" is never re-committed.
    buf.insert([_w("b", 0.3, 0.6), _w("c", 0.6, 0.9)], 0.0)
    buf.flush()
    buf.insert([_w("b", 0.3, 0.6), _w("c", 0.6, 0.9)], 0.0)
    committed = buf.flush()
    assert [w.text for w in committed] == ["c"]
    assert [w.text for w in buf.committed] == ["a", "b", "c"]


# --- join_words: script-aware reconstruction ----------------------------------


def test_join_words_spaces_english_but_not_malayalam() -> None:
    # English words space-joined.
    assert join_words([_w("blood", 0, 0.4), _w("test", 0.4, 0.8)]) == "blood test"
    # Consecutive Malayalam sub-tokens concatenated with NO space.
    assert join_words([_w("നമ", 0, 0.2), _w("സ്", 0.2, 0.3), _w("കാരം", 0.3, 0.6)]) == "നമസ്കാരം"
    # Mixed: space around the English island.
    got = join_words([_w("ഒരു", 0, 0.2), _w("blood", 0.2, 0.5), _w("ടെസ്റ്റ്", 0.5, 0.8)])
    assert got == "ഒരു blood ടെസ്റ്റ്"


# --- LocalAgreementStreamer: growing buffer, commit stream, trim --------------


def _audio(seconds: float, sr: int = 16000) -> np.ndarray:
    return np.zeros(int(seconds * sr), dtype=np.float32)


def test_streamer_emits_stable_growing_commit_stream() -> None:
    s = LocalAgreementStreamer(trim_after_seconds=100.0)
    scripted = [
        [_w("the", 0.0, 0.3), _w("patient", 0.3, 0.7)],
        [_w("the", 0.0, 0.3), _w("patient", 0.3, 0.7), _w("has", 0.7, 1.0)],
        [_w("the", 0.0, 0.3), _w("patient", 0.3, 0.7), _w("has", 0.7, 1.0), _w("fever", 1.0, 1.4)],
    ]
    it = iter(scripted)
    for _ in scripted:
        s.insert_audio(_audio(1.0))
        s.process(lambda _a: next(it))
    # "the patient has" are twice-agreed; "fever" awaits the next agreement.
    assert s.committed_text == "the patient has"
    s.finish()  # end of utterance commits the remaining tail
    assert s.committed_text == "the patient has fever"


def test_streamer_trims_buffer_after_cap_without_losing_committed_text() -> None:
    s = LocalAgreementStreamer(sample_rate=16000, trim_after_seconds=2.0)
    hyp = [_w("a", 0.0, 0.5), _w("b", 0.5, 1.0)]
    s.insert_audio(_audio(1.5))
    s.process(lambda _a: hyp)
    s.insert_audio(_audio(1.5))  # now 3.0s > 2.0s cap
    s.process(lambda _a: hyp)  # commits a, b -> triggers trim
    assert s.buffer_seconds < 3.0  # buffer was trimmed at the last committed word
    assert "a" in s.committed_text and "b" in s.committed_text
