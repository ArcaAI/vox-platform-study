import uvicorn

from nlp.core.bounds import InferenceBounds
from nlp.core.config import settings
from nlp.core.logging import get_logger, setup_logging

setup_logging()

logger = get_logger(__name__)

logger.info("Starting NLP Service...")


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
        # TASK-1047 FC-8: belt-and-braces recycle at the FC-8 default; the in-process
        # RecycleMiddleware honours the control-plane value (and the RSS limit).
        limit_max_requests=InferenceBounds().recycle_after_requests,
    )


if __name__ == "__main__":
    main()
