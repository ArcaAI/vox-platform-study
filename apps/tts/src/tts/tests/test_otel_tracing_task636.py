"""TDD tests for TTS observability — logging, request context and tracing via
``hope_obs`` (TASK-987 lane H).

TTS's OTel setup used to be entirely hand-rolled (`core/observability.py`) and
was the fleet's HARDENED reference on two axes: it never raised, and it always
wired a PHI-sanitisation hook into ``FastAPIInstrumentor`` — because TTS
receives clinical text on every synthesis request. This file ports the
original assertions onto the new ``hope_obs``-backed implementation
(``tts.core.observability.build_observability_config`` /
``setup_observability``) rather than deleting them, and adds coverage the
fleet-wide standard requires that TTS never had before:

  (a) tracing settings default OFF, ``TTS_OTEL_ENABLED`` is honoured for one
      release with a deprecation warning (R-2);
  (b) ``build_observability_config`` translates TTS's own ``TTS_``-prefixed
      settings onto the shared ``ObservabilityConfig`` correctly;
  (c) the PHI hook is wired into ``FastAPIInstrumentor.instrument_app``
      UNCONDITIONALLY whenever tracing is on — "the hook exists but is never
      passed" is a defect this fleet has shipped twice (NLP, then STT); TTS
      must never become the third;
  (d) ``create_app`` never raises, even with a configured-but-unreachable
      collector, or when exporter/resource construction itself fails;
  (e) ``deployment.environment`` still defaults to ``development``, never the
      ``"production"`` function default finding F-09 flagged (now deleted
      entirely, since the parameter it lived on no longer exists);
  (f) the request-context / access-log middlewares hope_obs installs: exactly
      one ``X-Request-ID`` echoed, ``X-Tenant-Id`` -> ``tenant_id`` on the log
      line, one ``request.complete`` JSON line per request carrying
      ``request_id`` and ``duration_ms``, and ``traceId`` on that line once a
      span is active (F-05 — TTS had none of this before).
"""

from __future__ import annotations

import io
import json
import logging
import warnings
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest
from hope_obs.phi import phi_sanitization_hook
from httpx import ASGITransport, AsyncClient
from opentelemetry.sdk.trace import TracerProvider

from tts.core.config import Settings
from tts.core.observability import build_observability_config, shutdown_observability


def _force_reset_otel() -> None:
    """Force-reset OTel global tracer-provider state so each test gets a
    clean provider. ``set_tracer_provider`` otherwise only accepts the FIRST
    call per process and silently ignores the rest.
    """
    import opentelemetry.trace as _trace_mod

    _trace_mod._TRACER_PROVIDER = None
    _trace_mod._TRACER_PROVIDER_SET_ONCE._done = False
    _trace_mod._PROXY_TRACER_PROVIDER._real_tracer_provider = None


@pytest.fixture(autouse=True)
def reset_otel():
    # `HTTPXClientInstrumentor().instrument()` patches `httpx` at the PROCESS
    # level (not per-app). Any test in this module that exercises the real
    # (unmocked) tracing setup would otherwise leave that global monkeypatch
    # in place for the rest of the pytest session, which breaks every other
    # TTS test that drives the app via
    # `httpx.AsyncClient(transport=ASGITransport(...))`. No test here asserts
    # on HTTPX instrumentation itself, so it is neutralised for the whole
    # module — mirrors the pre-TASK-987 version of this file.
    with patch("opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor"):
        _force_reset_otel()
        yield
        _force_reset_otel()


@contextmanager
def _capture_log_stream():
    """Redirect the already-configured root ``StreamHandler`` into a buffer.

    ``configure_logging`` (via ``create_app``) is idempotent and installs its
    handler at most once per process, so the handler this finds may have been
    installed by an earlier test in the session — that is fine, this only
    needs its stream. Restored on exit so later tests keep the real stream.
    """
    root = logging.getLogger()
    handler = next((h for h in root.handlers if isinstance(h, logging.StreamHandler)), None)
    assert handler is not None, "hope_obs logging was not configured by create_app"
    original_stream = handler.stream
    buffer = io.StringIO()
    handler.setStream(buffer)
    try:
        yield buffer
    finally:
        handler.setStream(original_stream)


