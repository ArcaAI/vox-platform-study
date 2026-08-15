"""Streamable-HTTP MCP tool client.

A thin async wrapper over the official ``mcp`` python SDK's streamable-HTTP client.
The SDK is imported LAZILY (an optional ``mcp-tools`` extra), so this module imports
even when the extra is absent — the whole MCP path is feature-flagged OFF and the
real transport only runs on an explicitly enabled server.

Security posture:

* The bearer credential (resolved from Vault by the caller) is passed ONLY as the
  ``Authorization`` header and is NEVER logged, echoed, or placed in an error/result.
* Errors are normalized to :class:`McpClientError` carrying a COARSE, secret-free
  message + an ``is_server_error`` / ``is_timeout`` flag so the calling activity can
  degrade (never crash) the clinical loop.
* Bounded transport retry (``max_attempts``) covers a transient timeout / 5xx before
  the activity degrades; a 4xx (client error) is non-retryable.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from harness.core.logging import get_logger

logger = get_logger(__name__)


class McpClientError(RuntimeError):
    """A normalized MCP transport/tool failure (never carries secret material)."""

    def __init__(
        self,
        message: str,
        *,
        is_server_error: bool = False,
        is_timeout: bool = False,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.is_server_error = is_server_error
        self.is_timeout = is_timeout
        self.status = status


@dataclass
class McpToolResult:
    """The text result of a tool call + the server's ``isError`` marker."""

    content: str
    is_error: bool = False


def _extract_text(call_result: Any) -> tuple[str, bool]:
    """Flatten an SDK ``CallToolResult`` to (text, is_error) without leaking objects.

    Prefers each content block's ``.text`` (``TextContent``); falls back to a JSON dump
    of a structured block so a non-text tool result is still captured as text.
    """
    is_error = bool(getattr(call_result, "is_error", getattr(call_result, "isError", False)))
    blocks = getattr(call_result, "content", None) or []
    parts: list[str] = []
    for block in blocks:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
            continue
        dump = getattr(block, "model_dump", None)
        if callable(dump):  # pragma: no cover - structured (non-text) blocks
            parts.append(json.dumps(dump(mode="json"), sort_keys=True, default=str))
        else:  # pragma: no cover - defensive
            parts.append(str(block))
    return "\n".join(parts), is_error


class McpToolClient:
    """Calls a single READ-ONLY MCP tool over streamable-HTTP with bounded retry."""

    def __init__(self, *, timeout_s: float = 20.0, max_attempts: int = 2) -> None:
        self._timeout_s = timeout_s
        self._max_attempts = max(1, max_attempts)

    async def call_tool(
        self,
        *,
        base_url: str,
        tool: str,
        args: dict[str, Any],
        auth_token: str | None = None,
    ) -> McpToolResult:
        """Invoke ``tool`` at ``base_url`` with ``args``; retry transient failures.

        Raises :class:`McpClientError` (secret-free) on a non-retryable failure or once
        the bounded retries are exhausted. The ``auth_token`` is sent ONLY as the
        ``Authorization`` bearer header and never logged.
        """
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else None
        last_exc: McpClientError | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await self._call_once(base_url, tool, args, headers)
            except McpClientError as exc:
                last_exc = exc
                # A client (4xx) error is a bug in the request — never retry it.
                if not (exc.is_server_error or exc.is_timeout):
                    raise
                if attempt < self._max_attempts:
                    logger.warning(
                        "harness.mcp.retry",
                        tool=tool,
                        attempt=attempt,
                        is_timeout=exc.is_timeout,
                        status=exc.status,
                    )
                    continue
        assert last_exc is not None  # loop ran >= 1 attempt
        raise last_exc

    async def _call_once(
        self,
        base_url: str,
        tool: str,
        args: dict[str, Any],
        headers: dict[str, str] | None,
    ) -> McpToolResult:  # pragma: no cover - exercised only with the `mcp` extra installed
        """One streamable-HTTP tool round-trip via the lazily-imported SDK."""
        try:
            import httpx2
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client
        except ImportError as exc:  # the extra is absent — surface as a coarse failure
            raise McpClientError("mcp SDK not installed (optional 'mcp-tools' extra)") from exc

        try:
            async with asyncio.timeout(self._timeout_s):
                # mcp 2: headers/timeout live on httpx2.AsyncClient; the transport
                # yields (read, write) only (no get_session_id callback).
                http_client = httpx2.AsyncClient(
                    headers=headers,
                    timeout=httpx2.Timeout(self._timeout_s),
                    follow_redirects=True,
                )
                async with http_client:
                    async with streamable_http_client(
                        base_url, http_client=http_client
                    ) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(tool, arguments=args)
        except TimeoutError as exc:
            raise McpClientError(
                f"mcp tool call timed out after {self._timeout_s}s", is_timeout=True
            ) from exc
        except McpClientError:
            raise
        except Exception as exc:  # noqa: BLE001 — normalize any transport/protocol error
            status, is_server = _classify_transport_error(exc)
            raise McpClientError(
                f"mcp tool call failed: {type(exc).__name__}",
                is_server_error=is_server,
                status=status,
            ) from exc

        text, is_error = _extract_text(result)
        return McpToolResult(content=text, is_error=is_error)


def _classify_transport_error(exc: Exception) -> tuple[int | None, bool]:  # pragma: no cover
    """Best-effort (status, is_server_error) from an httpx-style transport error."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status, status >= 500
    # A connect/read error with no response is treated as a (retryable) server-side fault.
    return None, True
