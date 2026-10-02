"""Chunked PII span extraction, shared by `/guardrail/redact` and the inbound screen.

GLiNER's cost is super-linear in input length, so a long text is partitioned into
bounded chunks (cut on a separator so an identifier is never split in half) and
each chunk's offsets are re-based onto the submitted document.

The chunks are extracted CONCURRENTLY (TASK-1035 §3.2). The model runs in
`apps/nlp`, behind its own admission and batching, so the memory argument that
once kept this loop sequential belongs to the peer, not to this process; what this
side owns is latency, and a sequential loop paid one full round trip per chunk.
Any chunk failing fails the whole extraction: a partially-extracted document is
never answered as if it were complete.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

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
) -> list[DocumentSpan]:
    """Extract PII spans over bounded chunks, in parallel, in document coordinates."""
    chunks = split_for_extraction(text, chunk_chars)
    if not chunks:
        return []

    offsets: list[int] = []
    position = 0
    for chunk in chunks:
        offsets.append(position)
        position += len(chunk)

    results = await asyncio.gather(*(extract(chunk) for chunk in chunks))

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
