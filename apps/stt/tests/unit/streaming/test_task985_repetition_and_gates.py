"""TASK-985 QW-10 (a)/(c), CL-5 and M-41 on the worker's final path.

* **QW-10 (a)** — the seam guard now asks the question ``HypothesisBuffer.insert``
  asks ("is this seam within a second?") instead of the narrower "do these two
  finals physically overlap?", and the rule itself is shared rather than
  re-implemented. Fourteen of the corpus's repeats are seam echoes across finals
  that do not overlap at all.
* **QW-10 (c)** — the n-gram repeat guard runs on finals, before the filler gate.
* **CL-5** — the hallucination RMS gate measures the ROOM, so it divides out the
  peak normalizer's gain. Without that a room-tone utterance in a quiet room
  measures ~0.045 against a 0.01 threshold and the gate can never fire.
* **M-41** — a punctuation model that misses its budget three times running is
  stood down: ``asyncio.wait_for`` abandons the wait, never the thread.
"""

from dataclasses import dataclass
from unittest.mock import patch

import numpy as np

from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

SAMPLE_RATE = 16000


def _utt(
    start: float,
    end: float,
    index: int,
    *,
    rms: float = 0.2,
    gain: float | None = None,
    is_final: bool = True,
):
    n = max(1, int((end - start) * SAMPLE_RATE))
    utt = AudioUtterance(
        samples=np.full(n, rms, dtype=np.float32),
        sample_rate=SAMPLE_RATE,
        start_time=start,
        end_time=end,
        utterance_index=index,
        is_final=is_final,
    )
    if gain is not None:
        # The segmentation lane's field (default 1.0). Attached here rather than
        # passed to the constructor so this file does not depend on the order in
        # which the two lanes land.
        utt.normalizer_gain = gain
    return utt


def _worker(texts: list[str], **kwargs) -> StreamingInferenceWorker:
    calls = {"n": 0}

    def _asr(samples, sample_rate, *, prompt=None):  # noqa: ANN001
        text = texts[min(calls["n"], len(texts) - 1)]
        calls["n"] += 1
        return {"text": text, "word_timestamps": []}

    return StreamingInferenceWorker(result_publisher=None, asr_pipeline=_asr, **kwargs)


class TestTheSeamWindow:
    async def test_a_seam_echo_across_a_SHORT_GAP_is_dropped(self):
        """The case the old ``overlap_s > 0`` gate could not see."""
        worker = _worker(["the patient has chest pain", "chest pain since tuesday"])
        await worker.process_utterance("s1", _utt(0.0, 5.0, 0))
        r2 = await worker.process_utterance("s1", _utt(5.4, 9.0, 1))  # 0.4 s gap
        assert r2.text == "since tuesday"

    async def test_beyond_the_window_a_repeat_is_speech_that_recurred(self):
        worker = _worker(["the patient has chest pain", "chest pain since tuesday"])
        await worker.process_utterance("s1", _utt(0.0, 5.0, 0))
        r2 = await worker.process_utterance("s1", _utt(7.0, 9.0, 1))  # 2 s gap
        assert r2.text == "chest pain since tuesday"

    async def test_the_guard_never_empties_a_final(self):
        """Deletion is already the dominant error class; an asymmetric cost."""
        worker = _worker(["okay", "okay"])
        await worker.process_utterance("s1", _utt(0.0, 2.0, 0))
        r2 = await worker.process_utterance("s1", _utt(2.0, 4.0, 1))
        assert r2.text == "okay"

    async def test_an_overlapping_force_emit_boundary_still_dedups(self):
        worker = _worker(["the patient reports severe pain", "severe pain in the chest"])
        await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(9.5, 15.0, 1))
        assert r2.text == "in the chest"


class TestTheRepeatGuardOnFinals:
    async def test_a_decoder_loop_is_rewound(self):
        worker = _worker(["the patient has has has has has has has has has has a fever"])
        r = await worker.process_utterance("s1", _utt(0.0, 6.0, 0))
        assert r.text == "the patient has a fever"
        assert worker.repeat_guard_drop_count == 9

    async def test_a_looped_filler_collapses_and_is_then_gated(self):
        """Running the guard BEFORE the filler gate is what makes this work.

        The filler pattern matches a whole string of filler forms; ten copies of
        one still match, but the guard makes the intent explicit and the counter
        attributable.
        """
        worker = _worker(["um um um um um um um um um um"])
        r = await worker.process_utterance("s1", _utt(0.0, 6.0, 0))
        assert r.text == ""

    async def test_legitimate_repetition_survives(self):
        worker = _worker(["no no no the swelling is not painful"])
        r = await worker.process_utterance("s1", _utt(0.0, 4.0, 0))
        assert r.text == "no no no the swelling is not painful"
        assert worker.repeat_guard_drop_count == 0

    async def test_partials_are_not_guarded(self):
        """A partial re-decodes an open utterance and feeds the commit policy's
        exact-prefix comparison; a new transform there is the instability D4-N3
        is about."""
        worker = _worker(["the the the the the the the the the the patient"])
        r = await worker.process_partial("s1", _utt(0.0, 4.0, 0, is_final=False))
        assert r.text.startswith("the the the")


