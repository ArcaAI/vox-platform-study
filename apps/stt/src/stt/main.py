"""STT Service - FastAPI Application Entry Point."""

import asyncio
import contextlib
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration
from hope_obs import configure_logging, configure_observability, shutdown_observability

from stt.core.config.settings import Settings, get_settings
from stt.core.database.connection import close_database, initialize_database
from stt.core.logging import get_logger
from stt.core.messaging.broker import close_redis, initialize_redis
from stt.core.storage.minio_client import close_minio, initialize_minio
from stt.core.telemetry import build_observability_config
from stt.health.api.routes import internal_router
from stt.health.api.routes import router as health_router
from stt.models.resolvable_routes import router as model_resolvable_router
from stt.streaming._runtime import (
    get_redis_client as get_streaming_redis_client,
)
from stt.streaming._runtime import initialize_streaming, shutdown_streaming
from stt.streaming.api.routes import router as streaming_router
from stt.transcription.api.routes import router as transcription_router
from stt.voice_profile.api.routes import router as voice_profile_router

settings = get_settings()
configure_logging(build_observability_config(settings))
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
    # import time by the OpenMP runtime). If already set, don't
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


# `_preload_pipeline_models` is REMOVED. It existed only to
# read `PRELOAD_PIPELINES`, a knob whose own description said it was deprecated
# and not used for selection; with the setting gone the function had no input
# and no caller-visible effect. Models load lazily on first use.


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

    # Pull the ~70 control-plane-owned settings ONCE at boot, so the values in
    # force are the platform's rather than this process's bootstrap defaults
    # from the first request onward. Deliberately AFTER the infrastructure block
    # and deliberately non-fatal: an unreachable gateway leaves every field on
    # its bootstrap value (the earlier behaviour), and boot must never
    # depend on the config plane being up.
    from stt.core.runtime_limits import refresh_settings_from_control_plane

    applied = await refresh_settings_from_control_plane()
    if applied:
        logger.info("STT control-plane settings applied", fields=len(applied))

    # Push invalidation for the control-plane pull client. Rule 09
    # invalidation is the propagation path, the TTL is only a
    # bounded-staleness backstop — before this a control-plane write took up to
    # 60s to be seen here. Reuses the streaming module's `redis.asyncio` client
    # (the Dramatiq broker's is SYNC and cannot serve an async pubsub loop)
    # rather than opening a second connection; if streaming is unavailable the
    # TTL simply remains the only path, which is the pre-existing behaviour.
    app.state.config_invalidation_task = None
    _invalidation_redis = get_streaming_redis_client()
    if _invalidation_redis is not None:
        from stt.core.effective_config import get_effective_config_client

        app.state.config_invalidation_task = asyncio.create_task(
            get_effective_config_client().run_invalidation_listener(_invalidation_redis)
        )

    # Auxiliary ML models (Silero VAD, Pyannote embedding, Cadence
    # punctuation) are NOT loaded at boot. Each loads lazily on first use via
    # its own idempotent, concurrency-safe guard, so a freshly booted process
    # holds no ML weights until a request needs them.

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. `DEPLOYMENT_ENVIRONMENT` / `NODE_ENV` is the same
    # repo-wide convention `hope_obs.ObservabilityConfig.from_env` resolves
    # `deployment_environment` from — stt has no dedicated `environment`
    # settings field.
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

    # Warm the model-cache roots ONCE, off every request path (TASK-890 F6).
    #
    # `HF_HOME` here is an external volume, and its FIRST access from a given
    # process can stay inside the kernel for minutes while a shell `ls` answers
    # instantly. Paying that cost in a detached boot task means the first
    # readiness sweep meets a volume that is already awake; when even a 60 s
    # budget gets no answer, the resolvable endpoints report `warm: false`
    # instead of the sweep discovering it one abandoned probe thread at a time.
    # Detached and never awaited: warming can make the first probe faster, never
    # slower, and it must not delay or fail boot.
    from hope_runtime_models import warm_cache_roots

    _cache_dir = getattr(app.state, "settings", settings).huggingface_cache_dir
    app.state.model_cache_warmup_task = asyncio.create_task(
        warm_cache_roots(hf_cache_dir=_cache_dir, s3_cache_dir=_cache_dir, service="stt")
    )

    logger.info("STT Service started successfully")

    yield

    # Shutdown
    logger.info("Shutting down STT Service...")
    warmup_task = getattr(app.state, "model_cache_warmup_task", None)
    if warmup_task is not None and not warmup_task.done():
        warmup_task.cancel()
    invalidation_task = getattr(app.state, "config_invalidation_task", None)
    if invalidation_task is not None:
        invalidation_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await invalidation_task
    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()
    await shutdown_streaming()
    try:
        from stt.punctuation import service as punctuation_service

        punctuation_service.shutdown()
    except Exception:
        pass
    # TASK-887 — nothing to shut down here any more. The embedding model is declared per
    # ASR agent, so the only embedding services that exist belong to a SessionManager's
    # per-model cache and die with it.
    await close_minio()
    await close_redis()
    await close_database()

    shutdown_observability(app)

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

    # `configure_observability` installs `AccessLogMiddleware` then
    # `RequestContextMiddleware` (context outermost) — replacing the deleted
    # `RequestLoggingMiddleware` / `RequestIDMiddleware` pair (F-08: both were
    # `BaseHTTPMiddleware`, on the most latency-sensitive service in the
    # fleet). Called here, between auth and CORS, so the execution order
    # (outer -> inner) stays CORS -> RequestContext -> AccessLog -> auth ->
    # routes, exactly as before. It also builds the OTLP tracer when
    # `obs_config.tracing_enabled`; `FastAPIInstrumentor` wraps the app's
    # `build_middleware_stack` lazily, so routers may be registered before or
    # after this call.
    obs_config = build_observability_config(app_settings)
    configure_observability(app, obs_config)

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
    # TASK-890 J1 MAJOR-A — the runtime resolvability probe the gateway readiness
    # sweep asks. Its own `/api/v1/internal/models` prefix; service-token gated
    # like every non-exempt route.
    app.include_router(model_resolvable_router)
    app.include_router(transcription_router, tags=["Transcription"])
    app.include_router(streaming_router, tags=["Streaming"])
    app.include_router(voice_profile_router, tags=["Voice Profile"])

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
