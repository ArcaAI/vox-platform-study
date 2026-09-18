"""Logging shape (R-3).

The regression this package exists to prevent is F-05: in five of six services a
`httpx`, `uvicorn.error` or `transformers` record landed as unstructured text
next to the JSON, because only STT routed stdlib logging through the structlog
chain. `test_third_party_stdlib_record_is_json` is that guard.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Callable

import pytest
from opentelemetry.sdk.trace import TracerProvider

from hope_obs import ObservabilityConfig, bind_request_context, configure_logging, get_logger

Capture = Callable[[], io.StringIO]


def _lines(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


class TestIdempotence:
    def test_two_calls_leave_exactly_one_root_handler(self) -> None:
        config = ObservabilityConfig(service_name="stt")
        configure_logging(config)
        configure_logging(config)
        assert len(logging.getLogger().handlers) == 1

    def test_second_call_does_not_reset_the_stream(self, capture_log_output: Capture) -> None:
        config = ObservabilityConfig(service_name="stt")
        configure_logging(config)
        stream = capture_log_output()
        configure_logging(config)
        get_logger("stt.test").info("stt.test.event")
        assert _lines(stream)


class TestJsonShape:
    def test_required_fields_on_every_line(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        get_logger("stt.session").info("stt.session.started")

        (line,) = _lines(stream)
        assert line["event"] == "stt.session.started"
        assert line["level"] == "info"
        assert line["logger"] == "stt.session"
        assert line["service"] == "stt"
        assert isinstance(line["timestamp"], str)
        assert line["timestamp"].endswith("Z")

    def test_extra_fields_are_rendered_as_fields(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        get_logger("stt.session").info("stt.session.started", session="abc123", ms=12)

        (line,) = _lines(stream)
        assert line["session"] == "abc123"
        assert line["ms"] == 12

    def test_log_level_is_honoured(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt", log_level="warning"))
        stream = capture_log_output()

        get_logger("stt.session").info("stt.session.suppressed")
        get_logger("stt.session").warning("stt.session.kept")

        assert [line["event"] for line in _lines(stream)] == ["stt.session.kept"]

    def test_numeric_log_level_is_honoured(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt", log_level="30"))
        stream = capture_log_output()

        get_logger("stt.session").info("stt.session.suppressed")
        get_logger("stt.session").warning("stt.session.kept")

        assert [line["event"] for line in _lines(stream)] == ["stt.session.kept"]


class TestStdlibBridge:
    def test_third_party_stdlib_record_is_json(self, capture_log_output: Capture) -> None:
        """F-05: a `httpx` record must come out through the SAME chain."""
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        logging.getLogger("httpx").warning("connect failed to %s", "collector")

        (line,) = _lines(stream)
        assert line["event"] == "connect failed to collector"
        assert line["logger"] == "httpx"
        assert line["level"] == "warning"
        assert line["service"] == "stt"
        assert isinstance(line["timestamp"], str)

    def test_uvicorn_access_is_disabled(self) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        assert logging.getLogger("uvicorn.access").disabled is True

    def test_uvicorn_error_propagates_to_the_root_chain(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        uvicorn_error = logging.getLogger("uvicorn.error")
        assert uvicorn_error.handlers == []
        assert uvicorn_error.propagate is True

        uvicorn_error.warning("uvicorn.shutdown")

        assert _lines(stream)[0]["logger"] == "uvicorn.error"

    def test_exception_info_is_rendered(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        try:
            raise ValueError("boom")
        except ValueError:
            get_logger("stt.session").exception("stt.session.failed")

        (line,) = _lines(stream)
        assert "ValueError" in str(line["exception"])


class TestTraceCorrelation:
    def test_trace_ids_absent_without_an_active_span(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        get_logger("stt.session").info("stt.session.started")

        (line,) = _lines(stream)
        assert "traceId" not in line
        assert "spanId" not in line

    def test_trace_ids_present_inside_a_span(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        provider = TracerProvider()
        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("unit") as span:
            get_logger("stt.session").info("stt.session.started")
            expected_trace = format(span.get_span_context().trace_id, "032x")
            expected_span = format(span.get_span_context().span_id, "016x")

        (line,) = _lines(stream)
        assert line["traceId"] == expected_trace
        assert line["spanId"] == expected_span
        assert len(str(line["traceId"])) == 32
        assert len(str(line["spanId"])) == 16


class TestRequestContext:
    def test_bound_context_appears_on_every_line(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        bind_request_context(request_id="req-1", tenant_id="tenant-1")
        get_logger("stt.session").info("stt.session.started")
        logging.getLogger("httpx").warning("outbound")

        first, second = _lines(stream)
        assert first["request_id"] == "req-1"
        assert first["tenant_id"] == "tenant-1"
        assert second["request_id"] == "req-1"
        assert second["tenant_id"] == "tenant-1"


class TestGetLogger:
    def test_returns_a_bound_logger(self) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        logger = get_logger("stt.session")
        assert hasattr(logger, "bind")
        assert hasattr(logger, "info")

    def test_usable_before_configure_logging(self, capture_log_output: Capture) -> None:
        """A module-level `logger = get_logger(__name__)` runs at import time."""
        logger = get_logger("stt.early")
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()
        logger.info("stt.early.event")
        assert _lines(stream)[0]["event"] == "stt.early.event"


@pytest.mark.parametrize("level", ["debug", "DEBUG", "10"])
def test_level_spellings_are_interchangeable(level: str, capture_log_output: Capture) -> None:
    configure_logging(ObservabilityConfig(service_name="stt", log_level=level))
    stream = capture_log_output()
    get_logger("stt.session").debug("stt.session.debugged")
    assert _lines(stream)[0]["event"] == "stt.session.debugged"
