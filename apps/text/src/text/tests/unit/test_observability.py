"""Tests for Text's `hope_obs` observability wiring (TASK-987).

`hope_obs`'s own suite (`packages/py-obs/tests/`) already covers
`configure_observability`'s internals — the PHI `server_request_hook`,
degrade-to-no-tracing on failure, resource attributes, sampling, the
never-raises posture. That is NOT re-tested here; duplicating a frozen shared
package's suite inside one of its six consumers is exactly the "six shapes of
one thing" this ticket removed.

What stays TEXT-SPECIFIC and is covered here:
- `_build_observability_config` — Text's own `TEXT_OTEL_EXPORTER_ENDPOINT`
  settings field (not `OTEL_EXPORTER_OTLP_ENDPOINT`) must reach
  `ObservabilityConfig.otlp_endpoint`, and the settings-derived identity
  fields (`otel_service_namespace`, `otel_deployment_environment`, `log_level`)
  must be carried over rather than re-derived from the environment.
- `create_app` integration — a configured collector produces a real
  `TracerProvider` on `app.state.tracer_provider`; an absent one does not.
- `Settings.otel_enabled` stays derived from `otel_exporter_endpoint` alone —
  the "no boolean can disagree with the endpoint" invariant `hope_obs.config`
  documents as R-2.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from opentelemetry.sdk.trace import TracerProvider

from text.core.config import Settings
from text.main import _build_observability_config


def _force_reset_otel():
    """Force-reset OTel global state so each test gets a clean provider."""
    import opentelemetry.trace as _trace_mod

    _trace_mod._TRACER_PROVIDER = None
    _trace_mod._TRACER_PROVIDER_SET_ONCE._done = False
    _trace_mod._PROXY_TRACER_PROVIDER._real_tracer_provider = None


@pytest.fixture(autouse=True)
def reset_otel():
    _force_reset_otel()
    yield
    _force_reset_otel()


# ---------------------------------------------------------------------------
# _build_observability_config
# ---------------------------------------------------------------------------


class TestBuildObservabilityConfig:
    def test_carries_the_text_specific_endpoint_var(self):
        settings = Settings(port=5099, otel_exporter_endpoint="http://collector:4317")
        config = _build_observability_config(settings)

        assert config.otlp_endpoint == "http://collector:4317"
        assert config.tracing_enabled is True

    def test_empty_endpoint_disables_tracing(self):
        settings = Settings(port=5099, otel_exporter_endpoint="")
        config = _build_observability_config(settings)

        assert config.otlp_endpoint is None
        assert config.tracing_enabled is False

    def test_carries_namespace_environment_and_log_level(self):
        settings = Settings(port=5099, log_level="debug")
        config = _build_observability_config(settings)

        assert config.service_namespace == settings.otel_service_namespace
        assert config.deployment_environment == settings.otel_deployment_environment
        assert config.log_level == "debug"

    def test_service_name_defaults_to_text(self, monkeypatch):
        """Absent an override, the service's own identity is `text`.

        `OTEL_SERVICE_NAME` legitimately overrides this (`from_env`'s own
        contract — a deployment names its telemetry resource), and `.env.test`
        sets it to `api-gateway` for the whole suite, so this test must clear
        it rather than assume a clean environment.
        """
        monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
        settings = Settings(port=5099)
        config = _build_observability_config(settings)

        assert config.service_name == "text"


# ---------------------------------------------------------------------------
# create_app integration
# ---------------------------------------------------------------------------


class TestCreateAppObservability:
    def test_no_tracer_provider_without_a_collector(self):
        settings = Settings(port=5099, otel_exporter_endpoint="")
        from text.main import create_app

        app = create_app(settings_override=settings)

        assert app.state.tracer_provider is None

    def test_real_tracer_provider_when_a_collector_is_configured(self):
        settings = Settings(port=5099, otel_exporter_endpoint="http://collector:4317")
        from text.main import create_app

        app = create_app(settings_override=settings)

        assert isinstance(app.state.tracer_provider, TracerProvider)

    def test_configure_observability_is_called_once(self):
        settings = Settings(port=5099)
        with patch("text.main.configure_observability") as mock_configure:
            from text.main import create_app

            create_app(settings_override=settings)

            mock_configure.assert_called_once()


# ---------------------------------------------------------------------------
# Settings — otel_enabled stays derived, not declared
# ---------------------------------------------------------------------------


class TestOtelExportIsDerivedNotDeclared:
    """One address decides everything about export.

    `TEXT_OTEL_ENABLED`, `TEXT_OTEL_LOGS_ENABLED` and `TEXT_OTEL_INSECURE` were
    three booleans that could each disagree with the endpoint they described —
    "enabled but no collector", "insecure=false over an http:// URL". They are
    derived now, so they cannot contradict their own source.
    """

    def test_no_boolean_otel_settings_survive(self):
        for retired in ("otel_enabled", "otel_logs_enabled", "otel_insecure"):
            assert retired not in Settings.model_fields

    def test_export_follows_the_presence_of_an_endpoint(self, monkeypatch):
        monkeypatch.delenv("TEXT_OTEL_EXPORTER_ENDPOINT", raising=False)
        assert Settings(port=5099, otel_exporter_endpoint="").otel_enabled is False
        assert (
            Settings(port=5099, otel_exporter_endpoint="http://collector:4317").otel_enabled is True
        )

    def test_the_retired_flags_are_inert(self, monkeypatch):
        """Setting the old names must not turn export off on a configured
        collector — a stale env var that silently blinds telemetry is exactly the
        failure mode deriving removes."""
        monkeypatch.setenv("TEXT_OTEL_ENABLED", "false")
        monkeypatch.setenv("TEXT_OTEL_LOGS_ENABLED", "false")
        settings = Settings(port=5099, otel_exporter_endpoint="http://collector:4317")
        assert settings.otel_enabled is True
