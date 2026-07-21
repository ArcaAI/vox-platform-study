"""Clinical-significance-weighted error rate tests.

The harm-weighted error rate encodes the npj framing that a *raw*
error rate is not a safety metric: `Σ(error × severity_weight) / Σ(weightable)`.
A major clinical error (dropped medication/dose/diagnosis) must outweigh a minor
narrative/formatting one, so two error sets with the SAME raw count but different
severity mixes produce DIFFERENT harm-weighted rates. Pure + offline: the scorer
is deterministic arithmetic over labelled errors — no model, no services.
"""

from __future__ import annotations

import pytest

from harness.eval.metrics.harm_weighted import (
    MAJOR_WEIGHT,
    MINOR_WEIGHT,
    score_harm_weighted,
    severity_weight,
)
from harness.eval.models import HarmWeightedResult, NoteError


class TestSeverityTable:
    def test_major_categories_weigh_more_than_minor(self):
        assert severity_weight("medication") == MAJOR_WEIGHT
        assert severity_weight("dose") == MAJOR_WEIGHT
        assert severity_weight("diagnosis") == MAJOR_WEIGHT
        assert severity_weight("allergy") == MAJOR_WEIGHT
        assert severity_weight("narrative") == MINOR_WEIGHT
        assert severity_weight("formatting") == MINOR_WEIGHT
        assert MAJOR_WEIGHT > MINOR_WEIGHT

    def test_category_lookup_is_case_insensitive(self):
        assert severity_weight("Medication") == MAJOR_WEIGHT
        assert severity_weight("  DOSE ") == MAJOR_WEIGHT

    def test_unknown_category_fails_safe_to_major(self):
        # Fail-safe: an unrecognised error is treated as major (max weight), never
        # silently under-weighted. Documented v1 behaviour.
        assert severity_weight("mystery-category") == MAJOR_WEIGHT


class TestHarmWeightedScore:
    def test_major_error_outweighs_minor_error(self):
        major = score_harm_weighted([NoteError(category="medication")], total_weightable=1)
        minor = score_harm_weighted([NoteError(category="narrative")], total_weightable=1)
        assert isinstance(major, HarmWeightedResult)
        assert major.harm_weighted_error_rate > minor.harm_weighted_error_rate
        assert major.harm_weighted_error_rate == pytest.approx(MAJOR_WEIGHT)
        assert minor.harm_weighted_error_rate == pytest.approx(MINOR_WEIGHT)

    def test_same_raw_count_different_mix_diverges(self):
        # The npj point: identical *raw* error rate, different *harm* rate.
        major_set = [NoteError(category="medication"), NoteError(category="dose")]
        minor_set = [NoteError(category="narrative"), NoteError(category="formatting")]
        major = score_harm_weighted(major_set, total_weightable=8)
        minor = score_harm_weighted(minor_set, total_weightable=8)

        # Same raw error rate (2 errors / 8 weightable).
        assert major.raw_error_rate == pytest.approx(minor.raw_error_rate)
        assert major.raw_error_rate == pytest.approx(2 / 8)
        # But the harm-weighted rate separates the major tail.
        assert major.harm_weighted_error_rate > minor.harm_weighted_error_rate
        assert major.harm_weighted_error_rate == pytest.approx((MAJOR_WEIGHT * 2) / 8)
        assert minor.harm_weighted_error_rate == pytest.approx((MINOR_WEIGHT * 2) / 8)

    def test_counts_and_mass_are_reported(self):
        result = score_harm_weighted(
            [
                NoteError(category="medication"),
                NoteError(category="narrative"),
                NoteError(category="allergy"),
            ],
            total_weightable=10,
        )
        assert result.total_errors == 3
        assert result.total_weightable == 10
        assert result.major_errors == 2
        assert result.minor_errors == 1
        assert result.weighted_error_mass == pytest.approx(MAJOR_WEIGHT * 2 + MINOR_WEIGHT)

    def test_no_errors_is_zero_rate(self):
        result = score_harm_weighted([], total_weightable=5)
        assert result.harm_weighted_error_rate == 0.0
        assert result.raw_error_rate == 0.0
        assert result.total_errors == 0

    def test_defaults_weightable_to_error_count_when_absent(self):
        # When the evaluable-unit count is not supplied, the denominator falls back
        # to the error count (a conservative all-errors-are-weightable baseline).
        result = score_harm_weighted([NoteError(category="medication"), NoteError(category="dose")])
        assert result.total_weightable == 2
        assert result.harm_weighted_error_rate == pytest.approx(MAJOR_WEIGHT)

    def test_rejects_fewer_weightable_than_errors(self):
        with pytest.raises(ValueError):
            score_harm_weighted([NoteError(category="dose")], total_weightable=0)