def _json_lines(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def _config_settings(**overrides: Any) -> Settings:
    """A minimal ``Settings`` for ``build_observability_config`` tests."""
    return Settings(host="127.0.0.1", port=5099, **overrides)


def _app_settings(**overrides: Any) -> Settings:
    """A ``Settings`` suitable for booting a real app via ``create_app``."""
    return Settings(host="127.0.0.1", port=5099, metrics_enabled=False, **overrides)


# ---------------------------------------------------------------------------
# (a) Settings — off by default
# ---------------------------------------------------------------------------


class TestOtelSettingsDefaults:
    def test_otel_disabled_by_default(self) -> None:
        assert Settings().otel_enabled is False

    def test_otel_exporter_endpoint_empty_by_default(self) -> None:
        # No hardcoded localhost default — an unset endpoint must never be
        # mistaken for "configured".
        assert Settings().otel_exporter_endpoint == ""

    def test_otel_enabled_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_OTEL_ENABLED", "true")
        assert Settings().otel_enabled is True

    def test_otel_exporter_endpoint_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")
        assert Settings().otel_exporter_endpoint == "http://collector:4317"

    def test_otel_service_name_default(self) -> None:
        assert Settings().otel_service_name == "tts"


# ---------------------------------------------------------------------------
# (b) build_observability_config — Settings -> the shared ObservabilityConfig
# ---------------------------------------------------------------------------


class TestBuildObservabilityConfig:
    def test_no_endpoint_means_tracing_disabled(self, monkeypatch) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        config = build_observability_config(_config_settings())
        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_settings_endpoint_enables_tracing(self) -> None:
        config = build_observability_config(
            _config_settings(otel_exporter_endpoint="http://collector:4317")
        )
        assert config.tracing_enabled is True
        assert config.otlp_endpoint == "http://collector:4317"

    def test_carries_over_service_identity_and_environment(self) -> None:
        config = build_observability_config(
            _config_settings(
                otel_exporter_endpoint="http://collector:4317",
                otel_service_name="hope-tts-v2",
                otel_service_namespace="hope-ns",
                otel_deployment_environment="staging",
                log_level="debug",
            )
        )
        assert config.service_name == "hope-tts-v2"
        assert config.service_namespace == "hope-ns"
        assert config.deployment_environment == "staging"
        assert config.log_level == "debug"

    def test_never_defaults_deployment_environment_to_production(self, monkeypatch) -> None:
        """F-09: the pre-migration `setup_opentelemetry` carried a function
        default of `deployment_environment: str = "production"`. That
        parameter — and the whole function — is deleted; pin the replacement
        never reintroduces it."""
        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.delenv("NODE_ENV", raising=False)
        config = build_observability_config(_config_settings())
        assert config.deployment_environment == "development"

    def test_deprecated_flag_false_vetoes_tracing_even_with_endpoint(self) -> None:
        """`TTS_OTEL_ENABLED=false` must still win for one release — the dev
        cluster sets it alongside the endpoint today — even though R-2 makes
        endpoint presence the only real enable signal going forward."""
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=False,
            otel_exporter_endpoint="http://collector:4317",
        )
        with pytest.warns(DeprecationWarning, match="TTS_OTEL_ENABLED"):
            config = build_observability_config(settings)
        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_deprecated_flag_true_still_warns(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=True,
            otel_exporter_endpoint="http://collector:4317",
        )
        with pytest.warns(DeprecationWarning, match="TTS_OTEL_ENABLED"):
            config = build_observability_config(settings)
        # True never vetoes — the endpoint alone would already have enabled
        # tracing; the flag being explicitly set is what triggers the warning.
        assert config.tracing_enabled is True

    def test_no_warning_when_flag_left_at_default(self) -> None:
        settings = _config_settings(otel_exporter_endpoint="http://collector:4317")
        assert "otel_enabled" not in settings.model_fields_set
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            config = build_observability_config(settings)  # must not raise/warn
        assert config.tracing_enabled is True


