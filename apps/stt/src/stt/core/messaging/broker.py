"""Dramatiq broker configuration with Redis."""

import os

import dramatiq
import structlog
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AgeLimit, CurrentMessage, Retries, TimeLimit
from dramatiq.results import Results
from dramatiq.results.backends import RedisBackend

from stt.core.config.settings import get_settings
from stt.core.exceptions import NON_RETRYABLE_EXCEPTIONS
from stt.core.messaging.worker_init_middleware import WorkerInitMiddleware

logger = structlog.get_logger(__name__)
settings = get_settings()

# Global broker instance
_broker: RedisBroker | None = None


def should_retry(retries_so_far: int, exception: BaseException) -> bool:
    """Determine if a job should be retried based on exception type."""
    # Never retry non-retryable exceptions
    if isinstance(exception, NON_RETRYABLE_EXCEPTIONS):
        logger.warning(
            "Non-retryable exception, will not retry",
            exception_type=type(exception).__name__,
            error_code=getattr(exception, "error_code", "UNKNOWN"),
        )
        return False

    # Retry up to max_retries for other exceptions
    should = retries_so_far < settings.worker_max_retries
    logger.info(
        "Retry decision",
        retries_so_far=retries_so_far,
        max_retries=settings.worker_max_retries,
        will_retry=should,
        exception_type=type(exception).__name__,
    )
    return should


def _add_prometheus_middleware(broker: RedisBroker) -> None:
    """Expose Dramatiq worker metrics for Prometheus.

    The batch worker is a SEPARATE process from the FastAPI app, so ``/metrics``
    on :8861 says nothing about it — job throughput, duration, retries and
    failures were entirely unmeasurable.

    Dramatiq's own middleware is used rather than a hand-rolled exporter
    because the worker FORKS (``--processes N``): a naive ``start_http_server``
    in each fork collides on the port, and plain ``prometheus_client`` counters
    would be per-fork and silently wrong. This middleware sets
    ``PROMETHEUS_MULTIPROC_DIR``, aggregates across forks, and binds once.

    Two ordering constraints, both easy to get wrong:

    1. ``dramatiq.middleware.prometheus`` reads ``dramatiq_prom_host`` /
       ``dramatiq_prom_port`` into MODULE-LEVEL constants at import time, so
       they must be set *before* the first import — hence the local import.
    2. The bind host defaults to **loopback**, not dramatiq's ``0.0.0.0``. This
       is a PHI-processing service; it must not become LAN-reachable by
       accident. ``scripts/dev-service.sh`` takes the same posture for the HTTP
       ports. Containers override via ``dramatiq_prom_host=0.0.0.0``.

    Gated on ``metrics_enabled`` — the invariant is that every
    exporter sits behind a switch and no backend is ever required to start.
    """
    if not settings.metrics_enabled:
        logger.info("dramatiq.prometheus_disabled", reason="metrics_enabled=false")
        return

    os.environ.setdefault("dramatiq_prom_host", "127.0.0.1")
    os.environ.setdefault("dramatiq_prom_port", "9191")

    try:
        from dramatiq.middleware.prometheus import Prometheus

        broker.add_middleware(Prometheus())
        logger.info(
            "dramatiq.prometheus_enabled",
            host=os.environ["dramatiq_prom_host"],
            port=os.environ["dramatiq_prom_port"],
        )
    except Exception as exc:  # pragma: no cover - defensive
        # Never let telemetry stop the worker from consuming jobs.
        logger.warning("dramatiq.prometheus_setup_failed", error=str(exc))

    _wire_queue_depth_gauge(broker)


def _wire_queue_depth_gauge(broker: RedisBroker) -> None:
    """Expose the ``stt_batch`` pending-message count as a Gauge.

    Registered on the SAME default ``prometheus_client`` registry
    ``prometheus_fastapi_instrumentator`` scrapes at :8861/metrics in the
    FastAPI app process — this function runs there too, since
    ``configure_broker()`` (which calls ``_add_prometheus_middleware``) is
    called from both ``main.py``'s lifespan AND the worker process.

    Uses ``Gauge.set_function`` so the value is computed lazily at scrape
    time via the broker's own ``do_qsize`` (Dramatiq's pending-message
    primitive, also used by ``broker.join()``) — no periodic poller, no
    extra background task. A Redis hiccup at scrape time reports 0.0 rather
    than failing the whole /metrics response.
    """
    from stt.core.metrics import WORKER_QUEUE_DEPTH

    def _depth() -> float:
        try:
            return float(broker.do_qsize("stt_batch"))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("stt_batch.queue_depth_read_failed", error=str(exc))
            return 0.0

    WORKER_QUEUE_DEPTH.labels(queue="stt_batch").set_function(_depth)


def configure_broker(redis_url: str) -> RedisBroker:
    """Configure and return the Dramatiq broker."""
    global _broker

    if _broker is not None:
        return _broker

    logger.info("Configuring Dramatiq broker", redis_url=redis_url[:30] + "...")

    # Create broker with custom middleware configuration
    # RedisBroker adds default middleware (AgeLimit, TimeLimit, Retries, etc.)
    # We configure it with middleware=[] to start fresh, then add our own
    _broker = RedisBroker(url=redis_url, middleware=[])

    # Create Redis result backend for storing actor return values
    result_backend = RedisBackend(url=redis_url)

    # Add middleware with custom configuration
    _broker.add_middleware(AgeLimit(max_age=86400000))  # 24 hours max job age
    _broker.add_middleware(TimeLimit(time_limit=settings.transcription_timeout_seconds * 1000))
    _broker.add_middleware(
        Retries(
            max_retries=settings.worker_max_retries,
            min_backoff=60000,  # 1 minute
            max_backoff=900000,  # 15 minutes
            retry_when=should_retry,
        )
    )
    _broker.add_middleware(CurrentMessage())
    # Results middleware to store return values from actors (needed for streaming)
    _broker.add_middleware(Results(backend=result_backend))

    _broker.add_middleware(WorkerInitMiddleware())

    _add_prometheus_middleware(_broker)

    # Set as the global broker
    dramatiq.set_broker(_broker)

    logger.info("Dramatiq broker configured successfully")
    return _broker


def get_broker() -> RedisBroker:
    """Get the configured broker instance."""
    if _broker is None:
        raise RuntimeError("Broker not configured. Call configure_broker() first.")
    return _broker


async def initialize_redis() -> None:
    """Initialize Redis connection for the broker."""
    configure_broker(settings.redis_url)
    logger.info("Redis/Dramatiq initialized")


async def close_redis() -> None:
    """Close Redis connection."""
    global _broker
    if _broker is not None:
        _broker.close()
        _broker = None
        logger.info("Redis/Dramatiq connection closed")