class TestTheHallucinationGateMeasuresTheRoom:
    async def test_a_gain_boosted_room_tone_utterance_is_gated(self):
        # 0.045 normalized against a 0.01 threshold — the gate could never fire
        # on this before CL-5. Raw level is 0.045 / 20 = 0.00225 (-53 dBFS).
        worker = _worker(["okay then"])
        r = await worker.process_utterance("s1", _utt(0.0, 1.0, 0, rms=0.045, gain=20.0))
        assert r.text == ""

    async def test_real_quiet_speech_at_unity_gain_is_untouched(self):
        worker = _worker(["okay then"])
        r = await worker.process_utterance("s1", _utt(0.0, 1.0, 0, rms=0.045, gain=1.0))
        assert r.text == "okay then"

    async def test_an_utterance_without_the_field_behaves_exactly_as_before(self):
        worker = _worker(["okay then"])
        r = await worker.process_utterance("s1", _utt(0.0, 1.0, 0, rms=0.045))
        assert r.text == "okay then"

    def test_a_nonsense_gain_is_refused_rather_than_trusted(self):
        utt = _utt(0.0, 1.0, 0, rms=0.045, gain=0.0)
        assert StreamingInferenceWorker._normalizer_gain(utt) == 1.0

    async def test_a_long_final_is_never_gated_by_energy(self):
        # The gate is bounded to <= 3 words; a real utterance is not at risk.
        worker = _worker(["the patient reports intermittent chest pain"])
        r = await worker.process_utterance("s1", _utt(0.0, 4.0, 0, rms=0.001, gain=20.0))
        assert r.text == "the patient reports intermittent chest pain"


@dataclass
class _Punct:
    enabled: bool = True
    model: str = "cadence-fast"


class TestThePunctuationStandDown:
    async def test_three_consecutive_timeouts_stand_the_stage_down(self):
        worker = _worker(["the patient has a fever"])
        worker._punctuation_config = _Punct()
        worker._uses_cadence_fast = True

        with patch("stt.punctuation.service.punctuate", side_effect=TimeoutError):
            for _ in range(3):
                assert await worker._apply_punctuation("hello", is_final=True) == "hello"

        assert worker._punctuation_stood_down is True

    async def test_a_success_between_timeouts_resets_the_count(self):
        worker = _worker(["x"])
        worker._punctuation_config = _Punct()
        worker._uses_cadence_fast = True

        with patch("stt.punctuation.service.punctuate", side_effect=TimeoutError):
            await worker._apply_punctuation("hello", is_final=True)
            await worker._apply_punctuation("hello", is_final=True)
        assert worker._punctuation_stood_down is False

        async def _ok(text, model_name=None):  # noqa: ANN001
            return "Hello."

        with patch("stt.punctuation.service.punctuate", _ok):
            assert await worker._apply_punctuation("hello", is_final=True) == "Hello."
        assert worker._punctuation_consecutive_timeouts == 0

        with patch("stt.punctuation.service.punctuate", side_effect=TimeoutError):
            await worker._apply_punctuation("hello", is_final=True)
            await worker._apply_punctuation("hello", is_final=True)
        assert worker._punctuation_stood_down is False

    async def test_a_stood_down_stage_stops_calling_the_model(self):
        worker = _worker(["x"])
        worker._punctuation_config = _Punct()
        worker._uses_cadence_fast = True
        worker._punctuation_stood_down = True

        with patch("stt.punctuation.service.punctuate") as mock_punctuate:
            assert await worker._apply_punctuation("hello", is_final=True) == "hello"
        mock_punctuate.assert_not_called()

    def test_the_republish_path_is_off_unless_the_spec_asks_for_it(self):
        worker = _worker(["x"])
        assert worker._republish_punctuated is False
