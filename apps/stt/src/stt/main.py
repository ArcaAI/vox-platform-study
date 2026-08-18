"""STT Service - FastAPI Application Entry Point."""

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from stt.core.config.settings import Settings, get_settings
from stt.core.database.connection import close_database, initialize_database
from stt.core.logging import get_logger, setup_logging
from stt.core.messaging.broker import close_redis, initialize_redis
from stt.core.storage.minio_client import close_minio, initialize_minio
from stt.health.api.routes import internal_router
from stt.health.api.routes import router as health_router
from stt.streaming._runtime import initialize_streaming, shutdown_streaming
from stt.streaming.api.routes import router as streaming_router
from stt.transcription.api.routes import router as transcription_router
from stt.voice_profile.api.routes import router as voice_profile_router

settings = get_settings()
setup_logging(settings.log_level)
logger = get_logger(__name__)


def _configure_torch_threading() -> None:
    """Configure PyTorch and OpenMP CPU threading for optimal inference.

    In containerised environments (K8s, Docker) PyTorch may default to 1
    thread or over-subscribe.  This sets ``torch.set_num_threads``,
    ``torch.set_num_interop_threads``, and the ``OMP_NUM_THREADS`` /
    ``MKL_NUM_THREADS`` environment variables so that CPU inference
    fully utilises the allocated cores.

    Priority: env var ``OMP_NUM_THREADS`` > setting ``TORCH_NUM_THREADS``
    > auto-detect from ``os.cpu_count()``.
    """
    import os

    num_threads = settings.torch_num_threads
    if num_threads <= 0:
        # Check if OMP_NUM_THREADS is already set (e.g. by K8s env)
        env_omp = os.environ.get("OMP_NUM_THREADS", "").strip()
        if env_omp and env_omp.isdigit() and int(env_omp) > 0:
            num_threads = int(env_omp)
        else:
            num_threads = os.cpu_count() or 4

    # Set OMP/MKL env vars BEFORE importing torch (they are read at
    # import time by the OpenMP runtime).  If already set, don't
    # override — the operator may have tuned them.
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        if not os.environ.get(var):
            os.environ[var] = str(num_threads)

    try:
        import torch

        torch.set_num_threads(num_threads)

        interop = settings.torch_num_interop_threads
        if interop > 0:
            torch.set_num_interop_threads(interop)

        logger.info(
            "PyTorch threading configured",
            intra_op_threads=torch.get_num_threads(),
            inter_op_threads=torch.get_num_interop_threads(),
            omp_num_threads=os.environ.get("OMP_NUM_THREADS"),
        )
    except ImportError:
        logger.info(
            "torch not installed — OMP/MKL env vars set",
            omp_num_threads=os.environ.get("OMP_NUM_THREADS"),
        )
    except Exception as exc:
        logger.warning("Failed to configure PyTorch threading", error=str(exc))


