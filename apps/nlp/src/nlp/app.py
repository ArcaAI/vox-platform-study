from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from nlp.core.logging import get_logger
from nlp.core.config import settings
from nlp.utils import is_production
from nlp.lifespan import lifespan
from nlp.api import api_router

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
    async def root():
        return JSONResponse({"service": "Medical Entity Recognition & NLP", "version": "1.0.0"})

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.security.cors_origins,
        allow_credentials=True,
        allow_methods=settings.security.cors_methods,
        allow_headers=["*"],
    )

    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(Exception, general_exception_handler)

    app.include_router(api_router)

    return app


async def http_exception_handler(request: Request, exc: HTTPException):
    logger.error(f"HTTP {exc.status_code}: {exc.detail}")
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail, "status_code": exc.status_code})


async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(status_code=500, content={"error": "Internal server error", "status_code": 500})
