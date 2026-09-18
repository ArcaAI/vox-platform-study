"""TASK-987 R-4 — request-context + access-log, newly gained by harness (F-05/F-06/F-07).

Before this ticket harness had no `api/middleware` directory at all: no
request id, no echoed `X-Request-ID`, no access log with latency, and no
`tenant_id` binding anywhere in the fleet (finding F-07 — guardrail decisions
the platform requires to be attributable were not attributable in ANY
service's logs). `create_app()` now installs `hope_obs`'s
`RequestContextMiddleware` + `AccessLogMiddleware` via `configure_observability`.

This suite proves harness's INTEGRATION of those middlewares — that
`create_app` actually wires them and a real request through the ASGI app
produces the expected header + log line — not the middlewares' own unit
behaviour (header-replace-not-append, contextvar leak on the exception path,
etc.), which is `packages/py-obs/tests`' job.

Log assertions use a dedicated root-logger handler rather than capturing
stdout: `hope_obs.logging.configure_logging` binds its `StreamHandler` to
whatever `sys.stdout` object exists at import time (module collection, before
any per-test capture fixture is active), and `structlog.stdlib
.ProcessorFormatter` is explicitly designed to let a SECOND handler render
the same `LogRecord` independently — the supported way to observe output
under test, not an OS-fd capture race.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

import pytest
import structlog

from harness.core.config import Settings
from harness.main import create_app


class _JSONLineCollector(logging.Handler):
    """Renders every record through the same JSON shape `hope_obs` installs,
    independent of whatever handler(s) are already on the root logger."""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict] = []
        self.setFormatter(
            structlog.stdlib.ProcessorFormatter(
                processors=[
                    structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                    structlog.processors.JSONRenderer(),
                ]
            )
        )

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.append(json.loads(self.format(record)))
        except Exception:  # noqa: BLE001 - a malformed record must not break the test harness
            pass


@pytest.fixture
def json_log_lines() -> Iterator[list[dict]]:
    """Every JSON log record emitted while this fixture is active."""
    collector = _JSONLineCollector()
    root = logging.getLogger()
    root.addHandler(collector)
    try:
        yield collector.records
    finally:
        root.removeHandler(collector)


class TestServiceComesUpWithAnUnreachableCollector:
    @pytest.mark.asyncio
    async def test_health_still_serves_with_unroutable_endpoint(self) -> None:
        """The service must come up even when the collector is unreachable — the
        same fail-safe posture `harness.main.lifespan` already has for Temporal
        (rule 06: "the FastAPI app must come up even when Temporal is down").
        An OTLP endpoint pointing nowhere must never cost harness its boot or
        its `/health` route.
        """
        from httpx import ASGITransport, AsyncClient

        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=False,
            otel_exporter_endpoint="http://127.0.0.1:1",
        )
        app = create_app(settings_override=settings)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/v1/health")

        assert resp.status_code == 200
        # An unroutable endpoint is a RUNTIME export failure (lazy gRPC connect),
        # not a configuration failure — tracing stays "on" (R-2).
        assert app.state.tracer_provider is not None


class TestRequestIdHeader:
    @pytest.mark.asyncio
    async def test_inbound_request_id_is_echoed_unchanged(self, async_client) -> None:
        resp = await async_client.get(
            "/api/v1/health", headers={"X-Request-ID": "test-request-id-123"}
        )

        assert resp.headers.get_list("x-request-id") == ["test-request-id-123"]

    @pytest.mark.asyncio
    async def test_request_id_generated_when_absent(self, async_client) -> None:
        resp = await async_client.get("/api/v1/health")

        assert resp.headers.get("x-request-id")


class TestAccessLogLine:
    @pytest.mark.asyncio
    async def test_request_complete_carries_request_id_and_duration(
        self, async_client, json_log_lines: list[dict]
    ) -> None:
        resp = await async_client.get("/api/v1/health", headers={"X-Request-ID": "req-fixture-abc"})
        assert resp.status_code == 200

        complete_lines = [r for r in json_log_lines if r.get("event") == "request.complete"]

        assert complete_lines, f"no request.complete line found: {json_log_lines!r}"
        record = complete_lines[-1]
        assert record["request_id"] == "req-fixture-abc"
        assert "duration_ms" in record
        assert record["path"] == "/api/v1/health"
        # No X-Tenant-Id sent on this request — absent is absent, never invented.
        assert "tenant_id" not in record

    @pytest.mark.asyncio
    async def test_tenant_id_appears_on_the_line_when_header_present(
        self, async_client, json_log_lines: list[dict]
    ) -> None:
        await async_client.get(
            "/api/v1/health",
            headers={"X-Request-ID": "req-tenant-check", "X-Tenant-Id": "tenant-abc-123"},
        )

        complete_lines = [r for r in json_log_lines if r.get("event") == "request.complete"]

        assert complete_lines
        assert complete_lines[-1]["tenant_id"] == "tenant-abc-123"

    @pytest.mark.asyncio
    async def test_log_lines_carry_no_clinical_content(
        self, async_client, json_log_lines: list[dict]
    ) -> None:
        """A cheap regression tripwire, not a substitute for the PHI guardrails
        doc: the health endpoint takes no clinical input, so nothing resembling
        a note/transcript field should ever appear on its access log line.
        """
        await async_client.get("/api/v1/health")

        complete_lines = [r for r in json_log_lines if r.get("event") == "request.complete"]

        assert complete_lines
        for forbidden_key in ("transcript", "note", "summary", "prompt", "completion"):
            assert forbidden_key not in complete_lines[-1]
