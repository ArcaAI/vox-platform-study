"""Tests for the StreamChunk model (models/stream.py)."""

from __future__ import annotations

from smr.models.stream import StreamChunk


class TestStreamChunkReasoningType:
    def test_reasoning_chunk_round_trips(self):
        chunk = StreamChunk(type="reasoning", content="Let me think about this...")

        dumped = chunk.model_dump_json()
        restored = StreamChunk.model_validate_json(dumped)

        assert restored.type == "reasoning"
        assert restored.content == "Let me think about this..."

    def test_reasoning_chunk_distinguishable_from_content_chunk(self):
        reasoning = StreamChunk(type="reasoning", content="thinking")
        content = StreamChunk(type="chunk", content="thinking")

        assert reasoning.type != content.type
