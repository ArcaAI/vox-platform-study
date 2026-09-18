"""Guardrail's request-time wiring onto `hope_obs` (TASK-987 lane C).

`test_otel_tracing_task636.py` locks the tracing-specific config precedence and
never-raises guarantees. This file locks what findings F-05/F-06/F-07 describe
as ABSENT from guardrail before this ticket — no `merge_contextvars` in its
logging chain, no request-id middleware, no echoed `X-Request-ID`, no access
log, nothing bound for a tenant id to attach to — using the liveness route
(`/api/v1/health/live`) because it needs no lifespan-managed dependency
(Redis, Postgres), the same pattern `test_auth_middleware.py` and
`test_health_endpoints.py` already use to drive `create_app()` without
entering `lifespan`.

RED: written before `guardrail.main.create_app` called
`guardrail.core.observability.setup_observability`, when guardrail emitted no
request id, no access log and no `tenant_id` at all (F-06/F-07).
"""

from __future__ import annotations

import io
import json
import logging

import pytest
import structlog
from httpx import ASGITransport, AsyncClient

from guardrail.main import create_app

#: TASK-985 (M-44) — a path no router claims. The shared access-log middleware
#: now excludes every PROBE spelling (`/health*`, `/ready`, `/live`, `/metrics`,
#: bare and `/api/v1`-prefixed): 913 `request.complete` lines an hour on an idle
#: pod buried the lines that answer real questions. These tests are about the LOG
#: LINE, not the handler, so they ask for something unrouted — a 404 still
#: traverses RequestContext + AccessLog and carries the same fields.
_NON_PROBE_PATH = "/api/v1/__access_log_subject__"

#: The real liveness endpoint. Still needed by the tests that assert it is
#: SERVED — those are about the endpoint, not about the access log.
LIVE_PATH = "/api/v1/health/live"


def _attach_capture() -> io.StringIO:
    """Redirect `hope_obs`'s JSON handler into an in-memory buffer.

    Mirrors `packages/py-obs/tests/conftest.py::capture_log_output`. Must be
    called AFTER `create_app()` — the handler (and the `sys.stdout` reference
    it wraps) is created inside `hope_obs.configure_logging`, and pytest may
    swap `sys.stdout` out from under a handler created before this call.

    Matched by FORMATTER, not just `isinstance(..., logging.StreamHandler)`:
    pytest's own `LogCaptureHandler` (installed on the root logger around
    every test for the "Captured log call" report section) is ALSO a
    `StreamHandler` subclass — redirecting it too interleaved its plain
    `"LEVEL logger:file:line {...}"` lines into this buffer alongside the real
    JSON, which is what broke the first version of this helper.
    """
    stream = io.StringIO()
    for handler in logging.getLogger().handlers:
        if isinstance(handler, logging.StreamHandler) and isinstance(
            handler.formatter, structlog.stdlib.ProcessorFormatter
        ):
            handler.setStream(stream)
    return stream


def _json_lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def _request_complete_lines(stream: io.StringIO) -> list[dict]:
    return [line for line in _json_lines(stream) if line.get("event") == "request.complete"]


class TestNoEndpointConfigured:
    """F-01's default-off invariant, proved at the `create_app()` boundary."""

    async def test_create_app_boots_and_exports_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", raising=False)
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_ENABLED", raising=False)

        app = create_app()

        assert app.state.tracer_provider is None

    async def test_health_live_still_served(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", raising=False)

        app = create_app()
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(LIVE_PATH)

        assert resp.status_code == 200
        assert resp.json()["alive"] is True


class TestUnroutableEndpoint:
    async def test_create_app_does_not_raise(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        app = create_app()  # must not raise

        # Runtime export failure, not a configuration failure (R-2's corrected
        # split) — the gRPC channel connects lazily, so the provider stays set.
        assert app.state.tracer_provider is not None

    async def test_health_live_still_served(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        app = create_app()
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(LIVE_PATH)

        assert resp.status_code == 200
        assert resp.json()["alive"] is True


class TestAccessLogAndRequestContext:
    """F-05/F-06: guardrail had no request-id middleware and no access log at
    all before this ticket. Both are `hope_obs.middleware`'s job now; these
    tests prove `create_app()` actually wires it, not just that `hope_obs`
    offers it (that guarantee is lane F's own suite)."""

    async def test_request_emits_one_request_complete_line_with_request_id_and_duration_ms(
        self,
    ) -> None:
        app = create_app()
        stream = _attach_capture()

        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(_NON_PROBE_PATH)

        assert resp.status_code == 404  # unrouted on purpose — see _NON_PROBE_PATH

        lines = _request_complete_lines(stream)
        assert len(lines) == 1
        line = lines[0]
        assert isinstance(line["request_id"], str) and line["request_id"]
        assert isinstance(line["duration_ms"], int | float)
        assert line["status_code"] == 404

    async def test_inbound_request_id_is_echoed_exactly_once(self) -> None:
        app = create_app()
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(_NON_PROBE_PATH, headers={"X-Request-ID": "req-abc-123"})

        assert resp.status_code == 404  # unrouted on purpose — see _NON_PROBE_PATH
        assert resp.headers.get_list("x-request-id") == ["req-abc-123"]

    async def test_request_complete_line_carries_the_inbound_request_id(self) -> None:
        app = create_app()
        stream = _attach_capture()

        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(_NON_PROBE_PATH, headers={"X-Request-ID": "req-abc-123"})

        assert resp.status_code == 404  # unrouted on purpose — see _NON_PROBE_PATH
        lines = _request_complete_lines(stream)
        assert len(lines) == 1
        assert lines[0]["request_id"] == "req-abc-123"

    async def test_inbound_tenant_id_appears_on_the_log_line(self) -> None:
        """F-07: guardrail decisions must be attributable per tenant
        (`.claude/rules/00-project-context.md`) — before this ticket nothing
        bound a tenant id into any log line at all."""
        app = create_app()
        stream = _attach_capture()

        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(_NON_PROBE_PATH, headers={"X-Tenant-Id": "tenant-xyz"})

        assert resp.status_code == 404  # unrouted on purpose — see _NON_PROBE_PATH
        lines = _request_complete_lines(stream)
        assert len(lines) == 1
        assert lines[0]["tenant_id"] == "tenant-xyz"

    async def test_no_tenant_header_means_no_tenant_id_field(self) -> None:
        """Absent stays absent — the middleware never invents or defaults a
        tenant (rule 00: a 'default tenant' knob is the exact failure mode)."""
        app = create_app()
        stream = _attach_capture()

        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(_NON_PROBE_PATH)

        assert resp.status_code == 404  # unrouted on purpose — see _NON_PROBE_PATH
        lines = _request_complete_lines(stream)
        assert len(lines) == 1
        assert "tenant_id" not in lines[0]
