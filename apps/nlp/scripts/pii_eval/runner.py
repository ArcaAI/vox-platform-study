"""Run a Detector over documents at the production window geometry, then score."""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence

from injection_eval.core import iter_windows

from .detectors import Detector
from .masking import mask_consultation
from .metrics import (
    clinician_stats,
    latency_summary,
    overmask_stats,
    prf_table,
    residual_stats,
    restore_stats,
    surrogate_stats,
)
from .spans import Detection, dedupe_longest

#: guardrail's `iter_windows(text, size, overlap)` geometry (TASK-1047 D4): 2,000 / 256.
WINDOW, OVERLAP = 2000, 256


def detect_document(
    detector: Detector,
    text: str,
    *,
    size: int = WINDOW,
    overlap: int = OVERLAP,
    timings: list[float] | None = None,
) -> list[Detection]:
    """Detections in DOCUMENT coordinates: one single-window call per window (the shape
    of guardrail's peer call), rebased, then de-duplicated longest-span-wins.

    `timings`, when given, receives one wall-clock duration (seconds) per window call.
    """
    found: list[Detection] = []
    for offset, chunk in iter_windows(text, size, overlap):
        started = time.perf_counter()
        batch = detector.detect_batch([chunk])
        if timings is not None:
            timings.append(time.perf_counter() - started)
        for d in batch[0]:
            found.append(
                Detection(d.label, d.start + offset, d.end + offset, d.score, raw_label=d.raw_label)
            )
    return dedupe_longest(found)


def run_detector(
    detector: Detector,
    docs: Sequence[Mapping],
    *,
    on_doc: Callable[[int, Mapping, list[Detection]], None] | None = None,
) -> tuple[list[list[Detection]], list[float]]:
    """Detections per document, plus every per-window latency in seconds."""
    preds: list[list[Detection]] = []
    timings: list[float] = []
    for i, doc in enumerate(docs):
        dets = detect_document(detector, doc["text"], timings=timings)
        preds.append(dets)
        if on_doc is not None:
            on_doc(i, doc, dets)
    return preds, timings


def _consultations(docs: Sequence[Mapping]) -> OrderedDict[str, list[int]]:
    groups: OrderedDict[str, list[int]] = OrderedDict()
    for i, doc in enumerate(docs):
        groups.setdefault(doc.get("consultation_id") or doc["id"], []).append(i)
    return groups


def evaluate_detections(docs: Sequence[Mapping], preds: Sequence[Sequence[Detection]]) -> dict:
    """Score precomputed detections (document coordinates) against the gold."""
    golds = [d["spans"] for d in docs]
    report: dict = {
        "documents": len(docs),
        "gold_spans": sum(len(g) for g in golds),
        "hard_negatives": sum(len(d["negatives"]) for d in docs),
        "spans": {mode: prf_table(golds, preds, mode) for mode in ("strict", "relaxed")},
    }
    texts: list[str] = []
    g_flat: list[Sequence[Mapping]] = []
    n_flat: list[Sequence[Mapping]] = []
    ivs: list[list[tuple[int, int, str]]] = []
    masked: list[str] = []
    restore = {"documents": 0, "exact": 0}
    surrogate = {"entities": 0, "inconsistent": 0, "surface_inconsistent": 0, "collisions": 0}
    for idxs in _consultations(docs).values():
        ts = [docs[i]["text"] for i in idxs]
        result = mask_consultation(ts, [preds[i] for i in idxs])
        texts += ts
        g_flat += [golds[i] for i in idxs]
        n_flat += [docs[i]["negatives"] for i in idxs]
        ivs += result.intervals
        masked += result.masked
        r = restore_stats(ts, result)
        restore["documents"] += r["documents"]
        restore["exact"] += r["exact"]
        s = surrogate_stats(ts, [golds[i] for i in idxs], result)
        for key in surrogate:
            surrogate[key] += s[key]
    restore["rate"] = restore["exact"] / restore["documents"] if restore["documents"] else None
    surrogate["consistent_rate"] = (
        1 - surrogate["inconsistent"] / surrogate["entities"] if surrogate["entities"] else None
    )
    report["masking"] = {
        "residual": residual_stats(texts, g_flat, ivs, masked),
        "overmask": overmask_stats(texts, n_flat, ivs),
        "clinician": clinician_stats(texts, g_flat, ivs),
        "restore": restore,
        "surrogate": surrogate,
    }
    return report


def evaluate(detector: Detector, docs: Sequence[Mapping]) -> dict:
    preds, timings = run_detector(detector, docs)
    report = evaluate_detections(docs, preds)
    report["detector"] = detector.name
    report["window"] = {"size": WINDOW, "overlap": OVERLAP}
    if timings:
        report["latency_per_window"] = latency_summary(timings)
    return report


def rss_probe(
    detector: Detector,
    texts: Sequence[str],
    *,
    rss_mib: Callable[[], float],
    windowed: bool = True,
) -> list[dict]:
    """RSS before / after detecting each text, in the order given (shortest first).

    `windowed=True` is the production path (bounded by the window). `windowed=False`
    sends the whole text to the model in ONE call: this is the quadratic-memory case
    (`nlp-gliner2-memory-blowup`) and must only be run behind the memory guard.
    """
    rows = []
    for text in texts:
        before = rss_mib()
        started = time.perf_counter()
        if windowed:
            detect_document(detector, text)
        else:
            detector.detect_batch([text])
        rows.append(
            {
                "chars": len(text),
                "windowed": windowed,
                "rss_before_mib": round(before, 1),
                "rss_after_mib": round(rss_mib(), 1),
                "growth_mib": round(rss_mib() - before, 1),
                "seconds": round(time.perf_counter() - started, 3),
            }
        )
    return rows
