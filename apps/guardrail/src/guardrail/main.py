"""Guardrail - AI-powered content safety service.

FastAPI application with OpenAI-compatible LLM engines and job queue processing.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader, load_env, real_secret
from hope_env.service_registration import start_registration, stop_registration

from guardrail.core.breaker import CircuitBreaker, FailPosture
from guardrail.core.concurrency import AdmissionGate
from guardrail.core.config import Settings, get_settings
from guardrail.core.effective_config import (
    CONFIG_INVALIDATION_CHANNEL as EFFECTIVE_CONFIG_INVALIDATION_CHANNEL,
)
from guardrail.core.logging import get_logger, setup_logging
from guardrail.core.metrics import record_config_cache_event

logger = get_logger(__name__)


def build_http_client(settings: Settings) -> httpx.AsyncClient:
    """The ONE shared peer client — bounded pool, every timeout phase explicit.

    A per-request client would open a fresh TCP+TLS handshake per delegation and
    defeat keep-alive entirely; a single unbounded one lets a stalled peer consume
    the process. Both bounds live here so there is exactly one place to read them.
    """
    t = settings.transport
    return httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=t.max_connections,
            max_keepalive_connections=t.max_keepalive_connections,
            keepalive_expiry=t.keepalive_expiry_s,
        ),
        timeout=httpx.Timeout(
            connect=t.connect_timeout_s,
            read=t.read_timeout_s,
            write=t.write_timeout_s,
            # BOUNDED: pool exhaustion surfaces as a fast failure
            # the admission gate can turn into a declared 503, not a silent stall.
            pool=t.pool_timeout_s,
        ),
    )


def build_admission_gates(settings: Settings) -> dict[str, AdmissionGate]:
    """The service's declared concurrency bounds, one gate per work class."""
    t = settings.transport
    return {
        "request": AdmissionGate(
            name="request",
            max_concurrent=t.max_concurrent_requests,
            max_wait_s=t.max_queue_wait_s,
        ),
        "batch": AdmissionGate(
            name="batch",
            max_concurrent=t.max_batch_concurrency,
            max_wait_s=t.max_queue_wait_s,
        ),
    }


def build_circuit_breakers(settings: Settings) -> dict[str, CircuitBreaker]:
    """One breaker per peer, each with its fail posture DECLARED here."""
    t = settings.transport
    return {
        # A moderation verdict has a safe default; guardrail's routes already map
        # the resulting exception to a fail-closed 503 / per-element undetermined.
        peer: CircuitBreaker(
            name=peer,
            posture=FailPosture.FAIL_CLOSED,
            failure_threshold=t.breaker_failure_threshold,
            recovery_timeout_s=t.breaker_recovery_timeout_s,
        )
        for peer in ("text", "nlp")
    }


#: The channel this listener watches. Re-pointed from the private
#: ``arca:guardrail-config:invalidate`` to the GENERALISED one the gateway
#: actually publishes on: the old literal appeared exactly once repo-wide — right
#: here — and had ZERO publishers, so this listener has never fired and guardrail
#: converged by 60s poll while believing it had push invalidation (RC-6). The old
#: name is not kept as an alias; keeping a second subscription would preserve the
#: appearance of a channel nothing writes to, which is the defect itself.
CONFIG_INVALIDATION_CHANNEL = EFFECTIVE_CONFIG_INVALIDATION_CHANNEL


def _invalidation_target(payload: str) -> tuple[str | None, str | None]:
    """Which `(tenant_id, task_key)` one invalidation payload narrows to.

    `(None, None)` means "drop everything" — the answer for an empty payload,
    ``"*"``, and for the gateway's JSON envelope (a `global-kv` write is
    platform-scope, so no tenant narrows it). The legacy
    ``"<tenant_id>[|<task_key>]"`` form still narrows.
    """
    if not payload or payload == "*" or payload.startswith("{"):
        return None, None
    tenant, _, task_key = payload.partition("|")
    return tenant or None, task_key or None


