"""TASK-985 QW-10 (c) — the n-gram repeat guard with rewind.

Immediate repetition is the most frequent error class in the owner's corpus
(§2.5 class 1: 54 exact repeats across 22 % of finals) and nothing in the
pipeline removed it: the adapter's collapse spares doubles, the worker's
sanitizer only collapses SENTENCE repeats, and the seam guard only fires at a
boundary.

The tests below pin the two properties that make the guard safe to ship on the
final path: it removes only EXACT immediate repetitions of something it has
already kept, and it never invents, reorders or shortens content.
"""

import pytest

from stt.postprocessing.repeat_guard import (
    DEFAULT_MAX_REPEATS,
    RepeatGuardConfig,
    collapse_repeats,
    config_from_mapping,
    max_repeats_for,
)


class TestTheAllowanceTable:
    def test_short_ngrams_are_allowed_many_repeats(self):
        # Clinical speech legitimately says "no no no"; a guard that ate it
        # would be a disfluency remover, which this is not.
        assert max_repeats_for(1) == 8
        assert max_repeats_for(2) == 8

    def test_longer_ngrams_tighten(self):
        assert max_repeats_for(3) == 4
        assert max_repeats_for(5) == 3
        assert max_repeats_for(9) == 3

    def test_the_table_is_the_documented_one(self):
        assert DEFAULT_MAX_REPEATS == {1: 8, 2: 8, 3: 4}


class TestWhatItLeavesAlone:
    @pytest.mark.parametrize(
        "text",
        [
            "the patient reports severe chest pain",
            "no no no",
            "yes yes",
            "take it twice a day twice a day",  # 2 copies of a 4-gram: allowance 3
            "",
            "   ",
            "one",
        ],
    )
    def test_unchanged(self, text):
        out, report = collapse_repeats(text)
        assert out == text
        assert not report.changed

    def test_a_repeat_that_is_not_IMMEDIATE_is_not_a_loop(self):
        text = "chest pain then nausea then chest pain"
        out, report = collapse_repeats(text)
        assert out == text
        assert not report.changed


class TestRewind:
    def test_a_unigram_loop_rewinds_to_one_copy(self):
        out, report = collapse_repeats("the " * 12 + "patient")
        assert out == "the patient"
        assert report.dropped_tokens == 11
        assert report.findings[0].ngram == "the"
        assert report.findings[0].repeats == 11

    def test_the_reported_period_is_the_shortest_one_that_tiles_the_run(self):
        # "chest pain" x 10 is a 2-gram loop. Reported as a 4-gram loop it would
        # be charged the tighter long-n-gram allowance AND leave two copies
        # standing, which is the bug this ordering exists to avoid.
        out, report = collapse_repeats("chest pain " * 10 + "today")
        assert out == "chest pain today"
        assert report.findings[0].length == 2

    def test_a_genuinely_long_period_is_still_reported_at_its_own_length(self):
        # No shorter n-gram tiles "a b c d", so the 4-gram is the true period.
        out, report = collapse_repeats("a b c d " * 5)
        assert out == "a b c d"
        assert report.findings[0].length == 4
        assert report.findings[0].repeats == 4

    def test_comparison_ignores_case_and_edge_punctuation(self):
        out, _ = collapse_repeats("Pain, pain. pain pain pain pain pain pain pain pain done")
        # The KEPT copy carries its original spelling and punctuation.
        assert out == "Pain, done"

    def test_content_after_the_loop_survives(self):
        out, _ = collapse_repeats("um " * 10 + "the patient has a fever")
        assert out == "um the patient has a fever"

    def test_two_independent_loops_are_both_rewound(self):
        out, report = collapse_repeats("the " * 10 + "patient " + "has " * 10 + "fever")
        assert out == "the patient has fever"
        assert len(report.findings) == 2

    def test_malayalam_tokens_rewind_the_same_way(self):
        out, report = collapse_repeats("ഉം " * 10 + "രോഗിക്ക്")
        assert out == "ഉം രോഗിക്ക്"
        assert report.dropped_tokens == 9


class TestItIsOffWhenAsked:
    def test_disabled_returns_the_input_untouched(self):
        text = "the " * 20
        out, report = collapse_repeats(text, RepeatGuardConfig(enabled=False))
        assert out == text
        assert not report.changed

    def test_a_looser_allowance_admits_more_repeats(self):
        text = ("the " * 12 + "patient").strip()
        loose = RepeatGuardConfig(max_repeats={1: 20, 2: 20, 3: 20}, long_ngram_max_repeats=20)
        out, report = collapse_repeats(text, loose)
        assert out == text
        assert not report.changed


class TestStockPhrases:
    def test_a_whole_segment_stock_phrase_is_removed(self):
        cfg = RepeatGuardConfig(stock_phrases=("Thank you for watching.",))
        out, report = collapse_repeats("thank you for watching", cfg)
        assert out == ""
        assert report.stock_phrases_removed == ("Thank you for watching.",)

    def test_a_stock_phrase_inside_a_longer_utterance_is_left_alone(self):
        cfg = RepeatGuardConfig(stock_phrases=("thank you",))
        text = "thank you for coming in today"
        out, report = collapse_repeats(text, cfg)
        assert out == text
        assert not report.changed

    def test_no_configured_phrases_means_no_phrase_work(self):
        out, report = collapse_repeats("thank you for watching")
        assert out == "thank you for watching"
        assert report.stock_phrases_removed == ()


class TestConfigFromTheWire:
    def test_absent_means_the_spec_said_nothing(self):
        assert config_from_mapping(None) is None
        assert config_from_mapping("not a block") is None

    def test_camel_and_snake_spellings_both_parse(self):
        camel = config_from_mapping({"enabled": False, "maxNgram": 4})
        snake = config_from_mapping({"enabled": False, "max_ngram": 4})
        assert camel == snake
        assert camel is not None
        assert camel.enabled is False
        assert camel.max_ngram == 4

    def test_a_malformed_member_is_ignored_not_fatal(self):
        cfg = config_from_mapping({"maxNgram": "six", "maxRepeats": {"one": "lots"}})
        assert cfg is not None
        assert cfg.max_ngram == RepeatGuardConfig().max_ngram
        assert cfg.max_repeats == dict(DEFAULT_MAX_REPEATS)

    def test_stock_phrases_come_from_config_not_from_this_module(self):
        cfg = config_from_mapping({"stockPhrases": ["Thanks for watching!", 7, ""]})
        assert cfg is not None
        assert cfg.stock_phrases == ("Thanks for watching!",)
