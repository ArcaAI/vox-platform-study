"""Dramatiq broker configuration with Redis."""

import dramatiq
import structlog
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AgeLimit, CurrentMessage, Retries, TimeLimit
from dramatiq.results import Results
from dramatiq.results.backends import RedisBackend

from stt_v2.core.config.settings import get_settings
from stt_v2.core.exceptions import NON_RETRYABLE_EXCEPTIONS
from stt_v2.core.messaging.worker_init_middleware import WorkerInitMiddleware

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
