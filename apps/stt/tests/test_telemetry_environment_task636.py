"""The telemetry resource must not hardcode the environment.

STT's own `_build_resource` used to stamp `deployment.environment:
"production"` on every span and log record regardless of where it actually
ran. Combined with the OTel collector — which upserted `"dev"` over
everything — the two disagreed inside one pipeline, and telemetry outside dev
was wrong from both directions.

TASK-987: resource-building moved to `hope_obs.tracing.build_resource` (fed
by `hope_obs.ObservabilityConfig.from_env`) — `stt.core.telemetry` no longer
carries a local `_build_resource`. This file is kept (rather than deleted) as
a service-level regression pin on the SAME defect, now against the shared
implementation every Python service in the fleet uses.

The environment is a deployment fact, so it comes from the environment.
"""

from __future__ import annotations

import pytest
from hope_obs.config import ObservabilityConfig
from hope_obs.tracing import build_resource


def _resource_attrs(service_name: str = "stt") -> dict:
    config = ObservabilityConfig.from_env(service_name)
    return dict(build_resource(config).attributes)


def test_environment_is_read_from_env_not_hardcoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

    attrs = _resource_attrs()

    assert attrs["deployment.environment"] == "staging"
    # Emit the current semantic-convention key too, matching the collector.
    assert attrs["deployment.environment.name"] == "staging"


def test_falls_back_to_node_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """NODE_ENV is the repo-wide environment selector."""
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.setenv("NODE_ENV", "test")

    assert _resource_attrs()["deployment.environment"] == "test"


def test_defaults_to_development_never_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The old default was 'production' — the most dangerous possible guess.

    An unset environment on a developer laptop would tag local traces as
    production data. Defaulting to 'development' fails safe: a mislabelled dev
    span is noise, a mislabelled prod span corrupts an audit trail.
    """
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)

    assert _resource_attrs()["deployment.environment"] == "development"


def test_service_identity_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pinned against real ambient pollution, not a hypothetical one.

    `hope_obs.ObservabilityConfig.from_env` honours a bare `OTEL_SERVICE_NAME`
    override by design (R-1 — that is how a Deployment names its own
    resource). The root `.env.test` sets that SAME bare name to `api-gateway`
    for the NestJS gateway, and `hope_env.load_env()` — triggered simply by
    importing `stt.core.config.settings` anywhere earlier in a shared pytest
    session — sets it into the real process `os.environ`, not just a
    `Settings` instance. Running this file in isolation never surfaces it;
    running the full `apps/stt` suite does, non-deterministically by test
    order. `monkeypatch.delenv` makes the test's OWN identity assertion
    independent of that shared-file environment.
    """
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "dev")

    attrs = _resource_attrs("stt-worker")

    assert attrs["service.name"] == "stt-worker"
    assert attrs["service.namespace"] == "hope"
    assert "service.version" in attrs