# ---------------------------------------------------------------------------
# (c) create_app wiring — tracer_provider set only when an endpoint resolves
# ---------------------------------------------------------------------------


class TestCreateAppOtelWiring:
    def test_tracer_provider_is_none_without_endpoint(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        assert app.state.tracer_provider is None

    def test_tracer_provider_set_when_endpoint_configured(self) -> None:
        from tts.main import create_app

        app = create_app(
            settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
        )
        assert isinstance(app.state.tracer_provider, TracerProvider)
        shutdown_observability(app)

    async def test_app_boots_and_serves_health_with_unreachable_endpoint(self) -> None:
        """Startup must not fail even with a real (unreachable) collector
        endpoint configured, and the service stays serviceable — invariant."""
        from tts.main import create_app

        app = create_app(
            settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/health")
        assert response.status_code == 200
        shutdown_observability(app)


# ---------------------------------------------------------------------------
# (d) never raises — the invariant TTS was already hardened for
# ---------------------------------------------------------------------------


class TestNeverRaises:
    def test_create_app_does_not_raise_with_unroutable_endpoint(self) -> None:
        from tts.main import create_app

        app = create_app(
            settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
        )
        assert app is not None
        # An unroutable-but-syntactically-valid endpoint is a RUNTIME export
        # failure, not a configuration failure (TASK-987 R-2) — tracing stays
        # ON, the gRPC channel connects lazily and buffers.
        assert isinstance(app.state.tracer_provider, TracerProvider)
        shutdown_observability(app)

    def test_create_app_does_not_raise_when_exporter_construction_fails(self) -> None:
        with patch(
            "hope_obs.tracing.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            from tts.main import create_app

            app = create_app(
                settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
            )
        assert app is not None
        # A genuine configuration failure degrades to no-tracing.
        assert app.state.tracer_provider is None

    def test_create_app_does_not_raise_on_resource_create_failure(self) -> None:
        with patch(
            "hope_obs.tracing.Resource.create",
            side_effect=RuntimeError("boom"),
        ):
            from tts.main import create_app

            app = create_app(
                settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
            )
        assert app is not None
        assert app.state.tracer_provider is None


# ---------------------------------------------------------------------------
# (e) PHI sanitisation hook — mandatory, unconditional
# ---------------------------------------------------------------------------


class TestPhiHookWiring:
    def test_phi_hook_passed_to_fastapi_instrumentor_unconditionally(self) -> None:
        with patch("opentelemetry.instrumentation.fastapi.FastAPIInstrumentor") as MockFastAPI:
            from tts.main import create_app

            create_app(
                settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
            )

            call = MockFastAPI.instrument_app.call_args
            assert call is not None, "FastAPIInstrumentor.instrument_app was never called"
            assert call.kwargs.get("server_request_hook") is phi_sanitization_hook

    def test_no_hook_argument_exists_to_switch_it_off(self) -> None:
        """There is no `phi_redaction=False` knob anywhere in this module —
        the hook is unconditional by construction, not by a default that a
        future call site could flip."""
        import inspect

        from tts.core.observability import setup_observability

        params = inspect.signature(setup_observability).parameters
        assert set(params) == {"app", "settings"}

    def test_excludes_health_and_metrics_urls(self) -> None:
        with patch("opentelemetry.instrumentation.fastapi.FastAPIInstrumentor") as MockFastAPI:
            from tts.main import create_app

            create_app(
                settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
            )

            call = MockFastAPI.instrument_app.call_args
            excluded = call.kwargs["excluded_urls"]
            assert "/api/v1/health" in excluded
            assert "/metrics" in excluded


# ---------------------------------------------------------------------------
# (f) Request context + access log middlewares (F-05, F-06, F-07)
# ---------------------------------------------------------------------------


class TestRequestContextAndAccessLog:
    async def test_request_id_is_echoed_exactly_once(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                "/api/v1/voices", headers={"X-Request-ID": "test-request-42"}
            )
        assert response.status_code == 200
        assert response.headers.get_list("x-request-id") == ["test-request-42"]

    async def test_request_without_inbound_id_gets_a_generated_one(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/voices")
        ids = response.headers.get_list("x-request-id")
        assert len(ids) == 1
        assert ids[0]  # non-empty

    async def test_request_complete_line_carries_request_id_and_duration(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        with _capture_log_stream() as stream:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get(
                    "/api/v1/voices", headers={"X-Request-ID": "req-track-me"}
                )
        assert response.status_code == 200
        lines = _json_lines(stream)
        complete = next(line for line in lines if line["event"] == "request.complete")
        assert complete["request_id"] == "req-track-me"
        assert isinstance(complete["duration_ms"], (int, float))
        assert complete["status_code"] == 200

    async def test_tenant_id_header_appears_as_tenant_id_on_the_log_line(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        with _capture_log_stream() as stream:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                await client.get(
                    "/api/v1/voices",
                    headers={"X-Request-ID": "req-tenant", "X-Tenant-Id": "tenant-abc-123"},
                )
        lines = _json_lines(stream)
        complete = next(line for line in lines if line["event"] == "request.complete")
        assert complete["tenant_id"] == "tenant-abc-123"

    async def test_tenant_id_absent_when_header_not_sent(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        with _capture_log_stream() as stream:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                await client.get("/api/v1/voices", headers={"X-Request-ID": "req-no-tenant"})
        lines = _json_lines(stream)
        complete = next(line for line in lines if line["event"] == "request.complete")
        assert "tenant_id" not in complete

    async def test_trace_id_appears_on_log_lines_when_tracing_enabled(self) -> None:
        """F-05 — TTS had zero trace correlation on log lines before this.

        `/api/v1/voices` is NOT in `hope_obs.tracing.EXCLUDED_URLS` (unlike
        `/api/v1/health`), so a real request opens a real server span.
        """
        from tts.main import create_app

        app = create_app(
            settings_override=_app_settings(otel_exporter_endpoint="http://localhost:1")
        )
        transport = ASGITransport(app=app)
        with _capture_log_stream() as stream:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get("/api/v1/voices")
        assert response.status_code == 200
        lines = _json_lines(stream)
        complete = next(line for line in lines if line["event"] == "request.complete")
        assert "traceId" in complete
        assert len(complete["traceId"]) == 32
        assert "spanId" in complete
        shutdown_observability(app)

    async def test_no_trace_id_when_tracing_disabled(self) -> None:
        from tts.main import create_app

        app = create_app(settings_override=_app_settings())
        transport = ASGITransport(app=app)
        with _capture_log_stream() as stream:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get("/api/v1/voices")
        assert response.status_code == 200
        lines = _json_lines(stream)
        complete = next(line for line in lines if line["event"] == "request.complete")
        assert "traceId" not in complete


# ---------------------------------------------------------------------------
# Fleet-wide regression guard — deployment.environment is never hardcoded
# ---------------------------------------------------------------------------


class TestDeploymentEnvironmentIsNotHardcoded:
    """`apps/text/core/config.py` is the reference every service's OTel setup
    was copied from, and it defaulted to "production". TTS, harness and STT
    all inherited that literal. A hardcoded "production" tags a developer
    laptop's spans as production data: a mislabelled dev span is noise, a
    mislabelled prod span corrupts an audit trail.
    """

    def test_defaults_to_development_never_production(self, monkeypatch) -> None:
        from tts.core.config import Settings

        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.delenv("NODE_ENV", raising=False)

        assert Settings().otel_deployment_environment == "development"

    def test_reads_deployment_environment(self, monkeypatch) -> None:
        from tts.core.config import Settings

        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

        assert Settings().otel_deployment_environment == "staging"
