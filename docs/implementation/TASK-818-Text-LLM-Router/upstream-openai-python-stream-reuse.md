# Upstream report — `openai-python`: a streamed response is closed before EOF, so its connection is never reused

| | |
|---|---|
| **Status** | **DRAFTED, NOT FILED.** Needs a human to post it — see §"Filing" below. |
| **Target** | <https://github.com/openai/openai-python> — new issue |
| **Related upstream** | [#763](https://github.com/openai/openai-python/issues/763) (closed) · [#667](https://github.com/openai/openai-python/issues/667) · [#2688](https://github.com/openai/openai-python/issues/2688) |
| **Our side** | Fixed locally in `apps/text/src/text/providers/pool.py`; see `baseline.md` §"Root cause of `1.000 conn/req`" |
| **Verified against** | `openai==3.1.0`, `httpx2==2.10.0`, Python 3.11.14 — and `openai-python` `main` by inspection, 2026-08-30 |

## Why this is not a duplicate of #763

[#763](https://github.com/openai/openai-python/issues/763) ("The connection is not
returned to the httpx pool when using a stream", Nov 2023, closed) reported **pool
exhaustion**: connections were never released, so the Nth request timed out waiting
for a free slot. Its reporter identified `AsyncStream.response.aclose()` as the
workaround, and today's `__stream__` carries exactly that call in its `finally` —
which does resolve exhaustion. *(We verified the current code, not the commit
history; if the maintainers say the `aclose()` arrived for another reason, the
substance below is unaffected.)*

**It resolves release, not reuse.** `aclose()` on a body that is not at EOF makes
httpcore *destroy* the connection rather than park it — the slot is freed, so #763's
symptom is gone, but every stream still pays a fresh TCP+TLS handshake. That residue
is what this report is about, and it is still present on `main`.

It is also a plausible contributor to [#2688](https://github.com/openai/openai-python/issues/2688)
(clients timing out after 24–26 h in production with `max_keepalive_connections=100`):
a keepalive pool that never accumulates a warm connection behaves very differently
under churn than one that does.

---

## The report (paste from here down)

### Streamed responses are closed before EOF, so their connections are destroyed instead of reused

**Summary.** Every `stream=True` call opens a brand-new TCP (and TLS) connection,
even on a client that is reused and has a healthy keepalive pool. `stream=False` on
the same client reuses one connection correctly. Verified on `openai==3.1.0` /
`httpx2==2.10.0`, and the relevant code is unchanged on `main`.

**Cause.** `src/openai/_streaming.py`:

```python
async def __stream__(self):
    ...
    try:
        async for sse in iterator:
            if sse.data.startswith("[DONE]"):
                break                       # (1)
            ...
    finally:
        await response.aclose()             # (2)
```

At (1) the iterator is abandoned with the response body **not at EOF**. There are no
application bytes left after `data: [DONE]` — I measured exactly `0` — but the HTTP
end-of-body marker (the `0\r\n\r\n` chunked terminator) has not been read. At (2),
httpcore sees a partially-consumed response and tears the connection down instead of
returning it to the keepalive pool.

The synchronous `Stream.__stream__` has the identical shape (`break` … `finally:
response.close()`).

The non-streaming path is unaffected because it reads its body to completion.

**Impact.** For any application that streams against a remote endpoint, connection
reuse is silently disabled: a TCP + TLS handshake per generation. `http_client=` with
tuned `Limits` does not help, because the connection is destroyed before it can be
parked. This is invisible in local testing against a loopback mock (a handshake to
`127.0.0.1` is nearly free) and expensive against a real API endpoint.

We hit this in a multi-tenant LLM router. With a process-wide client cache and one
pooled `httpx2.AsyncClient` per upstream — both verified to return the *same* client
object on every request — a TLS benchmark still measured **1.000 new connections per
request** at concurrency 1, 10 and 25. Draining before close took it to **0.000–0.09**.

### Reproduction

Self-contained; no API key, no network. `pip install "openai>=3"` then run:

```python
"""Minimal repro: AsyncStream does not return its connection to the pool.

    pip install "openai>=3" && python repro_openai_stream_conn.py

Expected: 1 connection for 5 requests (keep-alive reuse).
Actual:   5 connections when stream=True; 1 when stream=False.
"""

import asyncio
import json

import openai
from openai import AsyncOpenAI

ACCEPTED = 0


def _sse() -> bytes:
    events = []
    for i in range(3):
        events.append(
            "data: "
            + json.dumps(
                {
                    "id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                    "choices": [{"index": 0, "delta": {"content": f"t{i}"}, "finish_reason": None}],
                }
            )
            + "\n\n"
        )
    events.append(
        "data: "
        + json.dumps(
            {
                "id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
        )
        + "\n\n"
    )
    events.append("data: [DONE]\n\n")
    return "".join(events).encode()


async def _serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """A keep-alive HTTP/1.1 server that counts ACCEPTED connections."""
    global ACCEPTED
    ACCEPTED += 1
    try:
        while True:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = 0
            for line in headers.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":", 1)[1])
            body_in = await reader.readexactly(length) if length else b""
            streaming = b'"stream": true' in body_in or b'"stream":true' in body_in
            if streaming:
                body = _sse()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                    b"Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n"
                )
                writer.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body))
            else:
                body = json.dumps(
                    {
                        "id": "c", "object": "chat.completion", "created": 0, "model": "m",
                        "choices": [
                            {"index": 0, "message": {"role": "assistant", "content": "hi"},
                             "finish_reason": "stop"}
                        ],
                    }
                ).encode()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    b"Content-Length: %d\r\nConnection: keep-alive\r\n\r\n" % len(body)
                )
                writer.write(body)
            await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def main() -> None:
    global ACCEPTED
    server = await asyncio.start_server(_serve, "127.0.0.1", 0)
    host, port = server.sockets[0].getsockname()[:2]
    client = AsyncOpenAI(api_key="x", base_url=f"http://{host}:{port}/v1")
    args = dict(model="m", messages=[{"role": "user", "content": "hi"}])

    ACCEPTED = 0
    for _ in range(5):
        stream = await client.chat.completions.create(**args, stream=True)
        chunks = 0
        async for _chunk in stream:  # drained to exhaustion
            chunks += 1
        assert chunks == 4, f"server did not stream (got {chunks} chunks)"
    streamed = ACCEPTED

    ACCEPTED = 0
    for _ in range(5):
        assert (await client.chat.completions.create(**args)).choices
    unary = ACCEPTED

    print(f"openai=={openai.__version__}")
    print(f"  stream=True : {streamed} connections for 5 requests   (expected 1)")
    print(f"  stream=False: {unary} connections for 5 requests   (expected 1)")

    server.close()
    await server.wait_closed()


asyncio.run(main())
```

Output on `openai==3.1.0`:

```
openai==3.1.0
  stream=True : 5 connections for 5 requests   (expected 1)
  stream=False: 1 connections for 5 requests   (expected 1)
```

Reduced further, with no SDK in the path at all — plain `httpx2` against the same
server, five requests each:

| what the consumer does | new connections |
|---|---|
| iterate the body to EOF, then close | **1** |
| `break` on `data: [DONE]`, then close (what `__stream__` does) | **5** |
| `break` on `data: [DONE]`, **drain the remainder**, then close | **1** |

So this is httpx/httpcore behaving as designed, and the SDK's close is the trigger.

### Suggested fix

Drain the response to EOF before closing it, **bounded** so a genuinely aborted
stream (consumer stopped early, exception, `break` by the caller) is never read to
completion just to save a socket:

```python
finally:
    with contextlib.suppress(Exception):
        async with asyncio.timeout(DRAIN_TIMEOUT_S):
            read = 0
            async for chunk in iterator_of_remaining_bytes:
                read += len(chunk)
                if read >= DRAIN_MAX_BYTES:
                    break
    await response.aclose()
```

In the normal `[DONE]` case this reads zero bytes and completes immediately. A
sensible distinction, if you would rather not always drain: drain when the stream
ended *because of `[DONE]`* (the body really is complete) and close immediately when
it ended because the consumer stopped or an exception propagated.

We implemented the bounded-drain form at the transport layer as a local workaround —
64 KB / 250 ms — and it took our benchmark from 1.000 to 0.000 conn/req with no
change in behaviour on aborted streams.

### Workaround for others hitting this

Wrap the transport so the response body is drained (bounded) before `aclose()`:

```python
class DrainOnClose(httpx.AsyncByteStream):
    def __init__(self, inner): self._inner, self._it, self._eof = inner, None, False
    async def __aiter__(self):
        self._it = self._inner.__aiter__()
        async for part in self._it: yield part
        self._eof = True
    async def aclose(self):
        try:
            if not self._eof and self._it is not None:
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(0.25):
                        read = 0
                        async for part in self._it:
                            read += len(part)
                            if read >= 64 * 1024: break
        finally:
            await self._inner.aclose()

class DrainingTransport(httpx.AsyncHTTPTransport):
    async def handle_async_request(self, request):
        response = await super().handle_async_request(request)
        response.stream = DrainOnClose(response.stream)
        return response
```

Note that the SDK is on `httpx2` while some other SDKs are on `httpx` — subclass the
matching family's `AsyncByteStream`, or httpx's `assert isinstance(response.stream,
AsyncByteStream)` fails.

### Environment

- `openai==3.1.0`, `httpx2==2.10.0`, Python 3.11.14, macOS (arm64)
- Reproduced against a stdlib `asyncio.start_server` HTTP/1.1 endpoint, and against
  a uvicorn TLS endpoint
- `_streaming.py` on `main` verified unchanged as of 2026-08-30

---

## Filing

I could not post this: the GitHub MCP server needs authorization and this session is
non-interactive, and publishing to a public tracker is a call for a person to make
regardless. To file it:

1. Open <https://github.com/openai/openai-python/issues/new/choose> → Bug report.
2. Paste everything under **"The report (paste from here down)"**, with the
   `"""Minimal repro: AsyncStream does not return its connection to the pool.

    pip install "openai>=3" && python repro_openai_stream_conn.py

Expected: 1 connection for 5 requests (keep-alive reuse).
Actual:   5 connections when stream=True; 1 when stream=False.
"""

import asyncio
import json

import openai
from openai import AsyncOpenAI

ACCEPTED = 0


def _sse() -> bytes:
    events = []
    for i in range(3):
        events.append(
            "data: "
            + json.dumps(
                {
                    "id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                    "choices": [{"index": 0, "delta": {"content": f"t{i}"}, "finish_reason": None}],
                }
            )
            + "\n\n"
        )
    events.append(
        "data: "
        + json.dumps(
            {
                "id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
        )
        + "\n\n"
    )
    events.append("data: [DONE]\n\n")
    return "".join(events).encode()


async def _serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """A keep-alive HTTP/1.1 server that counts ACCEPTED connections."""
    global ACCEPTED
    ACCEPTED += 1
    try:
        while True:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = 0
            for line in headers.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":", 1)[1])
            body_in = await reader.readexactly(length) if length else b""
            streaming = b'"stream": true' in body_in or b'"stream":true' in body_in
            if streaming:
                body = _sse()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                    b"Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n"
                )
                writer.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body))
            else:
                body = json.dumps(
                    {
                        "id": "c", "object": "chat.completion", "created": 0, "model": "m",
                        "choices": [
                            {"index": 0, "message": {"role": "assistant", "content": "hi"},
                             "finish_reason": "stop"}
                        ],
                    }
                ).encode()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    b"Content-Length: %d\r\nConnection: keep-alive\r\n\r\n" % len(body)
                )
                writer.write(body)
            await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def main() -> None:
    global ACCEPTED
    server = await asyncio.start_server(_serve, "127.0.0.1", 0)
    host, port = server.sockets[0].getsockname()[:2]
    client = AsyncOpenAI(api_key="x", base_url=f"http://{host}:{port}/v1")
    args = dict(model="m", messages=[{"role": "user", "content": "hi"}])

    ACCEPTED = 0
    for _ in range(5):
        stream = await client.chat.completions.create(**args, stream=True)
        chunks = 0
        async for _chunk in stream:  # drained to exhaustion
            chunks += 1
        assert chunks == 4, f"server did not stream (got {chunks} chunks)"
    streamed = ACCEPTED

    ACCEPTED = 0
    for _ in range(5):
        assert (await client.chat.completions.create(**args)).choices
    unary = ACCEPTED

    print(f"openai=={openai.__version__}")
    print(f"  stream=True : {streamed} connections for 5 requests   (expected 1)")
    print(f"  stream=False: {unary} connections for 5 requests   (expected 1)")

    server.close()
    await server.wait_closed()


asyncio.run(main())` block replaced by the script in
   `apps/text/tests/bench/`-adjacent scratch, reproduced verbatim in the appendix
   below.
3. Consider cross-linking #763 with a one-liner: *"the `aclose()` added for this
   fixed release but not reuse — see <new issue>."*

Any upstream fix does **not** obsolete our transport wrapper on its own: `apps/text`
would still need the wrapper until the fixed `openai` version is pinned in
`apps/text/pyproject.toml` and the root `uv.lock` is regenerated. Remove it in one
commit that does both, and keep
`src/text/tests/unit/test_task818_stream_close_reuse.py` — it asserts the property
(streamed generations reuse one connection), not the mechanism, so it stays valid
either way and would catch a regression from an upstream bump.
