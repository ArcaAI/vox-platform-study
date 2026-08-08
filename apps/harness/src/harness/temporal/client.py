"""Temporal client factory.

Centralises how the FastAPI app, the worker, and (later) the API gateway
connect to the Temporal frontend, using the env-configured address/namespace.
"""

from __future__ import annotations

from temporalio.client import Client, Interceptor
from temporalio.contrib.pydantic import pydantic_data_converter

from harness.core.config import Settings, get_settings
from harness.core.logging import get_logger
from harness.temporal.metrics import build_runtime

logger = get_logger(__name__)


def _tracing_interceptors(settings: Settings) -> list[Interceptor]:
    """The Temporal SDK's OTel tracing interceptor, gated the same as HTTP tracing.

    TASK-636 OBS-14. ``TracingInterceptor`` (from
    ``temporalio.contrib.opentelemetry``) applies to BOTH client calls
    (e.g. workflow starts) and, once passed to ``Client.connect``, to the
    Worker built from that client — see its docstring: "This should be
    created and used for ``interceptors`` on the ``Client.connect`` call to
    apply to all client calls and worker calls using that client." So a
    single interceptor here covers ``temporal/worker.py`` too; no separate
    wiring is needed there.

    Empty (not just a disabled interceptor) when tracing is off, matching
    the TASK-411 default-off posture — and never raises: a construction
    failure degrades to an untraced client rather than a failed connect.
    """
    if not settings.otel_tracing_enabled:
        return []
    try:
        from temporalio.contrib.opentelemetry import TracingInterceptor

        return [TracingInterceptor()]
    except Exception as exc:  # noqa: BLE001 - tracing must never block a Temporal connect
        logger.warning("harness.temporal.tracing_interceptor_setup_failed", error=str(exc))
        return []


async def get_temporal_client(settings: Settings | None = None) -> Client:
    """Connect to the Temporal frontend using the configured address/namespace.

    Uses Temporal's Pydantic data converter so the document workflow's Pydantic
    payloads (inputs, signal args, activity I/O) round-trip natively. The
    converter is a superset of the default JSON converter, so the existing
    dataclass-based ping workflow keeps working.
    """
    settings = settings or get_settings()
    return await Client.connect(
        settings.temporal.address,
        namespace=settings.temporal.namespace,
        data_converter=pydantic_data_converter,
        # TASK-636 OBS-06 — SDK metrics (task-queue latency, workflow-task
        # timeouts, activity failures, poller health). `None` means the SDK's
        # default runtime with no metrics, so a disabled or failed exporter
        # degrades to an unmonitored client rather than a failed connect.
        runtime=build_runtime(settings),
        # TASK-636 OBS-14 — workflow/activity trace spans (default OFF).
        interceptors=_tracing_interceptors(settings),
    )