async def _config_invalidation_listener(app: FastAPI) -> None:
    """Drop cached config when the control plane says it changed.

    **Invalidation is the propagation path; the TTL is a bounded-staleness safety
    net** (rule 09 §Config caches).

    Evicts BOTH caches this process holds, because a control-plane write can move
    either: the per-tenant SQL resolver (`tenant_config`) and the platform-scope
    effective-config snapshot. Payloads accepted:

    * the gateway's JSON ``{"key", "scope", "tenantId"}`` — drops everything;
    * ``"*"`` — drops everything;
    * ``"<tenant_id>"`` / ``"<tenant_id>|<task_key>"`` — the narrow legacy form,
      kept so a future per-tenant publisher (the `AiRoutingPolicy` / `AiModel` write
      lanes, which are NOT this channel's publisher yet) can target one tenant.

    The listener never fails the service: a Redis outage degrades propagation back
    to the TTL.
    """
    resolver = getattr(app.state, "tenant_config_resolver", None)
    effective_config = getattr(app.state, "effective_config_client", None)
    if resolver is None and effective_config is None:
        return
    try:
        pubsub = app.state.redis.pubsub()
        await pubsub.subscribe(CONFIG_INVALIDATION_CHANNEL)
    except Exception as exc:  # noqa: BLE001 — propagation degrades to the TTL
        logger.warning("guardrail.config_invalidation.unavailable", error=str(exc))
        return

    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            raw = message.get("data")
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8", errors="replace")
            payload = str(raw or "").strip()

            # The platform-scope snapshot is dropped on EVERY message: it has no
            # tenant dimension to narrow by (D-1 — the pull route is one cached
            # entry per process).
            if effective_config is not None:
                effective_config.handle_invalidation_message(payload)

            if resolver is not None:
                tenant_id, task_key = _invalidation_target(payload)
                dropped = resolver.invalidate(tenant_id=tenant_id, task_key=task_key)
            else:
                dropped = 0
            record_config_cache_event("invalidated")
            logger.info("guardrail.config_invalidated", payload=payload, dropped=dropped)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardrail.config_invalidation.stopped", error=str(exc))
    finally:
        try:
            await pubsub.aclose()
        except Exception:  # noqa: BLE001
            pass


def _in_cluster_environment() -> bool:
    """Whether this process is a DEPLOYED workload rather than a developer's shell.

    `DEPLOYMENT_ENVIRONMENT` is the discriminator, not `NODE_ENV`. Measured on
    the live cluster 2026-09-07: `overlays/dev` patches the platform ConfigMap to
    `NODE_ENV=development` (only `base/config/platform.env` carries
    `NODE_ENV=production`), so a `node_env == "production"` gate is INERT in
    `hope-v2-dev` — precisely the environment where the missing token was found.
    `DEPLOYMENT_ENVIRONMENT` is set in EVERY deployed environment (base
    `production`, dev overlay `dev`) and is unset on a developer's machine
    (`.env.dev` ships only commented-out `*_OTEL_DEPLOYMENT_ENVIRONMENT`
    variants), which is exactly the split this gate needs. It is also the
    convention already used a few lines below for the service-registration
    `environment` field, so this keeps one rule in one file.

    `CI` is deliberately NOT a trigger: a CI *test* job is not a deployment, and
    coupling the two makes the gate fire in `test-guardrail` for no benefit.
    `NODE_ENV=production` is kept as a belt-and-braces trigger for any deployment
    that sets it without `DEPLOYMENT_ENVIRONMENT`.
    """
    if os.getenv("DEPLOYMENT_ENVIRONMENT", "").strip():
        return True
    return load_env().node_env == "production"


