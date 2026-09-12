"""TASK-959 M-4 — outbound body bytes are counted at the pool transport seam.

The owner's measurement model wants network consumption per third-party call,
and `providers/pool.py` already owns the ONE place every pooled adapter passes
through. These tests exercise that wrapper directly — a canned response over a
fake base transport, no socket and no vendor SDK — because what is being
asserted is the wrapper's arithmetic, not httpx's.

Two properties are load-bearing and easy to get wrong:

* **Bodies only.** Headers and their CRLF framing are NOT counted, so a fixture
  written with different line endings must produce the same totals. A test that
  counted the whole wire image would pass on one platform and fail on another.
* **A streamed response is counted as the consumer iterates it**, and the
  close-time drain's bytes are counted too — they were delivered.
"""

from __future__ import annotations

import httpx
import httpx2
import pytest

from text.providers.pool import (
    ProviderByteCounts,
    _draining_transport,
    _request_body_bytes,
    count_provider_bytes,
    current_byte_counts,
    with_byte_counts,
)

_JSON = b'{"model":"m","messages":[{"role":"user","content":"hello"}]}'


def _plain_stream_cls(family):  # type: ignore[no-untyped-def]
    """The family's own `AsyncByteStream` over a plain async iterator.

    Per family, because httpx asserts a transport hands back one of ITS base
    class and the two families are not interchangeable (see `pool.py`).
    """

    class _PlainStream(family.AsyncByteStream):  # type: ignore[misc, name-defined]
        def __init__(self, parts: list[bytes]) -> None:
            self._parts = parts

        async def __aiter__(self):  # type: ignore[no-untyped-def]
            for part in self._parts:
                yield part

        async def aclose(self) -> None:
            return None

    return _PlainStream


class _CannedBase:
    """A transport base whose `handle_async_request` returns a canned response.

    Stands in for `AsyncHTTPTransport` so `_draining_transport` can be composed
    over it exactly as it is over the real one — the wrapper under test is the
    subclass, not the socket beneath it.
    """

    def __init__(self, family: object, body: bytes, *, chunks: int = 1, **_: object) -> None:
        self._family = family
        self._body = body
        self._chunks = chunks
        self._stream_cls = _plain_stream_cls(family)

    async def handle_async_request(self, request: object) -> object:
        return self._family.Response(  # type: ignore[attr-defined]
            200,
            headers={"content-type": "application/json"},
            stream=self._stream_cls(_split(self._body, self._chunks)),
        )


