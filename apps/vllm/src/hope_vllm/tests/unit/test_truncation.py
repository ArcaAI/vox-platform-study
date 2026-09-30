"""The vllm#53144 hook: flag output that looks truncated relative to the audio."""

from __future__ import annotations

from hope_vllm.truncation import assess_truncation


def test_token_budget_exhaustion_is_always_flagged() -> None:
    verdict = assess_truncation(
        "a long transcript",
        finish_reason="length",
        voiced_seconds=5.0,
        min_chars_per_voiced_second=3.0,
    )
    assert verdict.suspected is True
    assert verdict.reason == "token_budget_exhausted"


def test_short_output_for_much_voiced_audio_is_flagged() -> None:
    # 6 s of voiced audio at >= 3 chars/s expects >= 18 non-space chars; 5 is an early stop.
    verdict = assess_truncation(
        "hello", finish_reason="stop", voiced_seconds=6.0, min_chars_per_voiced_second=3.0
    )
    assert verdict.suspected is True
    assert verdict.reason == "short_output_for_voiced_audio"
    assert verdict.chars == 5


def test_plausible_output_is_not_flagged() -> None:
    text = "the patient reports mild fever since yesterday"
    verdict = assess_truncation(
        text, finish_reason="stop", voiced_seconds=6.0, min_chars_per_voiced_second=3.0
    )
    assert verdict.suspected is False
    assert verdict.reason is None


def test_whitespace_does_not_count_as_transcribed_characters() -> None:
    verdict = assess_truncation(
        "   a  b   ", finish_reason="stop", voiced_seconds=2.0, min_chars_per_voiced_second=3.0
    )
    assert verdict.chars == 2
    assert verdict.suspected is True


def test_silence_with_empty_output_is_not_flagged() -> None:
    verdict = assess_truncation(
        "", finish_reason="stop", voiced_seconds=0.0, min_chars_per_voiced_second=3.0
    )
    assert verdict.suspected is False


def test_a_brief_blip_below_one_expected_character_is_not_flagged() -> None:
    verdict = assess_truncation(
        "", finish_reason="stop", voiced_seconds=0.2, min_chars_per_voiced_second=3.0
    )
    assert verdict.suspected is False
