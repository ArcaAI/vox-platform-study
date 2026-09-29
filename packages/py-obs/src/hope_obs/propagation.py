"""Outbound request-context propagation for peer HTTP clients.

``traceparent`` is injected by the httpx instrumentation; this adds the one
thing it does not carry — the edge ``X-Request-Id`` — so a request id quoted by a
caller can be searched across every service's log lines.

A peer client merges the result into the headers it already builds::

    headers = {"X-Service-Token": token, "X-Tenant-Id": tenant_id, **outbound_context_headers()}

``X-Tenant-Id`` is deliberately NOT forwarded from here: tenant identity on an
internal call is an explicit, mandatory decision of the caller (a peer that
omits it is a defect, not something to paper over with an ambient value).
"""

from __future__ import annotations

import re

import structlog

REQUEST_ID_HEADER = "X-Request-Id"

#: The shape a request id must have to be echoed or bound: anything else (a
#: newline, an unbounded length) is a log-injection vector and is replaced.
VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def valid_request_id(value: object) -> str | None:
    """``value`` when it is a well-formed request id, else ``None``."""
    return value if isinstance(value, str) and VALID_REQUEST_ID.match(value) else None


def outbound_context_headers() -> dict[str, str]:
    """Headers carrying the bound request context; empty when none is bound."""
    request_id = structlog.contextvars.get_contextvars().get("requestId")
    if not request_id:
        return {}
    return {REQUEST_ID_HEADER: str(request_id)}
