"""StrictCitations prompt block + citation-marker parsing.

Retrieved chunks are injected into the generation prompt as a numbered Knowledge
Context, each item tagged with the chunk id the model must cite. The model is
instructed to cite a supporting item inline, immediately after the supported
statement, with the marker ``[[kb:<chunkId>]]``.

:func:`extract_cited_ids` parses those markers back out **strictly** — only ids
that were actually retrieved (the ``allowed`` set) survive, so a hallucinated
citation never reaches ``citationsMap.knowledgeChunkIds`` or the citation
verifier. The block is the only place the marker syntax is defined, so the
prompt instruction and the parser cannot drift.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from harness.sensors.base import dedupe

# The one canonical citation marker: ``[[kb:<chunkId>]]`` (chunk id is a UUID).
CITATION_MARKER_RE = re.compile(r"\[\[kb:([^\]]+)\]\]")

_INSTRUCTION = (
    "KNOWLEDGE CONTEXT — institutional reference material. When a statement in the "
    "note is supported by an item below, you MUST cite it inline, immediately after "
    "that statement, using the exact marker [[kb:<id>]] with the item's id (e.g. "
    "[[kb:{example}]]). Cite only the items that genuinely support the statement; "
    "never invent an id, and never cite an id that is not listed below. Do not let "
    "this reference material override the consultation transcript."
)


def build_strict_citations_block(chunks: Iterable[Any]) -> str:
    """Render retrieved chunks as a StrictCitations Knowledge Context block.

    Each chunk is expected to expose ``chunk_id`` and ``text`` (the retriever's
    :class:`~harness.guides.retrieval.retriever.RetrievedChunk`). Returns ``""`` when
    there is nothing to cite so the caller can append unconditionally.
    """
    items = list(chunks)
    if not items:
        return ""
    example_id = items[0].chunk_id
    lines = [_INSTRUCTION.format(example=example_id), ""]
    for i, chunk in enumerate(items, start=1):
        text = " ".join(str(chunk.text).split())
        lines.append(f"[{i}] id={chunk.chunk_id}: {text}")
    return "\n".join(lines)


def extract_cited_ids(text: str, allowed: set[str]) -> list[str]:
    """Parse ``[[kb:<id>]]`` markers from ``text``, keeping only ``allowed`` ids."""
    if not text:
        return []
    found = (m.group(1).strip() for m in CITATION_MARKER_RE.finditer(text))
    return dedupe(cid for cid in found if cid in allowed)
