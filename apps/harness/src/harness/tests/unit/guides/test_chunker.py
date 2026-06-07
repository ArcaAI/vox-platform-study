"""Token-window chunker tests (RED-first, TASK-330 Phase 3).

The ingest endpoint slices an approved document into overlapping token windows
(~400-512 tokens / 10-20% overlap). The chunker is pure + deterministic: every
chunk's ``text`` must be the exact source substring ``[start_offset:end_offset]``
so the persisted offsets round-trip, consecutive chunks overlap, and
whitespace-only input yields no chunks.
"""

from __future__ import annotations

from harness.guides.retrieval.chunker import Chunk, chunk_text


def _words(n: int) -> str:
    return " ".join(f"w{i}" for i in range(n))


class TestChunker:
    def test_short_text_is_a_single_chunk(self):
        text = "Patient has hypertension and diabetes"
        chunks = chunk_text(text, chunk_size=450, overlap=64)
        assert len(chunks) == 1
        c = chunks[0]
        assert isinstance(c, Chunk)
        assert c.chunk_index == 0
        assert c.token_count == 5
        assert c.start_offset == 0
        assert c.end_offset == len(text)
        assert c.text == text

    def test_offsets_round_trip_to_source_substring(self):
        text = _words(12)
        chunks = chunk_text(text, chunk_size=5, overlap=2)
        for c in chunks:
            assert c.text == text[c.start_offset : c.end_offset]

    def test_overlapping_windows_are_deterministic(self):
        # 12 tokens, window 5, overlap 2 -> step 3 -> windows [0:5],[3:8],[6:11],[9:12].
        text = _words(12)
        chunks = chunk_text(text, chunk_size=5, overlap=2)
        assert [c.chunk_index for c in chunks] == [0, 1, 2, 3]
        assert [c.token_count for c in chunks] == [5, 5, 5, 3]
        # Consecutive chunks share `overlap` tokens (w3 w4 are in both chunk 0 and 1).
        assert "w3 w4" in chunks[0].text
        assert chunks[1].text.startswith("w3 w4")

    def test_whitespace_only_yields_no_chunks(self):
        assert chunk_text("   \n\t  ", chunk_size=10, overlap=2) == []
        assert chunk_text("", chunk_size=10, overlap=2) == []

    def test_exact_multiple_has_no_trailing_empty_chunk(self):
        text = _words(10)
        chunks = chunk_text(text, chunk_size=5, overlap=0)
        assert [c.token_count for c in chunks] == [5, 5]
        assert "".join(c.text for c in chunks).replace(" ", "") == text.replace(" ", "")

    def test_token_count_matches_whitespace_tokens(self):
        text = "  multiple   spaces\tand\nnewlines here  "
        chunks = chunk_text(text, chunk_size=450, overlap=64)
        assert len(chunks) == 1
        assert chunks[0].token_count == 5  # multiple/spaces/and/newlines/here


class TestChunkerValidation:
    def test_overlap_must_be_less_than_chunk_size(self):
        import pytest

        with pytest.raises(ValueError):
            chunk_text("a b c", chunk_size=4, overlap=4)

    def test_chunk_size_must_be_positive(self):
        import pytest

        with pytest.raises(ValueError):
            chunk_text("a b c", chunk_size=0, overlap=0)
