"""E9 (stt) — a Dramatiq job restores the enqueuer's trace + request id and never logs raw ids.

Carrier shape (written by the gateway on enqueue, read here):
``message.options["hope_trace"] = {"traceparent": ..., "tracestate"?: ..., "requestId": ...}``
"""

from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import structlog
from opentelemetry import trace

from stt.transcription.workers import job_context

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
TRACEPARENT = f"00-{TRACE_ID}-00f067aa0ba902b7-01"


def test_current_trace_carrier_reads_options_hope_trace() -> None:
    message = SimpleNamespace(
        options={"hope_trace": {"traceparent": TRACEPARENT, "requestId": "rid-1"}}
    )
    with patch.object(job_context, "_current_message", return_value=message):
        assert job_context.current_trace_carrier() == {
            "traceparent": TRACEPARENT,
            "requestId": "rid-1",
        }


def test_current_trace_carrier_is_none_without_a_message_or_option() -> None:
    with patch.object(job_context, "_current_message", return_value=None):
        assert job_context.current_trace_carrier() is None
    with patch.object(job_context, "_current_message", return_value=SimpleNamespace(options={})):
        assert job_context.current_trace_carrier() is None


def test_job_context_restores_trace_and_binds_request_and_tenant() -> None:
    carrier = {"traceparent": TRACEPARENT, "requestId": "rid-9"}

    with job_context.job_context(carrier, tenant_id="tenant-1"):
        span_context = trace.get_current_span().get_span_context()
        bound = structlog.contextvars.get_contextvars()
        assert format(span_context.trace_id, "032x") == TRACE_ID
        assert bound["requestId"] == "rid-9"
        assert bound["tenantId"] == "tenant-1"

    assert not trace.get_current_span().get_span_context().is_valid
    assert structlog.contextvars.get_contextvars() == {}


def test_job_context_without_carrier_still_binds_tenant() -> None:
    with job_context.job_context(None, tenant_id="tenant-2"):
        bound = structlog.contextvars.get_contextvars()
        assert bound == {"tenantId": "tenant-2"}


def test_job_context_rejects_a_malformed_request_id() -> None:
    with job_context.job_context({"requestId": "bad id\n"}, tenant_id="t"):
        assert "requestId" not in structlog.contextvars.get_contextvars()


def test_worker_logs_no_raw_job_id() -> None:
    module = importlib.import_module("stt.transcription.workers.transcribe_file")
    source = Path(module.__file__).read_text()
    assert "[{job_id}]" not in source
