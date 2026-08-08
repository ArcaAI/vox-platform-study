"""Temporal worker metrics runtime (TASK-636 OBS-06).

The Temporal worker is a SEPARATE process (`pnpm worker:dev` →
`python -m harness.temporal.worker`). The harness FastAPI app's `/metrics` on
:8866 tells you nothing about it, so task-queue latency, workflow-task
timeouts, activity failures and poller health — every signal for the substrate
that runs the durable clinical-documentation workflows — were invisible.

The Temporal SDK emits these only if a `Runtime` is constructed with a
`PrometheusConfig`. No runtime was ever built, so nothing was emitted anywhere.
"""

from __future__ import annotations

import socket

import pytest
from temporalio.runtime import Runtime

from harness.core.config import Settings
from harness.temporal.metrics import build_runtime, reset_runtime_for_tests


@pytest.fixture(autouse=True)
def _reset_memo():
    """The runtime is built once per process; clear the memo between tests."""
    reset_runtime_for_tests()
    yield
    reset_runtime_for_tests()


def test_build_runtime_returns_runtime_when_metrics_enabled() -> None:
    # Port 0 lets the OS pick a free port, so the test never collides with a
    # real worker or a previous run.
    settings = Settings(metrics_enabled=True, temporal_metrics_port=0)

    runtime = build_runtime(settings)

    assert isinstance(runtime, Runtime), (
        "A Temporal Runtime carrying a PrometheusConfig must be built, or the "
        "worker emits no metrics at all (OBS-06)."
    )


def test_build_runtime_returns_none_when_metrics_disabled() -> None:
    """TASK-411 invariant: exporters stay behind a switch."""
    settings = Settings(metrics_enabled=False)

    assert build_runtime(settings) is None


def test_bind_host_defaults_to_loopback() -> None:
    """A PHI-processing service must not become LAN-reachable by accident.

    The Temporal SDK has no opinion here, so the default is ours to set.
    `scripts/dev-service.sh` takes the same posture for the HTTP ports.
    """
    assert Settings().temporal_metrics_host == "127.0.0.1"
    assert Settings().temporal_metrics_port == 9464


def test_build_runtime_never_raises_when_port_is_taken() -> None:
    """A telemetry bind failure must never stop the worker starting.

    Two workers on one host, a stale process, or a container restart racing its
    predecessor must degrade to an unmonitored worker — not a worker that
    refuses to consume from the task queue.
    """
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    taken_port = sock.getsockname()[1]
    sock.listen(1)

    try:
        settings = Settings(metrics_enabled=True, temporal_metrics_port=taken_port)
        result = build_runtime(settings)
        # Either it bound anyway (SO_REUSEADDR) or degraded to None — never raised.
        assert result is None or isinstance(result, Runtime)
    finally:
        sock.close()


def test_runtime_is_built_once_per_process() -> None:
    """Temporal requires exactly one Runtime per process; the memo enforces it."""
    settings = Settings(metrics_enabled=True, temporal_metrics_port=0)

    first = build_runtime(settings)
    second = build_runtime(settings)

    assert first is second
