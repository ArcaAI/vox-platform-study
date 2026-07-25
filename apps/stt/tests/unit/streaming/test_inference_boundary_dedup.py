"""Force-emit boundary word dedup.

The preprocessor's force-emit split carries overlap audio into the
continuation utterance (120 ms smart split / 500 ms hard-split fallback), so
consecutive FINALS overlap in time and the ASR transcribes the carried words
twice. The worker strips the duplicated leading words from the second final.
"""

import numpy as np

from stt.postprocessing.overlap import dedup_overlap
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance


def _make_worker(texts: list[str]) -> StreamingInferenceWorker:
    """Worker whose ASR returns the given texts in order."""
    calls = {"n": 0}

    def _asr(samples, sample_rate):
        text = texts[min(calls["n"], len(texts) - 1)]
        calls["n"] += 1
        return {"text": text, "word_timestamps": []}

    return StreamingInferenceWorker(
        result_publisher=None,
        asr_pipeline=_asr,
    )


def _utt(start: float, end: float, index: int) -> AudioUtterance:
    n = max(1, int((end - start) * 16000))
    return AudioUtterance(
        samples=(np.random.randn(n) * 0.1).astype(np.float32),
        sample_rate=16000,
        start_time=start,
        end_time=end,
        utterance_index=index,
        is_final=True,
    )


class TestDedupOverlapShared:
    def test_strips_matching_prefix(self):
        assert (
            dedup_overlap("the patient reports severe pain", "severe pain in the chest")
            == "in the chest"
        )

    def test_case_and_punctuation_insensitive(self):
        assert dedup_overlap("Severe PAIN.", "severe pain, yes") == "yes"

    def test_no_match_untouched(self):
        assert dedup_overlap("hello world", "different words") == "different words"


class TestForcedBoundaryDedup:
    async def test_overlapping_finals_dedup_carried_words(self):
        worker = _make_worker(
            ["the patient reports severe pain", "severe pain in the chest"]
        )
        # Final 1: 0..10 s. Final 2 starts at 9.5 s (0.5 s hard-split carry).
        r1 = await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(9.5, 20.0, 1))

        assert r1.text == "the patient reports severe pain"
        assert r2.text == "in the chest"

    async def test_non_overlapping_finals_keep_genuine_repeats(self):
        # Silence-separated finals (no time overlap): a genuinely repeated
        # phrase must NOT be eaten.
        worker = _make_worker(["no no no", "no no no"])
        r1 = await worker.process_utterance("s1", _utt(0.0, 2.0, 0))
        r2 = await worker.process_utterance("s1", _utt(3.0, 5.0, 1))

        assert r1.text == "no no no"
        assert r2.text == "no no no"

    async def test_overlap_window_bounds_match_length(self):
        # 0.25 s overlap → at most 2 words may be stripped even if more match.
        worker = _make_worker(
            ["alpha beta gamma delta epsilon", "gamma delta epsilon zeta"]
        )
        await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(9.75, 15.0, 1))

        # max_words = min(12, int(0.25*4)+1) = 2 → only a ≤2-word prefix can
        # match; "gamma delta epsilon" (3 words) exceeds the window, and no
        # shorter prefix of the current text matches the tail — untouched.
        assert r2.text == "gamma delta epsilon zeta"

    async def test_empty_previous_final_disables_dedup(self):
        worker = _make_worker(["", "severe pain again"])
        r1 = await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(9.5, 15.0, 1))

        assert r1.text == ""
        assert r2.text == "severe pain again"


class TestP1ReviewFixes:
    """Regression locks for adversarial-review findings."""

    def test_timestamp_trim_is_match_based_not_positional(self):
        # Raw timestamps can carry sanitizer-removed artifacts before the
        # duplicated words; positional trimming cut the artifacts and KEPT
        # the duplicates.
        ts = [
            {"word": ">>", "start": 0.0, "end": 0.1},
            {"word": ">>", "start": 0.1, "end": 0.2},
            {"word": "severe", "start": 0.2, "end": 0.5},
            {"word": "pain,", "start": 0.5, "end": 0.8},
            {"word": "in", "start": 0.8, "end": 0.9},
            {"word": "the", "start": 0.9, "end": 1.0},
            {"word": "chest", "start": 1.0, "end": 1.4},
        ]
        out = StreamingInferenceWorker._trim_dedup_word_timestamps(
            ts, ["severe", "pain"]
        )
        words = [e["word"] for e in out]
        assert "severe" not in words
        assert "pain," not in words
        assert words[-3:] == ["in", "the", "chest"]

    async def test_tail_captured_before_disfluency_removal(self):
        # The stored tail must match the NEXT final's pre-postprocessing text;
        # a tail captured after disfluency removal breaks the contiguous
        # suffix/prefix match whenever the carry region contains a filler.
        from stt.pipeline.dto import PostprocessingConfig

        worker = _make_worker(["patient reports um severe pain", "um severe pain in chest"])
        worker._postprocessing_config = PostprocessingConfig(remove_disfluencies=True)

        r1 = await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(9.4, 15.0, 1))

        # Published finals have the filler removed…
        assert "um" not in r1.text
        # …but the boundary dedup still matched the raw overlap.
        assert r2.text == "in chest"

    async def test_dedup_window_capped_at_three_words(self):
        # overlap_s over-measures on smart splits; a duration-scaled window
        # could eat genuinely repeated phrases. Cap = 3 words.
        worker = _make_worker(
            ["alpha beta gamma delta epsilon zeta", "gamma delta epsilon zeta eta"]
        )
        await worker.process_utterance("s1", _utt(0.0, 10.0, 0))
        r2 = await worker.process_utterance("s1", _utt(8.0, 15.0, 1))  # 2 s overlap

        # A 4-word matching prefix exceeds the 3-word window → untouched.
        assert r2.text == "gamma delta epsilon zeta eta"
