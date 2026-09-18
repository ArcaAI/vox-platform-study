"""Health check API routes.

The HOPE four-route health contract (TASK-990): ``/health`` is the detailed,
informational endpoint and is ALWAYS 200; ``/health/live``, ``/health/ready``
and ``/health/startup`` are the three probe routes, and are the only ones
allowed to refuse. ``/live`` and ``/ready`` are backward-compatible aliases.
"""

import time
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from functools import lru_cache
from typing import Any, cast

import structlog
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader
from sqlalchemy import text

from stt.core.config.settings import get_settings
from stt.core.database.connection import get_db_session
from stt.core.storage.minio_client import get_minio_client

logger = structlog.get_logger(__name__)
settings = get_settings()
router = APIRouter()
internal_router = APIRouter(prefix="/internal", tags=["internal"])

# Track startup time
_startup_time = datetime.utcnow()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. ``settings.app_version`` defaults to the literal ``"2.0.0"``
    and its own comment already says the authoritative version is the one in
    ``build-info.json`` — this route simply never consulted it, so during a
    rollout you could not tell which build replied. CI bakes the real identity
    into every image (``docs/operations/build-info.schema.json``) and the
    gateway already reports it this way
    (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm stt:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived from
    git, or to ``0.0.0-unknown.unknown`` outside a checkout. Version reporting
    must never become a new way for ``/health`` to fail.

    Cached for the process lifetime: build identity is immutable artifact data,
    not configuration — read once, never re-read per request.

    Only ``version`` is surfaced. This route is auth-exempt and public; branch,
    SHA and pipeline id are operator data that belong behind an admin-gated
    surface, not on a probe endpoint.
    """
    return BuildInfoReader().get_build_info().version


class HealthStatus(StrEnum):
    """Health status values."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass
class ComponentHealth:
    """Health status of a single component."""

    name: str
    status: HealthStatus
    latency_ms: float
    message: str | None = None


@router.get("/health")
async def health_check() -> dict[str, Any]:
    """Detailed health check with component status.

    INFORMATIONAL ONLY, and deliberately **always HTTP 200** — the verdict lives
    in the body's ``status``, never in the status line. TASK-990 F1 recorded a
    real defect here, but it was in the MANIFEST: readiness and liveness both
    pointed at this route, which cannot fail, so both degraded to "something is
    listening on 8861". The fix is repointing those probes at ``/health/ready``
    (deployment repo), not making this route refuse — a misconfigured pod has to
    stay able to REPORT that it is unwell, which is the same reason
    ``EXEMPT_PATHS`` keeps it reachable when the service is failing closed
    (``stt.core.middleware.auth``). The gateway answers the same way.

    Failure is expressed on the other three routes: ``/health/live`` (process),
    ``/health/ready`` (dependencies + the drain flag), ``/health/startup``
    (initialisation).
    """

    checks: dict[str, dict[str, Any]] = {}
    overall_status = HealthStatus.HEALTHY

    db_health = await _check_database()
    checks["database"] = _component_to_dict(db_health)
    if db_health.status == HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.UNHEALTHY
    elif db_health.status == HealthStatus.DEGRADED and overall_status != HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.DEGRADED

    minio_health = await _check_minio()
    checks["minio"] = _component_to_dict(minio_health)
    if minio_health.status == HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.UNHEALTHY
    elif minio_health.status == HealthStatus.DEGRADED and overall_status != HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.DEGRADED

    redis_health = await _check_redis()
    checks["redis"] = _component_to_dict(redis_health)
    if redis_health.status == HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.UNHEALTHY
    elif redis_health.status == HealthStatus.DEGRADED and overall_status != HealthStatus.UNHEALTHY:
        overall_status = HealthStatus.DEGRADED

    streaming_info = _check_streaming()
    checks["streaming"] = streaming_info

    checks["processors"] = _check_processors()

    uptime = (datetime.utcnow() - _startup_time).total_seconds()

    payload: dict[str, Any] = {
        "status": overall_status.value,
        "service": settings.app_name,
        "version": _service_version(),
        "uptime_seconds": round(uptime, 1),
        "timestamp": datetime.utcnow().isoformat(),
        "checks": checks,
    }

    # Which config lane is live, mirroring the binding-health
    # precedent above. Health is auth-exempt, so this carries SOURCE LABELS and
    # timestamps only, never resolved values. Deliberately does not affect
    # `overall_status`: a config-plane outage degrades to env values, which is a
    # healthy state.
    try:
        from stt.core.effective_config import get_effective_config_client

        payload["effective_config"] = get_effective_config_client().diagnostics()
    except Exception as exc:  # noqa: BLE001 — diagnostics must never break /health
        payload["effective_config"] = {"error": type(exc).__name__}

    return payload


@router.get("/health/live")
async def liveness_check() -> dict[str, str]:
    """Kubernetes liveness probe — always returns 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/startup", response_model=None)
async def startup_check(request: Request) -> dict[str, str] | JSONResponse:
    """Kubernetes startup probe — has application initialisation finished?

    TASK-990 F7: the fourth route of the gateway's health contract
    (``apps/api/src/modules/health/health.controller.ts``), which the six Python
    services were missing. It sits in a four-route contract where only THIS
    route, ``/health/live`` and ``/health/ready`` may fail: ``/health`` is the
    informational, ops-facing endpoint and is always 200.

    The marker is ``app.state.service_release_task``. Every one of the six
    services assigns it UNCONDITIONALLY inside its lifespan (it is ``None`` when
    gateway registration is disabled, so the value says nothing — only its
    PRESENCE does), and no ``create_app`` assigns it. So the attribute existing
    means "this app's lifespan startup body ran to the point of announcing the
    service", and its absence means the app was assembled without one. The same
    marker is used by all six on purpose: six bespoke markers is six things to
    get wrong, and ``tests/contracts/test_health_contract_parity.py`` pins this
    one by name so removing it is a reviewed change rather than a silent
    downgrade to an always-200 route.

    Honest limitation, stated rather than buried: over HTTP in a normally
    assembled app the 503 is not reachable, because Starlette does not route a
    request until the lifespan's startup phase has RETURNED. While the app is
    still starting the kubelet gets a connection that never answers and the
    probe fails on ``timeoutSeconds`` — a probe failure either way, just not a
    503 body. The branch earns its place on an app built WITHOUT its lifespan
    (``uvicorn --lifespan off``, or a router mounted on a bare ``FastAPI()`` —
    which is exactly how several of these services' own suites build test apps).

    Deliberately NOT gated on model residency or on any dependency. Those are
    ``/health/ready``'s job; re-checking them here would make a slow dependency
    or a lazy model load look like a failed START and restart a healthy pod.
    """
    if getattr(request.app.state, "service_release_task", _UNSET) is _UNSET:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "Service is still initializing"},
        )
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness_check() -> JSONResponse | dict[str, str]:
    """Kubernetes readiness probe — verifies critical dependencies are available.

    Also fails once this instance has been marked draining : this
    is the ACTUAL mechanism by which a draining pod stops receiving new
    streaming sessions — k8s removes it from the Service Endpoints on the
    next probe failure, no gateway-side routing change needed. See
    """
    for check_fn in [_check_database, _check_minio, _check_redis]:
        result = await check_fn()
        if result.status == HealthStatus.UNHEALTHY:
            return JSONResponse(
                status_code=503,
                content={"status": "unhealthy", "message": f"{result.name} is unhealthy"},
            )

    from stt.streaming._runtime import get_session_manager

    mgr = get_session_manager()
    if mgr is not None and mgr.is_draining:
        return JSONResponse(
            status_code=503,
            content={"status": "draining", "message": "Instance draining; not accepting new work"},
        )

    return {"status": "healthy"}


# Backward-compatible aliases for existing Kubernetes probe configs
@router.get("/ready")
async def readiness_check_legacy() -> dict[str, str]:
    """Legacy readiness path — redirects to /health/ready."""
    return cast(dict[str, str], await readiness_check())


@router.get("/live")
async def liveness_check_legacy() -> dict[str, str]:
    """Legacy liveness path — redirects to /health/live."""
    return await liveness_check()


def _component_to_dict(component: ComponentHealth) -> dict[str, Any]:
    """Convert ComponentHealth to dict for checks map."""
    result = {
        "status": component.status.value,
        "duration_ms": round(component.latency_ms, 2),
    }
    if component.message:
        result["message"] = component.message
    return result


async def _check_database() -> ComponentHealth:
    """Check database connectivity.

    TASK-861: the read-only Postgres connection is OFF by default and nothing on
    the agent path reads it (selection arrives as a gateway-resolved spec), so a
    ``DatabaseDisabledError`` is a DECLARED absence, not a fault. Reporting it as
    unhealthy makes ``/health/ready`` fail permanently, which keeps the pod out
    of the Service Endpoints and stops STT serving at all.
    """
    from stt.core.database.connection import DatabaseDisabledError

    start = time.monotonic()
    try:
        async with get_db_session() as session:
            await session.execute(text("SELECT 1"))
        latency = (time.monotonic() - start) * 1000
        return ComponentHealth(
            name="database",
            status=HealthStatus.HEALTHY,
            latency_ms=latency,
        )
    except DatabaseDisabledError:
        return ComponentHealth(
            name="database",
            status=HealthStatus.HEALTHY,
            latency_ms=(time.monotonic() - start) * 1000,
            message="disabled by configuration (STT_DATABASE_ENABLED=false); not on the agent path",
        )
    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("Database health check failed", error=str(e))
        return ComponentHealth(
            name="database",
            status=HealthStatus.UNHEALTHY,
            latency_ms=latency,
            message=str(e)[:200],
        )


async def _check_minio() -> ComponentHealth:
    """Check MinIO connectivity."""
    start = time.monotonic()
    try:
        client = get_minio_client()
        is_healthy = client.health_check()
        latency = (time.monotonic() - start) * 1000
        return ComponentHealth(
            name="minio",
            status=HealthStatus.HEALTHY if is_healthy else HealthStatus.UNHEALTHY,
            latency_ms=latency,
        )
    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("MinIO health check failed", error=str(e))
        return ComponentHealth(
            name="minio",
            status=HealthStatus.UNHEALTHY,
            latency_ms=latency,
            message=str(e)[:200],
        )


async def _check_redis() -> ComponentHealth:
    """Check Redis connectivity"""
    import redis.asyncio as aioredis

    from stt.streaming._runtime import get_redis_client

    start = time.monotonic()
    owned_client: aioredis.Redis | None = None
    try:
        client = get_redis_client()
        if client is None:
            owned_client = aioredis.from_url(
                settings.redis_url,
                socket_connect_timeout=2,
                socket_timeout=2,
            )
            client = owned_client

        await client.ping()
        latency = (time.monotonic() - start) * 1000
        return ComponentHealth(
            name="redis",
            status=HealthStatus.HEALTHY,
            latency_ms=latency,
        )
    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.warning("Redis health check failed", error=str(e))
        return ComponentHealth(
            name="redis",
            status=HealthStatus.UNHEALTHY,
            latency_ms=latency,
            message=str(e)[:200],
        )
    finally:
        if owned_client is not None:
            await owned_client.aclose()


def _check_streaming() -> dict[str, Any]:
    """Check streaming module status (informational, non-blocking).

    Returns a component dict with streaming session counts and capacity.
    This is intentionally synchronous and never raises — streaming being
    unavailable does not affect batch transcription readiness.
    """
    try:
        from stt.streaming._runtime import get_session_manager

        mgr = get_session_manager()
        if mgr is None:
            return {
                "status": "degraded",
                "duration_ms": 0,
                "message": "Streaming module not started (batch-only mode)",
            }

        return {
            "status": HealthStatus.HEALTHY.value,
            "duration_ms": 0,
        }
    except Exception as exc:
        logger.warning("Streaming health check failed", error=str(exc))
        return {
            "status": "degraded",
            "duration_ms": 0,
            "message": str(exc)[:200],
        }


def _check_processors() -> dict[str, Any]:
    """Registered ASR engines + their resolved (device, compute) bindings.

    Surfaces silent downgrades (e.g. faster-whisper MPS -> CPU).
    Purely informational: never raises and never affects overall status, but it
    still honours the ``checks`` component contract ({status, duration_ms} plus
    an optional ``message``) so consumers can iterate the map uniformly. The
    engine detail is nested under ``engines``.
    """
    start = time.monotonic()
    try:
        from stt.processors.binding import asr_processor_health

        engines = asr_processor_health()
        return {
            "status": HealthStatus.HEALTHY.value,
            "duration_ms": round((time.monotonic() - start) * 1000, 2),
            "engines": engines,
        }
    except Exception as exc:  # noqa: BLE001 — health must never crash on this
        logger.warning("ASR processor health check failed", error=str(exc))
        return {
            "status": HealthStatus.DEGRADED.value,
            "duration_ms": round((time.monotonic() - start) * 1000, 2),
            "message": str(exc)[:200],
        }


# =============================================================================
# Internal Endpoints (for admin/debugging)
# =============================================================================


@internal_router.get("/cache/stats")
async def get_cache_stats() -> dict[str, Any]:
    """
    Get model cache statistics.

    Returns current state of the model cache including:
    - Number of loaded models
    - Total memory usage
    - Cache hit/miss rates
    - List of cached models with metadata
    """
    try:
        from stt.models.cache import get_model_cache

        cache = get_model_cache()
        stats = cache.stats()

        return {
            "total_models": stats.total_models,
            "total_memory_mb": stats.total_memory_mb,
            "max_models": stats.max_models,
            "max_memory_mb": stats.max_memory_mb,
            "hits": stats.hits,
            "misses": stats.misses,
            "evictions": stats.evictions,
            "hit_rate": round(stats.hit_rate, 4),
            "models": stats.models,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to get cache stats", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.post("/cache/clear")
async def clear_cache() -> dict[str, Any]:
    """
    Clear the model cache.

    Unloads all cached models and frees memory.
    Use with caution in production.
    """
    try:
        from stt.models.cache import clear_model_cache

        count = await clear_model_cache()

        logger.info("Model cache cleared", models_cleared=count)

        return {
            "status": "ok",
            "models_cleared": count,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to clear cache", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.get("/cache/model/{slug}")
async def get_cached_model_info(slug: str) -> dict[str, Any]:
    """
    Get info about a specific cached model.

    Args:
        slug: Model slug to look up

    Returns:
        Model info if cached, 404 if not found
    """
    try:
        from stt.models.cache import get_model_cache

        cache = get_model_cache()
        model = await cache.get(slug)

        if model is None:
            raise HTTPException(status_code=404, detail=f"Model '{slug}' not in cache")

        return {
            "slug": model.model_slug,
            "id": model.model_id,
            "format": model.format.value,
            "device": model.device,
            "memory_mb": model.memory_mb,
            "loaded_at": model.loaded_at.isoformat(),
            "has_tokenizer": model.tokenizer is not None,
            "has_processor": model.processor is not None,
            "extra": model.extra,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get model info", slug=slug, error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.get("/pipelines/loaded")
async def get_loaded_pipelines() -> dict[str, Any]:
    """
    Get list of pipelines with loaded models.

    Returns pipelines where all required models are currently cached.
    """
    try:
        from stt.models.cache import get_model_cache
        from stt.pipeline.config_reader import get_pipeline_reader

        cache = get_model_cache()
        pipeline_reader = get_pipeline_reader()

        # Get cache stats for current model list
        stats = cache.stats()
        cached_slugs = {m["slug"] for m in stats.models}

        # Get enabled pipelines. TASK-861: the pipeline table is deprecated and
        # the DB is off by default — report an empty, explicitly-disabled list
        # rather than a 500 (this is a readiness aid, not selection).
        from stt.core.database.connection import DatabaseDisabledError

        try:
            pipelines = await pipeline_reader.get_enabled_pipelines()
        except DatabaseDisabledError:
            return {
                "total_pipelines": 0,
                "ready_pipelines": 0,
                "pipelines": [],
                "database": "disabled",
                "timestamp": datetime.utcnow().isoformat(),
            }

        ready_pipelines = []
        for pipeline in pipelines:
            required_slugs = set(pipeline.get_required_model_slugs())
            is_ready = required_slugs.issubset(cached_slugs)

            ready_pipelines.append(
                {
                    "id": pipeline.id,
                    "slug": pipeline.slug,
                    "name": pipeline.name,
                    "required_models": list(required_slugs),
                    "is_ready": is_ready,
                    "missing_models": list(required_slugs - cached_slugs),
                }
            )

        return {
            "total_pipelines": len(pipelines),
            "ready_pipelines": sum(1 for p in ready_pipelines if p["is_ready"]),
            "pipelines": ready_pipelines,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to get loaded pipelines", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.get("/sessions")
async def get_streaming_sessions() -> dict[str, Any]:
    """
    Get active Redis-Streams streaming sessions.
    """
    try:
        from stt.streaming._runtime import get_session_manager

        mgr = get_session_manager()
        if mgr is None:
            return {
                "status": "not_initialized",
                "active_sessions": 0,
                "sessions": [],
                "timestamp": datetime.utcnow().isoformat(),
            }

        sessions = mgr.list_sessions()
        for session in sessions:
            session["source"] = "streaming"

        return {
            "status": "running",
            "active_sessions": len(sessions),
            "sessions": sessions,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to get streaming sessions", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.get("/streaming/status")
async def get_streaming_status() -> dict[str, Any]:
    """
    Get streaming module status including execution profile, capacity,
    and active sessions.
    """
    try:
        from stt.streaming._runtime import get_session_manager

        mgr = get_session_manager()
        if mgr is None:
            return {
                "status": "not_initialized",
                "message": "Streaming module has not been started.",
                "timestamp": datetime.utcnow().isoformat(),
            }

        return {
            "status": "running",
            **mgr.to_dict(),
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to get streaming status", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@internal_router.post("/sessions/cleanup")
async def cleanup_sessions(max_age_seconds: int = 3600) -> dict[str, Any]:
    """
    Clean up expired streaming sessions.

    Args:
        max_age_seconds: Maximum age for sessions (default 1 hour)
    """
    try:
        from stt.streaming._runtime import get_session_manager

        mgr = get_session_manager()
        if mgr is None:
            return {
                "status": "not_initialized",
                "sessions_cleaned": 0,
                "max_age_seconds": max_age_seconds,
                "timestamp": datetime.utcnow().isoformat(),
            }

        count = await mgr.reap_expired_sessions(max_age_seconds)

        return {
            "status": "ok",
            "sessions_cleaned": count,
            "max_age_seconds": max_age_seconds,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error("Failed to cleanup sessions", error=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e
