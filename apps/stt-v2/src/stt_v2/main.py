"""STT Service V2 - FastAPI Application Entry Point."""

import signal
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stt_v2.core.config.settings import get_settings
from stt_v2.core.database.connection import close_database, initialize_database
from stt_v2.core.logging import get_logger, setup_logging
from stt_v2.core.messaging.broker import close_redis, initialize_redis
from stt_v2.core.storage.minio_client import close_minio, initialize_minio
from stt_v2.embedding.api.routes import router as embedding_router
from stt_v2.health.api.routes import internal_router
from stt_v2.health.api.routes import router as health_router
from stt_v2.streaming._runtime import initialize_streaming, shutdown_streaming
from stt_v2.streaming.api.routes import router as streaming_router
from stt_v2.transcription.api.routes import router as transcription_router

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

    from stt_v2.pipeline.config_reader import get_pipeline_reader
    from stt_v2.transcription.batch_service import BatchTranscriptionService

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
    logger.info("Starting STT Service V2", version=settings.app_version)

    # Configure CPU threading BEFORE any model loading
    _configure_torch_threading()

    # Startup — infrastructure
    await initialize_database()
    await initialize_redis()
    await initialize_minio()
    await initialize_streaming()

    # Embedding model (required by /internal/embeddings/upsert)
    try:
        from stt_v2.diarization.embedding_service import get_embedding_service

        embedding_service = get_embedding_service()
        await embedding_service.initialize()
        logger.info("Pyannote embedding service initialized")
    except Exception as exc:
        logger.warning("Embedding service initialization failed (non-fatal)", error=str(exc))

    # Preload ML models (after DB is ready, since pipeline configs are in DB)
    await _preload_pipeline_models()

    # Punctuation model (Cadence)
    try:
        import asyncio as _aio

        from stt_v2.punctuation import service as punctuation_service

        await _aio.to_thread(punctuation_service.initialize)
        logger.info("Punctuation service initialized")
    except Exception as exc:
        logger.warning("Punctuation service initialization failed (non-fatal)", error=str(exc))

    logger.info("STT Service V2 started successfully")

    yield

    # Shutdown
    logger.info("Shutting down STT Service V2...")
    try:
        from stt_v2.punctuation import service as punctuation_service
        punctuation_service.shutdown()
    except Exception:
        pass
    try:
        from stt_v2.diarization.embedding_service import get_embedding_service

        await get_embedding_service().shutdown()
    except Exception:
        pass
    await shutdown_streaming()
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

    logger.info("STT Service V2 shutdown complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="STT Service V2",
        description="High-availability Speech-to-Text service with multi-model support",
        version=settings.app_version,
        docs_url="/api/v1/docs" if settings.debug else None,
        redoc_url="/api/v1/redoc" if settings.debug else None,
        lifespan=lifespan,
    )

    # Middleware (LIFO order: last-added runs first)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from stt_v2.core.middleware.logging import RequestLoggingMiddleware

    app.add_middleware(RequestLoggingMiddleware)

    from stt_v2.core.middleware.request_id import RequestIDMiddleware

    app.add_middleware(RequestIDMiddleware)

    # Register routers
    app.include_router(health_router, prefix="/api/v1", tags=["Health"])
    app.include_router(internal_router, tags=["Internal"])
    app.include_router(transcription_router, tags=["Transcription"])
    app.include_router(streaming_router, tags=["Streaming"])
    app.include_router(embedding_router, tags=["Embedding"])

    # OpenTelemetry (must be after routers for FastAPIInstrumentor)
    if settings.otel_enabled:
        from stt_v2.core.telemetry import setup_telemetry

        _telemetry_result = setup_telemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
        )
        app.state.telemetry = _telemetry_result

    # Prometheus metrics
    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


# Create application instance
app = create_app()


def handle_sigterm(signum: int, frame: object) -> None:
    """Handle SIGTERM for graceful shutdown."""
    logger.info("Received SIGTERM, initiating graceful shutdown...")
    raise SystemExit(0)


signal.signal(signal.SIGTERM, handle_sigterm)


def main() -> None:
    """Entry point for the application."""
    import uvicorn

    uvicorn.run(
        "stt_v2.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        log_config=None,
    )


if __name__ == "__main__":
    main()
