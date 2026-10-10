"""Region-aligned windows for every ML screen (TASK-1047 D4).

`apps/nlp`'s GLiNER2 runs a whole text in ONE forward pass, and its memory is
quadratic in the input length (16k chars ≈ 11 GiB). So guardrail never sends more
than one window per peer call, on any path:

* a **region** is one data block (or one untrusted segment, or the whole legacy
  `text`); windows are cut from the REGION's own start — size ``W``, overlap
  ``O`` — so an append-only region (the transcript) yields byte-identical earlier
  windows on every flush, which is what makes the verdict cache hit;
* the windows of one request run under a BOUNDED concurrency (a semaphore shared
  by every run of that request), never a `gather` of all of them;
* each window's verdict is looked up in / written to the window-verdict cache
  (`services/window_cache.py`) when one is configured.

Spans found in a window are re-based to REGION offsets; the duplicates two
overlapping windows both see are resolved longest-span-wins.

TASK-1059 C-1: the medical judge PACKS instead (:func:`pack_regions`) — small regions share a
window up to the geometry's size and only a region longer than a window is cut — and a window the
judge lane SHED is retried on its own (:func:`is_shed_judge_error`, OD-6).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any

from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.core.metrics import (
    observe_window_latency,
    record_screen_chars_computed,
    record_window_results,
)
from guardrail.services.window_cache import WindowVerdictCache


@dataclass(frozen=True)
class WindowGeometry:
    """How a region is cut: window size, overlap, and per-request concurrency."""

    size: int
    overlap: int
    concurrency: int


@dataclass(frozen=True)
class Window:
    """One window of one region. ``offset`` indexes the REGION's text."""

    region: str | None
    offset: int
    text: str


@dataclass(frozen=True)
class RegionSpan:
    """One span in REGION coordinates. ``region`` is ``None`` for a legacy `text`."""

    region: str | None
    label: str
    start: int
    end: int
    score: float


def iter_windows(text: str, size: int, overlap: int) -> Iterator[tuple[int, str]]:
    """Cover the WHOLE text. The last window is short, never dropped."""
    if not text:
        return
    step = max(1, size - max(0, overlap))
    start = 0
    while start < len(text):
        yield start, text[start : start + size]
        if start + size >= len(text):
            return
        start += step


def region_windows(region: str | None, text: str, geometry: WindowGeometry) -> list[Window]:
    """The windows of one region, cut from its own start."""
    return [
        Window(region=region, offset=offset, text=chunk)
        for offset, chunk in iter_windows(text, geometry.size, geometry.overlap)
    ]


#: Joins the regions packed into one window. Counted against the window size.
PACK_SEPARATOR = "\n\n"


@dataclass(frozen=True)
class PackedWindow:
    """One window of the size-packed plan. ``members`` index the input regions it carries."""

    text: str
    members: tuple[int, ...]


def pack_regions(
    regions: Sequence[tuple[str, str]], geometry: WindowGeometry
) -> list[PackedWindow]:
    """Size-based windows over ``(key, text)`` regions (TASK-1059 C-1, amendment A-1).

    A region longer than ``geometry.size`` is cut into its own windows from its own start (so an
    append-only transcript keeps byte-identical earlier windows). Every other region goes, in
    request order, into the FIRST window that still has room (first-fit), joined by
    :data:`PACK_SEPARATOR`; a new window opens only when none has. A short region therefore never
    gets a window of its own when it can share one. Empty regions yield nothing.
    """
    size = max(1, int(geometry.size))
    slots: list[tuple[list[int], list[str]]] = []
    packable: list[int] = []
    for index, (key, text) in enumerate(regions):
        if not text:
            continue
        if len(text) > size:
            slots.extend(([index], [w.text]) for w in region_windows(key, text, geometry))
            continue
        for slot in packable:
            members, texts = slots[slot]
            used = sum(len(t) for t in texts) + len(PACK_SEPARATOR) * len(texts)
            if used + len(text) <= size:
                members.append(index)
                texts.append(text)
                break
        else:
            packable.append(len(slots))
            slots.append(([index], [text]))
    return [PackedWindow(PACK_SEPARATOR.join(texts), tuple(members)) for members, texts in slots]


#: OD-6 — a window the judge lane shed is retried on its own this many times, with a linear
#: backoff (attempt N waits N x the backoff), before it fails the request closed.
SHED_RETRIES = 2
SHED_RETRY_BACKOFF_S = 1.0


