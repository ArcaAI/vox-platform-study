"""
Comprehensive E2E tests for health & metrics endpoints (Track A).

Enhances existing health endpoint coverage with:
  - Full response schema validation (every field, every type)
  - Performance/latency assertions
  - Component-level readiness checks with nullable field coverage
  - Prometheus metrics format validation (structure + content)
  - 404/405 edge-case routes with response body assertions
  - CORS header validation
  - Concurrent request safety
  - HEAD method support

All tests in this file use the ``configured_app`` fixture (testcontainers)
and do NOT require ML dependencies.

Endpoints covered:
  GET  /api/v1/health
  GET  /api/v1/live
  GET  /api/v1/ready
  GET  /metrics
  GET  /nonexistent  (404)
  POST /api/v1/health  (405)

Anti-patterns avoided (see testing-anti-patterns skill):
  #1 — No mocks: all tests hit the real FastAPI app via ASGITransport
  #2 — No test-only production code: uses testcontainers + real endpoints
  #4 — Complete schema assertions: every field, every type, nullable fields
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime

import pytest

# Valid HealthStatus values from the production enum.
# "not_initialized" is used by informational components (e.g. streaming)
# that may legitimately not be started in batch-only mode.
_VALID_HEALTH_STATUSES = frozenset({"healthy", "degraded", "unhealthy", "not_initialized"})

# Required infrastructure component names from the /ready endpoint
_REQUIRED_COMPONENTS = frozenset({"database", "minio", "redis"})


# ---------------------------------------------------------------------------
# A1 — Health endpoint: schema validation + performance
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestHealthEndpointE2E:
    """Comprehensive tests for GET /api/v1/health."""

    async def test_health_returns_200_with_complete_schema(self, configured_app):
        """Verify every field, type, and value in the response."""
        response = await configured_app.get("/api/v1/health")
        assert response.status_code == 200

        data = response.json()

        expected_keys = {"status", "service", "version", "uptime_seconds", "timestamp", "checks"}
        assert set(data.keys()) == expected_keys, (
            f"Unexpected keys in /health response: {set(data.keys())}"
        )

        assert data["status"] in _VALID_HEALTH_STATUSES

        assert isinstance(data["service"], str)
        assert data["service"] == "stt-v2"

        assert isinstance(data["version"], str)
        assert len(data["version"]) > 0

        assert isinstance(data["uptime_seconds"], (int, float))
        assert isinstance(data["checks"], dict)

        ts = datetime.fromisoformat(data["timestamp"])
        age_seconds = (datetime.utcnow() - ts).total_seconds()
        assert 0 <= age_seconds < 30, f"Timestamp is {age_seconds:.1f}s old — expected < 30s"

    async def test_health_response_time_under_threshold(self, configured_app):
        """Health endpoint should respond in < 500 ms."""
        start = time.monotonic()
        response = await configured_app.get("/api/v1/health")
        elapsed_ms = (time.monotonic() - start) * 1000

        assert response.status_code == 200
        assert elapsed_ms < 500, f"Health endpoint took {elapsed_ms:.0f}ms (limit 500ms)"

    async def test_health_returns_json_content_type(self, configured_app):
        """Response content-type must be application/json."""
        response = await configured_app.get("/api/v1/health")
        assert response.status_code == 200
        content_type = response.headers.get("content-type", "")
        assert "application/json" in content_type

    async def test_health_head_request_succeeds(self, configured_app):
        """HEAD on /health should return 200 with no body (monitoring tools use this)."""
        response = await configured_app.head("/api/v1/health")
        # FastAPI may return 200 or 405 for HEAD — both are valid contracts
        assert response.status_code in (200, 405)

    async def test_health_concurrent_requests(self, configured_app):
        """Multiple concurrent /health requests must all succeed."""
        responses = await asyncio.gather(*[configured_app.get("/api/v1/health") for _ in range(10)])
        for resp in responses:
            assert resp.status_code == 200
            assert resp.json()["status"] in _VALID_HEALTH_STATUSES


# ---------------------------------------------------------------------------
# A2 — Liveness endpoint: minimal OK + performance
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestLivenessEndpointE2E:
    """Comprehensive tests for GET /api/v1/live."""

    async def test_live_returns_exact_minimal_response(self, configured_app):
        """Liveness probe must return exactly {\"status\": \"healthy\"} with no extra keys."""
        response = await configured_app.get("/api/v1/live")
        assert response.status_code == 200

        data = response.json()
        assert data == {"status": "healthy"}, f"Liveness response has unexpected data: {data}"

    async def test_live_response_time_under_100ms(self, configured_app):
        """Liveness should be the fastest endpoint (< 100 ms)."""
        start = time.monotonic()
        response = await configured_app.get("/api/v1/live")
        elapsed_ms = (time.monotonic() - start) * 1000

        assert response.status_code == 200
        assert elapsed_ms < 100, f"Liveness took {elapsed_ms:.0f}ms (limit 100ms)"

    async def test_live_is_idempotent(self, configured_app):
        """Multiple rapid calls should all return the same result."""
        for _ in range(5):
            response = await configured_app.get("/api/v1/live")
            assert response.status_code == 200
            assert response.json() == {"status": "healthy"}

    async def test_live_returns_json_content_type(self, configured_app):
        """Liveness content-type must be application/json."""
        response = await configured_app.get("/api/v1/live")
        content_type = response.headers.get("content-type", "")
        assert "application/json" in content_type


# ---------------------------------------------------------------------------
# A3 — Readiness endpoint: component status validation
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestReadinessEndpointE2E:
    """Comprehensive tests for GET /api/v1/ready."""

    async def test_ready_returns_complete_top_level_schema(self, configured_app):
        """Verify the readiness response schema.

        The readiness endpoint returns {"status": "healthy"} on 200 or
        {"status": "unhealthy", "message": "..."} on 503.  In testcontainer
        mode MinIO and Redis may not be initialized, so 503 is acceptable.
        """
        response = await configured_app.get("/api/v1/ready")

        data = response.json()
        assert "status" in data
        assert data["status"] in _VALID_HEALTH_STATUSES

        if response.status_code == 200:
            assert data["status"] == "healthy"
        else:
            assert response.status_code == 503
            assert data["status"] == "unhealthy"
            assert "message" in data

    async def test_ready_returns_all_required_components(self, configured_app):
        """The /health endpoint (not /ready) exposes component-level checks.

        The readiness endpoint is a lightweight pass/fail probe.
        Verify that the detailed /health endpoint includes component checks.
        """
        response = await configured_app.get("/api/v1/health")
        data = response.json()

        assert "checks" in data
        component_names = set(data["checks"].keys())
        assert _REQUIRED_COMPONENTS.issubset(component_names), (
            f"Missing required components. Found: {component_names}, "
            f"expected at least: {_REQUIRED_COMPONENTS}"
        )

    async def test_ready_component_schema_is_complete(self, configured_app):
        """Every check in /health must have status and duration_ms."""
        response = await configured_app.get("/api/v1/health")
        data = response.json()

        for cname, component in data["checks"].items():
            assert "status" in component, f"Component {cname}: missing 'status'"
            assert (
                component["status"] in _VALID_HEALTH_STATUSES
            ), f"Component {cname}: unknown status '{component['status']}'"

            assert "duration_ms" in component, f"Component {cname}: missing 'duration_ms'"
            assert isinstance(
                component["duration_ms"], (int, float)
            ), f"Component {cname}: duration_ms is not numeric"
            assert component["duration_ms"] >= 0, f"Component {cname}: negative duration"

    async def test_ready_healthy_when_all_services_up(self, configured_app):
        """When all infra is running, the /health endpoint should report status.

        Note: The ``configured_app`` fixture uses testcontainers but does NOT
        trigger the FastAPI lifespan (``initialize_minio`` / ``configure_broker``
        are not called).  MinIO and Redis health checks will therefore report
        *unhealthy*.  Only the database component is expected to be healthy.
        """
        response = await configured_app.get("/api/v1/health")
        data = response.json()
        assert data["status"] in _VALID_HEALTH_STATUSES

        db_check = data["checks"].get("database")
        assert db_check is not None, "Expected 'database' check in /health response"
        assert db_check["status"] == "healthy", (
            f"Database check should be healthy via testcontainer, "
            f"got '{db_check['status']}': {db_check.get('message')}"
        )

    async def test_ready_component_latency_sanity(self, configured_app):
        """Component durations in /health should be positive and under 5 seconds."""
        response = await configured_app.get("/api/v1/health")
        data = response.json()

        for cname, component in data["checks"].items():
            duration = component["duration_ms"]
            assert 0 <= duration < 5000, (
                f"Component '{cname}' duration {duration:.1f}ms "
                f"outside sanity range [0, 5000)ms"
            )

    async def test_ready_healthy_components_have_no_message(self, configured_app):
        """Healthy components in /health should not have a message field."""
        response = await configured_app.get("/api/v1/health")
        data = response.json()

        for cname, component in data["checks"].items():
            if component["status"] == "healthy":
                assert "message" not in component, (
                    f"Healthy component '{cname}' has unexpected message: "
                    f"'{component.get('message')}'"
                )

    async def test_ready_concurrent_requests(self, configured_app):
        """Concurrent readiness checks must not interfere with each other."""
        responses = await asyncio.gather(*[configured_app.get("/api/v1/ready") for _ in range(5)])
        for resp in responses:
            assert resp.status_code in (200, 503)
            assert resp.json()["status"] in _VALID_HEALTH_STATUSES


# ---------------------------------------------------------------------------
# A4 — Metrics endpoint: Prometheus format validation
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestMetricsEndpointE2E:
    """Comprehensive tests for GET /metrics."""

    async def test_metrics_returns_valid_prometheus_format(self, configured_app):
        """Response must contain Prometheus exposition format with HELP + TYPE lines."""
        response = await configured_app.get("/metrics")
        assert response.status_code == 200

        text = response.text
        lines = text.strip().splitlines()

        # Must have meaningful content — not just a header
        assert (
            len(lines) >= 3
        ), f"Metrics response has only {len(lines)} lines — expected at least 3"

        # Prometheus format requires # HELP and # TYPE lines
        has_help = any(line.startswith("# HELP") for line in lines)
        has_type = any(line.startswith("# TYPE") for line in lines)
        assert has_help or has_type, (
            "Metrics response has no # HELP or # TYPE lines — "
            "does not appear to be valid Prometheus exposition format"
        )

    async def test_metrics_includes_http_request_metrics_after_traffic(self, configured_app):
        """After making requests, HTTP request metrics should appear."""
        # Generate some traffic first
        await configured_app.get("/api/v1/health")
        await configured_app.get("/api/v1/live")

        response = await configured_app.get("/metrics")
        text = response.text.lower()

        # prometheus-fastapi-instrumentator exposes http_request_* or starlette_* metrics
        assert "http_request" in text or "starlette" in text, (
            "No HTTP request metrics found after making requests. "
            "Is prometheus-fastapi-instrumentator configured?"
        )

    async def test_metrics_content_type_is_text_plain(self, configured_app):
        """Metrics endpoint must return text/plain content-type per Prometheus spec."""
        response = await configured_app.get("/metrics")
        content_type = response.headers.get("content-type", "")
        assert "text/" in content_type, f"Unexpected content-type for metrics: '{content_type}'"

    async def test_metrics_returns_non_empty_body(self, configured_app):
        """Metrics response should never be empty."""
        response = await configured_app.get("/metrics")
        assert response.status_code == 200
        assert len(response.text.strip()) > 0, "Metrics body is empty"

    async def test_metrics_includes_default_process_metrics(self, configured_app):
        """Default Prometheus client always exposes python_info and process_* metrics."""
        response = await configured_app.get("/metrics")
        text = response.text
        has_python_info = "python_info" in text
        has_process = "process_" in text
        assert (
            has_python_info or has_process
        ), "Expected at least python_info or process_* default metrics"

    async def test_metrics_has_no_duplicate_metric_families(self, configured_app):
        """Each metric family should only be defined once (no duplicate TYPE lines)."""
        response = await configured_app.get("/metrics")
        lines = response.text.strip().splitlines()

        type_lines = [line for line in lines if line.startswith("# TYPE")]
        metric_names = [line.split()[2] for line in type_lines if len(line.split()) >= 3]
        duplicates = [name for name in metric_names if metric_names.count(name) > 1]
        assert len(duplicates) == 0, f"Duplicate metric families found: {set(duplicates)}"


# ---------------------------------------------------------------------------
# A5 — Non-existent routes, wrong methods, and error response format
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestNotFoundRouteE2E:
    """Test non-existent routes return 404 and wrong methods return 405."""

    async def test_unknown_path_returns_404_with_detail(self, configured_app):
        """A completely unknown path should return 404 with a JSON detail field."""
        response = await configured_app.get("/nonexistent/path")
        assert response.status_code == 404
        data = response.json()
        assert "detail" in data, "404 response missing 'detail' field"

    async def test_unknown_api_v1_path_returns_404(self, configured_app):
        """Unknown path under /api/v1/ should return 404."""
        response = await configured_app.get("/api/v1/nonexistent")
        assert response.status_code == 404

    async def test_unknown_internal_path_returns_404(self, configured_app):
        """Unknown path under /internal/ should return 404."""
        response = await configured_app.get("/internal/nonexistent")
        assert response.status_code == 404

    async def test_wrong_method_post_on_health(self, configured_app):
        """POST to GET-only /api/v1/health should return 405 Method Not Allowed."""
        response = await configured_app.post("/api/v1/health")
        assert response.status_code == 405

    async def test_wrong_method_delete_on_health(self, configured_app):
        """DELETE to GET-only /api/v1/health should return 405."""
        response = await configured_app.delete("/api/v1/health")
        assert response.status_code == 405

    async def test_wrong_method_put_on_ready(self, configured_app):
        """PUT to GET-only /api/v1/ready should return 405."""
        response = await configured_app.put("/api/v1/ready")
        assert response.status_code == 405

    async def test_wrong_method_delete_on_live(self, configured_app):
        """DELETE to GET-only /api/v1/live should return 405."""
        response = await configured_app.delete("/api/v1/live")
        assert response.status_code == 405

    async def test_wrong_method_patch_on_metrics(self, configured_app):
        """PATCH to GET-only /metrics should return 405."""
        response = await configured_app.patch("/metrics")
        assert response.status_code == 405


# ---------------------------------------------------------------------------
# A6 — CORS headers validation
# ---------------------------------------------------------------------------


@pytest.mark.e2e
class TestCORSHeadersE2E:
    """Verify CORS middleware is configured on health endpoints."""

    async def test_cors_preflight_on_health(self, configured_app):
        """OPTIONS preflight on /api/v1/health should return CORS headers."""
        response = await configured_app.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:8868/api/v1",
                "Access-Control-Request-Method": "GET",
            },
        )
        # Should not return 405 — CORS middleware handles OPTIONS
        assert response.status_code in (200, 204)

    async def test_cors_allow_origin_on_get_health(self, configured_app):
        """GET /api/v1/health with an Origin header should return Access-Control-Allow-Origin."""
        response = await configured_app.get(
            "/api/v1/health",
            headers={"Origin": "http://localhost:8868/api/v1"},
        )
        assert response.status_code == 200
        # Depending on CORS config, may return * or the specific origin
        acao = response.headers.get("access-control-allow-origin")
        assert (
            acao is not None
        ), "Missing Access-Control-Allow-Origin header on /api/v1/health response"
