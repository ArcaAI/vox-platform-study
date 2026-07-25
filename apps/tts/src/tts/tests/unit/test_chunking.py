"""TDD tests for text segmentation / chunking."""

from __future__ import annotations

from tts.routing.chunking import chunk_text, segment

_CS4 = (
    "Chest X-ray-യിൽ right lower lobe-ൽ consolidation കാണുന്നു, "
    "community-acquired pneumonia സംശയിക്കുന്നു."
)


class TestSegment:
    def test_english_two_sentences(self) -> None:
        assert len(segment("Hello world. How are you?", "en-IN")) == 2

    def test_codeswitch_single_sentence_not_split(self) -> None:
        segs = segment(_CS4, "ml-IN")
        assert len(segs) == 1
        assert "X-ray-യിൽ" in segs[0]  # Latin+Malayalam agglutination intact

    def test_decimal_and_ratio_not_split(self) -> None:
        segs = segment("HbA1c 8.2 ശതമാനം; BP 140/90 mmHg ആണ്.", "ml-IN")
        assert any("8.2" in s for s in segs)  # decimal not a boundary
        assert any("140/90" in s for s in segs)  # ratio not a boundary

    def test_two_malayalam_sentences(self) -> None:
        assert len(segment("രോഗിക്ക് പനി ഉണ്ട്. മരുന്ന് കഴിക്കണം.", "ml-IN")) == 2


class TestChunkText:
    def test_order_preserved(self) -> None:
        out = chunk_text("One. Two. Three.", "en-IN", 4096)
        assert len(out) == 3
        assert out[0].startswith("One") and out[-1].startswith("Three")

    def test_long_sentence_hard_wrapped(self) -> None:
        long_sentence = ("word " * 2000).strip()  # ~10k chars, no boundary
        out = chunk_text(long_sentence, "en-IN", 100)
        assert len(out) > 1
        assert all(len(c) <= 100 for c in out)

    def test_never_empty(self) -> None:
        assert chunk_text("hello", "en-IN", 4096) == ["hello"]
