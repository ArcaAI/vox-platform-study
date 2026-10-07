"""Metric functions. Pure: no model, no I/O. Everything returns plain dicts for the report."""

from __future__ import annotations

import re
import statistics
from collections import defaultdict
from collections.abc import Mapping, Sequence

from .labels import CLINICIAN, DIRECT_IDENTIFIERS, OTHER, PHI_LABELS, QUASI_IDENTIFIERS
from .spans import Detection, match_spans

Interval = tuple[int, int, str]


def _ratio(num: int, den: int) -> float | None:
    return None if den == 0 else num / den


def _f1(p: float | None, r: float | None) -> float | None:
    if p is None or r is None:
        return None
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


# --------------------------------------------------------------------- span P/R/F1
def prf_table(
    gold_docs: Sequence[Sequence[Mapping]],
    pred_docs: Sequence[Sequence[Detection]],
    mode: str,
) -> dict:
    """Per-label and micro precision / recall / F1.

    Recall is attributed to the GOLD label; precision to the label the detector EMITTED
    (a generic `PERSON` hit on a patient name is a TP of `PERSON` and of `PATIENT_NAME`'s
    recall). `precision` is None for a label the detector never emitted. Detections
    labelled OTHER (facility names, ...) have no gold counterpart and are not scored.
    """
    gold_tp: dict[str, int] = defaultdict(int)
    gold_fn: dict[str, int] = defaultdict(int)
    pred_tp: dict[str, int] = defaultdict(int)
    pred_fp: dict[str, int] = defaultdict(int)
    for gold, pred in zip(gold_docs, pred_docs, strict=True):
        m = match_spans(gold, pred, mode)
        for gi, pi in m.tp:
            gold_tp[gold[gi]["label"]] += 1
            pred_tp[pred[pi].label] += 1
        for gi in m.fn:
            gold_fn[gold[gi]["label"]] += 1
        for pi in m.fp:
            if pred[pi].label != OTHER:
                pred_fp[pred[pi].label] += 1
    labels: dict[str, dict] = {}
    for label in sorted(set(gold_tp) | set(gold_fn) | set(pred_tp) | set(pred_fp)):
        recall = _ratio(gold_tp[label], gold_tp[label] + gold_fn[label])
        precision = _ratio(pred_tp[label], pred_tp[label] + pred_fp[label])
        labels[label] = {
            "gold": gold_tp[label] + gold_fn[label],
            "tp": gold_tp[label],
            "fn": gold_fn[label],
            "emitted": pred_tp[label] + pred_fp[label],
            "fp": pred_fp[label],
            "precision": precision,
            "recall": recall,
            "f1": _f1(precision, recall),
        }
    tp, fn, fp = sum(gold_tp.values()), sum(gold_fn.values()), sum(pred_fp.values())
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    return {
        "labels": labels,
        "micro": {
            "precision": precision,
            "recall": recall,
            "f1": _f1(precision, recall),
            "tp": tp,
            "fp": fp,
            "fn": fn,
        },
    }


# ------------------------------------------------------------------- residual PHI
def _covered(intervals: Sequence[Interval], limit: int) -> list[bool]:
    mask = [False] * limit
    for start, end, _ in intervals:
        for i in range(max(0, start), min(limit, end)):
            mask[i] = True
    return mask


def _bucket() -> dict:
    return {"spans": 0, "leaked_any": 0, "leaked_substantive": 0}


def _rates(b: dict) -> dict:
    b["rate_any"] = _ratio(b["leaked_any"], b["spans"])
    b["rate_substantive"] = _ratio(b["leaked_substantive"], b["spans"])
    return b


def residual_stats(
    texts: Sequence[str],
    golds: Sequence[Sequence[Mapping]],
    intervals: Sequence[Sequence[Interval]],
    masked: Sequence[str],
) -> dict:
    """What of the gold PHI is still readable after masking (the deciding metric).

    Per gold PHI span (CLINICIAN excluded) the characters outside every replaced interval
    are counted. `leaked_any`: at least one alphanumeric character survives.
    `leaked_substantive`: at least min(3, length) survive, i.e. not a stray boundary
    character. `verbatim_survivors`: distinct gold values (>= 3 chars) still present, as a
    whole word, in the masked text of the SAME document.
    """
    overall, direct, quasi = _bucket(), _bucket(), _bucket()
    by_label: dict[str, dict] = {}
    survivors = values = 0
    for text, gold, ivs, out in zip(texts, golds, intervals, masked, strict=True):
        covered = _covered(ivs, len(text))
        seen: set[str] = set()
        for span in gold:
            label = span["label"]
            if label not in PHI_LABELS:
                continue
            alnum = [i for i in range(span["start"], span["end"]) if text[i].isalnum()]
            uncovered = sum(1 for i in alnum if not covered[i])
            any_leak = uncovered > 0
            substantive = uncovered >= min(3, len(alnum)) and any_leak
            buckets = [overall, by_label.setdefault(label, _bucket())]
            if label in DIRECT_IDENTIFIERS:
                buckets.append(direct)
            if label in QUASI_IDENTIFIERS:
                buckets.append(quasi)
            for b in buckets:
                b["spans"] += 1
                b["leaked_any"] += any_leak
                b["leaked_substantive"] += substantive
            value = " ".join(span["text"].split()).casefold()
            if len(value) >= 3 and value not in seen:
                seen.add(value)
                values += 1
                pattern = r"(?<!\w)" + r"\s+".join(map(re.escape, value.split())) + r"(?!\w)"
                if re.search(pattern, out, flags=re.IGNORECASE):
                    survivors += 1
    return {
        "overall": _rates(overall),
        "direct": _rates(direct),
        "quasi": _rates(quasi),
        "by_label": {k: _rates(v) for k, v in sorted(by_label.items())},
        "verbatim_survivors": survivors,
        "verbatim_values": values,
    }


