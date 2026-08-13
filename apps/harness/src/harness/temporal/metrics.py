"""Temporal SDK metrics runtime.

The Temporal worker is a separate process from the FastAPI app, so the
harness's ``/metrics`` on :8866 says nothing about it. Task-queue latency,
workflow-task timeouts, activity failures and poller health — every signal for
the substrate running the durable clinical-documentation workflows — were
invisible because no ``Runtime`` was ever constructed.

The SDK emits metrics only when a ``Runtime`` is built with a telemetry config,
and a ``Runtime`` must be created ONCE per process and passed to
``Client.connect(runtime=...)``.
"""

from __future__ import annotations

from temporalio.runtime import PrometheusConfig, Runtime, TelemetryConfig

from harness.core.config import Settings
from harness.core.logging import get_logger

logger = get_logger(__name__)

_runtime: Runtime | None = None
_built = False


def build_runtime(settings: Settings) -> Runtime | None:
    """Build (once per process) the Temporal runtime that exports metrics.

    Returns ``None`` when metrics are disabled, or when the exporter cannot
    start. Callers pass the result straight to ``Client.connect(runtime=...)``,
    where ``None`` means "SDK default runtime, no metrics" — so a telemetry
    failure degrades to an unmonitored worker, never to a worker that will not
    start.
    """
    global _runtime, _built

    if _built:
        return _runtime
    _built = True

    if not settings.metrics_enabled:
        logger.info("temporal.metrics_disabled", reason="metrics_enabled=false")
        return None

    bind = f"{settings.temporal_metrics_host}:{settings.temporal_metrics_port}"
    try:
        _runtime = Runtime(
            telemetry=TelemetryConfig(
                metrics=PrometheusConfig(
                    bind_address=bind,
                    # Emit `_total` on counters and seconds-based histograms so
                    # the series follow Prometheus naming conventions rather
                    # than the SDK's millisecond defaults.
                    counters_total_suffix=True,
                    durations_as_seconds=True,
                )
            )
        )
        logger.info("temporal.metrics_enabled", bind_address=bind)
    except Exception as exc:
        # A held port (two workers on one host, a container restart racing its
        # predecessor) must not stop the worker consuming from the task queue.
        logger.warning("temporal.metrics_setup_failed", bind_address=bind, error=str(exc))
        _runtime = None

    return _runtime


def reset_runtime_for_tests() -> None:
    """Clear the once-per-process memo. Test-only."""
    global _runtime, _built
    _runtime = None
    _built = False
