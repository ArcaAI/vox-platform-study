"""STT telemetry resource must not hardcode the environment (TASK-636 OBS-18).

`_build_resource` stamped `deployment.environment: "production"` on every span
and log record regardless of where it actually ran. Combined with the OTel
collector — which upserted `"dev"` over everything — the two disagreed inside
one pipeline, and telemetry outside dev was wrong from both directions.

The environment is a deployment fact, so it comes from the environment.
"""

from __future__ import annotations

import importlib

import pytest


def _resource_attrs(service_name: str = "stt") -> dict:
    import stt.core.telemetry as telemetry

    importlib.reload(telemetry)
    return dict(telemetry._build_resource(service_name).attributes)


def test_environment_is_read_from_env_not_hardcoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

    attrs = _resource_attrs()

    assert attrs["deployment.environment"] == "staging"
    # Emit the current semantic-convention key too, matching the collector.
    assert attrs["deployment.environment.name"] == "staging"


def test_falls_back_to_node_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """NODE_ENV is the repo-wide environment selector (TASK-558)."""
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
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "dev")

    attrs = _resource_attrs("stt-worker")

    assert attrs["service.name"] == "stt-worker"
    assert attrs["service.namespace"] == "hope"
    assert "service.version" in attrs
