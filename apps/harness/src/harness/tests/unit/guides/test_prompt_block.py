"""StrictCitations prompt-block + citation-marker tests (Phase 3).

The retriever injects retrieved chunks into the generation prompt as a numbered
Knowledge Context, each item tagged with the chunk id the model MUST cite per
claim via the ``[[kb:<id>]]`` marker. ``extract_cited_ids`` parses those markers
back out (strict: only ids that were actually retrieved survive), which is how the
loop maps model citations onto ``citationsMap.knowledgeChunkIds``.
"""

from __future__ import annotations

from harness.guides.retrieval.prompt import (
    build_strict_citations_block,
    extract_cited_ids,
)
from harness.guides.retrieval.retriever import RetrievedChunk


def _chunks() -> list[RetrievedChunk]:
    return [
        RetrievedChunk(chunk_id="kc-1", text="First-line HTN therapy is a thiazide.", score=0.9),
        RetrievedChunk(chunk_id="kc-2", text="Metformin is first-line for T2DM.", score=0.8),
    ]


class TestPromptBlock:
    def test_empty_chunks_render_no_block(self):
        assert build_strict_citations_block([]) == ""

    def test_block_tags_each_chunk_with_its_id_and_text(self):
        block = build_strict_citations_block(_chunks())
        assert "kc-1" in block
        assert "kc-2" in block
        assert "thiazide" in block
        assert "Metformin" in block
        # The model is instructed to cite ids with the [[kb:<id>]] marker.
        assert "[[kb:" in block


class TestExtractCitedIds:
    def test_parses_markers_filtered_to_allowed_ids(self):
        text = "BP control [[kb:kc-1]] and glycemic control [[kb:kc-2]] and [[kb:kc-999]]."
        allowed = {"kc-1", "kc-2"}
        # kc-999 was never retrieved -> dropped (strict; no hallucinated citations).
        assert extract_cited_ids(text, allowed) == ["kc-1", "kc-2"]

    def test_dedupes_preserving_order(self):
        text = "[[kb:kc-2]] then [[kb:kc-1]] then [[kb:kc-2]]"
        assert extract_cited_ids(text, {"kc-1", "kc-2"}) == ["kc-2", "kc-1"]

    def test_no_markers_returns_empty(self):
        assert extract_cited_ids("plain note text", {"kc-1"}) == []
