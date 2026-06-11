"""Malayalam filler forms + configurable filler patterns (TASK-351 P2-1).

Covers:
- ``_FILLER_PATTERN`` (module default) recognizes common Malayalam
  filler/disfluency forms while leaving real Malayalam text intact
- ``build_filler_pattern`` accepts extra regex alternates
- ``StreamingInferenceWorker`` picks up extra alternates from the
  ``streaming_extra_filler_patterns`` setting (default preserves behavior)
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np

from stt_v2.streaming.inference import (
    _FILLER_PATTERN,
    StreamingInferenceWorker,
    build_filler_pattern,
)
from stt_v2.streaming.preprocessor import AudioUtterance


def _make_utterance(duration_s: float = 1.0) -> AudioUtterance:
    samples = np.random.randn(int(16000 * duration_s)).astype(np.float32)
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=0.0,
        end_time=duration_s,
        utterance_index=0,
        is_final=True,
    )


class TestMalayalamFillerPattern:
    """Module-default pattern includes Malayalam filler forms."""

    def test_single_malayalam_filler_matches(self):
        assert _FILLER_PATTERN.match("ഉം")

    def test_repeated_malayalam_fillers_match(self):
        assert _FILLER_PATTERN.match("ഉം ഉം ആ")

    def test_malayalam_filler_with_punctuation_matches(self):
        assert _FILLER_PATTERN.match("ഉം, ആ.")

    def test_mixed_english_malayalam_fillers_match(self):
        assert _FILLER_PATTERN.match("uh ഉം hmm")

    def test_real_malayalam_text_does_not_match(self):
        # "I have a fever" — genuine content must never be filtered.
        assert _FILLER_PATTERN.match("എനിക്ക് പനി ഉണ്ട്") is None

    def test_real_word_starting_with_filler_vowel_not_matched(self):
        # 'ആരാ' starts with the filler vowel 'ആ' but is a real word.
        assert _FILLER_PATTERN.match("ആരാ വന്നത്") is None

    def test_english_fillers_still_match(self):
        assert _FILLER_PATTERN.match("uh um hmm.")

    def test_english_sentence_still_not_matched(self):
        assert _FILLER_PATTERN.match("I have a fever") is None


class TestBuildFillerPattern:

    def test_extra_forms_are_appended(self):
        pattern = build_filler_pattern(["la+"])
        assert pattern.match("la laaa la")

    def test_extra_forms_do_not_match_real_text(self):
        pattern = build_filler_pattern(["la+"])
        assert pattern.match("real words here") is None

    def test_no_extra_forms_equivalent_to_default(self):
        pattern = build_filler_pattern()
        assert pattern.pattern == _FILLER_PATTERN.pattern


class TestWorkerFillerFiltering:

    def test_malayalam_filler_filtered_as_hallucination(self):
        worker = StreamingInferenceWorker()
        assert worker._is_hallucination("ഉം ഉം", _make_utterance()) is True

    def test_real_malayalam_not_filtered(self):
        worker = StreamingInferenceWorker()
        text = "എനിക്ക് പനി ഉണ്ട് ഡോക്ടറെ കാണണം"
        assert worker._is_hallucination(text, _make_utterance()) is False


class TestConfigurableExtraFillerPatterns:
    """streaming_extra_filler_patterns extends the worker's pattern."""

    @staticmethod
    def _make_worker(extra: str) -> StreamingInferenceWorker:
        settings = MagicMock()
        settings.streaming_extra_filler_patterns = extra
        with patch(
            "stt_v2.core.config.settings.get_settings", return_value=settings
        ):
            return StreamingInferenceWorker()

    def test_extra_patterns_from_settings_are_applied(self):
        worker = self._make_worker("haan|acha")
        assert worker._is_hallucination("haan acha", _make_utterance()) is True

    def test_default_does_not_filter_custom_forms(self):
        worker = self._make_worker("")
        assert worker._is_hallucination("haan acha", _make_utterance()) is False

    def test_builtin_forms_still_filtered_with_extras(self):
        worker = self._make_worker("haan")
        assert worker._is_hallucination("uh ഉം haan", _make_utterance()) is True

    def test_invalid_extra_pattern_falls_back_to_default(self):
        worker = self._make_worker("([unclosed")
        assert worker._is_hallucination("uh um", _make_utterance()) is True
        assert worker._is_hallucination("haan acha", _make_utterance()) is False
