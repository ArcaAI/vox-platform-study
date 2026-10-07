"""TASK-1049 R / TASK-1050 §12 — the Qwen3Guard-Gen native output parser.

The model answers in a fixed text grammar::

    Safety: Safe | Controversial | Unsafe
    Categories: <comma-separated native categories> | None
    Refusal: Yes | No            (response moderation only)

The parser returns the native fields RAW — tier, categories, refusal — and maps
nothing to a lane (that mapping is guardrail-side config). Anything it cannot
read unambiguously is an explicit ``undetermined`` result, never a guess.
"""

from __future__ import annotations

import pytest

from nlp.services.qwen3guard_judge import UNDETERMINED, parse_qwen3guard_output


@pytest.mark.parametrize("tier", ["Safe", "Controversial", "Unsafe"])
def test_every_tier_parses(tier):
    verdict = parse_qwen3guard_output(f"Safety: {tier}\nCategories: None", mode="prompt")
    assert verdict.tier == tier
    assert verdict.categories == []
    assert verdict.refusal is None
    assert verdict.reason is None


def test_one_category():
    verdict = parse_qwen3guard_output("Safety: Unsafe\nCategories: Jailbreak", mode="prompt")
    assert (verdict.tier, verdict.categories) == ("Unsafe", ["Jailbreak"])


def test_several_categories_keep_their_native_names_and_order():
    verdict = parse_qwen3guard_output(
        "Safety: Unsafe\nCategories: Violent, Non-violent Illegal Acts, Suicide & Self-Harm",
        mode="prompt",
    )
    assert verdict.categories == ["Violent", "Non-violent Illegal Acts", "Suicide & Self-Harm"]


@pytest.mark.parametrize(("line", "expected"), [("Refusal: Yes", True), ("Refusal: No", False)])
def test_the_refusal_line_is_read_in_response_mode(line, expected):
    verdict = parse_qwen3guard_output(f"Safety: Safe\nCategories: None\n{line}", mode="response")
    assert verdict.tier == "Safe"
    assert verdict.refusal is expected


def test_surrounding_whitespace_and_blank_lines_are_tolerated():
    verdict = parse_qwen3guard_output(
        "\n  Safety: Controversial  \n\nCategories: PII\n", mode="prompt"
    )
    assert (verdict.tier, verdict.categories) == ("Controversial", ["PII"])


@pytest.mark.parametrize(
    ("output", "mode", "reason"),
    [
        ("", "prompt", "empty_output"),
        ("   \n ", "prompt", "empty_output"),
        ("Categories: Violent", "prompt", "missing_safety"),
        ("Safety: Maybe\nCategories: None", "prompt", "unknown_tier"),
        ("Safety: Safe\nSafety: Unsafe\nCategories: None", "prompt", "duplicate_line"),
        ("Safety: Unsafe", "prompt", "missing_categories"),
        ("Safety: Unsafe\nCategories: ", "prompt", "missing_categories"),
        ("Safety: Safe\nCategories: None", "response", "missing_refusal"),
        ("Safety: Safe\nCategories: None\nRefusal: Perhaps", "response", "unknown_refusal"),
        (
            "Safety: Unsafe\nCategories: Violent\nThe user wants to hurt someone.",
            "prompt",
            "unexpected_line",
        ),
        ("I cannot help with that.", "prompt", "unexpected_line"),
    ],
)
def test_malformed_output_is_undetermined_never_a_guess(output, mode, reason):
    verdict = parse_qwen3guard_output(output, mode=mode)
    assert verdict.tier == UNDETERMINED
    assert verdict.categories == []
    assert verdict.refusal is None
    assert verdict.reason == reason


def test_a_refusal_line_in_prompt_mode_is_unexpected():
    verdict = parse_qwen3guard_output("Safety: Safe\nCategories: None\nRefusal: No", mode="prompt")
    assert (verdict.tier, verdict.reason) == (UNDETERMINED, "unexpected_line")
