"""PII span extraction over bounded pieces of text.

GLiNER's cost is super-linear (memory: quadratic) in input length, so no peer call
ever carries a whole document. Two shapes, one per caller:

* :func:`windowed_spans` — the SCREEN paths (inbound `pii_spans`, outbound
  `pii_leak`; TASK-1047 D4). Region-aligned overlapping windows, cached per
  window, re-based to REGION offsets, overlap duplicates resolved
  longest-span-wins.
* :func:`extract_spans` — `/guardrail/redact`. Separator-cut chunks, so an
  identifier is never split in half — the property masking needs — with offsets
  re-based onto the submitted document.

Both run under a BOUNDED concurrency (TASK-1047): TASK-1035 extracted every chunk
at once, which moved the latency cost off this process but handed `apps/nlp` an
unbounded burst per request. Any piece failing fails the whole extraction: a
partially-extracted document is never answered as if it were complete.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from guardrail.services.windowing import (
    RegionSpan,
    WindowGeometry,
    WindowRunner,
    dedupe_longest,
    region_windows,
)

#: Cache task name for a PII span window (FC-7 `<task>`; metrics family `pii`).
PII_TASK = "pii"

#: Split points, most-preferred first. The DNA corpus separator comes first so a
#: chunk boundary lands between two whole samples where possible.
CHUNK_SEPARATORS = ("\n\n---\n\n", "\n\n", "\n", ". ", " ")


@dataclass(frozen=True)
class DocumentSpan:
    """One PII span with offsets re-based onto the SUBMITTED document."""

    label: str
    start: int
    end: int
    score: float


def split_for_extraction(text: str, chunk_chars: int) -> list[str]:
    """Partition `text` into chunks of at most `chunk_chars`, cutting on a separator.

    A run of `chunk_chars` with no separator at all is cut hard rather than growing
    the chunk without limit. The result is a pure partition —
    `"".join(result) == text`.
    """
    if chunk_chars <= 0 or len(text) <= chunk_chars:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        if len(text) - start <= chunk_chars:
            chunks.append(text[start:])
            break

        window = text[start : start + chunk_chars]
        cut = -1
        for separator in CHUNK_SEPARATORS:
            # `rfind` keeps the separator at the END of the current chunk, so
            # joining the chunks reproduces the input exactly.
            found = window.rfind(separator)
            if found > 0:
                cut = found + len(separator)
                break

        if cut <= 0:
            cut = chunk_chars  # no boundary in range — hard cut, bound wins
        chunks.append(text[start : start + cut])
        start += cut

    return chunks


async def extract_spans(
    extract: Callable[[str], Awaitable[list[Any]]],
    text: str,
    chunk_chars: int,
    *,
    concurrency: int = 4,
) -> list[DocumentSpan]:
    """Extract PII spans over bounded chunks, ``concurrency`` at a time, in document coordinates."""
    chunks = split_for_extraction(text, chunk_chars)
    if not chunks:
        return []

    offsets: list[int] = []
    position = 0
    for chunk in chunks:
        offsets.append(position)
        position += len(chunk)

    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def _one(chunk: str) -> list[Any]:
        async with semaphore:
            return await extract(chunk)

    results = await asyncio.gather(*(_one(chunk) for chunk in chunks))

    spans: list[DocumentSpan] = []
    for offset, entities in zip(offsets, results, strict=True):
        for entity in entities or []:
            spans.append(
                DocumentSpan(
                    label=str(entity.label),
                    start=int(entity.start) + offset,
                    end=int(entity.end) + offset,
                    score=float(entity.score),
                )
            )
    spans.sort(key=lambda span: span.start)
    return spans


def _span_value(entities: list[Any]) -> dict[str, Any]:
    """A window's span verdict as cacheable data: ``[label, start, end, score]``, no text."""
    return {
        "spans": [[str(e.label), int(e.start), int(e.end), float(e.score)] for e in entities or []]
    }


async def windowed_spans(
    runner: WindowRunner,
    extract: Callable[[str], Awaitable[list[Any]]],
    model_id: str,
    regions: list[tuple[str | None, str]],
    geometry: WindowGeometry,
    *,
    retry_once: Callable[[BaseException], bool] | None = None,
) -> list[RegionSpan]:
    """PII spans of every region, window by window, in REGION coordinates.

    Each region is cut from its own start (an append-only region therefore re-uses
    every earlier window's cached verdict), and the overlap duplicates are resolved
    longest-span-wins.

    ``retry_once`` (TASK-1063 item 5a): a window whose extraction fails with an error it
    accepts is extracted ONE more time; a second failure fails the run as before.
    """
    windows = [w for key, text in regions for w in region_windows(key, text, geometry)]
    if not windows:
        return []

    async def _compute(window_text: str) -> dict[str, Any]:
        try:
            return _span_value(await extract(window_text))
        except Exception as exc:
            if retry_once is None or not retry_once(exc):
                raise
        return _span_value(await extract(window_text))

    verdicts = await runner.run(PII_TASK, model_id, [w.text for w in windows], _compute)

    spans: list[RegionSpan] = []
    for window, verdict in zip(windows, verdicts, strict=True):
        for label, start, end, score in verdict.get("spans") or []:
            spans.append(
                RegionSpan(
                    region=window.region,
                    label=str(label),
                    start=int(start) + window.offset,
                    end=int(end) + window.offset,
                    score=float(score),
                )
            )
    return dedupe_longest(spans)
