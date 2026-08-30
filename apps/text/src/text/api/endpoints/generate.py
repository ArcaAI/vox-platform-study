"""Text generation endpoint."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
import structlog.contextvars
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from opentelemetry import trace
from sse_starlette.sse import EventSourceResponse

from text.core.config import Settings
from text.core.dependencies import (
    get_app_state,
    get_circuit_breakers,
    get_generation_audit_logger,
    get_guardrail_client,
    get_pool_health_tracker,
    get_provider_queues,
    get_provider_registry,
    get_provider_semaphores,
    get_rate_limiters,
    get_redis,
    get_runtime_limits,
    get_shutdown_manager,
    get_task_manager,
)
from text.core.dependencies import (
    get_settings as get_dep_settings,
)
from text.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ProviderCredentialsError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
)
from text.core.exceptions import (
    ProviderNotFoundError as DomainProviderNotFoundError,
)
from text.core.exceptions import (
    ProviderTimeoutError as DomainProviderTimeoutError,
)
from text.core.exceptions import (
    QueueFullError as DomainQueueFullError,
)
from text.core.logging import get_logger
from text.core.metrics import (
    ACTIVE_GENERATIONS,
    CONCURRENT_REQUESTS,
    GENERATION_ERRORS,
    GENERATION_LATENCY,
    GENERATION_TOTAL,
    MODEL_INFERENCE_LATENCY,
    MODEL_RUNNING_INSTANCES,
    QUEUE_SIZE,
    QUEUE_WAIT_TIME,
    RATE_LIMIT_REJECTIONS,
    SERVICE_NAME,
    STOP_REASON_TOTAL,
    TOKENS_PER_SECOND,
    TOKENS_TOTAL,
)
from text.core.observability import set_generation_span_attributes
from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S
from text.models.requests import GenerateRequest
from text.models.responses import (
    ErrorResponse,
    GenerateResponse,
    TokenUsage,
)
from text.models.stats import (
    GenerationStats,
    degraded_stats,
)
from text.models.task import TaskStatus
from text.models.usage import (
    UsageDetail,
    build_usage_detail,
    guardrail_usage_from_verdict,
    raw_usage_from_stats,
)
from text.providers.base import ProviderNotFoundError, ProviderRegistry
from text.services.circuit_breaker import CircuitBreaker
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)
from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger
from text.services.judge_guard import assert_not_in_judge_scope
from text.services.pool_health import PoolHealthTracker
from text.services.pool_router import resolve_pool_route
from text.services.provider_queue import ProviderQueue, QueueFullError
from text.services.rate_limiter import RateLimitTracker, estimate_tokens
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.retry_handler import calculate_backoff, retry_after_from, should_retry
from text.services.runtime_limits import lane_budget
from text.services.shutdown_manager import ShutdownManager
from text.services.task_manager import TaskManager

logger = get_logger(__name__)

_DEFAULT_TIMEOUT_S = 120.0

# How long a completed generation stays replay-cached under
# ``text:idem:{key}``. Bounded so Redis never grows unboundedly, and comfortably longer
# than any worker-crash → Temporal activity re-delivery window (the replay this dedups).
_IDEMPOTENCY_TTL_S = 86_400  # 24h

# Re-exported for import compatibility: these moved to `text.routing.usage`
# (TASK-818 Wave 0.4) and are imported here by name so existing call sites and
# `from text.api.endpoints.generate import _x` keep resolving.
# Re-exported for import compatibility: the streaming path moved to
# `text.routing.streaming` (TASK-818 Wave 0.4).
from text.api.endpoints.stream import (  # noqa: E402
    _PING_SECONDS as SSE_PING_SECONDS,
)
from text.api.endpoints.stream import (  # noqa: E402
    _SSE_HEADERS as SSE_HEADERS,
)
from text.api.endpoints.stream import (  # noqa: E402
    stream_generation,
)
from text.routing.hub import (  # noqa: E402
    get_generation_hub,
    resolve_generation_policy,
)
from text.routing.streaming import (  # noqa: E402, F401
    _CB_STATE_MAP,
    _run_streaming_generation,
    _update_cb_metric,
    run_generation_producer,
)
from text.routing.usage import (  # noqa: E402, F401
    _coerce_stats,
    _extract_stream_usage,
    _extract_usage,
    _used_byok_credential,
)


async def _apply_guardrail_gate(
    guardrail_client: ExternalGuardrailClient | None,
    *,
    request_body: GenerateRequest,
    tenant_id: str | None,
    app_state: Any,
) -> UsageDetail | None:
    """Run the medical-content moderation gate; return guardrail's own usage.

    Extracted verbatim from the ``/generate`` body so there is exactly ONE
    moderation gate in this service and one place to assert it is not being
    reached from the internal judge lane. Behaviour is unchanged: a genuine
    content rejection is a 422, a sustained outage is a retryable 503, a
    malformed verdict fails closed, and the enforce-posture-with-unwired-client
    case fails closed too. The dev/CI bypass (client absent or disabled) is
    preserved.

    The ``assert_not_in_judge_scope`` call is the cycle tripwire (TASK-735
    §2.5): ``apps/guardrail`` delegates its LLM judgement to this service, so
    gating a JUDGE call on guardrail would close an unbounded
    ``text -> guardrail -> text`` cycle and deadlock the safety plane behind the
    pool it protects. If a future edit routes this helper onto the judge path it
    raises here rather than shipping the cycle.
    """
    if guardrail_client is not None:
        assert_not_in_judge_scope("generate._apply_guardrail_gate")
        verdict = await guardrail_client.validate(
            prompt=request_body.prompt,
            system_prompt=request_body.system_prompt,
            tenant_id=tenant_id,
            # The tenant's own moderation policy, PUSHED with the request. Folds
            # over the platform default tenant-first; absent ⇒ the platform
            # posture stands (`core/guardrail_posture.py`).
            tenant_policy=request_body.guardrail_policy,
        )
        # Lifted BEFORE the allow/deny branch: a REJECTED prompt still burned
        # guardrail tokens, and metering the safety plane is exactly how its cost
        # lands in per-encounter margin (it is never invoiced to the tenant).
        guardrail_usage = guardrail_usage_from_verdict(verdict)
        if not verdict.get("allowed", False):  # fail-closed default (missing key → reject)
            reason = verdict.get("reason", "not_allowed")
            # A sustained guardrail outage is retryable (503); a genuine content
            # rejection is a 422. Both fail CLOSED — generation never runs.
            status_code = 503 if reason == GUARDRAIL_UNAVAILABLE_REASON else 422
            raise HTTPException(
                status_code=status_code,
                detail=f"Content rejected by guardrail: {reason}",
            )
        return guardrail_usage
    if _platform_moderation_enabled(app_state):
        # Enforce posture on but the guardrail client is unwired — fail CLOSED rather
        # than silently skip moderation (a misconfiguration must not ship unmoderated
        # PHI). Retryable (503) once the client is provisioned.
        raise HTTPException(
            status_code=503,
            detail="Content rejected by guardrail: external_guardrail_unavailable",
        )
    return None


#: Streaming idempotency records live under their own prefix. The non-streaming
#: path caches a whole ``GenerateResponse`` under ``text:idem:``; a streaming
#: retry needs a generation id and a payload fingerprint instead, and two
#: different shapes must never share a key.
_STREAM_IDEM_PREFIX = "text:idem:stream:"


def _payload_fingerprint(request_body: GenerateRequest) -> str:
    """A stable hash of the request an idempotency key claims to identify.

    Excludes ``provider``, which the degrade-away-from-unhealthy router rewrites
    in place before this point: the same logical request rerouted to a healthy
    provider is still the same request, and fingerprinting the rewritten value
    would turn a successful failover into a spurious 409.
    """
    payload = request_body.model_dump(mode="json", exclude={"provider"})
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


async def _resolve_stream_idempotency(
    redis_client: aioredis.Redis | None,
    idempotency_key: str | None,
    request_body: GenerateRequest,
    generation_id: str,
) -> str | None:
    """Map an ``Idempotency-Key`` to a generation id (§3C.6).

    Returns the id of an EXISTING generation when this key has been seen before,
    or ``None`` when this request should proceed as new. Raises **409
    ``idempotency_conflict``** when the key was reused with a different payload —
    the one case where silently returning the first generation would be a lie.

    Best-effort in exactly the same sense as the non-streaming cache above: no
    key or no Redis means "generate", because a dedup-store outage must degrade
    to a duplicate generation, never to a refused one.
    """
    if not idempotency_key or redis_client is None:
        return None

    key = f"{_STREAM_IDEM_PREFIX}{idempotency_key}"
    fingerprint = _payload_fingerprint(request_body)
    record = json.dumps({"generation_id": generation_id, "fingerprint": fingerprint})

    try:
        # SET NX is what makes this a race-free claim rather than a
        # check-then-act: two concurrent retries of the same key cannot both
        # decide they are the first.
        claimed = await redis_client.set(key, record, nx=True, ex=3600)
        if claimed:
            return None
        existing = await redis_client.get(key)
    except Exception as exc:  # noqa: BLE001 — a dedup-store blip degrades to "generate"
        logger.warning(
            "generation.stream_idempotency_unavailable",
            cache_key=key,
            error=str(exc),
        )
        return None

    if existing is None:
        return None
    if isinstance(existing, bytes):
        existing = existing.decode()
    try:
        prior = json.loads(existing)
    except ValueError:
        return None

    if prior.get("fingerprint") != fingerprint:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "idempotency_conflict",
                "message": (
                    "This Idempotency-Key was already used with a different request payload."
                ),
            },
        )
    return str(prior.get("generation_id") or generation_id)


def _platform_moderation_enabled(app_state: Any) -> bool:
    """Whether the control plane says moderation is on.

    Read from live state rather than from settings: the switch moved off env
    onto the PULL channel, so a platform admin turning moderation on for a
    clinical deployment takes effect on the next request, not the next restart.
    """
    posture = getattr(app_state, "guardrail_posture", None)
    return bool(getattr(posture, "enabled", False))


def _get_provider_timeout(runtime_timeouts: dict[str, int], provider_name: str) -> float:
    """The per-provider request timeout, control-plane first.

    This used to read one of ten ``TEXT_<PROVIDER>_TIMEOUT_S`` env vars through a
    hand-maintained alias map — a map that silently dropped `ollama`, `openai`,
    `anthropic` and `vertex` onto a module default nobody noticed. Now there is
    one source (`AiRuntimeProfile` via `/internal/effective-config`) and one
    fallback (the resource-safety floor), so no provider can be missed by
    forgetting a dictionary entry.
    """
    served = runtime_timeouts.get(provider_name)
    return float(served) if served else float(PROVIDER_TIMEOUT_FLOOR_S)


# NOTE — TASK-818 C-4 ("`ORJSONResponse` as `default_response_class`") was tried
# here and DELIBERATELY NOT KEPT. Two measurements killed it:
#
#   * the win is 3 microseconds. Rendering a real `GenerateResponse` (770 bytes):
#     `jsonable_encoder` 0.0230 ms + stdlib `json.dumps` 0.0033 ms = 0.0263 ms,
#     versus 0.0230 + orjson 0.0003 = 0.0234 ms. `ORJSONResponse` does not avoid
#     `jsonable_encoder`, which is 87% of the cost — and the whole of it is 0.03%
#     of this request's ~8.3 ms CPU budget.
#   * FastAPI 0.141 DEPRECATES it: "ORJSONResponse is deprecated, FastAPI now
#     serializes data directly to JSON bytes via Pydantic when a return type or
#     response model is set, which is faster and doesn't need a custom response
#     class." Setting it emits that warning on every response.
#
# The non-deprecated fast path needs a declared response model, which this route
# cannot have: it returns EITHER a `GenerateResponse` OR an `EventSourceResponse`
# (hence `response_model=None`). Splitting the streaming branch onto its own route
# would unlock it — a real option, but a CONTRACT change, not an encoder swap.
# The error path reached the same verdict for the same reasons; see
# `core/exception_handlers.ERROR_RESPONSE_CLASS`.
#
# The request-path win was elsewhere entirely: `api/middleware/*` became pure
# ASGI, worth ~28% of per-request CPU.
router = APIRouter(tags=["generate"])


# Inbound `X-Tenant-Id` enforcement used to live here as `_require_inbound_tenant`,
# called by hand from this route and `/generate/batch`. It is now a middleware
# precondition (`api/middleware/auth.py`) that every route inherits — the two
# handlers below still declare the header because they READ it, not to guard it.


@router.post(
    "/generate",
    response_model=None,
    responses={
        200: {"model": GenerateResponse},
        409: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def generate(
    request_body: GenerateRequest,
    fastapi_request: Request,
    registry: ProviderRegistry = Depends(get_provider_registry),
    task_manager: TaskManager = Depends(get_task_manager),
    generation_audit: GenerationAuditLogger = Depends(get_generation_audit_logger),
    rate_limiters: dict[str, RateLimitTracker] = Depends(get_rate_limiters),
    circuit_breakers: dict[str, CircuitBreaker] = Depends(get_circuit_breakers),
    shutdown_manager: ShutdownManager | None = Depends(get_shutdown_manager),
    provider_queues: dict[str, ProviderQueue] = Depends(get_provider_queues),
    provider_semaphores: dict[str, ResizableSemaphore] = Depends(get_provider_semaphores),
    # Refreshes control-plane limits (cached, so ~free inside the TTL
    # window) and yields per-provider timeout overrides; empty ⇒ env value wins.
    runtime_timeouts: dict[str, int] = Depends(get_runtime_limits),
    settings: Settings = Depends(get_dep_settings),
    # Live control-plane state: the resolved moderation posture and lane budgets
    # that replaced `TEXT_EXTERNAL_GUARDRAIL_*` / `TEXT_QUEUE_*`.
    app_state: Any = Depends(get_app_state),
    guardrail_client: ExternalGuardrailClient | None = Depends(get_guardrail_client),
    redis_client: aioredis.Redis | None = Depends(get_redis),
    pool_health_tracker: PoolHealthTracker = Depends(get_pool_health_tracker),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    if shutdown_manager and shutdown_manager.is_shutting_down:
        raise ShutdownError("Service is shutting down — not accepting new requests.")

    # Degrade-away-from-unhealthy routing (TASK-725 Task 2, design.md Services
    # program): a provider the LAST `/health` check marked unhealthy is never
    # blindly dispatched into. Reroutes to `fallback_provider` when the
    # caller declared one AND it's actually registered; otherwise fails fast
    # with a typed 503 (`PoolUnhealthyError`) rather than queueing into a dead
    # engine. The routed name is written back onto `request_body.provider` so
    # every downstream lookup keyed by provider name (rate limiter, circuit
    # breaker, queue, semaphore, metrics, audit, task state) reflects the
    # ACTUAL provider serving the request — one rewrite point, not a parallel
    # "effective provider" variable threaded through the rest of the function.
    fallback_name = request_body.fallback_provider
    request_body.provider = resolve_pool_route(
        request_body.provider,
        tracker=pool_health_tracker,
        fallback=fallback_name,
        fallback_registered=bool(fallback_name) and fallback_name in registry.list_providers(),
    )

    # Idempotent replay. A deterministic Idempotency-Key (set by the harness
    # from workflow_run:activity_id — globally unique per logical generate; the apps/api Text
    # proxy strips any client-supplied header, so no tenant scoping is required here, though a
    # tenant prefix would be a cheap defense-in-depth if that ever changes) makes a worker-crash
    # re-delivery return the FIRST generation instead of re-invoking — and re-billing — the
    # model. On a HIT we return the cached GenerateResponse without touching the provider (or any
    # rate-limit / circuit-breaker / task machinery below); a successful MISS caches it before
    # returning. The lookup is strictly BEST-EFFORT: no key, no Redis wired, OR a Redis read
    # error all fall through to normal generation — a dedup-store outage must degrade to
    # "generate" (the documented residual), never fail an otherwise-serviceable request.
    cache_key = f"text:idem:{idempotency_key}" if idempotency_key else None
    if cache_key is not None and redis_client is not None:
        try:
            cached = await redis_client.get(cache_key)
        except Exception as exc:
            logger.warning(
                "generation.idempotency_cache_read_failed", cache_key=cache_key, error=str(exc)
            )
            cached = None
        if cached is not None:
            logger.debug("generation.idempotency_cache_hit", cache_key=cache_key)
            return GenerateResponse.model_validate_json(cached)

    # Guardrail's own LLM spend rides back on THIS response — guardrail is a peer
    # service with no gateway in front of it, so the verdict is the only path its
    # tokens have to the billing plane.
    guardrail_usage: UsageDetail | None = None

    # Guardrail medical-content validation (see ``_apply_guardrail_gate``).
    guardrail_usage = await _apply_guardrail_gate(
        guardrail_client,
        request_body=request_body,
        tenant_id=x_tenant_id,
        app_state=app_state,
    )

    ctx = structlog.contextvars.get_contextvars()

    # Text is a stateless gateway with no default model. The
    # caller (API/harness) resolves and supplies the model on every request;
    # a missing/blank model fails closed with a 422 (no silent default).
    model = request_body.model
    if model is None or not model.strip():
        raise HTTPException(
            status_code=422,
            detail="Field 'model' is required: Text has no default model.",
        )

    rate_limiter = rate_limiters.get(request_body.provider)
    queue = provider_queues.get(request_body.provider)
    if rate_limiter:
        estimated = estimate_tokens(request_body.prompt)
        if not rate_limiter.can_proceed(estimated):
            if queue and not queue.is_full:
                queue_start = time.monotonic()
                future: asyncio.Future[bool] = asyncio.get_event_loop().create_future()
                try:
                    await queue.enqueue(
                        priority=0, future=future, request_id=ctx.get("request_id", "unknown")
                    )
                    QUEUE_SIZE.labels(provider=request_body.provider).set(queue.size)
                    await asyncio.wait_for(
                        future,
                        timeout=lane_budget(
                            app_state, request_body.provider, "user"
                        ).queue_max_wait_s,
                    )
                    QUEUE_WAIT_TIME.labels(provider=request_body.provider).observe(
                        time.monotonic() - queue_start
                    )
                    QUEUE_SIZE.labels(provider=request_body.provider).set(queue.size)
                except TimeoutError:
                    QUEUE_SIZE.labels(provider=request_body.provider).set(queue.size)
                    RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider).inc()
                    raise QueueTimeoutError(
                        "Request queued but timed out waiting for capacity",
                        provider=request_body.provider,
                    ) from None
                except QueueFullError:
                    RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider).inc()
                    raise DomainQueueFullError(
                        "Rate limit exceeded and queue is full",
                        provider=request_body.provider,
                    ) from None
            else:
                RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider).inc()
                wait = rate_limiter.get_wait_seconds(estimated)
                raise RateLimitError(
                    "Rate limit exceeded and queue is full" if queue else "Rate limit exceeded",
                    retry_after=wait,
                )
        rate_limiter.record_request(estimated)

    cb = circuit_breakers.get(request_body.provider)
    if cb and not cb.allow_request():
        _update_cb_metric(request_body.provider, cb)
        raise CircuitOpenError(
            "Service temporarily unavailable (circuit open)",
            provider=request_body.provider,
        )

    try:
        provider = registry.get(request_body.provider)
    except ProviderNotFoundError:
        raise DomainProviderNotFoundError(
            f"Provider '{request_body.provider}' not found",
            provider=request_body.provider,
        ) from None

    task = await task_manager.create_task(provider=request_body.provider, model=model)

    if shutdown_manager:
        shutdown_manager.register_task(task.task_id)

    if request_body.stream:
        # 200 + SSE, immediately. The 202-and-poll indirection is gone (§3C.3(1)):
        # it cost every stream a second HTTP round trip before its first token,
        # and it made the generation a `BackgroundTasks` callback — which runs
        # AFTER the response completes and is owned by it. A producer owned by a
        # response cannot outlive one, and outliving it is the entire point.
        #
        # The audit event is still logged by the producer when the stream ENDS,
        # with the real token totals: an audit record must describe what
        # happened, not what is about to.
        hub = get_generation_hub(fastapi_request.app)
        generation_id = task.task_id

        replayed = await _resolve_stream_idempotency(
            redis_client, idempotency_key, request_body, generation_id
        )
        if replayed is not None:
            # A retry of a delivered request. Same id, no second provider call —
            # the terminal write is keyed by generation id, so replaying it is a
            # no-op (§3C.6). We simply subscribe to what already exists.
            generation_id = replayed
            if shutdown_manager:
                shutdown_manager.complete_task(task.task_id)
        else:
            hub.start(
                generation_id,
                lambda producer: run_generation_producer(
                    producer,
                    task_manager,
                    provider,
                    request_body,
                    provider_name=request_body.provider,
                    model=model,
                    shutdown_manager=shutdown_manager,
                    circuit_breakers=circuit_breakers,
                    generation_audit=generation_audit,
                    tenant_id=x_tenant_id,
                    request_id=ctx.get("request_id", "unknown"),
                    byok=_used_byok_credential(request_body),
                    policy=resolve_generation_policy(app_state, x_tenant_id),
                ),
                provider=request_body.provider,
            )

        return EventSourceResponse(
            # The policy matters on the idempotent-replay path above: that
            # branch starts NO producer, so if the first delivery ran in another
            # process this response is a cross-process tail and needs the same
            # `maxGenerationSeconds` bound a `/generations/{id}/stream` resume gets.
            stream_generation(
                hub,
                task_manager,
                generation_id,
                0,
                resolve_generation_policy(app_state, x_tenant_id),
            ),
            headers=SSE_HEADERS,
            ping=SSE_PING_SECONDS,
        )

    _SEMAPHORE_ACQUIRE_TIMEOUT = 30.0

    semaphore = provider_semaphores.get(request_body.provider)

    async def _take_permit() -> None:
        """Acquire the provider's concurrency permit, or refuse with a typed 503."""
        if semaphore is None:
            return
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=_SEMAPHORE_ACQUIRE_TIMEOUT)
        except TimeoutError:
            raise ConcurrencyLimitError(
                "Too many concurrent requests — try again later",
                provider=request_body.provider,
            ) from None
        CONCURRENT_REQUESTS.labels(provider=request_body.provider).inc()

    def _drop_permit() -> None:
        if semaphore is None:
            return
        CONCURRENT_REQUESTS.labels(provider=request_body.provider).dec()
        semaphore.release()

    await _take_permit()
    #: Whether THIS request currently holds the permit. It is handed back across
    #: retry backoff (see the loop below), so the outer `finally` cannot assume it.
    holds_permit = semaphore is not None

    await task_manager.update_task(task.task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=request_body.provider).inc()
    # Cross-service per-model running gauge (e.g. gemma-4-e4b).
    MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=model).inc()
    start = time.monotonic()

    timeout_s = _get_provider_timeout(runtime_timeouts, request_body.provider)
    max_retries = request_body.retry_config.max_retries
    retry_on = request_body.retry_config.retry_on

    try:
        last_exc: Exception | None = None
        error_type = "provider_error"

        for attempt in range(max_retries + 1):
            try:
                content, reasoning, gen_result = await asyncio.wait_for(
                    provider.generate(request_body),
                    timeout=timeout_s,
                )
                if cb:
                    cb.record_success()
                    _update_cb_metric(request_body.provider, cb)
                last_exc = None
                break
            except TimeoutError as exc:
                error_type = "timeout"
                last_exc = exc
                logger.warning(
                    "generation.timeout",
                    attempt=attempt + 1,
                    timeout_s=timeout_s,
                    task_id=task.task_id,
                )
            except Exception as exc:
                error_type = "provider_error"
                last_exc = exc

            if not should_retry(error_type, retry_on, attempt, max_retries):
                break

            # C-6: the wait the upstream itself asked for wins over the computed
            # exponential delay — and is jittered either way, because an exact
            # `Retry-After` hands every limited caller the SAME deadline.
            asked_for = retry_after_from(last_exc) if last_exc is not None else None
            backoff = calculate_backoff(attempt, retry_after=asked_for)
            logger.warning(
                "generation.retry",
                attempt=attempt + 1,
                max_retries=max_retries,
                backoff_s=round(backoff, 2),
                retry_after_s=asked_for,
                error_type=error_type,
                task_id=task.task_id,
            )

            # C-5 (B-5): hand the provider's concurrency permit BACK for the
            # duration of the backoff. Holding it across `sum(backoffs) +
            # attempts x timeout` is how one degrading provider converts its own
            # slowness into capacity starvation for every other request — and
            # every other tenant — queued behind the same semaphore.
            if holds_permit:
                _drop_permit()
                holds_permit = False
            await asyncio.sleep(backoff)
            # Re-entering the lane is admission control again, not a formality:
            # if capacity is gone, this request waits its turn or is refused with
            # the same typed 503 the first acquire would have raised.
            await _take_permit()
            holds_permit = semaphore is not None

        if last_exc is not None:
            raise last_exc

        latency_ms = int((time.monotonic() - start) * 1000)
        prompt_tokens, completion_tokens, total_tokens = _extract_usage(gen_result)

        # assemble normalized GenerationStats and thread it onto
        # the response. STRICTLY best-effort — a stats-mapping failure must never
        # fail an otherwise-successful, already-billed generation (degrade to a
        # null-safe, clearly-marked stats object + a warning). The provider now
        # returns REAL stats (native finish reason surfaced), so the non-stream
        # stop reason is no longer the frozen wire-compat "stop".
        stats: GenerationStats
        try:
            stats = _coerce_stats(
                gen_result,
                provider=request_body.provider,
                model=model,
                latency_ms=latency_ms,
            )
        except Exception as exc:
            logger.warning("generation.stats_degraded", task_id=task.task_id, error=str(exc))
            stats = degraded_stats(provider=request_body.provider, model=model, total_ms=latency_ms)
        # Wire-compat ``finish_reason`` reflects the provider's REAL native stop
        # reason (falling back to the normalized reason, then "stop") — NOT the
        # frozen "stop" the pre-AD-1 endpoint always reported.
        finish_reason = stats.stop_reason_raw or stats.stop_reason or "stop"

        await task_manager.update_task(
            task.task_id, status=TaskStatus.COMPLETED, total_tokens=total_tokens
        )

        GENERATION_TOTAL.labels(
            provider=request_body.provider, model=model, status="completed"
        ).inc()
        GENERATION_LATENCY.labels(provider=request_body.provider, model=model).observe(
            latency_ms / 1000
        )
        # Cross-service per-model inference latency (for avg latency).
        MODEL_INFERENCE_LATENCY.labels(service=SERVICE_NAME, model=model).observe(latency_ms / 1000)
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="input").inc(
            prompt_tokens
        )
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="output").inc(
            completion_tokens
        )

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(UTC).isoformat(),
                provider=request_body.provider,
                model=model,
                status="completed",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                latency_ms=latency_ms,
                finish_reason=finish_reason,
                tenant_id=x_tenant_id,
            )
        )

        # Metric/span stamping is STRICTLY best-effort and must be guarded on its
        # own: the model already ran and the task is COMPLETED, so a Prometheus
        # label edge case or an OTel span raise here must NEVER bubble into the
        # outer ``except`` — that would record a FALSE circuit-breaker failure,
        # flip the task to FAILED, skip the idempotency cache, and return a 5xx
        # the harness retries (re-invoking = re-billing). Swallow and continue;
        # worst case degrades to "not recorded" (same posture as AD-1 stats +
        # the idempotency-cache write below).
        try:
            if stats.tokens_per_second is not None:
                TOKENS_PER_SECOND.labels(provider=request_body.provider, model=model).observe(
                    stats.tokens_per_second
                )
            STOP_REASON_TOTAL.labels(
                provider=request_body.provider, model=model, stop_reason=stats.stop_reason
            ).inc()
            set_generation_span_attributes(
                trace.get_current_span(),
                provider=request_body.provider,
                model=model,
                input_tokens=stats.prompt_tokens,
                output_tokens=stats.predicted_tokens,
                finish_reasons=[stats.stop_reason],
            )
        except Exception as exc:
            logger.warning(
                "generation.stats_telemetry_failed", task_id=task.task_id, error=str(exc)
            )

        response = GenerateResponse(
            task_id=task.task_id,
            status="completed",
            content=content,
            reasoning=reasoning,
            provider=request_body.provider,
            model=model,
            usage=TokenUsage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
            ),
            latency_ms=latency_ms,
            finish_reason=finish_reason,
            stats=stats,
            usage_detail=build_usage_detail(
                task_id=task.task_id,
                request_id=ctx.get("request_id"),
                provider=request_body.provider,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                raw=raw_usage_from_stats(stats),
                byok=_used_byok_credential(request_body),
            ),
            guardrail_usage=guardrail_usage,
        )
        # Cache the completed generation so a replayed request carrying the
        # same key returns THIS response instead of re-billing the model (bounded TTL). STRICTLY
        # best-effort and locally guarded: the model already ran and the task is COMPLETED, so a
        # cache-write failure (Redis OOM on a large SOAP note, a dropped connection) must NEVER
        # bubble into the outer ``except`` — that would discard a billed generation, record a
        # FALSE circuit-breaker failure, flip the task to FAILED, and return a 5xx the harness
        # retries (re-invoking the model would double-bill it). Swallow
        # it and return the response; the worst case degrades to "not cached" (documented residual).
        if cache_key is not None and redis_client is not None:
            try:
                await redis_client.set(cache_key, response.model_dump_json(), ex=_IDEMPOTENCY_TTL_S)
            except Exception as exc:
                logger.warning(
                    "generation.idempotency_cache_write_failed",
                    task_id=task.task_id,
                    error=str(exc),
                )
        return response
    except TimeoutError:
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error(
            "generation.timeout_final",
            task_id=task.task_id,
            provider=request_body.provider,
            timeout_s=timeout_s,
        )
        await task_manager.update_task(
            task.task_id, status=TaskStatus.FAILED, error="Request timed out"
        )
        GENERATION_ERRORS.labels(
            provider=request_body.provider, model=model, error_type="timeout"
        ).inc()
        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="failed").inc()

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(UTC).isoformat(),
                provider=request_body.provider,
                model=model,
                status="failed",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                latency_ms=latency_ms,
                finish_reason="error",
                error="Request timed out",
                tenant_id=x_tenant_id,
            )
        )

        raise DomainProviderTimeoutError(
            f"Generation timed out after {timeout_s}s for provider '{request_body.provider}'.",
            provider=request_body.provider,
        ) from None
    except ProviderCredentialsError:
        # A missing BYOK credential is a platform-CONFIG gap, not a
        # provider health failure — do NOT record a circuit-breaker failure (it
        # would open the breaker for a provider that never handled a request) and
        # do NOT collapse it into a generic 502. Mark the task failed for a
        # consistent record, then re-raise so the shared exception handler maps it
        # to 503 (PROVIDER_CREDENTIALS_MISSING) via ``_STATUS_MAP``.
        await task_manager.update_task(
            task.task_id, status=TaskStatus.FAILED, error="Provider credentials not configured"
        )
        GENERATION_ERRORS.labels(
            provider=request_body.provider, model=model, error_type="credentials_missing"
        ).inc()
        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="failed").inc()
        raise
    except ConcurrencyLimitError:
        # Raised by the re-acquire between retry attempts (C-5): capacity was
        # handed back for the backoff and could not be reclaimed inside the
        # admission timeout. Same reasoning as the credentials arm above — this is
        # a CAPACITY refusal, not evidence that the provider is unhealthy, so do
        # NOT record a circuit-breaker failure and do NOT collapse it into a 502.
        # Re-raise so the shared handler maps it to 503 + `Retry-After`.
        await task_manager.update_task(
            task.task_id, status=TaskStatus.FAILED, error="Concurrency limit reached"
        )
        GENERATION_ERRORS.labels(
            provider=request_body.provider, model=model, error_type="concurrency_limit"
        ).inc()
        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="failed").inc()
        raise
    except Exception as exc:
        if cb:
            cb.record_failure()
            _update_cb_metric(request_body.provider, cb)
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error(
            "generation.failed",
            task_id=task.task_id,
            provider=request_body.provider,
            error=str(exc),
            exc_info=True,
        )
        await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error=str(exc))
        GENERATION_ERRORS.labels(
            provider=request_body.provider, model=model, error_type="provider_error"
        ).inc()
        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="failed").inc()

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(UTC).isoformat(),
                provider=request_body.provider,
                model=model,
                status="failed",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                latency_ms=latency_ms,
                finish_reason="error",
                error=str(exc),
                tenant_id=x_tenant_id,
            )
        )

        raise HTTPException(
            status_code=502,
            detail="Generation failed due to an internal error. Check server logs for details.",
        ) from exc
    finally:
        ACTIVE_GENERATIONS.labels(provider=request_body.provider).dec()
        MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=model).dec()
        # `holds_permit`, not `if semaphore`: the retry loop hands the permit back
        # across backoff, so an unconditional release here would release a permit
        # this request no longer owns — `ResizableSemaphore.release()` raises on
        # an over-release, which would replace the real error with a RuntimeError.
        if holds_permit:
            _drop_permit()
        if shutdown_manager:
            shutdown_manager.complete_task(task.task_id)
