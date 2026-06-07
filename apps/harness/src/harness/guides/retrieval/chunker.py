"""Deterministic token-window chunker for institutional-knowledge ingestion.

Phase 3 slices an approved document into overlapping windows (~400-512 tokens,
10-20% overlap) before dense+sparse embedding. The chunker is **pure and
deterministic**: it tokenizes on whitespace and tracks each token's character
span, so every emitted :class:`Chunk` carries the exact source offsets
(``text == source[start_offset:end_offset]``) the persisted ``KnowledgeChunk``
rows round-trip. A real subword tokenizer is a noted follow-up; whitespace tokens
are a conservative over-estimate of model tokens (more chunks, never fewer), which
keeps each chunk safely inside the embedding model's context window.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict

# A "token" is a maximal run of non-whitespace characters (with its char span).
_TOKEN_RE = re.compile(r"\S+")


class Chunk(BaseModel):
    """One token-window slice of a source document (offsets are char-based)."""

    model_config = ConfigDict(extra="forbid")

    text: str
    chunk_index: int
    start_offset: int
    end_offset: int
    token_count: int


def chunk_text(text: str, *, chunk_size: int = 450, overlap: int = 64) -> list[Chunk]:
    """Slice ``text`` into overlapping token windows.

    ``chunk_size`` is the window length in whitespace tokens; ``overlap`` is the
    number of tokens shared between consecutive windows (the step is
    ``chunk_size - overlap``). Whitespace-only/empty input yields ``[]``.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer")
    if not (0 <= overlap < chunk_size):
        raise ValueError("overlap must satisfy 0 <= overlap < chunk_size")

    spans = [(m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    if not spans:
        return []

    step = chunk_size - overlap
    chunks: list[Chunk] = []
    i = 0
    while i < len(spans):
        window = spans[i : i + chunk_size]
        start = window[0][0]
        end = window[-1][1]
        chunks.append(
            Chunk(
                text=text[start:end],
                chunk_index=len(chunks),
                start_offset=start,
                end_offset=end,
                token_count=len(window),
            )
        )
        # Stop once this window reached the end (avoids a trailing duplicate/empty).
        if i + chunk_size >= len(spans):
            break
        i += step
    return chunks
