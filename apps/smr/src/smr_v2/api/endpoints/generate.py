"""Text generation endpoint."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
import structlog.contextvars
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from fastapi.responses import JSONResponse

from smr_v2.core.config import Settings
from smr_v2.core.dependencies import (
    get_circuit_breakers,
    get_generation_audit_logger,
    get_guardrail_client,
    get_provider_queues,
    get_provider_registry,
    get_provider_semaphores,
    get_rate_limiters,
    get_redis,
    get_shutdown_manager,
    get_task_manager,
)
from smr_v2.core.dependencies import (
    get_settings as get_dep_settings,
)
from smr_v2.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
)
from smr_v2.core.exceptions import (
    ProviderNotFoundError as DomainProviderNotFoundError,
)
from smr_v2.core.exceptions import (
    ProviderTimeoutError as DomainProviderTimeoutError,
)
from smr_v2.core.exceptions import (
    QueueFullError as DomainQueueFullError,
)
from smr_v2.core.logging import get_logger
from smr_v2.core.metrics import (
    ACTIVE_GENERATIONS,
    CIRCUIT_BREAKER_STATE,
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
    TOKENS_TOTAL,
)
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.responses import (
    ErrorResponse,
    GenerateResponse,
    StreamingGenerateResponse,
    TokenUsage,
)
from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskStatus
from smr_v2.providers.base import LLMProvider, ProviderNotFoundError, ProviderRegistry
from smr_v2.services.circuit_breaker import CircuitBreaker, CircuitState
from smr_v2.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)
from smr_v2.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger
from smr_v2.services.provider_queue import ProviderQueue, QueueFullError
from smr_v2.services.rate_limiter import RateLimitTracker, estimate_tokens
from smr_v2.services.retry_handler import calculate_backoff, should_retry
from smr_v2.services.shutdown_manager import ShutdownManager
from smr_v2.services.task_manager import TaskManager

logger = get_logger(__name__)

_DEFAULT_TIMEOUT_S = 120.0

# C1-04 (TASK-469): how long a completed generation stays replay-cached under
# ``smr:idem:{key}``. Bounded so Redis never grows unboundedly, and comfortably longer
# than any worker-crash → Temporal activity re-delivery window (the replay this dedups).
_IDEMPOTENCY_TTL_S = 86_400  # 24h


def _get_provider_timeout(settings: Settings, provider_name: str) -> float:
    """Get timeout in seconds for the given provider."""
    config_map = {
        "ollama": settings.ollama.timeout_s,
        "azure-openai": settings.azure.timeout_s,
        "bedrock": settings.bedrock.timeout_s,
        "lm-studio": settings.openai_compat.timeout_s,
        # Backward-compatible aliases
        "azure": settings.azure.timeout_s,
        "openai_compat": settings.openai_compat.timeout_s,
    }
    return float(config_map.get(provider_name, _DEFAULT_TIMEOUT_S))

router = APIRouter(tags=["generate"])


@router.post(
    "/generate",
    response_model=None,
    responses={
        200: {"model": GenerateResponse},
        202: {"model": StreamingGenerateResponse},
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def generate(
    request_body: GenerateRequest,
    background_tasks: BackgroundTasks,
    registry: ProviderRegistry = Depends(get_provider_registry),
    task_manager: TaskManager = Depends(get_task_manager),
    generation_audit: GenerationAuditLogger = Depends(get_generation_audit_logger),
    rate_limiters: dict[str, RateLimitTracker] = Depends(get_rate_limiters),
    circuit_breakers: dict[str, CircuitBreaker] = Depends(get_circuit_breakers),
    shutdown_manager: ShutdownManager | None = Depends(get_shutdown_manager),
    provider_queues: dict[str, ProviderQueue] = Depends(get_provider_queues),
    provider_semaphores: dict[str, asyncio.Semaphore] = Depends(get_provider_semaphores),
    settings: Settings = Depends(get_dep_settings),
    guardrail_client: ExternalGuardrailClient | None = Depends(get_guardrail_client),
    redis_client: aioredis.Redis | None = Depends(get_redis),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    if shutdown_manager and shutdown_manager.is_shutting_down:
        raise ShutdownError("Service is shutting down — not accepting new requests.")

    # C1-04 (TASK-469): idempotent replay. A deterministic Idempotency-Key (set by the harness
    # from workflow_run:activity_id — globally unique per logical generate; the apps/api SMR
    # proxy strips any client-supplied header, so no tenant scoping is required here, though a
    # tenant prefix would be a cheap defense-in-depth if that ever changes) makes a worker-crash
    # re-delivery return the FIRST generation instead of re-invoking — and re-billing — the
    # model. On a HIT we return the cached GenerateResponse without touching the provider (or any
    # rate-limit / circuit-breaker / task machinery below); a successful MISS caches it before
    # returning. The lookup is strictly BEST-EFFORT: no key, no Redis wired, OR a Redis read
    # error all fall through to normal generation — a dedup-store outage must degrade to
    # "generate" (the documented residual), never fail an otherwise-serviceable request.
    cache_key = f"smr:idem:{idempotency_key}" if idempotency_key else None
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

    # Guardrail medical-content validation (TASK-338 Phase 4b; TASK-478 fail-closed).
    # The consultation tenant is forwarded so guardrail resolves per-tenant
    # provider/model from DB. Degrade-safe → fail-CLOSED posture (TASK-478): a
    # guardrail failure never ships an unmoderated PHI prompt — the verdict defaults
    # to NOT-allowed on a missing/malformed key, a sustained outage rejects with a
    # retryable 503 (vs a 422 content rejection), and if the enforce posture is on
    # (external_guardrail.enabled) but the client is unwired the gate fails closed
    # rather than silently skipping. The intentional dev/CI bypass (enabled=False —
    # the client short-circuits, or is simply absent) is preserved.
    if guardrail_client is not None:
        verdict = await guardrail_client.validate(
            prompt=request_body.prompt,
            system_prompt=request_body.system_prompt,
            tenant_id=x_tenant_id,
        )
        if not verdict.get("allowed", False):  # fail-closed default (missing key → reject)
            reason = verdict.get("reason", "not_allowed")
            # A sustained guardrail outage is retryable (503); a genuine content
            # rejection is a 422. Both fail CLOSED — generation never runs.
            status_code = 503 if reason == GUARDRAIL_UNAVAILABLE_REASON else 422
            raise HTTPException(
                status_code=status_code,
                detail=f"Content rejected by guardrail: {reason}",
            )
    elif settings.external_guardrail.enabled:
        # Enforce posture on but the guardrail client is unwired — fail CLOSED rather
        # than silently skip moderation (a misconfiguration must not ship unmoderated
        # PHI). Retryable (503) once the client is provisioned.
        raise HTTPException(
            status_code=503,
            detail="Content rejected by guardrail: external_guardrail_unavailable",
        )

    ctx = structlog.contextvars.get_contextvars()

    # D-7 (TASK-356): SMR is a stateless gateway with no default model. The
    # caller (API/harness) resolves and supplies the model on every request;
    # a missing/blank model fails closed with a 422 (no silent default).
    model = request_body.model
    if model is None or not model.strip():
        raise HTTPException(
            status_code=422,
            detail="Field 'model' is required: SMR has no default model.",
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
                    await queue.enqueue(priority=0, future=future, request_id=ctx.get("request_id", "unknown"))
                    QUEUE_SIZE.labels(provider=request_body.provider).set(queue.size)
                    await asyncio.wait_for(future, timeout=settings.queue.max_wait_s)
                    QUEUE_WAIT_TIME.labels(provider=request_body.provider).observe(time.monotonic() - queue_start)
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
        background_tasks.add_task(
            _run_streaming_generation,
            task_manager,
            provider,
            task.task_id,
            request_body,
            provider_name=request_body.provider,
            model=model,
            shutdown_manager=shutdown_manager,
            circuit_breakers=circuit_breakers,
        )
        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(UTC).isoformat(),
                provider=request_body.provider,
                model=model,
                status="streaming",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                latency_ms=0,
                finish_reason="streaming",
            )
        )
        return JSONResponse(
            status_code=202,
            content=StreamingGenerateResponse(
                task_id=task.task_id,
                status="running",
                stream_url=f"/api/v1/tasks/{task.task_id}/stream",
            ).model_dump(mode="json"),
        )

    _SEMAPHORE_ACQUIRE_TIMEOUT = 30.0

    semaphore = provider_semaphores.get(request_body.provider)
    if semaphore:
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=_SEMAPHORE_ACQUIRE_TIMEOUT)
        except TimeoutError:
            raise ConcurrencyLimitError(
                "Too many concurrent requests — try again later",
                provider=request_body.provider,
            ) from None
        CONCURRENT_REQUESTS.labels(provider=request_body.provider).inc()

    await task_manager.update_task(task.task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=request_body.provider).inc()
    # TASK-386 — cross-service per-model running gauge (e.g. gemma-4-e4b).
    MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=model).inc()
    start = time.monotonic()

    timeout_s = _get_provider_timeout(settings, request_body.provider)
    max_retries = request_body.retry_config.max_retries
    retry_on = request_body.retry_config.retry_on

    try:
        last_exc: Exception | None = None
        error_type = "provider_error"

        for attempt in range(max_retries + 1):
            try:
                content, usage = await asyncio.wait_for(
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

            backoff = calculate_backoff(attempt)
            logger.warning(
                "generation.retry",
                attempt=attempt + 1,
                max_retries=max_retries,
                backoff_s=round(backoff, 2),
                error_type=error_type,
                task_id=task.task_id,
            )
            await asyncio.sleep(backoff)

        if last_exc is not None:
            raise last_exc

        latency_ms = int((time.monotonic() - start) * 1000)
        total_tokens = usage.get("total_tokens", 0)
        await task_manager.update_task(task.task_id, status=TaskStatus.COMPLETED, total_tokens=total_tokens)

        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="completed").inc()
        GENERATION_LATENCY.labels(provider=request_body.provider, model=model).observe(latency_ms / 1000)
        # TASK-386 — cross-service per-model inference latency (for avg latency).
        MODEL_INFERENCE_LATENCY.labels(service=SERVICE_NAME, model=model).observe(latency_ms / 1000)
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="input").inc(usage.get("prompt_tokens", 0))
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="output").inc(usage.get("completion_tokens", 0))

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(UTC).isoformat(),
                provider=request_body.provider,
                model=model,
                status="completed",
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                total_tokens=total_tokens,
                latency_ms=latency_ms,
                finish_reason="stop",
            )
        )

        response = GenerateResponse(
            task_id=task.task_id,
            status="completed",
            content=content,
            provider=request_body.provider,
            model=model,
            usage=TokenUsage(
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                total_tokens=total_tokens,
            ),
            latency_ms=latency_ms,
            finish_reason="stop",
        )
        # C1-04 (TASK-469): cache the completed generation so a replayed request carrying the
        # same key returns THIS response instead of re-billing the model (bounded TTL). STRICTLY
        # best-effort and locally guarded: the model already ran and the task is COMPLETED, so a
        # cache-write failure (Redis OOM on a large SOAP note, a dropped connection) must NEVER
        # bubble into the outer ``except`` — that would discard a billed generation, record a
        # FALSE circuit-breaker failure, flip the task to FAILED, and return a 5xx the harness
        # retries (re-invoking the model = the very C1-04 double-bill this ticket closes). Swallow
        # it and return the response; the worst case degrades to "not cached" (documented residual).
        if cache_key is not None and redis_client is not None:
            try:
                await redis_client.set(cache_key, response.model_dump_json(), ex=_IDEMPOTENCY_TTL_S)
            except Exception as exc:
                logger.warning(
                    "generation.idempotency_cache_write_failed", task_id=task.task_id, error=str(exc)
                )
        return response
    except TimeoutError:
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error("generation.timeout_final", task_id=task.task_id, provider=request_body.provider, timeout_s=timeout_s)
        await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error="Request timed out")
        GENERATION_ERRORS.labels(provider=request_body.provider, model=model, error_type="timeout").inc()
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
            )
        )

        raise DomainProviderTimeoutError(
            f"Generation timed out after {timeout_s}s for provider '{request_body.provider}'.",
            provider=request_body.provider,
        ) from None
    except Exception as exc:
        if cb:
            cb.record_failure()
            _update_cb_metric(request_body.provider, cb)
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error("generation.failed", task_id=task.task_id, provider=request_body.provider, error=str(exc), exc_info=True)
        await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error=str(exc))
        GENERATION_ERRORS.labels(provider=request_body.provider, model=model, error_type="provider_error").inc()
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
            )
        )

        raise HTTPException(status_code=502, detail="Generation failed due to an internal error. Check server logs for details.") from exc
    finally:
        ACTIVE_GENERATIONS.labels(provider=request_body.provider).dec()
        MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=model).dec()
        if semaphore:
            CONCURRENT_REQUESTS.labels(provider=request_body.provider).dec()
            semaphore.release()
        if shutdown_manager:
            shutdown_manager.complete_task(task.task_id)


_CB_STATE_MAP = {
    CircuitState.CLOSED: 0,
    CircuitState.OPEN: 1,
    CircuitState.HALF_OPEN: 2,
}


def _update_cb_metric(provider_name: str, cb: CircuitBreaker) -> None:
    CIRCUIT_BREAKER_STATE.labels(provider=provider_name).set(_CB_STATE_MAP.get(cb.state, 0))


async def _run_streaming_generation(
    task_manager: TaskManager,
    provider: LLMProvider,
    task_id: str,
    request_body: GenerateRequest,
    *,
    provider_name: str = "unknown",
    model: str = "default",
    shutdown_manager: ShutdownManager | None = None,
    circuit_breakers: dict[str, CircuitBreaker] | None = None,
) -> None:
    from smr_v2.core.metrics import TTFT_SECONDS

    resolved_model = model or request_body.model
    resolved_provider = provider_name or request_body.provider
    await task_manager.update_task(task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=resolved_provider).inc()
    # TASK-386 — cross-service per-model running gauge (streaming path).
    MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=resolved_model).inc()
    start = time.monotonic()
    first_chunk_recorded = False
    total_input_tokens = 0
    total_output_tokens = 0
    try:
        async for chunk in provider.generate_stream(request_body):
            if not first_chunk_recorded:
                ttft = time.monotonic() - start
                TTFT_SECONDS.labels(provider=resolved_provider, model=resolved_model).observe(ttft)
                first_chunk_recorded = True
            if chunk.type == "usage" and isinstance(chunk.data, dict):
                total_input_tokens += chunk.data.get("prompt_tokens", 0)
                total_output_tokens += chunk.data.get("completion_tokens", 0)
            await task_manager.append_chunk(task_id, chunk)
        latency_ms = int((time.monotonic() - start) * 1000)
        await task_manager.update_task(task_id, status=TaskStatus.COMPLETED)
        GENERATION_TOTAL.labels(provider=resolved_provider, model=resolved_model, status="completed").inc()
        GENERATION_LATENCY.labels(provider=resolved_provider, model=resolved_model).observe(latency_ms / 1000)
        # TASK-386 — cross-service per-model inference latency (streaming path).
        MODEL_INFERENCE_LATENCY.labels(service=SERVICE_NAME, model=resolved_model).observe(latency_ms / 1000)
        if total_input_tokens or total_output_tokens:
            TOKENS_TOTAL.labels(provider=resolved_provider, model=resolved_model, direction="input").inc(total_input_tokens)
            TOKENS_TOTAL.labels(provider=resolved_provider, model=resolved_model, direction="output").inc(total_output_tokens)
        cb = (circuit_breakers or {}).get(resolved_provider)
        if cb:
            cb.record_success()
            _update_cb_metric(resolved_provider, cb)
    except Exception as exc:
        logger.error("streaming_generation.failed", task_id=task_id, error=str(exc), exc_info=True)
        await task_manager.update_task(task_id, status=TaskStatus.FAILED, error=str(exc))
        await task_manager.append_chunk(task_id, StreamChunk(type="error", data={"error": "Generation failed due to an internal error."}))
        GENERATION_ERRORS.labels(provider=resolved_provider, model=resolved_model, error_type="provider_error").inc()
        GENERATION_TOTAL.labels(provider=resolved_provider, model=resolved_model, status="failed").inc()
        cb = (circuit_breakers or {}).get(resolved_provider)
        if cb:
            cb.record_failure()
            _update_cb_metric(resolved_provider, cb)
    finally:
        ACTIVE_GENERATIONS.labels(provider=resolved_provider).dec()
        MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=resolved_model).dec()
        if shutdown_manager:
            shutdown_manager.complete_task(task_id)
