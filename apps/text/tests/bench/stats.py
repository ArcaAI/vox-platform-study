"""Percentile / summary helpers for the Lane H benchmark harness.

/ (AC-1..AC-4, AC-7): report **p50/p95/p99, never averages**.
This module is the one place that computes a percentile, so every consumer
(harness.py's live sweep report, any future CI gate) reads the same
definition.

Deliberately dependency-free (no numpy/scipy) — the sample sizes here are at
most a few thousand floats per concurrency level, and the nearest-rank method
below is exact and simple to audit.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass


def percentile(values: list[float], p: float) -> float:
    """The ``p``-th percentile of ``values`` (nearest-rank method).

    ``p`` is in ``[0, 100]``. Raises ``ValueError`` on an empty series or an
    out-of-range percentile — a benchmark that silently returns 0/NaN for a
    misuse would misreport a real number as a real number.
    """
    if not values:
        raise ValueError("percentile() of an empty series is undefined")
    if not 0 <= p <= 100:
        raise ValueError(f"percentile must be in [0, 100], got {p}")

    ordered = sorted(values)
    if p == 100:
        return ordered[-1]
    # Nearest-rank: the smallest value such that at least p% of the sample is
    # <= it. rank is 1-indexed into `ordered`.
    rank = max(1, math.ceil((p / 100) * len(ordered)))
    return ordered[rank - 1]


@dataclass(frozen=True)
class Sample:
    """A summarized latency/throughput series.

    ``p50``/``p95``/``p99`` are the fields every report in this harness
    leads with ("report p50/p95/p99 TTFT ... never averages").
    ``mean`` is retained as secondary context only.
    """

    count: int
    min: float
    max: float
    mean: float
    p50: float
    p95: float
    p99: float

    def as_dict(self) -> dict[str, float | int]:
        return {
            "count": self.count,
            "min": self.min,
            "max": self.max,
            "mean": self.mean,
            "p50": self.p50,
            "p95": self.p95,
            "p99": self.p99,
        }


def summarize(values: list[float]) -> Sample:
    """Summarize a series of measurements (milliseconds, bytes, whatever).

    An empty series returns an explicit ``NaN``-filled ``Sample`` (count=0)
    rather than raising — a concurrency level that produced zero successful
    samples (e.g. every request errored) is a real, reportable outcome, not a
    caller bug.
    """
    if not values:
        nan = float("nan")
        return Sample(count=0, min=nan, max=nan, mean=nan, p50=nan, p95=nan, p99=nan)
    return Sample(
        count=len(values),
        min=min(values),
        max=max(values),
        mean=statistics.fmean(values),
        p50=percentile(values, 50),
        p95=percentile(values, 95),
        p99=percentile(values, 99),
    )
