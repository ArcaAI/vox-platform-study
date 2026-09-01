"""TASK-846 D-3 — the httpx2 transport that PINS a validated MCP egress target.

WHY A TRANSPORT AND NOT A ONE-OFF CHECK. Validating a URL and then handing the name to
the socket layer is the classic DNS-rebinding TOCTOU: the attacker's resolver answers the
first lookup with a public address and the second — the one the kernel actually dials —
with 169.254.169.254. The only way to close it is to make the address we validated and
the address we connect to the same value, decided once. That is what this transport does,
and doing it at the TRANSPORT layer buys two more properties for free:

* EVERY request is checked, not just the first. Streamable-HTTP opens a session and then
  issues further requests against the same base URL; each one passes through here.
* A redirect hop, if one were ever followed, is re-validated as a new target. The client
  also sets ``follow_redirects=False`` (a 302 is simply not followed), so this is the
  second of two independent answers to "what about redirects".

IMPORT COST. ``httpx2`` ships only with the optional ``mcp-tools`` extra (it arrives
transitively with the ``mcp`` SDK), so this module imports it at MODULE level and is
itself imported LAZILY by ``mcp_client._call_once`` — inside the same try/except that
guards the SDK import. Do not import this module at the top of ``mcp_client``; the whole
MCP path must stay importable on a base install.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence

import httpx2

from harness.core.logging import get_logger
from harness.tools.egress_guard import (
    EgressBlocked,
    HostResolver,
    default_resolver,
    evaluate_egress,
)

logger = get_logger(__name__)

#: Bytes read from one MCP response before the transport gives up. Bounds the blast
#: radius of a hostile or compromised server: the activity's ``max_result_bytes`` cap
#: only applies AFTER the whole body is in memory, which is too late to stop an OOM.
DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class ResponseTooLarge(Exception):
    """An MCP server sent more than ``max_response_bytes``; the stream was abandoned."""


class _CappedByteStream(httpx2.AsyncByteStream):
    """Wraps a response stream and refuses to yield past ``max_bytes``."""

    def __init__(self, inner: httpx2.AsyncByteStream, max_bytes: int) -> None:
        self._inner = inner
        self._max_bytes = max_bytes

    async def __aiter__(self) -> AsyncIterator[bytes]:
        total = 0
        async for chunk in self._inner:
            total += len(chunk)
            if total > self._max_bytes:
                raise ResponseTooLarge(
                    f"MCP response exceeded {self._max_bytes} bytes; stream abandoned"
                )
            yield chunk

    async def aclose(self) -> None:
        aclose = getattr(self._inner, "aclose", None)
        if aclose is not None:
            await aclose()


class PinnedEgressTransport(httpx2.AsyncBaseTransport):
    """Validate every request target, then dial the address that was validated."""

    def __init__(
        self,
        inner: httpx2.AsyncBaseTransport,
        *,
        allowed_hosts: Sequence[str] | None,
        resolver: HostResolver | None = None,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        self._inner = inner
        self._allowed_hosts = allowed_hosts
        self._resolver = resolver or default_resolver
        self._max_response_bytes = max_response_bytes

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        # `evaluate_egress` calls `getaddrinfo`, which blocks — keep it off the loop.
        decision = await asyncio.to_thread(
            evaluate_egress, str(request.url), self._allowed_hosts, self._resolver
        )
        if not decision.allowed:
            # Attributable, but never the URL: a connector URL can carry a token in its
            # query string, and a log that quoted it would BE the leak.
            logger.warning(
                "harness.mcp.egress.blocked",
                host=decision.host,
                reason=decision.reason,
            )
            raise EgressBlocked(decision)

        original_host = request.url.host
        pinned = decision.pinned[0]

        # Rewrite the target to the validated literal, but keep presenting the real host
        # so virtual hosting still routes and TLS still verifies against the right name.
        pinned_request = httpx2.Request(
            method=request.method,
            url=request.url.copy_with(host=pinned),
            headers=request.headers,
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": original_host},
        )
        pinned_request.headers["Host"] = request.headers.get("Host", original_host)

        response = await self._inner.handle_async_request(pinned_request)

        # `Response.stream` is typed as the sync|async union because one Response class
        # serves both worlds; an ASYNC transport always yields the async half. Narrowed
        # rather than cast so the impossible case fails loudly instead of silently
        # skipping the size cap.
        stream = response.stream
        if not isinstance(stream, httpx2.AsyncByteStream):
            raise RuntimeError("async transport returned a synchronous response stream")

        return httpx2.Response(
            status_code=response.status_code,
            headers=response.headers,
            stream=_CappedByteStream(stream, self._max_response_bytes),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        aclose = getattr(self._inner, "aclose", None)
        if aclose is not None:
            await aclose()
