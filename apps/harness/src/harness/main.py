"""Harness — Clinical Documentation Harness orchestrator.

FastAPI application. The bounded ``guides → generate → sensors → gate`` loop runs
as a Temporal durable workflow (see ``harness.temporal``); ``apps/api`` remains
the gateway / system-of-record. This module wires the HTTP surface and a
lifespan that best-effort connects to the Temporal frontend.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from harness.core.config import Settings, get_settings
from harness.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. A dedicated short-lived httpx client (kept out of
    # any request-serving pool) — closed on shutdown below.
    app.state.service_release_task = None
    app.state.service_release_http_client = None
    try:
        registration_client = httpx.AsyncClient()
        app.state.service_release_http_client = registration_client
        app.state.service_release_task = start_registration(
            http_client=registration_client,
            gateway_url=f"{settings.api_base_url.rstrip('/')}/api/v1",
            service_token=settings.peer_service_token(settings.service_token),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.environment,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("harness.service_release_registration_failed", error=str(exc))

    logger.info("harness.started")
    yield

    logger.info("harness.shutting_down")
    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()
    app.state.temporal_client = None

    from harness.core.observability import shutdown_opentelemetry

    shutdown_opentelemetry(app)

    logger.info("harness.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="Harness — Clinical Documentation Harness",
        description=(
            "Bounded guides→generate→sensors→gate clinical-documentation loop "
            "orchestrated as a Temporal durable workflow."
        ),
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url="/api/v1/redoc",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.temporal_client = None
    app.state.tracer_provider = None

    if settings.cors_enabled and settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    from harness.api.endpoints.admin import router as admin_router
    from harness.api.endpoints.eval import router as eval_router
    from harness.api.endpoints.health import router as health_router
    from harness.api.endpoints.internal import router as internal_router
    from harness.api.endpoints.interpreter import router as interpreter_router
    from harness.api.endpoints.knowledge import router as knowledge_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(internal_router, prefix="/api/v1/internal")
    app.include_router(interpreter_router, prefix="/api/v1/internal")
    app.include_router(knowledge_router, prefix="/api/v1/internal")
    app.include_router(eval_router, prefix="/api/v1/internal")
    app.include_router(admin_router, prefix="/api/v1/internal/harness")

    if settings.otel_tracing_enabled:
        from harness.core.observability import setup_opentelemetry

        setup_opentelemetry(app, settings)

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
