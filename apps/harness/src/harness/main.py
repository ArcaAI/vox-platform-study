"""Harness — Clinical Documentation Harness orchestrator (TASK-330).

FastAPI application. The bounded ``guides → generate → sensors → gate`` loop runs
as a Temporal durable workflow (see ``harness.temporal``); ``apps/api`` remains
the gateway / system-of-record. This module wires the HTTP surface and a
lifespan that best-effort connects to the Temporal frontend.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from harness.core.config import Settings, get_settings
from harness.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage shared resources: logging + a best-effort Temporal client."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)
    logger.info(
        "harness.starting",
        host=settings.host,
        port=settings.port,
        debug=settings.debug,
        temporal_address=settings.temporal.address,
    )

    # Best-effort connect: the service must come up even when Temporal is down
    # (fail-safe — degrade toward "not ready", never crash the gateway). The
    # worker (harness.temporal.worker) is what actually requires Temporal.
    app.state.temporal_client = None
    try:
        from harness.temporal.client import get_temporal_client

        app.state.temporal_client = await asyncio.wait_for(
            get_temporal_client(settings),
            timeout=settings.temporal.connect_timeout_s,
        )
        logger.info("harness.temporal_connected", address=settings.temporal.address)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully on any failure
        logger.warning(
            "harness.temporal_unavailable",
            address=settings.temporal.address,
            error=str(exc),
        )

    logger.info("harness.started")
    yield

    logger.info("harness.shutting_down")
    app.state.temporal_client = None
    logger.info("harness.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="Harness — Clinical Documentation Harness",
        description=(
            "Bounded guides→generate→sensors→gate clinical-documentation loop "
            "orchestrated as a Temporal durable workflow (TASK-330)."
        ),
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url="/api/v1/redoc",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.temporal_client = None

    if settings.cors_enabled and settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    from harness.api.endpoints.admin import router as admin_router
    from harness.api.endpoints.health import router as health_router
    from harness.api.endpoints.internal import router as internal_router
    from harness.api.endpoints.knowledge import router as knowledge_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(internal_router, prefix="/api/v1/internal")
    app.include_router(knowledge_router, prefix="/api/v1/internal")
    app.include_router(admin_router, prefix="/api/v1/internal/harness")

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
