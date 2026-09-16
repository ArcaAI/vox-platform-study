"""Pure diarization-ACCURACY metric functions.

The streaming scorecard lists diarization scoring as its own concern, owned
separately here. It is a SIBLING of ``streaming_quality.py`` (NOT a fork
of it): the ASR-guardrail scorecard (WER / keyterm recall / transport) stays in
``streaming_quality.py``; the speaker-attribution scorecard lives here.

Deterministic, dependency-light (stdlib only — no numpy, no model), so the metric
math is unit-testable with NOTHING staged. It is backend-agnostic: it scores the
turns of whichever diarizer produced them (today the embedding-clustering path).
The LIVE capture on real de-identified 2-speaker clinical audio (baseline) has not
been taken yet — this module is the scaffold that capture will feed.

WHAT'S HERE
-----------
* ``diarization_error_rate(ref, hyp)`` — NIST DER = (missed + false-alarm +
  confusion) / total-reference-speech, over the optimal speaker-label mapping
  (label-permutation invariant: hyp may use S0/S1, ref clinician/patient).
* ``jaccard_error_rate(ref, hyp)`` — DIHARD-style per-reference-speaker Jaccard
  error, averaged over reference speakers.
* ``speaker_confusion_rate(ref, hyp)`` — confusion time / reference speech (the
  2-speaker clinician↔patient swap — the headline error mode).
* ``attribution_accuracy(ref, hyp)`` — fraction of reference speech attributed to
  the correct (optimally-mapped) speaker.
* ``load_turns_fixture(path)`` — load a de-identified 2-speaker turn fixture.
* ``build_diarization_scorecard(...)`` / ``diarization_regression_report(...)`` /
  ``assert_no_diarization_regression(...)`` — the pass/fail gate (mirrors the
  ``streaming_quality`` regression-gate shape). ``load_diarization_thresholds()``
  reads the committed sibling ``streaming_diarization_thresholds.json``.

Turns are ``(start_s, end_s, speaker_label)`` tuples. Scope is 2-speaker
(clinician/patient); the optimal-mapping enumeration is capped for small speaker
counts accordingly.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from itertools import permutations
from pathlib import Path
from typing import Any

Turn = tuple[float, float, str]

_THRESHOLDS_PATH = Path(__file__).with_name("streaming_diarization_thresholds.json")


# ---------------------------------------------------------------------------
# Interval helpers
# ---------------------------------------------------------------------------


def _labels(turns: Sequence[Turn]) -> list[str]:
    return sorted({label for _, _, label in turns})


def _speaker_time(turns: Sequence[Turn], label: str | None) -> float:
    if label is None:
        return 0.0
    return sum(end - start for start, end, spk in turns if spk == label and end > start)


def _pair_overlap(
    turns_a: Sequence[Turn], label_a: str | None, turns_b: Sequence[Turn], label_b: str | None
) -> float:
    if label_a is None or label_b is None:
        return 0.0
    total = 0.0
    for sa, ea, la in turns_a:
        if la != label_a:
            continue
        for sb, eb, lb in turns_b:
            if lb != label_b:
                continue
            total += max(0.0, min(ea, eb) - max(sa, sb))
    return total


def _atomic_intervals(
    reference: Sequence[Turn], hypothesis: Sequence[Turn]
) -> list[tuple[float, set[str], set[str]]]:
    """Partition the timeline at every turn boundary; return per-atom
    ``(duration, ref_speakers_active, hyp_speakers_active)``."""
    points = sorted(
        {p for start, end, _ in reference for p in (start, end)}
        | {p for start, end, _ in hypothesis for p in (start, end)}
    )
    atoms: list[tuple[float, set[str], set[str]]] = []
    for left, right in zip(points, points[1:], strict=False):
        if right <= left:
            continue
        mid = (left + right) / 2.0
        ref_active = {spk for s, e, spk in reference if s <= mid < e}
        hyp_active = {spk for s, e, spk in hypothesis if s <= mid < e}
        atoms.append((right - left, ref_active, hyp_active))
    return atoms


def _cooccurrence(
    atoms: Sequence[tuple[float, set[str], set[str]]],
) -> dict[tuple[str, str], float]:
    cooccur: dict[tuple[str, str], float] = {}
    for dur, ref_active, hyp_active in atoms:
        for r in ref_active:
            for h in hyp_active:
                cooccur[(r, h)] = cooccur.get((r, h), 0.0) + dur
    return cooccur


def _optimal_map(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> dict[str, str]:
    """Injective hypothesis-label → reference-label map maximizing co-occurrence.

    Enumerates assignments (deterministic, stable order) — fine for the small
    speaker counts of the 2-speaker clinical scope.
    """
    ref_labels = _labels(reference)
    hyp_labels = _labels(hypothesis)
    if not hyp_labels or not ref_labels:
        return {}
    cooccur = _cooccurrence(_atomic_intervals(reference, hypothesis))
    slots: list[str | None] = list(ref_labels) + [None] * max(0, len(hyp_labels) - len(ref_labels))
    best_map: dict[str, str] = {}
    best_score = -1.0
    for perm in permutations(slots, len(hyp_labels)):
        assigned = [r for r in perm if r is not None]
        if len(assigned) != len(set(assigned)):
            continue  # a ref label may back at most one hyp label
        score = sum(
            cooccur.get((perm[i], hyp_labels[i]), 0.0)
            for i in range(len(hyp_labels))
            if perm[i] is not None
        )
        if score > best_score:
            best_score = score
            best_map = {
                hyp_labels[i]: perm[i] for i in range(len(hyp_labels)) if perm[i] is not None
            }
    return best_map


# ---------------------------------------------------------------------------
# DER + companions
# ---------------------------------------------------------------------------


def diarization_error_rate(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> dict[str, Any]:
    """NIST Diarization Error Rate with optimal speaker-label mapping.

    ``DER = (missed + false_alarm + confusion) / total_reference_speech``. Returns
    the rate plus its time decomposition (seconds) for scorecard drill-down.
    """
    atoms = _atomic_intervals(reference, hypothesis)
    hyp_map = _optimal_map(reference, hypothesis)

    missed = false_alarm = confusion = correct = total_ref = 0.0
    for dur, ref_active, hyp_active in atoms:
        mapped_hyp = {hyp_map.get(h) for h in hyp_active}
        n_ref = len(ref_active)
        n_hyp = len(hyp_active)
        n_correct = len(ref_active & mapped_hyp)
        missed += dur * max(0, n_ref - n_hyp)
        false_alarm += dur * max(0, n_hyp - n_ref)
        confusion += dur * (min(n_ref, n_hyp) - n_correct)
        correct += dur * n_correct
        total_ref += dur * n_ref

    der = (missed + false_alarm + confusion) / total_ref if total_ref > 0 else 0.0
    return {
        "der": round(der, 6),
        "missed": round(missed, 6),
        "false_alarm": round(false_alarm, 6),
        "confusion": round(confusion, 6),
        "correct": round(correct, 6),
        "total_reference_speech": round(total_ref, 6),
    }


def speaker_confusion_rate(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> float:
    """Confusion time / total reference speech — the clinician↔patient swap rate."""
    report = diarization_error_rate(reference, hypothesis)
    total = report["total_reference_speech"]
    return round(report["confusion"] / total, 6) if total > 0 else 0.0


def attribution_accuracy(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> float:
    """Fraction of reference speech attributed to the correctly-mapped speaker."""
    report = diarization_error_rate(reference, hypothesis)
    total = report["total_reference_speech"]
    return round(report["correct"] / total, 6) if total > 0 else 1.0


def jaccard_error_rate(reference: Sequence[Turn], hypothesis: Sequence[Turn]) -> float:
    """DIHARD Jaccard Error Rate: mean per-reference-speaker Jaccard error."""
    ref_labels = _labels(reference)
    if not ref_labels:
        return 0.0
    hyp_map = _optimal_map(reference, hypothesis)
    ref_to_hyp = {ref: hyp for hyp, ref in hyp_map.items()}
    errors: list[float] = []
    for ref in ref_labels:
        hyp = ref_to_hyp.get(ref)
        ref_time = _speaker_time(reference, ref)
        hyp_time = _speaker_time(hypothesis, hyp)
        inter = _pair_overlap(reference, ref, hypothesis, hyp)
        union = ref_time + hyp_time - inter
        err = (ref_time - inter) + (hyp_time - inter)
        errors.append(err / union if union > 0 else 0.0)
    return round(sum(errors) / len(errors), 6)


# ---------------------------------------------------------------------------
# De-identified 2-speaker turn fixture
# ---------------------------------------------------------------------------


@dataclass
class DiarizationFixture:
    """A de-identified synthetic 2-speaker clinical fixture with turn ground truth."""

    audio_seconds: float
    reference_turns: list[Turn] = field(default_factory=list)
    speaker_roles: dict[str, str] = field(default_factory=dict)


def load_turns_fixture(path: str | Path) -> DiarizationFixture:
    """Load a ``*.turns.json`` fixture (``{audio_seconds, speakers, turns[]}``)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    turns: list[Turn] = [
        (float(t["start"]), float(t["end"]), str(t["speaker"])) for t in data["turns"]
    ]
    return DiarizationFixture(
        audio_seconds=float(data["audio_seconds"]),
        reference_turns=turns,
        speaker_roles=dict(data.get("speakers", {})),
    )


