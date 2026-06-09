"""Inter-rater reliability statistics for judge calibration.

Self-contained, dependency-light (numpy only) implementations of:

* **ICC(2,1)** — two-way random-effects, absolute-agreement, single-rater
  intraclass correlation (Shrout & Fleiss 1979, model "ICC(2,1)"). This is the
  statistic the PDSQI-9 literature reports for judge↔clinician agreement
  (reasoning judge ≈0.818; release gate **ICC ≥ 0.8**).
* **Gwet's AC2** — chance-corrected agreement coefficient that is robust to the
  prevalence/marginal "paradoxes" of Cohen's κ, with ordinal weights for the
  1–5 Likert PDSQI dimensions (Gwet 2014, *Handbook of Inter-Rater Reliability*).

The functions are pure and offline so the calibration unit tests are
deterministic, reproducible, and require no LLM calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

import numpy as np

__all__ = [
    "CalibrationError",
    "CalibrationReport",
    "assert_judge_calibrated",
    "calibration_report",
    "gwet_ac2",
    "intraclass_correlation",
]


class CalibrationError(RuntimeError):
    """Raised when judge↔clinician agreement fails the configured ICC gate."""


def intraclass_correlation(ratings: np.ndarray | list[list[float]]) -> float:
    """ICC(2,1): two-way random effects, absolute agreement, single rater.

    Parameters
    ----------
    ratings:
        A ``(n_targets, n_raters)`` matrix; rows are subjects (e.g. summary
        dimensions/cases) and columns are raters (e.g. ``[judge, clinician]``).

    Returns
    -------
    float
        The ICC(2,1) coefficient. ``1.0`` for perfect agreement; can be negative
        for systematic disagreement.
    """
    y = np.asarray(ratings, dtype=float)
    if y.ndim != 2:
        raise ValueError("ratings must be a 2D (n_targets, n_raters) matrix")
    n, k = y.shape
    if k < 2:
        raise ValueError("ICC requires at least 2 raters (columns)")
    if n < 2:
        raise ValueError("ICC requires at least 2 targets (rows)")

    grand_mean = y.mean()
    row_means = y.mean(axis=1)
    col_means = y.mean(axis=0)

    # Two-way ANOVA decomposition.
    ss_rows = k * np.sum((row_means - grand_mean) ** 2)
    ss_cols = n * np.sum((col_means - grand_mean) ** 2)
    ss_total = np.sum((y - grand_mean) ** 2)
    ss_error = ss_total - ss_rows - ss_cols

    ms_rows = ss_rows / (n - 1)
    ms_cols = ss_cols / (k - 1)
    ms_error = ss_error / ((n - 1) * (k - 1))

    denominator = ms_rows + (k - 1) * ms_error + (k / n) * (ms_cols - ms_error)
    if denominator == 0:
        # Degenerate: no variance at all → treat identical constant ratings as
        # perfect agreement, otherwise undefined → 0.0.
        return 1.0 if ss_total == 0 else 0.0
    return float((ms_rows - ms_error) / denominator)


def _weight_matrix(categories: list[float], weights: str) -> np.ndarray:
    """Build the q×q agreement-weight matrix for Gwet AC2.

    ``identity`` reduces AC2 to AC1; ``linear``/``quadratic`` are the standard
    ordinal weightings (full credit on the diagonal, graded partial credit for
    near-misses on an ordinal scale).
    """
    q = len(categories)
    cats = np.asarray(categories, dtype=float)
    if weights == "identity":
        return np.eye(q)
    if q == 1:
        return np.ones((1, 1))
    span = cats.max() - cats.min()
    if span == 0:
        return np.eye(q)
    diff = np.abs(cats[:, None] - cats[None, :]) / span
    if weights == "linear":
        return cast(np.ndarray, 1.0 - diff)
    if weights == "quadratic":
        return cast(np.ndarray, 1.0 - diff**2)
    raise ValueError(f"unknown weights: {weights!r} (use identity|linear|quadratic)")


def gwet_ac2(
    ratings: np.ndarray | list[list[float]],
    categories: list[float] | tuple[float, ...] = (1, 2, 3, 4, 5),
    weights: str = "quadratic",
) -> float:
    """Gwet's AC2 weighted agreement coefficient.

    Parameters
    ----------
    ratings:
        A ``(n_items, n_raters)`` matrix of category labels. ``NaN`` marks a
        missing rating; items with fewer than 2 ratings are skipped.
    categories:
        The ordinal category set (default the 1–5 PDSQI Likert scale).
    weights:
        ``identity`` (≡ Gwet AC1), ``linear``, or ``quadratic`` (default, ordinal).
    """
    y = np.asarray(ratings, dtype=float)
    if y.ndim != 2:
        raise ValueError("ratings must be a 2D (n_items, n_raters) matrix")

    cats = list(categories)
    q = len(cats)
    cat_index = {c: i for i, c in enumerate(cats)}
    w = _weight_matrix(cats, weights)

    # r[i, k] = number of raters who assigned item i to category k.
    n_items = y.shape[0]
    counts = np.zeros((n_items, q), dtype=float)
    for i in range(n_items):
        for value in y[i]:
            if np.isnan(value):
                continue
            if value not in cat_index:
                raise ValueError(f"rating {value!r} not in categories {cats}")
            counts[i, cat_index[value]] += 1.0

    r_i = counts.sum(axis=1)
    scored = r_i >= 2
    if not np.any(scored):
        raise ValueError("AC2 requires at least one item rated by ≥2 raters")

    counts = counts[scored]
    r_i = r_i[scored]
    n_eff = counts.shape[0]

    # Observed weighted agreement (pairwise; reduces to w(c1,c2) for 2 raters).
    pa_terms = np.zeros(n_eff)
    for i in range(n_eff):
        weighted_counts = w @ counts[i]  # sum_l w_kl * r_il
        pa_terms[i] = (np.sum(weighted_counts * counts[i]) - np.sum(np.diag(w) * counts[i])) / (
            r_i[i] * (r_i[i] - 1)
        )
    pa = float(pa_terms.mean())

    # Chance agreement (Gwet): pe = (Tw / (q(q-1))) * Σ_k π_k (1 - π_k).
    pi = (counts / r_i[:, None]).mean(axis=0)
    tw = float(w.sum())
    if q < 2:
        return 1.0 if pa == 1.0 else 0.0
    pe = (tw / (q * (q - 1))) * float(np.sum(pi * (1.0 - pi)))

    if pe >= 1.0:
        return 1.0 if pa >= 1.0 else 0.0
    return float((pa - pe) / (1.0 - pe))


@dataclass(frozen=True)
class CalibrationReport:
    """Outcome of comparing judge scores to clinician ratings."""

    icc: float
    ac2: float
    n: int
    k: int
    icc_threshold: float

    @property
    def passed(self) -> bool:
        return self.icc >= self.icc_threshold


def _paired_matrix(judge: np.ndarray | list[float], human: np.ndarray | list[float]) -> np.ndarray:
    j = np.asarray(judge, dtype=float).ravel()
    h = np.asarray(human, dtype=float).ravel()
    if j.shape != h.shape:
        raise ValueError(f"judge ({j.shape}) and human ({h.shape}) must align")
    if j.size < 2:
        raise ValueError("need at least 2 paired observations to calibrate")
    return np.column_stack([j, h])


def calibration_report(
    judge: np.ndarray | list[float],
    human: np.ndarray | list[float],
    icc_threshold: float = 0.8,
    categories: list[float] | tuple[float, ...] = (1, 2, 3, 4, 5),
    ac2_weights: str = "quadratic",
) -> CalibrationReport:
    """Compute ICC(2,1) and Gwet AC2 for paired judge↔clinician scores."""
    matrix = _paired_matrix(judge, human)
    icc = intraclass_correlation(matrix)
    ac2 = gwet_ac2(matrix, categories=categories, weights=ac2_weights)
    return CalibrationReport(
        icc=icc,
        ac2=ac2,
        n=int(matrix.shape[0]),
        k=int(matrix.shape[1]),
        icc_threshold=icc_threshold,
    )


def assert_judge_calibrated(
    judge: np.ndarray | list[float],
    human: np.ndarray | list[float],
    icc_threshold: float = 0.8,
    categories: list[float] | tuple[float, ...] = (1, 2, 3, 4, 5),
    ac2_weights: str = "quadratic",
) -> CalibrationReport:
    """Return the calibration report, or raise :class:`CalibrationError`.

    This is the **release gate**: a judge whose agreement with clinicians falls
    below ``icc_threshold`` (default 0.8) is rejected so its automated scores
    are never trusted downstream.
    """
    report = calibration_report(
        judge, human, icc_threshold=icc_threshold, categories=categories, ac2_weights=ac2_weights
    )
    if not report.passed:
        raise CalibrationError(
            f"judge calibration failed: ICC(2,1)={report.icc:.4f} < {icc_threshold} "
            f"(Gwet AC2={report.ac2:.4f}, n={report.n}). "
            "The PDSQI-9 judge is not trustworthy enough to gate releases — "
            "re-prompt/re-model or expand the clinician-rated calibration set."
        )
    return report
