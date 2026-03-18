import uvicorn

from nlp.core.logging import get_logger, setup_logging
from nlp.core.config import settings


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
    )


if __name__ == "__main__":
    main()
