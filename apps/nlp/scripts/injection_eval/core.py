"""Pure helpers for the TASK-1049 evaluation (windows, segments, scores, statistics)."""

from __future__ import annotations

import random
from collections.abc import Iterator, Mapping, Sequence

from scipy.stats import beta


def iter_windows(text: str, size: int, overlap: int) -> Iterator[tuple[int, str]]:
    """Copy of guardrail's `services/windowing.py:iter_windows` (parity is tested)."""
    if not text:
        return
    step = max(1, size - max(0, overlap))
    start = 0
    while start < len(text):
        yield start, text[start : start + size]
        if start + size >= len(text):
            return
        start += step


def token_segments(n_tokens: int, *, max_tokens: int, overlap: int) -> list[tuple[int, int]]:
    """`[start, end)` content-token ranges covering all `n_tokens`, each <= `max_tokens`.

    The model card of Prompt Guard 2 asks for long inputs to be split and every segment
    scored; a window is then as malicious as its worst segment.
    """
    segments: list[tuple[int, int]] = []
    step = max_tokens - overlap
    start = 0
    while start < n_tokens:
        end = min(start + max_tokens, n_tokens)
        segments.append((start, end))
        if end == n_tokens:
            break
        start += step
    return segments


def attack_score(scores: Mapping[str, float], *, attack: set[str], benign: set[str]) -> float:
    """The window's attack score: the highest attack-label score (0.0 if none present).

    A label that is neither attack nor benign raises: a mapping mistake must never be
    read as "benign".
    """
    unknown = set(scores) - attack - benign
    if unknown:
        raise ValueError(f"unknown label(s) {sorted(unknown)}")
    return max((s for label, s in scores.items() if label in attack), default=0.0)


def embed_payload(
    base: str, payload: str, carrier: str, rng: random.Random, *, max_chars: int
) -> str:
    """Insert `"<carrier>: <payload>"` as its own line at a random line boundary of `base`.

    `base` is first trimmed (at a line boundary) so the result fits in `max_chars`.
    """
    line = f"{carrier}: {payload}" if carrier else payload
    budget = max_chars - len(line) - 1
    lines = base.split("\n")
    kept: list[str] = []
    used = 0
    for item in lines:
        if used + len(item) + 1 > budget:
            break
        kept.append(item)
        used += len(item) + 1
    position = rng.randint(0, len(kept))
    kept.insert(position, line)
    return "\n".join(kept)[:max_chars]


def straddle_payload(base: str, payload: str, *, size: int, overlap: int) -> str:
    """A region where no single window holds the whole of `payload`.

    The payload starts one character before the second window's offset and runs past
    the end of the first window. Only possible when `len(payload) > overlap`: with the
    production geometry any payload of <= 256 chars is always wholly inside a window.
    """
    if len(payload) <= overlap + 1:
        raise ValueError("payload must be longer than the overlap to straddle")
    start = size - overlap - 1
    return base[:start] + payload + base[start:]


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Exact ONE-SIDED (1-alpha) Clopper-Pearson bounds: ``(lower, upper)``.

    One-sided because every claim made with them is one-sided ("FP rate is at most",
    "recall is at least"). For k = 0 the upper bound is exactly ``1 - alpha**(1/n)``.
    """
    if n == 0:
        return 0.0, 1.0
    lo = 0.0 if k == 0 else float(beta.ppf(alpha, k, n - k + 1))
    hi = 1.0 if k == n else float(beta.ppf(1 - alpha, k + 1, n - k))
    return lo, hi


def select_threshold(dev_benign_scores: Sequence[float], target_fpr: float) -> float:
    """Smallest threshold whose FP rate on the DEV benign scores is <= `target_fpr`.

    A window is flagged when `score >= threshold`. Takes the dev split only, by shape.
    """
    ordered = sorted(dev_benign_scores, reverse=True)
    allowed = int(target_fpr * len(ordered))  # flagged benign windows we may keep
    if allowed >= len(ordered):
        return 0.0
    # Everything strictly above ordered[allowed] may be flagged (<= allowed items).
    cut = ordered[allowed]
    return float(cut) + 1e-9


def render_golden_case(case: dict) -> str:
    """One multi-encounter golden case as ONE data region: ``Speaker: text`` lines.

    This is the rendering that reproduces TASK-1047 §8.6's 75 windows at 2,000 / 256
    over `multi_encounter_v1.json` (other renderings give 67-97; see the README).
    """
    transcript = case["transcript"]
    return "\n".join(
        f"{segment['speaker']}: {segment['text']}"
        for encounter in transcript["encounters"]
        for segment in encounter["segments"]
    )
