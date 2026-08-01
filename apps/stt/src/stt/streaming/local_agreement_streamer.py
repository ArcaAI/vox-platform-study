"""LocalAgreement-2 streaming processor (whisper_streaming / Macháček 2023).

⚠️ EXPERIMENTAL — NOT WIRED INTO THE SESSION (TASK-594). Built and unit-tested,
then validated offline against the labeled ml-en clips with the real adapter's
word timestamps: it scored **CER ~0.59 vs ~0.32 for the shipped adapter path** —
a regression. Root cause: the LocalAgreement-2 algorithm needs reliable WORD
BOUNDARIES to align consecutive hypotheses, which Malayalam (no inter-word spaces)
does not provide, and it requires the ``max_len=1`` word-timestamp decode mode
which is itself lower quality than the clean decode. Kept for reference / a future
char-level or timestamp-DTW-aligned variant; do NOT integrate as-is.

The current streaming design decodes a rolling TAIL window for partials and a
fresh full decode for the final. On continuous, pause-free speech that produces
two failures the offline scorecard could not see:

* a window that STARTS mid-phrase makes the fine-tune collapse (a whole segment
  is dropped), and
* the final is an independent re-decode that can CONTRADICT the partials the user
  already saw (English terms transliterated into Malayalam at finalize time).

This component replaces that with the whisper_streaming algorithm:

* keep a GROWING audio buffer for the utterance and re-decode it FROM THE START
  each step (so a hypothesis never begins mid-phrase),
* commit a word only once TWO consecutive re-decodes agree on it
  (LocalAgreement-2) — the committed prefix is stable and never rewritten, so
  there is no "it changed at finalize",
* trim the buffer at the last committed word once it grows past a cap, bounding
  decode cost while preserving left context.

The "final" is simply the committed text when the utterance ends — it can only
EXTEND what the partials showed, never contradict it.

Pure logic: the decode step is injected as a callable so this is fully unit
testable offline (the live partial cadence is wall-clock-gated and cannot be
exercised by fast replay). Ported from ``ufal/whisper_streaming``'s
``HypothesisBuffer`` / ``OnlineASRProcessor`` (MIT), adapted to the HOPE adapter's
``word_timestamps`` contract and to non-space-delimited scripts.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import NamedTuple

import numpy as np


# A timestamped word: (start_s, end_s, text). Times are session-relative.
class TsWord(NamedTuple):
    start: float
    end: float
    text: str


# Decode contract: audio (float32, 16 kHz) -> word list with times RELATIVE to the
# start of the passed audio. The caller adapts the engine adapter to this.
DecodeFn = Callable[[np.ndarray], list[TsWord]]

_MALAYALAM_RE = re.compile(r"[ഀ-ൿ]")


def _is_malayalam(token: str) -> bool:
    return bool(_MALAYALAM_RE.search(token))


def join_words(words: Sequence[TsWord]) -> str:
    """Reconstruct display text from committed word units. English words are
    space-joined; consecutive Malayalam sub-tokens are concatenated WITHOUT a
    space (Malayalam is not space-delimited — space-joining would corrupt it)."""
    out: list[str] = []
    for i, w in enumerate(words):
        tok = w.text
        if i == 0:
            out.append(tok)
            continue
        prev = words[i - 1].text
        if _is_malayalam(tok) and _is_malayalam(prev):
            out.append(tok)  # no separator between Malayalam sub-tokens
        else:
            out.append(" " + tok)
    return re.sub(r"\s+", " ", "".join(out)).strip()


class HypothesisBuffer:
    """LocalAgreement-2 core: commit the longest prefix on which the last two
    hypotheses agree, word by word."""

    def __init__(self) -> None:
        self.committed: list[TsWord] = []
        self._buffer: list[TsWord] = []  # previous hypothesis (unconfirmed tail)
        self._new: list[TsWord] = []
        self.last_committed_time: float = 0.0

    def insert(self, words: list[TsWord], offset: float) -> None:
        """Feed the newest hypothesis (times relative to the buffer); *offset* is
        the buffer's session-relative start time. Words at or before the last
        committed time are dropped, and any n-gram already committed at the seam
        is de-duplicated."""
        shifted = [TsWord(s + offset, e + offset, t) for s, e, t in words]
        self._new = [w for w in shifted if w.start > self.last_committed_time - 0.1]
        if not self._new or not self.committed:
            return
        # Drop a leading n-gram (up to 5 words) that repeats the committed tail —
        # guards against the re-decode re-emitting already-confirmed words.
        if abs(self._new[0].start - self.last_committed_time) < 1.0:
            cn, nn = len(self.committed), len(self._new)
            for i in range(1, min(cn, nn, 5) + 1):
                tail = " ".join(w.text for w in self.committed[-i:])
                head = " ".join(w.text for w in self._new[:i])
                if tail == head:
                    del self._new[:i]
                    break

    def flush(self) -> list[TsWord]:
        """Commit the agreed prefix of the current vs previous hypothesis."""
        agreed: list[TsWord] = []
        while self._new and self._buffer:
            if self._new[0].text == self._buffer[0].text:
                w = self._new.pop(0)
                self._buffer.pop(0)
                self.last_committed_time = w.end
                agreed.append(w)
            else:
                break
        self._buffer = self._new
        self._new = []
        self.committed.extend(agreed)
        return agreed

    def complete(self) -> list[TsWord]:
        """Remaining unconfirmed tail — committed as-is at end of utterance."""
        return list(self._buffer)


class LocalAgreementStreamer:
    """Growing-buffer, re-decode-from-start streaming processor."""

    def __init__(self, sample_rate: int = 16000, trim_after_seconds: float = 15.0) -> None:
        self._sr = sample_rate
        self._trim_after = trim_after_seconds
        self._audio = np.zeros(0, dtype=np.float32)
        self._offset = 0.0  # session-relative start time of the current buffer
        self._hyp = HypothesisBuffer()

    def insert_audio(self, samples: np.ndarray) -> None:
        self._audio = np.append(self._audio, np.asarray(samples, dtype=np.float32))

    def process(self, decode_fn: DecodeFn) -> list[TsWord]:
        """Re-decode the whole buffer, commit newly-agreed words, trim if long.
        Returns the words committed THIS step (may be empty)."""
        words = decode_fn(self._audio)
        self._hyp.insert(words, self._offset)
        committed = self._hyp.flush()
        self._maybe_trim()
        return committed

    def finish(self) -> list[TsWord]:
        """End the utterance: commit the remaining unconfirmed tail."""
        rest = self._hyp.complete()
        self._hyp.committed.extend(rest)
        return rest

    @property
    def committed_words(self) -> list[TsWord]:
        return list(self._hyp.committed)

    @property
    def committed_text(self) -> str:
        return join_words(self._hyp.committed)

    @property
    def buffer_seconds(self) -> float:
        return len(self._audio) / float(self._sr) if self._sr else 0.0

    def _maybe_trim(self) -> None:
        """Once the buffer exceeds the cap, drop the audio up to the last
        committed word so re-decode cost stays bounded (its text is already
        committed and won't be re-emitted thanks to ``last_committed_time``)."""
        if self.buffer_seconds <= self._trim_after or not self._hyp.committed:
            return
        cut_time = self._hyp.committed[-1].end
        cut_samples = int((cut_time - self._offset) * self._sr)
        if cut_samples <= 0 or cut_samples >= len(self._audio):
            return
        self._audio = self._audio[cut_samples:]
        self._offset = cut_time
