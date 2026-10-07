"""Detections, span matching (strict / relaxed) and the production window de-dupe."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from .labels import compatible


@dataclass(frozen=True)
class Detection:
    """One detected span, `[start, end)`, in the coordinates of the text it was found in."""

    label: str  # canonical (see labels.py)
    start: int
    end: int
    score: float = 1.0
    raw_label: str = field(default="", compare=False)  # what the model called it

    def __post_init__(self) -> None:
        if not self.raw_label:
            object.__setattr__(self, "raw_label", self.label)


@dataclass
class MatchResult:
    tp: list[tuple[int, int]]  # (gold index, pred index)
    fn: list[int]
    fp: list[int]


def _overlap(a0: int, a1: int, b0: int, b1: int) -> int:
    return max(0, min(a1, b1) - max(a0, b0))


def match_spans(gold: Sequence[Mapping], pred: Sequence[Detection], mode: str) -> MatchResult:
    """One-to-one greedy alignment. `strict`: identical boundaries; `relaxed`: any overlap.

    Both need a compatible label. Candidate pairs are taken best-IoU first, ties broken by
    index, so the result is deterministic.
    """
    if mode not in ("strict", "relaxed"):
        raise ValueError(mode)
    pairs: list[tuple[float, int, int]] = []
    for gi, g in enumerate(gold):
        for pi, p in enumerate(pred):
            if not compatible(p.label, g["label"]):
                continue
            ov = _overlap(g["start"], g["end"], p.start, p.end)
            if ov == 0:
                continue
            if mode == "strict" and (g["start"], g["end"]) != (p.start, p.end):
                continue
            union = (g["end"] - g["start"]) + (p.end - p.start) - ov
            pairs.append((-(ov / union), gi, pi))
    pairs.sort()
    used_g: set[int] = set()
    used_p: set[int] = set()
    tp: list[tuple[int, int]] = []
    for _, gi, pi in pairs:
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        tp.append((gi, pi))
    return MatchResult(
        tp=tp,
        fn=[i for i in range(len(gold)) if i not in used_g],
        fp=[i for i in range(len(pred)) if i not in used_p],
    )


def dedupe_longest(spans: Sequence[Detection]) -> list[Detection]:
    """Intersecting spans of ONE text: longest wins, ties by higher score.

    Same rule as `apps/guardrail/.../services/windowing.py:dedupe_longest` (kept here
    because that module imports guardrail's metrics); parity is covered by the tests.
    """
    kept: list[Detection] = []
    for span in sorted(spans, key=lambda s: (-(s.end - s.start), -s.score, s.start)):
        if any(k.start < span.end and span.start < k.end for k in kept):
            continue
        kept.append(span)
    kept.sort(key=lambda s: s.start)
    return kept
