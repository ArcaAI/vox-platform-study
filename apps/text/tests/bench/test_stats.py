"""Unit tests for the bench percentile/summary helpers.

Deliberately outside `src/text/tests` (`testpaths = ["src/text/tests"]` in
`apps/text/pyproject.toml`), so it never runs as part of the `pnpm text:test`
gate and never perturbs the 1458-test baseline. Run explicitly with:

    uv run --extra test python -m pytest apps/text/tests/bench -q --no-cov

TDD note: written and watched RED (ModuleNotFoundError for `stats`) before
`stats.py` existed.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from stats import Sample, percentile, summarize  # noqa: E402


class TestPercentile:
    def test_empty_raises(self) -> None:
        with pytest.raises(ValueError):
            percentile([], 50)

    def test_single_value(self) -> None:
        assert percentile([42.0], 50) == 42.0
        assert percentile([42.0], 99) == 42.0

    def test_p50_of_ordered_list_is_the_median(self) -> None:
        values = [1.0, 2.0, 3.0, 4.0, 5.0]
        assert percentile(values, 50) == 3.0

    def test_unsorted_input_is_sorted_first(self) -> None:
        values = [5.0, 1.0, 3.0, 2.0, 4.0]
        assert percentile(values, 50) == 3.0

    def test_p99_is_near_the_max_for_a_large_sample(self) -> None:
        values = [float(i) for i in range(1, 101)]  # 1..100
        p99 = percentile(values, 99)
        assert p99 >= 98.0

    @pytest.mark.parametrize("p", [-1, 100.1, 101])
    def test_out_of_range_percentile_raises(self, p: float) -> None:
        with pytest.raises(ValueError):
            percentile([1.0, 2.0, 3.0], p)


class TestSummarize:
    def test_summarize_reports_p50_p95_p99_never_a_bare_average(self) -> None:
        values = [float(i) for i in range(1, 1001)]  # 1..1000
        result = summarize(values)
        assert isinstance(result, Sample)
        assert result.count == 1000
        assert result.p50 == pytest.approx(500.5, rel=0.01)
        assert result.p95 == pytest.approx(950.0, rel=0.02)
        assert result.p99 == pytest.approx(990.0, rel=0.02)
        assert result.min == 1.0
        assert result.max == 1000.0
        # The mean is still available (useful context), but it is not what a
        # caller should reach for first — p50/p95/p99 are the primary fields.
        assert result.mean == pytest.approx(500.5, rel=0.01)

    def test_summarize_empty_series_is_explicit_not_nan(self) -> None:
        result = summarize([])
        assert result.count == 0
        assert math.isnan(result.p50)
        assert math.isnan(result.p95)
        assert math.isnan(result.p99)