async def _preload_pipeline_models() -> None:
    """Preload models for configured pipelines at startup.

    Reads ``PRELOAD_PIPELINES`` from settings (comma-separated slugs),
    resolves each pipeline from the database, and loads all its models
    into the in-memory cache.  This eliminates cold-start latency on
    the first transcription request.
    """
    raw = settings.preload_pipelines
    if not raw or not raw.strip():
        return

    slugs = [s.strip() for s in raw.split(",") if s.strip()]
    if not slugs:
        return

    import time

    from stt.pipeline.config_reader import get_pipeline_reader
    from stt.transcription.batch_service import BatchTranscriptionService

    pipeline_reader = get_pipeline_reader()
    batch_service = BatchTranscriptionService()

    logger.info("Preloading models for pipelines", pipelines=slugs)
    overall_start = time.time()

    for slug in slugs:
        t0 = time.time()
        try:
            pipeline_config = await pipeline_reader.get_pipeline(slug)
            if pipeline_config is None:
                logger.warning("Pipeline not found for preload", slug=slug)
                continue

            models = await batch_service._load_models(pipeline_config)
            loaded = [k for k, v in models.items() if v is not None]
            elapsed = time.time() - t0
            logger.info(
                "Pipeline models preloaded",
                slug=slug,
                models=loaded,
                elapsed_seconds=round(elapsed, 2),
            )
        except Exception as exc:
            elapsed = time.time() - t0
            logger.warning(
                "Failed to preload pipeline models (non-fatal)",
                slug=slug,
                error=str(exc),
                elapsed_seconds=round(elapsed, 2),
            )

    total = time.time() - overall_start
    logger.info(
        "Model preloading complete",
        total_seconds=round(total, 2),
        pipelines_requested=len(slugs),
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifecycle management."""
    logger.info("Starting STT Service", version=settings.app_version)

    # Configure CPU threading BEFORE any model loading
    _configure_torch_threading()

    # Install the control-plane retention refresher. The ModelCache keeps NO hard
    # dependency on HTTP; this is what opts a running app into the pull, so unit
    # tests and non-served contexts stay network-free. Performs no I/O here: the
    # first model load triggers the first (TTL-cached, fail-safe) fetch, and an
    # unreachable gateway simply leaves env values in force.
    from stt.core.runtime_limits import refresh_model_cache_retention
    from stt.models.cache import set_retention_refresher

    set_retention_refresher(refresh_model_cache_retention)

    # Startup — infrastructure
    await initialize_database()
    await initialize_redis()
    await initialize_minio()
    await initialize_streaming()

    # Auxiliary ML models (Silero VAD, Pyannote embedding, Cadence
    # punctuation) are NOT loaded at boot. Each loads lazily on first use via
    # its own idempotent, concurrency-safe guard, so a freshly booted process
    # holds no ML weights until a request needs them. Optional pipeline warm-up
    # (PRELOAD_PIPELINES, empty by default) remains available below.
    await _preload_pipeline_models()

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. `DEPLOYMENT_ENVIRONMENT` / `NODE_ENV` is the same
    # repo-wide convention `stt.core.telemetry._deployment_environment` uses
    # stt has no dedicated `environment` settings field.
    app.state.service_release_task = None
    app.state.service_release_http_client = None
    try:
        registration_client = httpx.AsyncClient()
        app.state.service_release_http_client = registration_client
        app.state.service_release_task = start_registration(
            http_client=registration_client,
            gateway_url=settings.api_gateway_url,
            service_token=settings.api_gateway_key.get_secret_value(),
            build_info=BuildInfoReader().get_build_info(),
            environment=os.getenv("DEPLOYMENT_ENVIRONMENT")
            or os.getenv("NODE_ENV")
            or "development",
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("stt.service_release_registration_failed", error=str(exc))

    logger.info("STT Service started successfully")

    yield

    # Shutdown
    logger.info("Shutting down STT Service...")
    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()
    await shutdown_streaming()
    try:
        from stt.punctuation import service as punctuation_service

        punctuation_service.shutdown()
    except Exception:
        pass
    try:
        from stt.diarization.embedding_service import get_embedding_service

        await get_embedding_service().shutdown()
    except Exception:
        pass
    await close_minio()
    await close_redis()
    await close_database()

    telemetry = getattr(app.state, "telemetry", None)
    if telemetry is not None:
        if telemetry.logger_provider:
            telemetry.logger_provider.force_flush()
            telemetry.logger_provider.shutdown()
        if telemetry.tracer_provider:
            telemetry.tracer_provider.force_flush()
            telemetry.tracer_provider.shutdown()

    logger.info("STT Service shutdown complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    # `settings_override` mirrors text/tts/guardrail's factory so a test can
    # build an app around a specific configuration; production still uses the
    # module-level singleton.
    app_settings = settings_override if settings_override is not None else settings

    app = FastAPI(
        title="STT Service",
        description="High-availability Speech-to-Text service with multi-model support",
        version=app_settings.app_version,
        docs_url="/api/v1/docs" if app_settings.debug else None,
        redoc_url="/api/v1/redoc" if app_settings.debug else None,
        lifespan=lifespan,
    )

    # The auth middleware reads its accepted tokens from here, so the app object
    # — not an import-time global — decides who gets in.
    app.state.settings = app_settings

    # Middleware (LIFO order: last-added runs first)
    #
    # Inbound service auth is added FIRST so it runs LAST of the three below —
    # i.e. INSIDE CORS, matching apps/tts. A browser preflight carries no
    # `X-Service-Token` (custom headers are never sent on OPTIONS), so an
    # outermost CORSMiddleware is what keeps a configured CORS origin working
    # at all; auth still gates every real request.
    from stt.core.middleware.auth import ServiceAuthMiddleware
    from stt.core.service_auth import is_local_environment

    # A deployed process with no internal credential serves NOTHING but its
    # probes. Say so loudly at boot: the operator's symptom is otherwise a
    # uniformly 401-ing service with no explanation.
    if not app_settings.accepted_service_tokens and not is_local_environment():
        logger.error(
            "stt.auth.no_internal_token_configured",
            detail=(
                "INTERNAL_ACCESS_TOKEN is unset in a deployed environment; "
                "all non-exempt routes will be rejected"
            ),
        )

    app.add_middleware(ServiceAuthMiddleware)

    from stt.core.middleware.logging import RequestLoggingMiddleware

    app.add_middleware(RequestLoggingMiddleware)

    from stt.core.middleware.request_id import RequestIDMiddleware

    app.add_middleware(RequestIDMiddleware)

    if app_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=app_settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Register routers
    app.include_router(health_router, prefix="/api/v1", tags=["Health"])
    app.include_router(internal_router, tags=["Internal"])
    app.include_router(transcription_router, tags=["Transcription"])
    app.include_router(streaming_router, tags=["Streaming"])
    app.include_router(voice_profile_router, tags=["Voice Profile"])

    # OpenTelemetry (must be after routers for FastAPIInstrumentor)
    if app_settings.otel_enabled:
        from stt.core.telemetry import setup_telemetry

        _telemetry_result = setup_telemetry(
            app,
            endpoint=app_settings.otel_exporter_endpoint,
            service_name=app_settings.otel_service_name,
        )
        app.state.telemetry = _telemetry_result

    # Prometheus metrics
    if app_settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


# Create application instance
app = create_app()

# NOTE: this module must NOT install its own SIGTERM
# handler. `stt.main:app` is always passed to uvicorn as a STRING target
# (`uvicorn stt.main:app`, `python -m uvicorn stt.main:app`, and the
# `stt = "stt.main:main"` console script all do this), so `Config.load()`
# imports this module *after* `Server.serve()` has already called
# `signal.signal(SIGTERM, self.handle_exit)` inside `capture_signals()`. A
# module-level `signal.signal(signal.SIGTERM, ...)` here would therefore
# always run SECOND and silently overwrite uvicorn's handler. The previous
# handler did `raise SystemExit(0)`, which unwinds straight out of
# `asyncio.run()` without ever setting `Server.should_exit` — skipping
# uvicorn's own graceful path and, with it, the ASGI `lifespan` shutdown
# event that drives `shutdown_streaming()` below. Let uvicorn own SIGTERM
# exclusively; its normal `should_exit -> main_loop() -> Server.shutdown()`
# path is what reaches the `lifespan()` post-`yield` cleanup.


def main() -> None:
    """Entry point for the application."""
    import uvicorn

    uvicorn.run(
        "stt.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        log_config=None,
    )


if __name__ == "__main__":
    main()
