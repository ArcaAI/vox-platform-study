"""Temporal worker entrypoint.

Run with the configured conda env:

    conda run -n arcaenv python -m harness.temporal.worker

The worker polls the configured task queue and hosts the harness workflows and
activities. It requires a reachable Temporal server (see ``infrastructure/docker``
for the dev stack, started via ``--profile temporal``).
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import signal
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration
from temporalio.worker import Worker

from harness.core.config import _DEPLOYED_ENVIRONMENTS, Settings, get_settings
from harness.core.logging import get_logger, setup_logging
from harness.temporal.activities import DOCUMENT_ACTIVITIES, ping_activity
from harness.temporal.client import get_temporal_client
from harness.temporal.workflows import HarnessDocWorkflow, HarnessPingWorkflow

logger = get_logger(__name__)

_SHUTDOWN_SIGNALS = (signal.SIGINT, signal.SIGTERM)

# How often the worker releases idle-expired model weights.
# The MiniCheck entailer is loaded by an ACTIVITY, so its GGUF lives in THIS
# process; the FastAPI app could never sweep it. One minute is well below the
# 60 s minimum idle TTL, so the sweep never becomes the binding constraint.
_MODEL_CACHE_SWEEP_INTERVAL_S = 60.0


async def _sweep_model_caches_once() -> int:
    """Release idle-expired model weights; returns how many. NEVER raises.

    The sweep is blocking (it runs unload hooks), so it goes to a thread — and a
    failure is logged rather than propagated: retention housekeeping must never
    take the worker down mid-poll.
    """
    from harness.sensors.inferential import minicheck_entailer

    try:
        return await asyncio.to_thread(minicheck_entailer.sweep_entailer_cache)
    except Exception as exc:  # noqa: BLE001 — housekeeping never breaks the worker
        logger.warning(
            "harness.worker.model_cache_sweep_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return 0


async def _refresh_model_cache_retention_once(client: Any) -> None:
    """Pull control-plane retention and apply it to the entailer cache. NEVER raises.

    This runs HERE, in the worker, because the MiniCheck GGUF is
    loaded by an activity and is resident in THIS process. `configure`
    adopts the new limits without dropping a resident entailer, so an admin
    moving the slider never evicts a model mid-document.

    No client, or no opinion from the control plane, ⇒ the env values stay in
    force — exactly the behaviour before this control-plane retention feature.
    """
    if client is None:
        return

    from harness.sensors.inferential import minicheck_entailer

    try:
        snapshot = await client.get()
        retention = snapshot.retention()
        if retention:
            minicheck_entailer.configure_entailer_cache(retention)
    except Exception as exc:  # noqa: BLE001 — housekeeping never breaks the worker
        logger.warning(
            "harness.worker.model_cache_retention_refresh_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )


def _effective_config_client() -> Any:
    """The worker's control-plane client, or None when it cannot be built."""
    from harness.core.effective_config import build_effective_config_client

    try:
        return build_effective_config_client()
    except Exception as exc:  # noqa: BLE001 — a worker must boot without the gateway
        logger.warning(
            "harness.worker.effective_config_client_unavailable",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return None


async def _model_cache_housekeeping_once(client: Any = None) -> int:
    """One housekeeping tick: adopt current retention, THEN sweep against it."""
    await _refresh_model_cache_retention_once(client)
    return await _sweep_model_caches_once()


async def _sweep_model_caches_forever(
    interval_s: float = _MODEL_CACHE_SWEEP_INTERVAL_S,
) -> None:
    """Periodic housekeeping loop; cancelled when the worker shuts down."""
    client = _effective_config_client()
    while True:
        await asyncio.sleep(interval_s)
        released = await _model_cache_housekeeping_once(client)
        if released:
            logger.info("harness.worker.model_cache_swept", released=released)


# Liveness heartbeat ────────────────────────────────────────────────────────
#
# The worker serves no HTTP, so it has no endpoint for a kubelet httpGet probe.
# The alternative in this repo — stt-v2-worker's manifest — ships NO probes at
# all, which means a wedged worker is never restarted. That is the gap this
# closes (TASK-625 W-10), so it deliberately does not copy that pattern.
#
# Instead the worker touches a file on a timer and the manifest execs
# `find <file> -mmin -1`. The file's MTIME is the signal: if the asyncio loop
# wedges, the touch stops, the file ages out, and the probe fails. A probe that
# merely checked the file EXISTS would pass forever after the first write and
# detect nothing.
#
# Interval is 15s against a 60s probe window, so three consecutive misses are
# needed before a restart — one slow tick under load does not kill the worker.
HEARTBEAT_PATH = Path("/tmp/harness-worker-heartbeat")  # noqa: S108 - container-local, not shared
_HEARTBEAT_INTERVAL_S = 15.0


async def _write_heartbeat_forever(
    path: Path = HEARTBEAT_PATH,
    interval_s: float = _HEARTBEAT_INTERVAL_S,
) -> None:
    """Touch the liveness file on a timer; cancelled when the worker shuts down.

    Writes BEFORE the first sleep so the file exists as soon as the worker is
    running — otherwise the liveness probe races the first interval and can fail
    a healthy worker during startup.

    Never raises: a heartbeat write failure must not take down a worker that is
    otherwise processing work correctly. A persistent failure ages the file out
    and the probe restarts the pod, which is the intended outcome anyway.
    """
    while True:
        try:
            path.touch()
        except OSError as exc:  # pragma: no cover - defensive
            logger.warning("harness.worker.heartbeat_write_failed", error=str(exc))
        await asyncio.sleep(interval_s)


def _assert_claim_check_store_is_deployable(settings: Settings) -> None:
    """Refuse to start a deployed worker that would offload blobs to the fake store.

    Independent defence behind the ``Settings`` model validator: a
    settings object can be constructed in code or mutated after validation, and the
    worker is the process that actually dereferences claim-check refs — a
    cross-worker retry against the per-process in-memory store raises
    ``ClaimCheckNotFound`` and loses the clinical blob.

    NOTE: this raises, unlike the housekeeping helpers above which deliberately
    log-and-continue. A misconfigured worker must never register on the task queue
    and start accepting work; degrading here would lose data silently.
    """
    if not settings.claim_check.enabled or settings.claim_check.store != "memory":
        return

    if settings.environment in _DEPLOYED_ENVIRONMENTS:
        raise RuntimeError(
            f"refusing to start: claim-check offload is enabled with the in-memory "
            f"store in '{settings.environment}'. Set HARNESS_CLAIM_CHECK_STORE=s3 "
            f"(plus the MinIO endpoint/credentials)."
        )

    # Single-process dev is the supported case for the in-memory store — but running
    # a SECOND worker against it silently breaks cross-worker retries, so say so once.
    logger.warning(
        "harness.worker.claim_check_memory_store",
        environment=settings.environment,
        detail=(
            "in-memory claim-check store: correct for single-worker local dev, but a "
            "second worker process will fail cross-worker activity retries with "
            "ClaimCheckNotFound. Set HARNESS_CLAIM_CHECK_STORE=s3 to run more than one."
        ),
    )


async def run_worker() -> None:
    """Connect to Temporal and run the harness worker until interrupted.

    Shutdown is graceful: SIGINT (Ctrl+C) and SIGTERM (``docker stop`` /
    Kubernetes) set an interrupt event that stops the worker via its async
    context manager. Temporal then drains in-flight activities for up to
    ``graceful_shutdown_timeout_s`` before cancelling them, so a worker being
    rolled is not killed mid-activity.
    """
    settings = get_settings()
    setup_logging(settings.log_level)
    _assert_claim_check_store_is_deployable(settings)

    # TASK-636 OBS-14 — the worker is its own process, separate from the
    # FastAPI app, so it needs its own TracerProvider installed for the
    # TracingInterceptor wired in `get_temporal_client` (below) to export
    # workflow/activity spans instead of no-oping. No-op when tracing is off
    # (default) or the collector is unreachable.
    from harness.core.observability import build_tracer_provider

    build_tracer_provider(settings)

    logger.info(
        "harness.worker.connecting",
        address=settings.temporal.address,
        namespace=settings.temporal.namespace,
        task_queue=settings.temporal.task_queue,
    )
    client = await get_temporal_client(settings)

    interrupt_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in _SHUTDOWN_SIGNALS:
        try:
            loop.add_signal_handler(sig, functools.partial(_request_shutdown, sig, interrupt_event))
        except NotImplementedError:
            # add_signal_handler is unavailable on some platforms (e.g. Windows);
            # fall back to the KeyboardInterrupt path handled in main().
            pass

    worker = Worker(
        client,
        task_queue=settings.temporal.task_queue,
        workflows=[HarnessPingWorkflow, HarnessDocWorkflow],
        activities=[ping_activity, *DOCUMENT_ACTIVITIES],
        graceful_shutdown_timeout=timedelta(seconds=settings.temporal.graceful_shutdown_timeout_s),
        # F-29 — admission cap coordinated with the LLM concurrency governor
        # (HARNESS_LLM_MAX_CONCURRENCY, core/llm_concurrency.py): without this,
        # Temporal admits unbounded concurrent activities, which just queue behind
        # that single process-wide semaphore once they reach an inferential call.
        max_concurrent_activities=settings.max_concurrent_activities,
    )

    logger.info(
        "harness.worker.started",
        task_queue=settings.temporal.task_queue,
        graceful_shutdown_timeout_s=settings.temporal.graceful_shutdown_timeout_s,
        max_concurrent_activities=settings.max_concurrent_activities,
    )
    sweeper = asyncio.create_task(_sweep_model_caches_forever())
    heartbeat = asyncio.create_task(_write_heartbeat_forever())

    # Self-registration (TASK-648 W9): this worker has no inbound HTTP surface
    # of its own, so it registers+heartbeats independently, exactly like the
    # FastAPI app does — fire-and-forget, bounded-timeout, NEVER blocks or
    # fails boot. Registers as service "harness-worker" (distinct from the
    # FastAPI app's "harness" build-info `service` field) so the registry can
    # tell the two processes apart.
    service_release_task = None
    service_release_http_client = httpx.AsyncClient()
    try:
        worker_build_info = _worker_build_info()
        service_release_task = start_registration(
            http_client=service_release_http_client,
            gateway_url=f"{settings.api_base_url.rstrip('/')}/api/v1",
            service_token=settings.service_token.get_secret_value(),
            build_info=worker_build_info,
            environment=settings.environment,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("harness.worker.service_release_registration_failed", error=str(exc))

    try:
        async with worker:
            await interrupt_event.wait()
    finally:
        for task in (sweeper, heartbeat):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await stop_registration(service_release_task)
        await service_release_http_client.aclose()
    logger.info("harness.worker.stopped")


def _worker_build_info() -> Any:
    """The worker's build-info, `service` renamed to `harness-worker`.

    Same baked `/app/build-info.json` as the FastAPI app (same image), so
    every field except `service` is identical; the rename is what lets the
    registry distinguish the two processes booted from that one image.
    """
    from dataclasses import replace

    base = BuildInfoReader().get_build_info()
    return replace(base, service="harness-worker")


def _request_shutdown(sig: signal.Signals, interrupt_event: asyncio.Event) -> None:
    """Signal handler: log once and trigger graceful worker shutdown."""
    if not interrupt_event.is_set():
        logger.info("harness.worker.shutdown_requested", signal=sig.name)
    interrupt_event.set()


def main() -> None:
    """Console-script / module entrypoint."""
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        # Reached only when signal handlers could not be installed (e.g. running
        # off the main thread, or an unsupported platform). Exit cleanly instead
        # of dumping a traceback.
        logger.info("harness.worker.interrupted")


if __name__ == "__main__":
    main()
