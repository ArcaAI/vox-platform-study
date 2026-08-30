"""The streaming generation path.

Moved verbatim from `api/endpoints/generate.py` (TASK-818 Wave 0.4). This is the
concern TASK-818 Lane B owns: today it produces one Redis entry per chunk, and
the resumable-streaming design (§3C) restructures it into a producer that
outlives the response with coalesced durable writes. Isolating it here means
that work no longer collides with every other change to the generate endpoint.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from text.core.logging import get_logger
from text.core.metrics import (
    ACTIVE_GENERATIONS,
    CIRCUIT_BREAKER_STATE,
    GENERATION_ERRORS,
    GENERATION_LATENCY,
    GENERATION_TOTAL,
    MODEL_INFERENCE_LATENCY,
    MODEL_RUNNING_INSTANCES,
    SERVICE_NAME,
    STOP_REASON_TOTAL,
    TOKENS_PER_SECOND,
    TOKENS_TOTAL,
    TTFT_SECONDS,
)
from text.models.requests import GenerateRequest
from text.models.stats import build_generation_stats
from text.models.stream import StreamChunk
from text.models.task import TaskStatus
from text.models.usage import build_usage_detail, raw_usage_from_stats
from text.providers.base import LLMProvider
from text.routing.usage import _extract_stream_usage
from text.services.circuit_breaker import CircuitBreaker, CircuitState
from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger
from text.services.shutdown_manager import ShutdownManager
from text.services.task_manager import TaskManager

logger = get_logger(__name__)

__all__ = ["_CB_STATE_MAP", "_run_streaming_generation", "_update_cb_metric"]


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
    generation_audit: GenerationAuditLogger | None = None,
    tenant_id: str | None = None,
    request_id: str | None = None,
    byok: bool = False,
) -> None:

    resolved_model = model or request_body.model
    resolved_provider = provider_name or request_body.provider
    await task_manager.update_task(task_id, status=TaskStatus.RUNNING)
    ACTIVE_GENERATIONS.labels(provider=resolved_provider).inc()
    # Cross-service per-model running gauge (streaming path).
    MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=resolved_model).inc()
    start = time.monotonic()
    first_chunk_recorded = False
    ttft_ms: int | None = None
    total_input_tokens = 0
    total_output_tokens = 0
    reported_total_tokens: int | None = None
    raw_usage: dict[str, Any] | None = None
    stream_finish_reason: str | None = None
    # The provider's own ``done`` frame, held back so the usage block can be
    # folded into it. The SSE reader STOPS at the first ``done``/``error``, so a
    # usage frame appended after one would never be delivered.
    pending_done: StreamChunk | None = None

    def _usage_detail(*, interrupted: bool) -> dict[str, Any]:
        return build_usage_detail(
            task_id=task_id,
            request_id=request_id,
            provider=resolved_provider,
            model=resolved_model or "",
            prompt_tokens=total_input_tokens,
            completion_tokens=total_output_tokens,
            total_tokens=reported_total_tokens,
            raw=raw_usage,
            interrupted=interrupted,
            byok=byok,
        ).model_dump(mode="json")

    def _log_audit(*, status: str, latency_ms: int, finish_reason: str, error: str | None) -> None:
        """Log the generation's REAL totals, once, when the stream has ended."""
        if generation_audit is None:
            return
        generation_audit.log_generation(
            GenerationAuditEvent(
                request_id=request_id or "unknown",
                timestamp=datetime.now(UTC).isoformat(),
                provider=resolved_provider,
                model=resolved_model or "",
                status=status,
                prompt_tokens=total_input_tokens,
                completion_tokens=total_output_tokens,
                total_tokens=(
                    reported_total_tokens
                    if reported_total_tokens is not None
                    else total_input_tokens + total_output_tokens
                ),
                latency_ms=latency_ms,
                finish_reason=finish_reason,
                error=error,
                tenant_id=tenant_id,
            )
        )

    try:
        async for chunk in provider.generate_stream(request_body):
            if not first_chunk_recorded:
                ttft = time.monotonic() - start
                TTFT_SECONDS.labels(provider=resolved_provider, model=resolved_model).observe(ttft)
                ttft_ms = int(ttft * 1000)
                first_chunk_recorded = True
            if chunk.type == "usage" and isinstance(chunk.data, dict):
                # TAKE-LAST, never sum. Anthropic restates its usage cumulatively
                # on every ``message_delta``, so summing multiplies the bill by
                # the number of deltas; every other provider reports usage
                # exactly once, for which take-last is identical to summing.
                prompt, completion, total = _extract_stream_usage(chunk.data)
                total_input_tokens = prompt
                total_output_tokens = completion
                reported_total_tokens = total
                raw_usage = raw_usage_from_stats(chunk.data) or raw_usage
            if chunk.type == "done":
                if isinstance(chunk.data, dict):
                    stream_finish_reason = chunk.data.get("finish_reason") or stream_finish_reason
                # Hold it back; it is re-emitted below carrying the usage block.
                pending_done = chunk
                continue
            await task_manager.append_chunk(task_id, chunk)
        latency_ms = int((time.monotonic() - start) * 1000)
        # stamp normalized stop-reason + decode-throughput fleet
        # metrics from the streamed native finish reason / token counts. Never
        # allowed to fail the stream (best-effort telemetry).
        try:
            stream_stats = build_generation_stats(
                provider=resolved_provider,
                model=resolved_model or "",
                raw_stop_reason=stream_finish_reason or "stop",
                prompt_tokens=total_input_tokens,
                predicted_tokens=total_output_tokens,
                total_ms=latency_ms,
                ttft_ms=ttft_ms,
            )
            if stream_stats.tokens_per_second is not None:
                TOKENS_PER_SECOND.labels(provider=resolved_provider, model=resolved_model).observe(
                    stream_stats.tokens_per_second
                )
            STOP_REASON_TOTAL.labels(
                provider=resolved_provider,
                model=resolved_model,
                stop_reason=stream_stats.stop_reason,
            ).inc()
        except Exception as exc:  # noqa: BLE001 — telemetry must never fail the stream
            logger.warning("streaming_generation.stats_degraded", task_id=task_id, error=str(exc))

        # The terminal frame, carrying the usage block the gateway meters from.
        # A provider that emitted no ``done`` of its own still gets one, so the
        # frame the gateway keys on is always present.
        done_data: dict[str, Any] = dict(
            pending_done.data if pending_done and isinstance(pending_done.data, dict) else {}
        )
        done_data.setdefault("finish_reason", stream_finish_reason or "stop")
        done_data["usage"] = _usage_detail(interrupted=False)
        await task_manager.append_chunk(task_id, StreamChunk(type="done", data=done_data))

        await task_manager.update_task(task_id, status=TaskStatus.COMPLETED)
        GENERATION_TOTAL.labels(
            provider=resolved_provider, model=resolved_model, status="completed"
        ).inc()
        GENERATION_LATENCY.labels(provider=resolved_provider, model=resolved_model).observe(
            latency_ms / 1000
        )
        # Cross-service per-model inference latency (streaming path).
        MODEL_INFERENCE_LATENCY.labels(service=SERVICE_NAME, model=resolved_model).observe(
            latency_ms / 1000
        )
        if total_input_tokens or total_output_tokens:
            TOKENS_TOTAL.labels(
                provider=resolved_provider, model=resolved_model, direction="input"
            ).inc(total_input_tokens)
            TOKENS_TOTAL.labels(
                provider=resolved_provider, model=resolved_model, direction="output"
            ).inc(total_output_tokens)
        cb = (circuit_breakers or {}).get(resolved_provider)
        if cb:
            cb.record_success()
            _update_cb_metric(resolved_provider, cb)
        _log_audit(
            status="completed",
            latency_ms=latency_ms,
            finish_reason=stream_finish_reason or "stop",
            error=None,
        )
    except Exception as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        logger.error("streaming_generation.failed", task_id=task_id, error=str(exc), exc_info=True)
        await task_manager.update_task(task_id, status=TaskStatus.FAILED, error=str(exc))
        # The interrupted stream still burned whatever tokens it had already
        # reported — emit them. Dropping the tail here is the bug
        # class: the provider bills for work whose only record we threw away.
        # The block carries the SAME ``task_id`` a clean completion would, so the
        # gateway's idempotency key converges instead of double-billing.
        await task_manager.append_chunk(
            task_id,
            StreamChunk(
                type="error",
                data={
                    "error": "Generation failed due to an internal error.",
                    "usage": _usage_detail(interrupted=True),
                },
            ),
        )
        _log_audit(
            status="failed",
            latency_ms=latency_ms,
            finish_reason="error",
            error=str(exc),
        )
        GENERATION_ERRORS.labels(
            provider=resolved_provider, model=resolved_model, error_type="provider_error"
        ).inc()
        GENERATION_TOTAL.labels(
            provider=resolved_provider, model=resolved_model, status="failed"
        ).inc()
        cb = (circuit_breakers or {}).get(resolved_provider)
        if cb:
            cb.record_failure()
            _update_cb_metric(resolved_provider, cb)
    finally:
        ACTIVE_GENERATIONS.labels(provider=resolved_provider).dec()
        MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=resolved_model).dec()
        if shutdown_manager:
            shutdown_manager.complete_task(task_id)
