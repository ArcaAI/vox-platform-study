import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI

from nlp.core.logging import get_logger
from nlp.core.observability import setup_opentelemetry, setup_prometheus, shutdown_opentelemetry
from nlp.dependencies import (
    get_text_classifier,
    get_token_classifier,
    get_text_corrector,
    get_medical_suggester,
    get_websocket_manager,
)

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Medical NLP Service...")

    text_classifier_service = get_text_classifier()
    token_classifier_service = get_token_classifier()
    spelling_corrector_service = get_text_corrector()
    medical_suggester_service = get_medical_suggester()
    websocket_service = get_websocket_manager()

    setup_opentelemetry(app)
    setup_prometheus(app)
    
    await asyncio.gather(
        text_classifier_service.initialize(),
        token_classifier_service.initialize(),
        spelling_corrector_service.initialize(),
        medical_suggester_service.initialize(),
        websocket_service.initialize(),
    )

    logger.info("Medical NLP Service started successfully")

    yield

    await asyncio.gather(
        text_classifier_service.shutdown(),
        token_classifier_service.shutdown(),
        spelling_corrector_service.shutdown(),
        medical_suggester_service.shutdown(),
        websocket_service.shutdown(),
    )
    
    shutdown_opentelemetry(app)

    logger.info("Medical NLP Service shutdown complete")
