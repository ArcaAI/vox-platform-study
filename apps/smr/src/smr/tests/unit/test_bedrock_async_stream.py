"""TDD tests for Bedrock async stream bridge (Phase 4, Task 4.1).

The original generate_stream() calls asyncio.to_thread() to get the boto3
response, then iterates the EventStream synchronously with ``for event in
response["stream"]``, which **blocks the event loop** on every next() call
because boto3's streaming response is a synchronous iterator that performs
network I/O.

The fix uses an asyncio.Queue bridge: a background thread iterates the sync
stream and pushes events via call_soon_threadsafe, while the async generator
awaits queue.get().
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock, patch

import pytest

from smr.core.config import BedrockConfig
from smr.models.requests import GenerateRequest
from smr.models.stream import StreamChunk

# ── Helpers ──────────────────────────────────────────────────────────────────


class MockEventStream:
    """Simulates boto3 EventStream — a synchronous iterator that would
    normally perform blocking network reads on each next() call."""

    def __init__(self, events: list[dict], *, delay: float = 0.0):
        self._events = events
        self._index = 0
        self._delay = delay

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._events):
            raise StopIteration
        if self._delay:
            time.sleep(self._delay)
        event = self._events[self._index]
        self._index += 1
        return event


class ErrorEventStream:
    """Simulates a boto3 EventStream that raises mid-iteration."""

    def __init__(self, events_before_error: list[dict], error: Exception):
        self._events = events_before_error
        self._error = error
        self._index = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._events):
            raise self._error
        event = self._events[self._index]
        self._index += 1
        return event


def _make_provider():
    """Create a BedrockProvider with mocked boto3 clients."""
    from smr.providers.bedrock import BedrockProvider

    config = BedrockConfig(region="us-east-1")
    with patch("boto3.client"):
        provider = BedrockProvider(config)
    provider._client = MagicMock()
    return provider


# ── Tests ────────────────────────────────────────────────────────────────────


class TestBedrockAsyncStream:
    """Verify generate_stream() uses an async queue bridge and does not block
    the event loop."""

    @pytest.mark.asyncio
    async def test_stream_yields_chunks_in_order(self):
        """Content chunks must arrive in the same order as the EventStream."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"text": "Hello"}}},
                {"contentBlockDelta": {"delta": {"text": " world"}}},
                {"contentBlockDelta": {"delta": {"text": "!"}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ])
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) == 3
        assert text_chunks[0].content == "Hello"
        assert text_chunks[1].content == " world"
        assert text_chunks[2].content == "!"

    @pytest.mark.asyncio
    async def test_stream_yields_reasoning_chunk(self):
        """A reasoningContent delta must produce a reasoning StreamChunk."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking..."}}}},
                {"contentBlockDelta": {"delta": {"text": "Answer"}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ])
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        reasoning_chunks = [c for c in chunks if c.type == "reasoning"]
        content_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(reasoning_chunks) == 1
        assert reasoning_chunks[0].content == "Thinking..."
        assert len(content_chunks) == 1
        assert content_chunks[0].content == "Answer"

    @pytest.mark.asyncio
    async def test_stream_yields_done_chunk(self):
        """A messageStop event must produce a done StreamChunk with finish_reason."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"text": "Hi"}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ])
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        done_chunks = [c for c in chunks if c.type == "done"]
        assert len(done_chunks) == 1
        assert done_chunks[0].data == {"finish_reason": "end_turn"}

    @pytest.mark.asyncio
    async def test_stream_yields_usage_chunk(self):
        """A metadata event with usage must produce a usage StreamChunk."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"text": "Ok"}}},
                {"messageStop": {"stopReason": "end_turn"}},
                {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}},
            ])
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        # AD-1: the usage chunk now carries the FULL GenerationStats dict
        # (``predicted_tokens`` not ``completion_tokens``) with the real
        # normalized stop reason, emitted once after the stream drains.
        usage_chunks = [c for c in chunks if c.type == "usage"]
        assert len(usage_chunks) == 1
        data = usage_chunks[0].data
        assert data["prompt_tokens"] == 10
        assert data["predicted_tokens"] == 5
        assert data["total_tokens"] == 15
        assert data["stop_reason"] == "stop"  # end_turn → stop (Bedrock table)

    @pytest.mark.asyncio
    async def test_stream_handles_empty_text(self):
        """Events with empty text in contentBlockDelta must be skipped."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"text": "A"}}},
                {"contentBlockDelta": {"delta": {"text": ""}}},
                {"contentBlockDelta": {"delta": {"text": "B"}}},
                {"contentBlockDelta": {"delta": {}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ])
        }

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) == 2
        assert text_chunks[0].content == "A"
        assert text_chunks[1].content == "B"

    @pytest.mark.asyncio
    async def test_stream_propagates_exception(self):
        """If boto3 raises during iteration, the exception must propagate to the caller."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": ErrorEventStream(
                events_before_error=[
                    {"contentBlockDelta": {"delta": {"text": "partial"}}},
                ],
                error=RuntimeError("connection reset"),
            )
        }

        chunks: list[StreamChunk] = []
        with pytest.raises(RuntimeError, match="connection reset"):
            async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
                chunks.append(chunk)

        assert len(chunks) == 1
        assert chunks[0].content == "partial"

    @pytest.mark.asyncio
    async def test_stream_does_not_block_event_loop(self):
        """Prove the event loop stays responsive *during* streaming.

        Strategy: each mock event sleeps 0.08s (simulating blocking network
        I/O).  We schedule a concurrent probe that waits 0.1s (so the sync
        iteration has definitely started), then tries ``await asyncio.sleep(0)``
        and records when it completes.

        If the event loop is blocked by synchronous iteration, the probe's
        sleep(0) won't resolve until the entire stream finishes (~0.56s).
        With a proper async bridge the probe completes at ~0.1s.
        """
        per_event_delay = 0.08
        n_events = 6
        total_stream_time = per_event_delay * (n_events + 1)

        provider = _make_provider()
        events = [
            {"contentBlockDelta": {"delta": {"text": f"tok{i}"}}}
            for i in range(n_events)
        ] + [{"messageStop": {"stopReason": "end_turn"}}]

        provider._client.converse_stream.return_value = {
            "stream": MockEventStream(events, delay=per_event_delay)
        }

        probe_completed_at: float | None = None
        t0 = time.monotonic()

        async def probe():
            nonlocal probe_completed_at
            await asyncio.sleep(0.1)
            await asyncio.sleep(0)
            probe_completed_at = time.monotonic() - t0

        probe_task = asyncio.create_task(probe())

        chunks: list[StreamChunk] = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
            chunks.append(chunk)

        await probe_task

        assert probe_completed_at is not None, "Probe never completed"
        assert probe_completed_at < total_stream_time, (
            f"Probe completed at {probe_completed_at:.3f}s but total stream "
            f"time is {total_stream_time:.2f}s — event loop was blocked by "
            f"synchronous stream iteration."
        )
        assert len([c for c in chunks if c.type == "chunk"]) == n_events

    @pytest.mark.asyncio
    async def test_stream_sets_span_attributes(self):
        """OTel span attributes must be set for finish_reason and token usage."""
        provider = _make_provider()
        provider._client.converse_stream.return_value = {
            "stream": MockEventStream([
                {"contentBlockDelta": {"delta": {"text": "Hi"}}},
                {"messageStop": {"stopReason": "end_turn"}},
                {"metadata": {"usage": {"inputTokens": 42, "outputTokens": 17}}},
            ])
        }

        mock_span = MagicMock()
        mock_tracer = MagicMock()
        mock_tracer.start_as_current_span.return_value.__enter__ = MagicMock(return_value=mock_span)
        mock_tracer.start_as_current_span.return_value.__exit__ = MagicMock(return_value=False)

        with patch("smr.providers.bedrock._get_tracer", return_value=mock_tracer):
            chunks: list[StreamChunk] = []
            async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", model="anthropic.claude-3-5-haiku-20241022-v1:0")):
                chunks.append(chunk)

        calls = {
            call.args[0]: call.args[1]
            for call in mock_span.set_attribute.call_args_list
        }
        assert calls["gen_ai.response.finish_reason"] == "end_turn"
        assert calls["gen_ai.usage.input_tokens"] == 42
        assert calls["gen_ai.usage.output_tokens"] == 17
