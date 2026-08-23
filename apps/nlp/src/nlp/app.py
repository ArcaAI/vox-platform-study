from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from nlp.api import api_router
from nlp.core.config import settings
from nlp.core.logging import get_logger
from nlp.core.observability import setup_prometheus
from nlp.lifespan import lifespan
from nlp.utils import is_production

logger = get_logger(__name__)


def get_app() -> FastAPI:
    logger.info("Initializing FastAPI application...")

    app = FastAPI(
        title="Medical Entity Recognition & NLP Service",
        description="AI-powered medical entity extraction service for AgenticSDK",
        version="1.0.0",
        docs_url="/docs" if not is_production() else None,
        redoc_url="/redoc" if not is_production() else None,
        lifespan=lifespan,
    )

    @app.get("/", include_in_schema=False)
    async def root() -> JSONResponse:
        return JSONResponse({"service": "Medical Entity Recognition & NLP", "version": "1.0.0"})

    # Expose settings on app.state (parity with the other Python services) and
    # enforce inter-service auth. Added before CORS so CORS stays
    # outermost; an empty service_token is a dev / hermetic-CI bypass. The
    # middleware reads the token from the nlp.core.config singleton at dispatch.
    app.state.settings = settings

    from nlp.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.security.cors_origins,
        # The DECLARED knob, not a literal: `SecurityConfig` refuses the
        # wildcard-origins + credentials pairing at validation, so this can
        # never re-open it.
        allow_credentials=settings.security.cors_allow_credentials,
        allow_methods=settings.security.cors_methods,
        allow_headers=["*"],
    )

    setup_prometheus(app)

    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(Exception, general_exception_handler)

    app.include_router(api_router)

    return app


async def http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    if isinstance(exc, HTTPException):
        logger.error(f"HTTP {exc.status_code}: {exc.detail}")
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.detail, "status_code": exc.status_code},
            # Headers the raiser set are part of the contract, not decoration:
            # a shed 503 without its `Retry-After` tells the caller nothing
            # about whether to back off or give up (TASK-778).
            headers=exc.headers,
        )
    logger.error(f"Unexpected error: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500, content={"error": "Internal server error", "status_code": 500}
    )


async def general_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500, content={"error": "Internal server error", "status_code": 500}
    )
