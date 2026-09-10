"""TASK-946 — carry-forward hygiene and the script tripwire.

The 2026-09-10 trial produced case notes from a transcript that was almost entirely
Malayalam script on an English consultation. Two things made that worse than it had to
be, and both are here:

* **Carry-forward.** ``_previous_text`` is fed back into the next decode as Whisper
  prior context. Once one decode came back in the wrong script, the next decode was
  PRIMED with that script — the collapse sustained itself. It is now taken from FINALS
  only, and a final that contradicts its own pinned language is not carried at all.
* **Silence.** Nothing told anyone. A session pinned to a Latin-script language whose
  finals come back in another script now publishes one ``status: degraded`` /
  ``reason: script_mismatch`` to the caller, counts a metric, and logs a WARNING.

Note what is NOT done: the text is still published. Deciding a clinician may not see a
decode is not this layer's call — the tripwire reports, it does not censor.
"""

from __future__ import annotations

import numpy as np
import pytest

from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

MALAYALAM = "രോഗിക്ക് നെഞ്ചുവേദന ഉണ്ട് രണ്ട് ദിവസമായി"
ENGLISH = "the patient reports severe chest pain for two days"


class _FakePublisher:
    """The two publisher calls this path makes, recorded."""

    def __init__(self) -> None:
        self.results: list[object] = []
        self.statuses: list[dict[str, object]] = []

    async def publish(self, result):  # noqa: ANN001 — mirrors ResultPublisher
        self.results.append(result)
        return "1-1"

    async def publish_degraded(self, *, reason, utterance_index=None):  # noqa: ANN001
        self.statuses.append({"reason": reason, "utterance_index": utterance_index})
        return "1-2"


def _worker(
    texts: list[str],
    *,
    language: str | None,
    publisher: _FakePublisher | None = None,
) -> StreamingInferenceWorker:
    calls = {"n": 0}

    def _asr(samples, sample_rate):  # noqa: ANN001
        text = texts[min(calls["n"], len(texts) - 1)]
        calls["n"] += 1
        return {"text": text, "word_timestamps": []}

    return StreamingInferenceWorker(
        result_publisher=publisher,
        asr_pipeline=_asr,
        language=language,
    )


def _utt(index: int, *, is_final: bool = True, start: float = 0.0, end: float = 5.0):
    n = max(1, int((end - start) * 16000))
    return AudioUtterance(
        samples=(np.random.randn(n) * 0.1).astype(np.float32),
        sample_rate=16000,
        start_time=start,
        end_time=end,
        utterance_index=index,
        is_final=is_final,
    )


class TestCarryForwardIsFinalsOnly:
    async def test_a_final_sets_the_carry_forward(self) -> None:
        worker = _worker([ENGLISH], language="en")
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text.endswith("two days")

    async def test_a_non_final_never_sets_it(self) -> None:
        """A partial is a guess at an utterance still in flight; priming the next decode
        with a guess is how a bad hypothesis becomes the session's context."""
        worker = _worker(["the patient rep"], language="en")
        await worker.process_utterance("s1", _utt(0, is_final=False))
        assert worker._previous_text == ""

    async def test_a_non_final_does_not_overwrite_a_final(self) -> None:
        worker = _worker([ENGLISH, "and then the"], language="en")
        await worker.process_utterance("s1", _utt(0))
        carried = worker._previous_text
        assert carried
        await worker.process_utterance("s1", _utt(1, is_final=False, start=5.0, end=7.0))
        assert worker._previous_text == carried


class TestScriptMismatchClearsTheCarryForward:
    async def test_a_wrong_script_final_is_not_carried(self) -> None:
        worker = _worker([MALAYALAM], language="en")
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text == ""

    async def test_it_also_drops_context_a_good_final_had_established(self) -> None:
        worker = _worker([ENGLISH, MALAYALAM], language="en")
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text
        await worker.process_utterance("s1", _utt(1, start=5.0, end=10.0))
        assert worker._previous_text == ""

    async def test_the_text_itself_still_reaches_the_caller(self) -> None:
        """The tripwire reports; it does not censor."""
        publisher = _FakePublisher()
        worker = _worker([MALAYALAM], language="en", publisher=publisher)
        result = await worker.process_utterance("s1", _utt(0))
        assert result.text.strip()
        assert publisher.results

    @pytest.mark.parametrize("language", [None, "ml"])
    async def test_an_unpinned_or_non_latin_session_is_never_judged(self, language) -> None:
        """No pin, nothing to contradict — and a Malayalam session is correct in
        Malayalam."""
        worker = _worker([MALAYALAM], language=language)
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text != ""

    async def test_vietnamese_diacritics_are_latin(self) -> None:
        """`vi` is Latin-script; an ASCII test would fire on every correct line."""
        worker = _worker(["bệnh nhân bị đau ngực dữ dội hai ngày"], language="vi")
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text != ""

    async def test_a_short_final_is_below_the_judging_floor(self) -> None:
        """One foreign proper noun is not a collapse."""
        worker = _worker(["ഡോക്ടർ"], language="en")
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text != ""


class TestScriptMismatchIsReportedOncePerSession:
    async def test_it_publishes_one_degraded_status_with_the_reason(self) -> None:
        publisher = _FakePublisher()
        worker = _worker([MALAYALAM], language="en", publisher=publisher)
        await worker.process_utterance("s1", _utt(0))
        assert publisher.statuses == [{"reason": "script_mismatch", "utterance_index": 0}]

    async def test_a_second_bad_final_does_not_republish(self) -> None:
        """One per session: the caller needs to know the session is degraded, not to be
        told again on every utterance for the next forty minutes."""
        publisher = _FakePublisher()
        worker = _worker([MALAYALAM, MALAYALAM], language="en", publisher=publisher)
        await worker.process_utterance("s1", _utt(0))
        await worker.process_utterance("s1", _utt(1, start=5.0, end=10.0))
        assert len(publisher.statuses) == 1

    async def test_a_clean_session_publishes_nothing(self) -> None:
        publisher = _FakePublisher()
        worker = _worker([ENGLISH], language="en", publisher=publisher)
        await worker.process_utterance("s1", _utt(0))
        assert publisher.statuses == []

    async def test_it_counts_every_occurrence_not_just_the_first(self) -> None:
        """The status says "this session went wrong"; the metric says how badly."""
        from stt.core.metrics import STREAMING_SCRIPT_MISMATCH_TOTAL

        before = STREAMING_SCRIPT_MISMATCH_TOTAL._value.get()
        worker = _worker([MALAYALAM, MALAYALAM], language="en")
        await worker.process_utterance("s1", _utt(0))
        await worker.process_utterance("s1", _utt(1, start=5.0, end=10.0))
        assert STREAMING_SCRIPT_MISMATCH_TOTAL._value.get() == before + 2

    async def test_a_worker_without_a_publisher_still_guards_the_carry_forward(self) -> None:
        worker = _worker([MALAYALAM], language="en", publisher=None)
        await worker.process_utterance("s1", _utt(0))
        assert worker._previous_text == ""