def clinician_stats(
    texts: Sequence[str],
    golds: Sequence[Sequence[Mapping]],
    intervals: Sequence[Sequence[Interval]],
) -> dict:
    """How often a clinician's name was masked. Neutral, reported for transparency only."""
    total = masked = 0
    for text, gold, ivs in zip(texts, golds, intervals, strict=True):
        covered = _covered(ivs, len(text))
        for span in gold:
            if span["label"] == CLINICIAN:
                total += 1
                masked += any(covered[span["start"] : span["end"]])
    return {"spans": total, "masked": masked, "rate": _ratio(masked, total)}


# -------------------------------------------------------------------- over-masking
def overmask_stats(
    texts: Sequence[str],
    negatives: Sequence[Sequence[Mapping]],
    intervals: Sequence[Sequence[Interval]],
) -> dict:
    """Hard negatives (eponyms, drugs, intervals, doses, under-90 ages) touched by a mask."""
    overall = {"negatives": 0, "overmasked": 0}
    by_kind: dict[str, dict] = {}
    for text, negs, ivs in zip(texts, negatives, intervals, strict=True):
        covered = _covered(ivs, len(text))
        for neg in negs:
            hit = any(covered[neg["start"] : neg["end"]])
            for b in (overall, by_kind.setdefault(neg["kind"], {"negatives": 0, "overmasked": 0})):
                b["negatives"] += 1
                b["overmasked"] += hit
    overall["rate"] = _ratio(overall["overmasked"], overall["negatives"])
    for b in by_kind.values():
        b["rate"] = _ratio(b["overmasked"], b["negatives"])
    return {"overall": overall, "by_kind": dict(sorted(by_kind.items()))}


# --------------------------------------------------------- round trip, consistency
def restore_stats(texts: Sequence[str], result) -> dict:
    """Does `restore(mask(text)) == text`, character for character?"""
    exact = sum(
        1
        for text, masked in zip(texts, result.masked, strict=True)
        if result.restore(masked) == text
    )
    return {"documents": len(texts), "exact": exact, "rate": _ratio(exact, len(texts))}


def surrogate_stats(texts: Sequence[str], golds: Sequence[Sequence[Mapping]], result) -> dict:
    """Co-reference across ONE consultation's texts.

    `inconsistent`: entities (>= 2 masked occurrences) whose occurrences got more than one
    token, e.g. "Anil Kumar" in the transcript and "Kumar" in the note.
    `surface_inconsistent`: the same entity AND the same spelling got different tokens
    (a detector labelling it differently in two places). `collisions`: tokens shared by
    more than one entity (two people, one surrogate; restore stays correct, the model is
    told they are the same person).
    """
    tokens_by_entity: dict[str, list[str]] = defaultdict(list)
    tokens_by_surface: dict[tuple[str, str], set[str]] = defaultdict(set)
    entities_by_token: dict[str, set[str]] = defaultdict(set)
    for text, gold, ivs in zip(texts, golds, result.intervals, strict=True):
        phi = [s for s in gold if s["label"] in PHI_LABELS and s.get("entity")]
        for start, end, label in ivs:
            best, overlap = None, 0
            for s in phi:
                ov = min(end, s["end"]) - max(start, s["start"])
                if ov > overlap:
                    best, overlap = s, ov
            if best is None:
                continue
            token = result.token_for(label, text[start:end])
            tokens_by_entity[best["entity"]].append(token)
            surface = " ".join(best["text"].split()).casefold()
            tokens_by_surface[(best["entity"], surface)].add(token)
            entities_by_token[token].add(best["entity"])
    eligible = {e: t for e, t in tokens_by_entity.items() if len(t) >= 2}
    inconsistent = sum(1 for t in eligible.values() if len(set(t)) > 1)
    return {
        "entities": len(eligible),
        "inconsistent": inconsistent,
        "consistent_rate": None if not eligible else 1 - inconsistent / len(eligible),
        "surface_inconsistent": sum(1 for t in tokens_by_surface.values() if len(t) > 1),
        "collisions": sum(1 for e in entities_by_token.values() if len(e) > 1),
    }


# ------------------------------------------------------------------------ latency
def percentile(values: Sequence[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("no values")
    pos = (len(ordered) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def latency_summary(seconds: Sequence[float]) -> dict:
    return {
        "n": len(seconds),
        "p50_ms": round(1000 * percentile(seconds, 0.50), 2),
        "p95_ms": round(1000 * percentile(seconds, 0.95), 2),
        "mean_ms": round(1000 * statistics.fmean(seconds), 2),
    }
