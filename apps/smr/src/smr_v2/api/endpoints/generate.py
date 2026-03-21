"""Text generation endpoint."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse

import structlog.contextvars

from smr_v2.core.dependencies import (
    get_audit_logger,
    get_circuit_breakers,
    get_generation_audit_logger,
    get_guardrail_scanner,
    get_provider_queues,
    get_provider_registry,
    get_provider_semaphores,
    get_rate_limiters,
    get_settings as get_dep_settings,
    get_shutdown_manager,
    get_task_manager,
)
from smr_v2.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ContentBlockedError,
    ProviderError as DomainProviderError,
    ProviderNotFoundError as DomainProviderNotFoundError,
    ProviderTimeoutError as DomainProviderTimeoutError,
    QueueFullError as DomainQueueFullError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
)
from smr_v2.core.logging import get_logger
from smr_v2.core.metrics import (
    ACTIVE_GENERATIONS,
    CIRCUIT_BREAKER_STATE,
    CONCURRENT_REQUESTS,
    GENERATION_ERRORS,
    GENERATION_LATENCY,
    GENERATION_TOTAL,
    GUARDRAIL_SCANS,
    QUEUE_SIZE,
    QUEUE_WAIT_TIME,
    RATE_LIMIT_REJECTIONS,
    TOKENS_TOTAL,
)
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.responses import ErrorResponse, GenerateResponse, StreamingGenerateResponse, TokenUsage
from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskStatus
from smr_v2.providers.base import ProviderNotFoundError, ProviderRegistry
from smr_v2.core.config import Settings
from smr_v2.services.audit import GuardrailAuditEvent, GuardrailAuditLogger
from smr_v2.services.circuit_breaker import CircuitBreaker, CircuitState
from smr_v2.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger
from smr_v2.services.guardrails import PromptInjectionScanner
from smr_v2.services.provider_queue import ProviderQueue, QueueFullError
from smr_v2.services.rate_limiter import RateLimitTracker, estimate_tokens
from smr_v2.services.retry_handler import calculate_backoff, should_retry
from smr_v2.services.shutdown_manager import ShutdownManager
from smr_v2.services.task_manager import TaskManager

logger = get_logger(__name__)

_DEFAULT_TIMEOUT_S = 120.0


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
    scanner: PromptInjectionScanner = Depends(get_guardrail_scanner),
    audit_logger: GuardrailAuditLogger = Depends(get_audit_logger),
    generation_audit: GenerationAuditLogger = Depends(get_generation_audit_logger),
    rate_limiters: dict[str, RateLimitTracker] = Depends(get_rate_limiters),
    circuit_breakers: dict[str, CircuitBreaker] = Depends(get_circuit_breakers),
    shutdown_manager: ShutdownManager | None = Depends(get_shutdown_manager),
    provider_queues: dict[str, ProviderQueue] = Depends(get_provider_queues),
    provider_semaphores: dict[str, asyncio.Semaphore] = Depends(get_provider_semaphores),
    settings: Settings = Depends(get_dep_settings),
) -> Any:
    if shutdown_manager and shutdown_manager.is_shutting_down:
        raise ShutdownError("Service is shutting down — not accepting new requests.")

    scan_start = time.monotonic()
    scan_result = scanner.scan(request_body.prompt)
    if request_body.system_prompt:
        system_scan = scanner.scan(request_body.system_prompt)
        scan_result = scan_result.merge(system_scan)
    scan_duration_ms = (time.monotonic() - scan_start) * 1000

    blocked = (
        scan_result.is_suspicious
        and scanner.mode == "block"
        and scan_result.risk_level in ("medium", "high")
    )

    if blocked:
        action = "blocked"
    elif scan_result.is_suspicious:
        action = "logged"
    else:
        action = "allowed"

    GUARDRAIL_SCANS.labels(result=action, risk_level=scan_result.risk_level).inc()

    ctx = structlog.contextvars.get_contextvars()
    model = request_body.model or "default"

    audit_logger.log_scan(
        GuardrailAuditEvent(
            request_id=ctx.get("request_id", "unknown"),
            timestamp=datetime.now(timezone.utc).isoformat(),
            guardrail_type="prompt_injection_scan",
            action=action,
            is_suspicious=scan_result.is_suspicious,
            risk_level=scan_result.risk_level,
            matched_patterns=scan_result.matched_patterns,
            provider=request_body.provider,
            model=model,
            scan_duration_ms=round(scan_duration_ms, 3),
        )
    )

    if scan_result.is_suspicious:
        logger.warning(
            "guardrail.prompt_injection_detected",
            matched_patterns=scan_result.matched_patterns,
            risk_level=scan_result.risk_level,
            mode=scanner.mode,
        )
        if blocked:
            GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="blocked").inc()
            raise ContentBlockedError("Request blocked by content safety filter.")

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
                except asyncio.TimeoutError:
                    QUEUE_SIZE.labels(provider=request_body.provider).set(queue.size)
                    RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider).inc()
                    raise QueueTimeoutError(
                        "Request queued but timed out waiting for capacity",
                        provider=request_body.provider,
                    )
                except QueueFullError:
                    RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider).inc()
                    raise DomainQueueFullError(
                        "Rate limit exceeded and queue is full",
                        provider=request_body.provider,
                    )
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
        )

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
        )
        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(timezone.utc).isoformat(),
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
        except asyncio.TimeoutError:
            raise ConcurrencyLimitError(
                "Too many concurrent requests — try again later",
                provider=request_body.provider,
            )
        CONCURRENT_REQUESTS.labels(provider=request_body.provider).inc()

    await task_manager.update_task(task.task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=request_body.provider).inc()
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
            except asyncio.TimeoutError as exc:
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
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="input").inc(usage.get("prompt_tokens", 0))
        TOKENS_TOTAL.labels(provider=request_body.provider, model=model, direction="output").inc(usage.get("completion_tokens", 0))

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(timezone.utc).isoformat(),
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

        return GenerateResponse(
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
    except asyncio.TimeoutError:
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error("generation.timeout_final", task_id=task.task_id, provider=request_body.provider, timeout_s=timeout_s)
        await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error="Request timed out")
        GENERATION_ERRORS.labels(provider=request_body.provider, model=model, error_type="timeout").inc()
        GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="failed").inc()

        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=ctx.get("request_id", "unknown"),
                timestamp=datetime.now(timezone.utc).isoformat(),
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
        )
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
                timestamp=datetime.now(timezone.utc).isoformat(),
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

        raise HTTPException(status_code=502, detail="Generation failed due to an internal error. Check server logs for details.")
    finally:
        ACTIVE_GENERATIONS.labels(provider=request_body.provider).dec()
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
    task_manager,
    provider,
    task_id: str,
    request_body: GenerateRequest,
    *,
    provider_name: str = "unknown",
    model: str = "default",
    shutdown_manager: ShutdownManager | None = None,
):
    from smr_v2.core.metrics import TTFT_SECONDS

    resolved_model = model or request_body.model or "default"
    resolved_provider = provider_name or request_body.provider
    await task_manager.update_task(task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=resolved_provider).inc()
    start = time.monotonic()
    first_chunk_recorded = False
    try:
        async for chunk in provider.generate_stream(request_body):
            if not first_chunk_recorded:
                ttft = time.monotonic() - start
                TTFT_SECONDS.labels(provider=resolved_provider, model=resolved_model).observe(ttft)
                first_chunk_recorded = True
            await task_manager.append_chunk(task_id, chunk)
        latency_ms = int((time.monotonic() - start) * 1000)
        await task_manager.update_task(task_id, status=TaskStatus.COMPLETED)
        GENERATION_TOTAL.labels(provider=resolved_provider, model=resolved_model, status="completed").inc()
        GENERATION_LATENCY.labels(provider=resolved_provider, model=resolved_model).observe(latency_ms / 1000)
    except Exception as exc:
        logger.error("streaming_generation.failed", task_id=task_id, error=str(exc), exc_info=True)
        await task_manager.update_task(task_id, status=TaskStatus.FAILED, error=str(exc))
        await task_manager.append_chunk(task_id, StreamChunk(type="error", data={"error": "Generation failed due to an internal error."}))
        GENERATION_ERRORS.labels(provider=resolved_provider, model=resolved_model, error_type="provider_error").inc()
        GENERATION_TOTAL.labels(provider=resolved_provider, model=resolved_model, status="failed").inc()
    finally:
        ACTIVE_GENERATIONS.labels(provider=resolved_provider).dec()
        if shutdown_manager:
            shutdown_manager.complete_task(task_id)
