import uvicorn

from nlp.core.bounds import InferenceBounds
from nlp.core.config import settings
from nlp.core.logging import get_logger, setup_logging

setup_logging()

logger = get_logger(__name__)

logger.info("Starting NLP Service...")


def uvicorn_max_requests(workers: int, after_requests: int) -> int | None:
    """uvicorn's own request-count restart, only where a sibling worker keeps serving.

    With a single process uvicorn has no supervisor: hitting the limit stops the server.
    """
    if workers > 1 and after_requests > 0:
        return after_requests
    return None


def main() -> None:
    """Entrypoint of the application."""
    uvicorn.run(
        "nlp.app:get_app",
        host=settings.service.host,
        port=settings.service.port,
        workers=settings.service.workers,
        log_level=settings.service.log_level,
        factory=True,
        lifespan="on",
        # Belt-and-braces recycle at the FC-8 default when several workers run; the
        # in-process RecycleMiddleware honours the control-plane value (and the RSS limit).
        limit_max_requests=uvicorn_max_requests(
            settings.service.workers, InferenceBounds().recycle_after_requests
        ),
    )


if __name__ == "__main__":
    main()
