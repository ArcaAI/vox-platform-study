"""STT Service - FastAPI Application Entry Point."""

import asyncio
import contextlib
import os
import time
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
#
# TASK-985 QW-4 / OD-F brings a warm start BACK, and the removed knob's own
# epitaph said where it belongs: "a warm-start knob, if one is ever wanted
# again, belongs in the control plane like every other"
# (`core/config/settings.py`). Hence `stt.warmDefaultAsrOnBoot` below rather
# than an env var.

#: The control-plane key that opts a pod into warming its ASR model at boot.
#: SYSTEM-tier, boolean, DEFAULT OFF — absent, null or non-boolean all leave
#: today's lazy-load behaviour in force, which is the `open-to-default` posture
#: this class of tuning knob takes (it is availability, not selection).
WARM_DEFAULT_ASR_ON_BOOT_KEY = "stt.warmDefaultAsrOnBoot"

#: Where the gateway answers "which ASR spec would a tenant with no opinion
#: get?". STT resolves NOTHING itself here: since TASK-861 the agent path reads
#: no selection from Postgres, and its `database_enabled` is off by default, so
#: the alternative would be re-opening the DB read that ticket deliberately
#: closed. Absent route ⇒ one WARN and no warm (the key is default-OFF anyway).
DEFAULT_ASR_SPEC_PATH = "/internal/stt/default-asr-spec"


async def _warm_default_asr_model() -> None:
    """Load the platform's default ASR model once, off every request path.

    TASK-985 QW-4. Idle TTL evicts the served model between consultations —
    measured at a 4.6 s cold reload inside a 5807 ms session-create against
    118/224 ms warm — and the cluster's own runbook documents the resulting 503
    on the first session after a GPU pod rolls.

    THREE PROPERTIES THIS FUNCTION MUST KEEP, and they are the whole design:

    1. **It never gates startup.** Fired detached, never awaited by `lifespan`.
       A slow load (a network-backed cache read) or a broken one (bad digest,
       corrupt GGUF) would otherwise turn a routine model swap into a
       `CrashLoopBackOff` that kills ALL serving capacity — strictly worse than
       today's per-session cold penalty. This inherits the contract the
       cache-root warm task already documents: "warming can make the first probe
       faster, never slower, and it must not delay or fail boot."
    2. **It never gates readiness.** `/health/ready` checks that the process's
       hard infra dependencies are reachable; model residency is not one of
       them, because a pod that has not warmed is still fully capable of
       lazy-loading on first request. Gating readiness on residency is a
       separate, LATER change with a mandatory timeout, and it belongs to
       whoever owns `/health/ready`.
    3. **It warms the ASR model and nothing else.** Silero VAD, the Pyannote
       embedding and Cadence punctuation stay lazy behind their own idempotent
       per-use guards: most sessions never touch diarization or embedding, and
       generalising this to "everything the SYSTEM agent might reference" would
       reintroduce at boot the dead-import cost that was moved to first use.

    Every failure path is a log line and a return. This function raises nothing.
    """
    from stt.core.effective_config import get_effective_config_client

    try:
        snapshot = await get_effective_config_client().get()
        entry = (snapshot.raw.get("settings") or {}).get(WARM_DEFAULT_ASR_ON_BOOT_KEY)
        enabled = entry.get("value") if isinstance(entry, dict) else None
    except Exception as exc:  # noqa: BLE001 — boot must not depend on the config plane
        logger.warning("stt.warm_default_asr.config_unavailable", error=str(exc))
        return

    # `is not True`, not falsy: a served string or number is a WRONG value, and a
    # wrong value must leave the bootstrap behaviour standing rather than be
    # coerced into an opinion.
    if enabled is not True:
        logger.debug("stt.warm_default_asr.disabled", served=enabled)
        return

    try:
        async with httpx.AsyncClient(
            base_url=settings.api_gateway_url,
            timeout=getattr(settings, "api_gateway_timeout", 30),
            headers={"X-Internal-Service-Key": settings.api_gateway_key.get_secret_value()},
        ) as client:
            response = await client.get(DEFAULT_ASR_SPEC_PATH)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:  # noqa: BLE001 — a warm is best-effort, always
        logger.warning(
            "stt.warm_default_asr.spec_unavailable",
            path=DEFAULT_ASR_SPEC_PATH,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return

    try:
        from stt.models import get_model_cache
        from stt.pipeline.spec import bundle_from_resolved

        # The SAME mapping a session create performs, so a warmed model is
        # keyed and budgeted exactly as the served one will be — warming under a
        # different key would warm nothing.
        bundle = bundle_from_resolved(payload)
        slug = bundle.spec.models.asr.slug
        model_config = bundle.model_configs.get(slug)
        if model_config is None:
            logger.warning("stt.warm_default_asr.model_config_missing", model_slug=slug)
            return
        started = time.monotonic()
        await get_model_cache().get_or_load(model_config)
        logger.info(
            "stt.warm_default_asr.loaded",
            model_slug=slug,
            elapsed_s=round(time.monotonic() - started, 3),
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — a failed warm is a slow first session
        logger.warning(
            "stt.warm_default_asr.load_failed",
            error=str(exc),
            error_type=type(exc).__name__,
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

    # TASK-985 QW-4 / OD-F — optionally warm the default ASR model, on exactly
    # the same terms as the cache-root warm above: detached, never awaited,
    # cancelled on shutdown, and governed by a SYSTEM-tier key that is DEFAULT
    # OFF. Deliberately fired AFTER `refresh_settings_from_control_plane()`
    # (which ran above), so the key's served value is already in hand.
    #
    # Landing this does NOT replace the `stt.modelCache.ttlSeconds` write: the
    # TTL is what removes the recurring MID-SHIFT cold start, and it is a
    # control-plane write, not code. This only removes the post-roll one.
    app.state.asr_warmup_task = asyncio.create_task(_warm_default_asr_model())

    logger.info("STT Service started successfully")

    yield

    # Shutdown
    logger.info("Shutting down STT Service...")
    warmup_task = getattr(app.state, "model_cache_warmup_task", None)
    if warmup_task is not None and not warmup_task.done():
        warmup_task.cancel()
    asr_warmup_task = getattr(app.state, "asr_warmup_task", None)
    if asr_warmup_task is not None and not asr_warmup_task.done():
        asr_warmup_task.cancel()
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