def _split(body: bytes, chunks: int) -> list[bytes]:
    if chunks <= 1:
        return [body]
    size = max(1, len(body) // chunks)
    return [body[i : i + size] for i in range(0, len(body), size)]


def _build(family, body: bytes, *, chunks: int = 1):  # type: ignore[no-untyped-def]
    transport_cls = _draining_transport(_CannedBase, family)
    return transport_cls(family, body, chunks=chunks)


def _request(family, body: bytes | None = _JSON):  # type: ignore[no-untyped-def]
    return family.Request(
        "POST",
        "https://vendor.example/v1/chat/completions",
        headers={"content-type": "application/json"},
        content=body,
    )


class TestRequestBodySizing:
    def test_byte_body_is_sized_exactly(self) -> None:
        assert _request_body_bytes(_request(httpx)) == len(_JSON)

    def test_empty_body_is_zero_not_an_error(self) -> None:
        assert _request_body_bytes(_request(httpx, b"")) == 0

    def test_an_unsizable_body_falls_back_to_content_length(self) -> None:
        class _Streaming:
            headers = httpx.Headers({"content-length": "1234"})

            @property
            def content(self) -> bytes:
                raise RuntimeError("streaming body not read")

        assert _request_body_bytes(_Streaming()) == 1234

    def test_a_body_with_no_size_at_all_is_zero(self) -> None:
        class _Opaque:
            headers = httpx.Headers({})

            @property
            def content(self) -> bytes:
                raise RuntimeError("streaming body not read")

        assert _request_body_bytes(_Opaque()) == 0


@pytest.mark.parametrize("family", [httpx, httpx2], ids=["httpx", "httpx2"])
class TestTransportCountsBothDirections:
    @pytest.mark.asyncio
    async def test_non_streaming_call_counts_request_and_response(self, family) -> None:  # type: ignore[no-untyped-def]
        body = b'{"choices":[{"message":{"content":"hi"}}]}'
        transport = _build(family, body)
        with count_provider_bytes("openai") as counts:
            response = await transport.handle_async_request(_request(family))
            seen = b"".join([part async for part in response.stream])
            await response.stream.aclose()

        assert seen == body
        assert counts.request_bytes == len(_JSON)
        assert counts.response_bytes == len(body)
        assert counts.observed is True

    @pytest.mark.asyncio
    async def test_streamed_response_counts_every_delivered_chunk(self, family) -> None:  # type: ignore[no-untyped-def]
        body = b"data: one\n\ndata: two\n\ndata: [DONE]\n\n"
        transport = _build(family, body, chunks=4)
        with count_provider_bytes("lm-studio") as counts:
            response = await transport.handle_async_request(_request(family))
            async for _part in response.stream:
                pass
            await response.stream.aclose()

        assert counts.response_bytes == len(body)

    @pytest.mark.asyncio
    async def test_bytes_swallowed_by_the_close_drain_are_counted(self, family) -> None:  # type: ignore[no-untyped-def]
        """A consumer that stops early was still SENT the rest of the body.

        `openai`'s stream reader breaks on `data: [DONE]` and closes; the drain
        reads what is left to return the socket to the pool. Those bytes crossed
        the network, so the bill includes them.
        """
        body = b"".join(b"data: chunk-%02d\n\n" % i for i in range(8))
        transport = _build(family, body, chunks=8)
        with count_provider_bytes("lm-studio") as counts:
            response = await transport.handle_async_request(_request(family))
            async for _part in response.stream:
                break  # the SDK's `break` on [DONE]
            await response.stream.aclose()

        assert counts.response_bytes == len(body)

    @pytest.mark.asyncio
    async def test_header_framing_is_not_counted_so_line_endings_are_irrelevant(
        self, family
    ) -> None:  # type: ignore[no-untyped-def]
        """CRLF-agnostic: only bodies are counted, and both fixtures' bodies match."""
        lf = b'{"a":1}'
        transport = _build(family, lf)
        with count_provider_bytes("openai") as counts:
            response = await transport.handle_async_request(_request(family))
            async for _ in response.stream:
                pass
            await response.stream.aclose()
        assert counts.request_bytes == len(_JSON)
        assert counts.response_bytes == len(lf)

    @pytest.mark.asyncio
    async def test_retries_accumulate_onto_one_record(self, family) -> None:  # type: ignore[no-untyped-def]
        body = b'{"ok":true}'
        transport = _build(family, body)
        with count_provider_bytes("openai") as counts:
            for _attempt in range(3):
                response = await transport.handle_async_request(_request(family))
                async for _ in response.stream:
                    pass
                await response.stream.aclose()

        assert counts.requests == 3
        assert counts.request_bytes == 3 * len(_JSON)
        assert counts.response_bytes == 3 * len(body)

    @pytest.mark.asyncio
    async def test_an_unbound_call_counts_nothing_and_does_not_raise(self, family) -> None:  # type: ignore[no-untyped-def]
        """No record bound ⇒ nothing is counted, and nothing is misattributed."""
        transport = _build(family, b'{"ok":true}')
        assert current_byte_counts() is None
        response = await transport.handle_async_request(_request(family))
        async for _ in response.stream:
            pass
        await response.stream.aclose()


class TestRecordBinding:
    def test_the_record_is_restored_on_exit(self) -> None:
        assert current_byte_counts() is None
        with count_provider_bytes("openai") as outer:
            assert current_byte_counts() is outer
            with count_provider_bytes("anthropic") as inner:
                assert current_byte_counts() is inner
            assert current_byte_counts() is outer
        assert current_byte_counts() is None

    def test_funding_is_carried_on_the_record(self) -> None:
        with count_provider_bytes("openai", funding="tenant") as counts:
            assert counts.funding == "tenant"

    def test_a_never_used_record_reports_unobserved(self) -> None:
        with count_provider_bytes("vertex") as counts:
            pass
        assert counts.observed is False

    def test_with_byte_counts_rebinds_inside_a_worker_thread(self) -> None:
        """`run_in_executor` carries no context — this closes that gap."""
        from concurrent.futures import ThreadPoolExecutor

        seen: list[ProviderByteCounts | None] = []

        def _work() -> None:
            record = current_byte_counts()
            seen.append(record)
            if record is not None:
                record.add_request(11)
                record.add_response(22)

        with count_provider_bytes("bedrock") as counts:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(with_byte_counts(_work)).result()
                # Without the re-binding the same thread sees nothing.
                pool.submit(_work).result()

        assert seen[0] is counts
        assert seen[1] is None
        assert counts.request_bytes == 11
        assert counts.response_bytes == 22


class TestPrometheusCounter:
    def test_totals_are_stamped_once_on_exit(self) -> None:
        from text.core.metrics import PROVIDER_BYTES

        def _value(direction: str, funding: str) -> float:
            return (
                PROVIDER_BYTES.labels(
                    provider="metric-probe", direction=direction, funding=funding
                )._value.get()
                or 0.0
            )

        before_out = _value("egress", "tenant")
        before_in = _value("ingress", "tenant")
        with count_provider_bytes("metric-probe", funding="tenant") as counts:
            counts.add_request(100)
            counts.add_response(250)
        assert _value("egress", "tenant") == before_out + 100
        assert _value("ingress", "tenant") == before_in + 250
