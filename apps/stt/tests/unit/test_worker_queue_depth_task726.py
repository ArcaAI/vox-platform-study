"""STT batch worker queue-depth metric.

The metric a KEDA `ScaledObject` in the deployment repo would read for the
`stt_batch` queue. Computed lazily via `Gauge.set_function` reading
`RedisBroker.do_qsize()` (Dramatiq's own pending-message primitive), wired
inside the existing `_add_prometheus_middleware` — see
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from prometheus_client import generate_latest


@pytest.fixture()
def restore_broker():
    """configure_broker() memoises into a module global; reset it per test."""
    from stt.core.messaging import broker as broker_mod

    saved = broker_mod._broker
    broker_mod._broker = None
    yield broker_mod
    broker_mod._broker = saved


def test_queue_depth_gauge_reflects_broker_qsize(restore_broker, monkeypatch: pytest.MonkeyPatch):
    """After configure_broker() with metrics enabled, the gauge reads live qsize."""
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", True, raising=False)

    broker = broker_mod.configure_broker("redis://localhost:6379/0")
    monkeypatch.setattr(broker, "do_qsize", lambda queue_name: 7)

    output = generate_latest().decode()

    assert 'stt_worker_queue_depth{queue="stt_batch"} 7.0' in output


def test_queue_depth_gauge_reports_zero_on_broker_error(
    restore_broker, monkeypatch: pytest.MonkeyPatch
):
    """A Redis hiccup at scrape time must not crash /metrics — reports 0.0."""
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", True, raising=False)

    broker = broker_mod.configure_broker("redis://localhost:6379/0")

    def _raise(queue_name: str) -> int:
        raise ConnectionError("redis down")

    monkeypatch.setattr(broker, "do_qsize", _raise)

    output = generate_latest().decode()

    assert 'stt_worker_queue_depth{queue="stt_batch"} 0.0' in output


def test_queue_depth_gauge_not_wired_when_metrics_disabled(
    restore_broker, monkeypatch: pytest.MonkeyPatch
):
    """Invariant: every exporter (incl. this gauge's set_function) stays behind
    the same metrics_enabled switch as the rest of _add_prometheus_middleware."""
    broker_mod = restore_broker
    monkeypatch.setattr(broker_mod.settings, "metrics_enabled", False, raising=False)

    with patch("stt.core.metrics.WORKER_QUEUE_DEPTH") as mock_gauge:
        broker_mod.configure_broker("redis://localhost:6379/0")
        mock_gauge.labels.assert_not_called()
