"""TASK-818 — a STREAMED generation must return its socket to the pool.

Lane A (B-2) made the SDK client cache hit on every request and Lane B-8 gave
each upstream one pooled transport, and both were verifiably working — yet the
TLS benchmark still measured `1.000 conn/req` at concurrency 1: a brand-new
handshake for every streamed generation, which is precisely the cost those two
caches exist to remove.

The drop is below both of them. `openai.AsyncStream.__stream__` `break`s out of
its SSE loop on `data: [DONE]` and then closes the response in its `finally`.
No application bytes remain — but the HTTP end-of-body marker has not been read,
so httpcore sees a partially-consumed response and TEARS THE CONNECTION DOWN
instead of parking it for reuse. The non-streaming path never had the problem,
because it reads its body to completion.

So the assertion that matters is not "the cache returns the same client" (Lane A
already locks that, and it stayed true throughout) but "N streamed generations
open ONE connection". This exercises the real pooled transport against a real
loopback HTTP/1.1 server that counts accepted connections; nothing is mocked
between `AsyncOpenAI` and the socket, because everything that was mocked out was
where the bug lived.
"""

from __future__ import annotations

import asyncio
import json

import httpx2
import pytest
from openai import AsyncOpenAI

from text.providers.pool import (
    DRAIN_ON_CLOSE_MAX_BYTES,
    TransportFamily,
    _DrainOnCloseMixin,
    pooled_http_client,
    reset_pooled_clients,
)

_TOKENS = 8


def _sse_body(*, done: bool = True) -> bytes:
    """One OpenAI-wire SSE stream, exactly as an engine sends it."""
    parts = []
    for i in range(_TOKENS):
        chunk = {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "m",
            "choices": [{"index": 0, "delta": {"content": f"t{i}"}, "finish_reason": None}],
        }
        parts.append(f"data: {json.dumps(chunk)}\n\n")
    final = {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "m",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    parts.append(f"data: {json.dumps(final)}\n\n")
    if done:
        # The line the SDK breaks on, leaving the terminator below unread.
        parts.append("data: [DONE]\n\n")
    return "".join(parts).encode()


class _CountingEngine:
    """A loopback HTTP/1.1 server that counts ACCEPTED connections.

    Counting at accept (not per request) is the whole point: keep-alive means
    many requests legitimately share one connection, so a request-level counter
    can never tell reuse from a handshake per stream.
    """

    def __init__(self) -> None:
        self.connections = 0
        self._server: asyncio.AbstractServer | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.sockets[0].getsockname()[:2]
        return f"http://{host}:{port}/v1"

    async def __aenter__(self) -> _CountingEngine:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        try:
            while True:
                headers = await reader.readuntil(b"\r\n\r\n")
                length = 0
                for line in headers.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1])
                if length:
                    await reader.readexactly(length)
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: text/event-stream\r\n"
                    b"Transfer-Encoding: chunked\r\n"
                    b"Connection: keep-alive\r\n\r\n"
                )
                body = _sse_body()
                writer.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            writer.close()


async def _stream_once(client: AsyncOpenAI) -> int:
    """One generation, drained the way `openai_compat._stream` drains it."""
    stream = await client.chat.completions.create(
        model="m",
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        stream_options={"include_usage": True},
    )
    received = 0
    async for _chunk in stream:
        received += 1
    return received


@pytest.mark.asyncio
async def test_streamed_generations_reuse_one_connection() -> None:
    """Five streamed generations over one pooled client => ONE handshake.

    RED before the drain-on-close wrapper: five requests, five connections.
    """
    reset_pooled_clients()
    async with _CountingEngine() as engine:
        transport = pooled_http_client("test-upstream", timeout_s=30, family=TransportFamily.HTTPX2)
        client = AsyncOpenAI(api_key="not-needed", base_url=engine.base_url, http_client=transport)

        for _ in range(5):
            assert await _stream_once(client) > 0

        assert engine.connections == 1, (
            f"expected one connection for five streamed generations, "
            f"saw {engine.connections} — the streamed socket is not returning to the pool"
        )
    reset_pooled_clients()


@pytest.mark.asyncio
async def test_non_streaming_reuse_is_unaffected() -> None:
    """The path that already worked keeps working — the wrapper is not a regression."""
    reset_pooled_clients()
    async with _CountingEngine() as engine:
        transport = pooled_http_client(
            "test-upstream-2", timeout_s=30, family=TransportFamily.HTTPX2
        )
        for _ in range(3):
            response = await transport.post(f"{engine.base_url}/chat/completions", json={})
            assert response.status_code == 200
        assert engine.connections == 1
    reset_pooled_clients()


@pytest.mark.asyncio
async def test_drain_on_close_is_bounded_for_an_aborted_stream() -> None:
    """An ABORTED stream is not drained to completion just to save a socket.

    The bound is what stops "return the connection to the pool" turning into
    "read the whole rest of a generation nobody is listening to".
    """

    class _EndlessBody:
        """A body that never ends — an in-flight generation whose consumer left."""

        def __init__(self) -> None:
            self.read = 0
            self.closed = False

        async def __aiter__(self):
            while True:
                self.read += 4096
                yield b"x" * 4096

        async def aclose(self) -> None:
            self.closed = True

    class _Stream(_DrainOnCloseMixin, httpx2.AsyncByteStream):
        pass

    inner = _EndlessBody()
    wrapped = _Stream(inner)
    async for _part in wrapped:
        break  # exactly what `AsyncStream.__stream__` does on `[DONE]`
    await wrapped.aclose()

    assert (
        inner.read <= DRAIN_ON_CLOSE_MAX_BYTES + 4096
    ), f"the drain read {inner.read} bytes from an endless body — it must be bounded"
    assert inner.closed is True, "the connection must be closed even when the drain gives up"
