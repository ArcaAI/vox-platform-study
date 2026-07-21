"""Clinical-significance-weighted error rate.

A *raw* error rate is not a safety metric: the npj framework finding
is that a 1.47% hallucination rate hid **44% major** errors —
averaging major and minor into one number is actively misleading for a safety
gate. This module weights every note error by a documented v1 severity table so a
dropped medication/dose/diagnosis outweighs a narrative/formatting slip:

    harm_weighted_error_rate = Σ(error × severity_weight) / Σ(weightable)

Pure, offline, deterministic — arithmetic over labelled errors. No model, no
services. The scorer is the sibling of :mod:`harness.eval.metrics.faithfulness`:
both are recall-/error-style metrics over the generated note.
"""

from __future__ import annotations

from collections.abc import Iterable

from harness.eval.models import HarmWeightedResult, NoteError

# --- v1 severity table -------------------------------------------------------
# Major = a clinically consequential error (the 44% tail); minor = a narrative /
# presentational slip. Weights are the deterministic multipliers in the rate.
MAJOR_WEIGHT = 1.0
MINOR_WEIGHT = 0.25

MAJOR_CATEGORIES: frozenset[str] = frozenset(
    {"medication", "dose", "route", "diagnosis", "procedure", "allergy"}
)
MINOR_CATEGORIES: frozenset[str] = frozenset({"narrative", "social", "formatting"})

SEVERITY_WEIGHTS_V1: dict[str, float] = {
    **dict.fromkeys(MAJOR_CATEGORIES, MAJOR_WEIGHT),
    **dict.fromkeys(MINOR_CATEGORIES, MINOR_WEIGHT),
}


def _normalize(category: str) -> str:
    return category.strip().lower()


def severity_weight(category: str) -> float:
    """The v1 severity weight for an error category.

    Unknown categories **fail safe to major** (max weight): an unrecognised error
    is never silently under-weighted. This is a deliberate, documented v1 choice.
    """
    return SEVERITY_WEIGHTS_V1.get(_normalize(category), MAJOR_WEIGHT)


def is_minor(category: str) -> bool:
    """True only for the explicit minor categories (unknown → major, not minor)."""
    return _normalize(category) in MINOR_CATEGORIES


def score_harm_weighted(
    errors: Iterable[NoteError], total_weightable: int | None = None
) -> HarmWeightedResult:
    """Score the harm-weighted error rate over a set of labelled note errors.

    ``total_weightable`` is the count of evaluable units the errors are drawn from
    (e.g. total claims/entities examined) — the rate denominator. When omitted it
    defaults to the error count (a conservative all-errors-are-weightable
    baseline). Raising when it is *smaller* than the error count guards against an
    impossible >100% raw rate.
    """
    errors = list(errors)
    n_errors = len(errors)
    weightable = n_errors if total_weightable is None else total_weightable
    if weightable < n_errors:
        raise ValueError(
            f"total_weightable ({weightable}) cannot be fewer than the error count ({n_errors})"
        )

    weighted_mass = sum(severity_weight(e.category) for e in errors)
    minor = sum(1 for e in errors if is_minor(e.category))
    major = n_errors - minor

    harm_rate = weighted_mass / weightable if weightable else 0.0
    raw_rate = n_errors / weightable if weightable else 0.0

    return HarmWeightedResult(
        harm_weighted_error_rate=harm_rate,
        raw_error_rate=raw_rate,
        weighted_error_mass=weighted_mass,
        total_errors=n_errors,
        total_weightable=weightable,
        major_errors=major,
        minor_errors=minor,
    )
