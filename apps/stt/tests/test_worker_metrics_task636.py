"""STT Dramatiq worker Prometheus exposition.

The batch worker is a SEPARATE process from the FastAPI app. `/metrics` on
:8861 is served by the API process and says nothing about the worker, so batch
transcription throughput, job duration, queue depth and failure rate were
entirely unmeasurable — the worker configured OTel *logs* only.

Why dramatiq's own middleware rather than a hand-rolled exporter: dramatiq
FORKS worker processes (`--processes N`). A naive `start_http_server` in each
fork collides on the port, and plain `prometheus_client` counters would be
per-fork and silently wrong. `dramatiq.middleware.prometheus.Prometheus` is
built for this — it sets `PROMETHEUS_MULTIPROC_DIR`, aggregates across forks,
and binds the HTTP server once.
"""

from __future__ import annotations

import importlib
import os

import pytest


@pytest.fixture()
def restore_broker():
    """configure_broker() memoises into a module global; reset it per test."""
    from stt.core.messaging import broker as broker_mod

    saved = broker_mod._broker
    broker_mod._broker = None
    yield broker_mod
    broker_mod._broker = saved


def _middleware_names(broker) -> list[str]:
    return [type(m).__name__ for m in broker.middleware]


def test_prometheus_middleware_is_registered_when_metrics_enabled(
    restore_broker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The worker must expose dramatiq_* metrics when metrics are enabled."""
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", True, raising=False)

    broker = broker_mod.configure_broker("redis://localhost:6379/0")

    assert "Prometheus" in _middleware_names(broker), (
        "dramatiq's Prometheus middleware must be registered so the batch "
        "worker exposes job throughput/duration/failure metrics (OBS-05)."
    )


def test_prometheus_middleware_absent_when_metrics_disabled(
    restore_broker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Invariant: every exporter stays behind a switch."""
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", False, raising=False)

    broker = broker_mod.configure_broker("redis://localhost:6379/0")

    assert "Prometheus" not in _middleware_names(broker)


def test_bind_address_is_configured_before_middleware_import(
    restore_broker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bind host/port must be settable, and must default to LOOPBACK.

    dramatiq reads `dramatiq_prom_host` / `dramatiq_prom_port` into module-level
    constants at IMPORT time, so they have to be set before the middleware
    module is first imported — a subtle ordering bug if done naively.

    The default matters: dramatiq's own default is 0.0.0.0. A PHI-processing
    dev service must not become LAN-reachable by accident (the same posture
    `scripts/dev-service.sh` takes for the HTTP ports).
    """
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", True, raising=False)
    monkeypatch.delenv("dramatiq_prom_host", raising=False)
    monkeypatch.delenv("dramatiq_prom_port", raising=False)

    broker_mod.configure_broker("redis://localhost:6379/0")

    assert os.environ.get("dramatiq_prom_host") == "127.0.0.1"
    assert os.environ.get("dramatiq_prom_port") == "9191"

    # And the imported middleware module must agree with what we set.
    pm = importlib.import_module("dramatiq.middleware.prometheus")
    assert pm.HTTP_HOST == "127.0.0.1"
    assert pm.HTTP_PORT == 9191