def is_shed_judge_error(exc: BaseException) -> bool:
    """True when the judge client's failure was a 503 from text ``/internal/judge``.

    A 503 there (``CONCURRENCY_LIMIT``: the judge lane's bounded queue is full; or the lane's
    breaker) started no judgement, so asking again cannot stack load. A TIMEOUT is never a shed:
    that judgement is still running on the shared GPU. The judge client folds the HTTP error into
    :class:`GuardrailUndeterminedError`'s detail, which is the only place the status survives.
    """
    return (
        isinstance(exc, GuardrailUndeterminedError)
        and exc.reason == REASON_ENGINE_ERROR
        and "'503 " in exc.detail
    )


def dedupe_longest(spans: Sequence[RegionSpan]) -> list[RegionSpan]:
    """Resolve intersecting spans of ONE region longest-span-wins (ties: higher score).

    Two overlapping windows report the same entity twice — or one of them reports
    it clipped at its boundary. The longest reading is the one that masks the whole
    identifier. Spans of different regions are never compared.
    """
    kept: list[RegionSpan] = []
    for span in sorted(spans, key=lambda s: (-(s.end - s.start), -s.score, s.start)):
        if any(k.region == span.region and k.start < span.end and span.start < k.end for k in kept):
            continue
        kept.append(span)
    order: dict[str | None, int] = {}
    for span in spans:
        order.setdefault(span.region, len(order))
    kept.sort(key=lambda s: (order[s.region], s.start))
    return kept


class WindowRunner:
    """Runs one request's windows: cache first, then bounded concurrent compute.

    One runner per REQUEST: its semaphore is the per-request concurrency bound,
    shared by every task the request runs (classify and PII spans together).
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        policy_version: str | None,
        cache: WindowVerdictCache | None,
        concurrency: int,
    ) -> None:
        self.tenant_id = tenant_id
        self.policy_version = policy_version
        # No policy version ⇒ no key can be formed safely ⇒ no cache. Computing
        # every window is always correct; reusing one under an unknown policy is not.
        self.cache = cache if policy_version else None
        self._semaphore = asyncio.Semaphore(max(1, int(concurrency)))

    async def run(
        self,
        task: str,
        model_id: str,
        texts: Sequence[str],
        compute: Callable[[str], Awaitable[dict[str, Any]]],
        *,
        project: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        complete: Callable[[dict[str, Any]], bool] | None = None,
        retry: Callable[[BaseException], bool] | None = None,
    ) -> list[dict[str, Any]]:
        """One verdict per text, in order. Any failing window fails the whole run.

        ``compute`` returns the full verdict; ``project`` (default: identity) is the
        TEXT-FREE part that is cached. A hit returns the projection, a miss the
        full verdict — callers read only projected fields for the decision.

        ``complete`` (TASK-1050 follow-up I; default: everything is complete) says whether a
        verdict answers everything the request asked. An INCOMPLETE computed verdict is used
        for this request but never stored, and an incomplete cached entry is a miss.
        """
        family = task.split(":", 1)[0]
        project = project or (lambda value: value)
        results: list[dict[str, Any] | None] = [None] * len(texts)
        keys: list[str | None] = [None] * len(texts)
        misses: list[int] = []

        cache = self.cache
        if cache is not None and self.policy_version:
            for index, text in enumerate(texts):
                key = cache.key(self.tenant_id, self.policy_version, model_id, task, text)
                keys[index] = key
                hit = await cache.get(key)
                if hit is not None and complete is not None and not complete(hit):
                    hit = None
                if hit is None:
                    misses.append(index)
                else:
                    results[index] = hit
        else:
            misses = list(range(len(texts)))

        async def _one(index: int) -> None:
            attempt = 0
            while True:
                try:
                    async with self._semaphore:
                        started = time.monotonic()
                        try:
                            value = await compute(texts[index])
                        finally:
                            observe_window_latency(family, time.monotonic() - started)
                    break
                except Exception as exc:
                    if retry is None or attempt >= SHED_RETRIES or not retry(exc):
                        raise
                    attempt += 1
                    await asyncio.sleep(SHED_RETRY_BACKOFF_S * attempt)
            results[index] = value
            key = keys[index]
            if cache is not None and key is not None and (complete is None or complete(value)):
                await cache.set(key, project(value))

        outcomes = await asyncio.gather(*(_one(i) for i in misses), return_exceptions=True)
        record_window_results(
            family, requested=len(texts), computed=len(misses), cached=len(texts) - len(misses)
        )
        record_screen_chars_computed(family, sum(len(texts[i]) for i in misses))
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                # Fail CLOSED: a partially-screened request is never answered as
                # if it were complete.
                raise outcome
        return [value if value is not None else {} for value in results]
