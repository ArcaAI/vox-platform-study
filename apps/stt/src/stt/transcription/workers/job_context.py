"""Restore the enqueuer's trace and request id inside a Dramatiq job.

The gateway writes the carrier onto the message when it enqueues::

    message.options["hope_trace"] = {"traceparent": ..., "tracestate"?: ..., "requestId": ...}

so a batch transcription joins the request that submitted it: the worker's spans
become children of the enqueue span, and every log line carries the same
``requestId`` (and the job's ``tenantId``) the gateway logged.

``CurrentMessage`` is thread-local, so the carrier is read in the actor thread
(``current_trace_carrier``) and handed to the coroutine that runs on the worker
loop, where :func:`job_context` applies it.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from hope_obs import bind_request_context, clear_request_context
from hope_obs.propagation import valid_request_id
from hope_otel.trace_propagation import extract_trace_context
from opentelemetry import context as otel_context

HOPE_TRACE_OPTION = "hope_trace"


def _current_message() -> Any:
    """The message being processed, or ``None`` outside a Dramatiq worker thread."""
    try:
        from dramatiq.middleware import CurrentMessage

        return CurrentMessage.get_current_message()
    except Exception:  # noqa: BLE001 - middleware absent or no message: no carrier
        return None


def current_trace_carrier() -> dict[str, Any] | None:
    """The ``hope_trace`` carrier on the current message, if the enqueuer sent one."""
    message = _current_message()
    options = getattr(message, "options", None) or {}
    carrier = options.get(HOPE_TRACE_OPTION)
    return carrier if isinstance(carrier, dict) else None


@contextmanager
def job_context(carrier: dict[str, Any] | None, *, tenant_id: str | None) -> Iterator[None]:
    """Continue the enqueuer's trace and bind ``requestId``/``tenantId`` for the job."""
    fields: dict[str, str] = {}
    request_id = valid_request_id((carrier or {}).get("requestId"))
    if request_id:
        fields["requestId"] = request_id
    if tenant_id:
        fields["tenantId"] = tenant_id
    if fields:
        bind_request_context(**fields)

    token = None
    parent = extract_trace_context(carrier)
    if parent is not None:
        token = otel_context.attach(parent)
    try:
        yield
    finally:
        if token is not None:
            otel_context.detach(token)
        clear_request_context()
