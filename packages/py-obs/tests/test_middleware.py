"""Request context and access logging (R-4).

Both middlewares are pure ASGI. `BaseHTTPMiddleware` is banned here for the
reason measured in `apps/text/src/text/api/middleware/request_id.py`: three
stacked shim layers cost ~2.2 ms CPU/request, ~30% of the per-request budget on
a service already running at 96-98% of one core.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import uuid
from collections.abc import Callable
from typing import Any

import pytest
import structlog

from hope_obs import ObservabilityConfig, configure_logging
from hope_obs.middleware import AccessLogMiddleware, RequestContextMiddleware

Capture = Callable[[], io.StringIO]

_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _scope(headers: list[tuple[bytes, bytes]] | None = None, path: str = "/api/v1/things") -> dict:
    return {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": headers or [],
    }


async def _receive() -> dict[str, Any]:  # pragma: no cover - never awaited by these apps
    return {"type": "http.request", "body": b"", "more_body": False}


def _lines(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


class TestRequestContextMiddleware:
    def test_binds_request_id_and_tenant_id(self) -> None:
        seen: dict[str, Any] = {}

        async def app(scope: dict, receive: Any, send: Any) -> None:
            seen.update(structlog.contextvars.get_contextvars())
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        middleware = RequestContextMiddleware(app)
        scope = _scope([(b"x-request-id", b"req-42"), (b"x-tenant-id", b"tenant-7")])
        asyncio.run(middleware(scope, _receive, _collect([])))

        assert seen["request_id"] == "req-42"
        assert seen["tenant_id"] == "tenant-7"

    def test_generates_a_uuid4_when_no_header_is_sent(self) -> None:
        seen: dict[str, Any] = {}

        async def app(scope: dict, receive: Any, send: Any) -> None:
            seen.update(structlog.contextvars.get_contextvars())
            await send({"type": "http.response.start", "status": 200, "headers": []})

        asyncio.run(RequestContextMiddleware(app)(_scope(), _receive, _collect([])))

        assert _UUID4.match(seen["request_id"])
        uuid.UUID(seen["request_id"])

    def test_tenant_id_is_absent_when_the_header_is_absent(self) -> None:
        """Never invent a tenant; absent is absent (00-project-context.md)."""
        seen: dict[str, Any] = {}

        async def app(scope: dict, receive: Any, send: Any) -> None:
            seen.update(structlog.contextvars.get_contextvars())
            await send({"type": "http.response.start", "status": 200, "headers": []})

        asyncio.run(RequestContextMiddleware(app)(_scope(), _receive, _collect([])))

        assert "tenant_id" not in seen

    def test_echoes_exactly_one_request_id_header(self) -> None:
        sent: list[dict[str, Any]] = []
        shared_headers = [(b"content-type", b"text/plain")]

        async def app(scope: dict, receive: Any, send: Any) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": shared_headers})
            await send({"type": "http.response.start", "status": 200, "headers": shared_headers})

        asyncio.run(
            RequestContextMiddleware(app)(
                _scope([(b"x-request-id", b"req-42")]), _receive, _collect(sent)
            )
        )

        for message in sent:
            names = [key for key, _ in message["headers"] if key.lower() == b"x-request-id"]
            assert names == [b"x-request-id"]
        # The inner app's own list must never be mutated in place: the same list
        # object is reused across sends and would accumulate a duplicate header.
        assert shared_headers == [(b"content-type", b"text/plain")]

    def test_replaces_an_inbound_request_id_header_on_the_response(self) -> None:
        sent: list[dict[str, Any]] = []

        async def app(scope: dict, receive: Any, send: Any) -> None:
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"x-request-id", b"stale")],
                }
            )

        asyncio.run(
            RequestContextMiddleware(app)(
                _scope([(b"x-request-id", b"req-42")]), _receive, _collect(sent)
            )
        )

        values = [value for key, value in sent[0]["headers"] if key.lower() == b"x-request-id"]
        assert values == [b"req-42"]

    def test_clears_contextvars_on_the_exception_path(self) -> None:
        async def app(scope: dict, receive: Any, send: Any) -> None:
            assert structlog.contextvars.get_contextvars()["request_id"] == "req-42"
            raise RuntimeError("boom")

        async def run() -> dict[str, Any]:
            middleware = RequestContextMiddleware(app)
            with pytest.raises(RuntimeError):
                await middleware(_scope([(b"x-request-id", b"req-42")]), _receive, _collect([]))
            return structlog.contextvars.get_contextvars()

        assert asyncio.run(run()) == {}

    def test_clears_contextvars_on_the_success_path(self) -> None:
        async def app(scope: dict, receive: Any, send: Any) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": []})

        async def run() -> dict[str, Any]:
            await RequestContextMiddleware(app)(_scope(), _receive, _collect([]))
            return structlog.contextvars.get_contextvars()

        assert asyncio.run(run()) == {}

    def test_non_http_scope_is_passed_through_untouched(self) -> None:
        calls: list[str] = []

        async def app(scope: dict, receive: Any, send: Any) -> None:
            calls.append(scope["type"])

        asyncio.run(RequestContextMiddleware(app)({"type": "lifespan"}, _receive, _collect([])))

        assert calls == ["lifespan"]


class TestAccessLogMiddleware:
    def test_emits_start_and_complete_with_latency(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        async def app(scope: dict, receive: Any, send: Any) -> None:
            await send({"type": "http.response.start", "status": 201, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})

        asyncio.run(
            AccessLogMiddleware(app, logger_name="stt.access")(_scope(), _receive, _collect([]))
        )

        start, complete = _lines(stream)
        assert start["event"] == "request.start"
        assert start["method"] == "GET"
        assert start["path"] == "/api/v1/things"
        assert complete["event"] == "request.complete"
        assert complete["status_code"] == 201
        assert complete["logger"] == "stt.access"
        assert isinstance(complete["duration_ms"], (int, float))

    def test_complete_is_emitted_at_response_start_not_body_end(
        self, capture_log_output: Capture
    ) -> None:
        """Moving it to body end would turn SSE request latency into generation duration."""
        configure_logging(ObservabilityConfig(service_name="text"))
        stream = capture_log_output()
        observed_before_body: list[str] = []

        async def app(scope: dict, receive: Any, send: Any) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": []})
            observed_before_body.extend(str(line["event"]) for line in _lines(stream))
            await send({"type": "http.response.body", "body": b"chunk"})

        asyncio.run(
            AccessLogMiddleware(app, logger_name="text.access")(_scope(), _receive, _collect([]))
        )

        assert "request.complete" in observed_before_body

    def test_emits_failed_and_reraises(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()

        async def app(scope: dict, receive: Any, send: Any) -> None:
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            asyncio.run(
                AccessLogMiddleware(app, logger_name="stt.access")(_scope(), _receive, _collect([]))
            )

        failed = _lines(stream)[-1]
        assert failed["event"] == "request.failed"
        assert failed["error_type"] == "RuntimeError"
        assert isinstance(failed["duration_ms"], (int, float))

    def test_non_http_scope_is_passed_through_untouched(self, capture_log_output: Capture) -> None:
        configure_logging(ObservabilityConfig(service_name="stt"))
        stream = capture_log_output()
        calls: list[str] = []

        async def app(scope: dict, receive: Any, send: Any) -> None:
            calls.append(scope["type"])

        asyncio.run(
            AccessLogMiddleware(app, logger_name="stt.access")(
                {"type": "websocket"}, _receive, _collect([])
            )
        )

        assert calls == ["websocket"]
        assert _lines(stream) == []


def _collect(sink: list[dict[str, Any]]) -> Callable[[dict[str, Any]], Any]:
    async def send(message: dict[str, Any]) -> None:
        sink.append(message)

    return send