# ---------------------------------------------------------------------------
# Scorecard + regression gate
# ---------------------------------------------------------------------------


def load_diarization_thresholds() -> dict[str, Any]:
    """Load the committed sibling diarization thresholds JSON."""
    return json.loads(_THRESHOLDS_PATH.read_text(encoding="utf-8"))


def build_diarization_scorecard(
    *, reference: Sequence[Turn], hypothesis: Sequence[Turn]
) -> dict[str, Any]:
    """Compose the diarization-accuracy metrics into one flat scorecard dict."""
    der = diarization_error_rate(reference, hypothesis)
    return {
        "diarization": {
            "der": der["der"],
            "jaccard_error_rate": jaccard_error_rate(reference, hypothesis),
            "speaker_confusion_rate": speaker_confusion_rate(reference, hypothesis),
            "attribution_accuracy": attribution_accuracy(reference, hypothesis),
            "detail": der,
        }
    }


def _check(metric: str, observed: Any, limit: Any, passed: bool, direction: str) -> dict[str, Any]:
    return {
        "metric": metric,
        "observed": observed,
        "limit": limit,
        "direction": direction,
        "passed": bool(passed),
    }


def diarization_regression_report(
    scorecard: Mapping[str, Any], thresholds: Mapping[str, Any]
) -> dict[str, Any]:
    """Evaluate a diarization scorecard against committed thresholds. Pure — never
    raises. Each metric enforces an ABSOLUTE bootstrap ceiling/floor always; a
    ``baseline`` (null until the model-staged live capture) adds a tighter
    baseline±ε check when present. An empty card must NEVER pass vacuously.
    """
    diar = scorecard.get("diarization", {})
    checks: list[dict[str, Any]] = []

    # Lower-is-better error rates: <= ceiling (and <= baseline+eps when captured).
    for name in ("der", "jaccard_error_rate", "speaker_confusion_rate"):
        cfg = thresholds.get(name, {})
        val = diar.get(name)
        if val is None:
            continue
        ceiling = cfg.get("ceiling")
        if ceiling is not None:
            checks.append(_check(name, val, ceiling, val <= ceiling, "<= ceiling"))
        base = cfg.get("baseline")
        if base is not None:
            lim = base + cfg.get("epsilon", 0.0)
            checks.append(_check(f"{name}_vs_baseline", val, lim, val <= lim, "<= baseline+eps"))

    # Higher-is-better attribution accuracy: >= floor (and >= baseline-eps).
    acc_cfg = thresholds.get("attribution_accuracy", {})
    acc = diar.get("attribution_accuracy")
    if acc is not None:
        floor = acc_cfg.get("floor")
        if floor is not None:
            checks.append(_check("attribution_accuracy", acc, floor, acc >= floor, ">= floor"))
        base = acc_cfg.get("baseline")
        if base is not None:
            lim = base - acc_cfg.get("epsilon", 0.0)
            checks.append(
                _check("attribution_accuracy_vs_baseline", acc, lim, acc >= lim, ">= baseline-eps")
            )

    if not checks:
        return {
            "passed": False,
            "checks": [],
            "error": "diarization scorecard exposed no observable metrics to gate",
        }
    return {"passed": all(c["passed"] for c in checks), "checks": checks}


def assert_no_diarization_regression(
    scorecard: Mapping[str, Any], thresholds: Mapping[str, Any]
) -> dict[str, Any]:
    """Raise ``AssertionError`` on any threshold breach; else return the verdict."""
    report = diarization_regression_report(scorecard, thresholds)
    if not report["passed"]:
        detail = report.get("error") or json.dumps(
            [c for c in report["checks"] if not c["passed"]], ensure_ascii=False
        )
        raise AssertionError("diarization accuracy regression vs committed thresholds: " + detail)
    return report