def _assert_internal_access_token(settings: Settings) -> None:
    """C3 — refuse to silently run every internal call unauthenticated.

    `INTERNAL_ACCESS_TOKEN` absent from `hope-secrets` (TASK-892 S2.5) currently
    fails OPEN: the `optional: true` Secret binding lets the container start
    happily, and every gateway-bound internal call (`effective-config` pull,
    service-release registration) 401s — the process then silently runs on
    compiled defaults instead of its resolved tenant -> SYSTEM configuration.

    An empty value is exactly as unconfigured as an absent one here — unlike
    `X-Service-Token`, where an empty value is the DELIBERATE dev/hermetic-CI
    auth-bypass sentinel (`06-python-services.md`). `real_secret` also maps the
    unfilled-secret placeholder (`CHANGE_ME`) onto empty, so a template value
    left unfilled is never mistaken for a real credential.

    In-cluster this is a hard failure: refuse to start rather than run with the
    gateway unauthenticated. In local dev it is not fatal — the developer's
    console is right there — so this logs ONE error-level line naming the
    variable and lets boot continue.
    """
    if real_secret(settings.internal_access_token):
        return

    if _in_cluster_environment():
        raise RuntimeError(
            "INTERNAL_ACCESS_TOKEN is missing or empty. guardrail refuses to start "
            "in-cluster without it: every internal call to the gateway "
            "(effective-config pull, service-release registration) would run "
            "unauthenticated and the service would silently fall back to "
            "compiled defaults instead of its resolved tenant configuration."
        )

    logger.error(
        "guardrail.internal_token.missing",
        variable="INTERNAL_ACCESS_TOKEN",
        detail=(
            "internal calls to the gateway will 401 and this process will run on "
            "compiled defaults instead of its resolved tenant configuration"
        ),
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources: httpx client, Redis, LLM providers."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    # Startup assertion (TASK-892 C3) — before any I/O, so an in-cluster
    # refusal never opens a connection it cannot authenticate.
    _assert_internal_access_token(settings)

    logger.info(
        "guardrail.starting",
        host=settings.host,
        port=settings.port,
        debug=settings.debug,
    )

    # The ONE shared peer client: bounded pool, every timeout phase explicit.
    http_client = build_http_client(settings)
    app.state.http_client = http_client

    # Declared concurrency bounds + per-peer breakers.
    app.state.admission_gates = build_admission_gates(settings)
    app.state.circuit_breakers = build_circuit_breakers(settings)

    # Redis client for job queue and caching
    redis_client = aioredis.from_url(settings.redis.redis_url, decode_responses=True)
    app.state.redis = redis_client

    # The control-plane pull client for aux-cache retention.
    # Construction performs NO I/O, so boot never blocks on (or fails because of)
    # the gateway; the first analyze/groundedness request triggers the first
    # fetch, and a failure negative-caches into env behaviour.
    if not hasattr(app.state, "effective_config_client"):
        from guardrail.core.effective_config import EffectiveConfigClient

        app.state.effective_config_client = EffectiveConfigClient(
            base_url=settings.gateway_url,
            # `peer_service_token`, never the legacy field directly: under owner
            # decision D-D the shared `INTERNAL_ACCESS_TOKEN` is set and the
            # per-service one is empty, so `get_secret_value()` sent "" and every
            # pull 401'd — negative-cached, so the service silently ran on its env
            # values. It also skips `real_secret`, transmitting a CHANGE_ME
            # sentinel verbatim.
            token=settings.peer_service_token(settings.service_token),
        )

    # Per-tenant config resolver. Always initialized: the `db_config_enabled`
    # gate that used to gate it is gone. It described an
    # "otherwise the env-only engine path is used" fallback that /736
    # deleted, so its only effect was to leave the resolver unbuilt and 503 every
    # route that needs a selection.
    if not hasattr(app.state, "tenant_config_resolver"):
        app.state.tenant_config_resolver = None
    if app.state.tenant_config_resolver is None:
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from guardrail.core.tenant_config import TenantConfigResolver

        db_engine = create_async_engine(
            settings.db.database_url,
            pool_size=settings.db.pool_size,
            max_overflow=settings.db.max_overflow,
            pool_pre_ping=True,
        )
        app.state.tenant_config_engine = db_engine
        session_factory = async_sessionmaker(bind=db_engine, expire_on_commit=False)
        app.state.tenant_config_resolver = TenantConfigResolver(
            session_factory=session_factory,
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )
        logger.info(
            "guardrail.tenant_config_enabled",
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )

    # No engine providers are initialized here. Guardrail hosts no LLM
    # medical validation delegates to `apps/text`'s judge
    # lane through a per-request client built from the tenant's own
    # `AiRoutingPolicy` selection, so there is nothing process-wide to construct —
    # and no env-configured engine to fall back to.

    # No aux models are loaded here either. Phases 3 & 6 moved the GLiNER
    # detector and the MiniCheck groundedness scorer into `apps/nlp` along with
    # their model cache and weight staging, so guardrail holds ZERO resident model
    # weights in ANY process, at any point in its lifetime.

    # Initialize job queue processor
    if not hasattr(app.state, "job_processor") or app.state.job_processor is None:
        from guardrail.core.dependencies import pinned_safety_analyzer
        from guardrail.services.job_processor import JobProcessor

        # A job carries the tenant that SUBMITTED it (stamped by
        # `/guardrail/analyze/async`, which now refuses an absent `X-Tenant-Id` with
        # 428). Model selection therefore resolves tenant-first for deferred work too,
        # instead of the old `tenant_id=None` that silently pinned every job to SYSTEM.
        def _analyzer_for_job(tenant_id: str | None) -> object:
            return pinned_safety_analyzer(app.state, tenant_id=tenant_id)

        app.state.job_processor = JobProcessor(
            redis=redis_client,
            analyzer_resolver=_analyzer_for_job,  # type: ignore[arg-type]
            max_concurrent=settings.queue.max_concurrent,
        )

        # Start background job processing
        app.state.job_processor_task = asyncio.create_task(
            app.state.job_processor.start_processing()
        )
        logger.info("guardrail.job_processor_started")

    # Config invalidation listener — the propagation path for a policy change.
    app.state.config_invalidation_task = asyncio.create_task(_config_invalidation_listener(app))

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Reuses the shared `http_client` above. Guardrail
    # has no dedicated `environment` settings field; `DEPLOYMENT_ENVIRONMENT`
    # / `NODE_ENV` is the same repo-wide convention `_deployment_environment()`
    # uses for OTel elsewhere.
    app.state.service_release_task = None
    try:
        app.state.service_release_task = start_registration(
            http_client=http_client,
            gateway_url=settings.gateway_url,
            service_token=settings.peer_service_token(settings.service_token),
            build_info=BuildInfoReader().get_build_info(),
            environment=os.getenv("DEPLOYMENT_ENVIRONMENT")
            or os.getenv("NODE_ENV")
            or "development",
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("guardrail.service_release_registration_failed", error=str(exc))

    yield

    # Cleanup
    logger.info("guardrail.shutting_down")

    await stop_registration(app.state.service_release_task)

    invalidation_task = getattr(app.state, "config_invalidation_task", None)
    if invalidation_task is not None:
        invalidation_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await invalidation_task

    if hasattr(app.state, "job_processor") and app.state.job_processor:
        await app.state.job_processor.stop()

    if hasattr(app.state, "job_processor_task") and app.state.job_processor_task:
        await app.state.job_processor_task

    # No aux-model caches to drain: guardrail holds no resident weights.

    if hasattr(app.state, "http_client") and app.state.http_client:
        await app.state.http_client.aclose()

    if hasattr(app.state, "redis") and app.state.redis:
        await app.state.redis.aclose()

    if getattr(app.state, "tenant_config_engine", None) is not None:
        await app.state.tenant_config_engine.dispose()

    from guardrail.core.observability import shutdown_opentelemetry

    shutdown_opentelemetry(app)


def create_app() -> FastAPI:
    """Create FastAPI application with middleware and routes."""
    settings = get_settings()

    app = FastAPI(
        title="Guardrail",
        description="AI-powered content safety service",
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS middleware
    if settings.cors_enabled:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Store settings in app state (read by ServiceAuthMiddleware at dispatch).
    app.state.settings = settings

    # Inter-service auth: enforce X-Service-Token on non-exempt paths.
    # An empty service_token is a dev / hermetic-CI bypass.
    from guardrail.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)

    # Include routers
    from guardrail.api.endpoints.groundedness import router as groundedness_router
    from guardrail.api.endpoints.guardrails import router as guardrails_router
    from guardrail.api.endpoints.health import router as health_router
    from guardrail.api.endpoints.jobs import router as jobs_router
    from guardrail.api.endpoints.medical import router as medical_router
    from guardrail.api.endpoints.realtime import router as realtime_router
    from guardrail.api.endpoints.redact import router as redact_router
    from guardrail.api.endpoints.screen import router as screen_router

    app.include_router(health_router, prefix="/api", tags=["health"])
    # Every other python service exposes health at /api/v1/health; alias it here
    # too (same router/handler) so callers using the v1 path don't 404 while
    # /api/health keeps working for existing callers.
    app.include_router(health_router, prefix="/api/v1", tags=["health"])
    app.include_router(medical_router, prefix="/api", tags=["medical"])  # Primary endpoint
    app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])
    # Live output-side groundedness gate — behind X-Service-Token.
    app.include_router(groundedness_router, prefix="/api", tags=["groundedness"])
    # Tenant-facing PHI redactor — behind X-Service-Token.
    app.include_router(redact_router, prefix="/api", tags=["guardrails"])
    # Bidirectional screening — inbound prompt + outbound response.
    app.include_router(screen_router, prefix="/api/v1", tags=["screening"])
    app.include_router(realtime_router, prefix="/api/v1", tags=["realtime"])
    app.include_router(jobs_router, prefix="/api", tags=["jobs"])

    # OpenTelemetry tracing. Default-OFF: both the master
    # switch AND a non-empty collector endpoint are required, so an unset
    # endpoint can never make a truthy flag start dialing a collector that
    # was never configured.
    if settings.otel_enabled and settings.otel_exporter_endpoint:
        from guardrail.core.observability import setup_opentelemetry

        setup_opentelemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
        )
    else:
        app.state.tracer_provider = None

    # Metrics endpoint
    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "guardrail.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level,
    )
