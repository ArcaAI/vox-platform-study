"""The streaming generation path — the producer half of the split.

( This module owns the provider socket and nothing else
owns it. It runs as a detached task registered with :class:`GenerationHub`, so:

* the HTTP response that started it is just the first subscriber, and killing it
  changes nothing here;
* deltas reach attached subscribers **before** anything durable happens, so the
  client's latency never waits on Redis;
* the durable write is coalesced into one ``XADD`` per batch (AC-5);
* the only thing that ends this loop early is an **explicit** cancel or a
  configured abandonment deadline — never a socket event.

The metering, audit and metric behaviour of the pre-split implementation is
preserved verbatim; only the delivery mechanism changed.
"""

from __future__ import annotations

import asyncio
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
from text.models.usage import build_usage_detail, engine_ms_from_stats, raw_usage_from_stats
from text.providers.base import LLMProvider
from text.providers.pool import ProviderByteCounts, count_provider_bytes
from text.routing.hub import BatchFlusher, GenerationEvent, GenerationPolicy, Producer
from text.routing.usage import _extract_stream_usage, funding_label
from text.services.circuit_breaker import CircuitBreaker, CircuitState
from text.services.external_guardrail import ExternalGuardrailClient
from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger
from text.services.output_gate import (
    OutputRejectedError,
    assemble_completion,
    gate_completion,
    source_context_of,
)
from text.services.retry_handler import (
    INVALID_REQUEST_ERROR_TYPE,
    RATE_LIMITED_CODE,
    RATE_LIMITED_ERROR_TYPE,
    is_provider_invalid_request,
    is_provider_rate_limited,
    provider_error_code_from,
)
from text.services.shutdown_manager import ShutdownManager
from text.services.task_manager import TaskManager

logger = get_logger(__name__)

__all__ = [
    "_CB_STATE_MAP",
    "_run_streaming_generation",
    "_update_cb_metric",
    "run_generation_producer",
]


_CB_STATE_MAP = {
    CircuitState.CLOSED: 0,
    CircuitState.OPEN: 1,
    CircuitState.HALF_OPEN: 2,
}

#: How often the persisted cancel flag and the abandonment deadline are
# re-checked. "Between batches" ( in wall-clock terms — bounded so a
#: cancel lands promptly, gated so a long generation does not cost one Redis read
#: per token.
_CONTROL_POLL_INTERVAL_S = 0.5


def _update_cb_metric(provider_name: str, cb: CircuitBreaker) -> None:
    CIRCUIT_BREAKER_STATE.labels(provider=provider_name).set(_CB_STATE_MAP.get(cb.state, 0))


async def run_generation_producer(
    producer: Producer,
    task_manager: TaskManager,
    provider: LLMProvider,
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
    connection_id: str | None = None,
    policy: GenerationPolicy | None = None,
    guardrail_client: ExternalGuardrailClient | None = None,
    guardrail_usage: dict[str, Any] | None = None,
    app_state: Any = None,
) -> None:
    """Drive one generation to its terminal frame. Never raises to the hub.

    ``guardrail_usage`` (TASK-959) is the INPUT gate's own spend, already
    measured by the route before this producer started, carried through onto the
    terminal frame. A streamed generation runs the same moderation call a
    blocking one does and burns the same guardrail tokens; the blocking response
    has always had a slot for them and the stream had none, so that spend simply
    never reached the billing plane. Passing it through is the whole fix — this
    producer never calls guardrail for usage, it only forwards what it was given.

    ``guardrail_client`` / ``app_state`` feed the post-receive gate
    (`services/output_gate.py`): the ASSEMBLED completion is screened after the
    provider stream ends and before the terminal frame. Both default to ``None``
    — the dev/CI bypass, and what every pre-existing caller gets — so an
    unwired producer behaves exactly as it did; the ``/generate`` route passes
    the live client and state.
    """
    generation_id = producer.generation_id
    resolved_model = model or request_body.model
    resolved_provider = provider_name or request_body.provider
    effective_policy = policy or GenerationPolicy()

    flusher = BatchFlusher(
        generation_id=generation_id,
        provider=resolved_provider,
        write=lambda batch: task_manager.append_batch(
            generation_id, batch, tenant_id=tenant_id, correlation_id=request_id
        ),
    )
    flush_task = asyncio.create_task(flusher.run(), name=f"text-flush-{generation_id}")

    def emit(chunk: StreamChunk) -> None:
        """Publish one delta: subscribers first, durability second.

        The wire JSON is built exactly once here and reused by every subscriber
        and by the durable write — the single encode that replaces the two JSON
        passes and two pydantic validations the per-chunk path spent per token.
        """
        event = GenerationEvent(
            seq=producer.next_seq(), event=chunk.type, payload=chunk.model_dump_json()
        )
        producer.publish(event)
        flusher.offer(event)

    async def emit_terminal(chunk: StreamChunk) -> None:
        """Publish the terminal frame and make it durable **immediately**.

        Deliberately NOT coalesced. Coalescing exists to amortise a per-token
        cost and there is exactly one of these per generation; meanwhile it
        carries the usage block the gateway meters from, so it wants its own
        envelope and its own idempotency key, and a client reconnecting the
        instant it sees ``done`` must find it already in the buffer.

        Written after the coalescer has drained, so the replay order is deltas
        then terminal — which is also what makes its sequence number line up:
        the batch entries carry seqs 1..N explicitly, and this entry lands at
        N+1 from both sides.
        """
        flusher.close()
        try:
            await flush_task
        except Exception as exc:  # noqa: BLE001 — durability is best-effort
            logger.warning(
                "streaming_generation.flush_drain_failed",
                generation_id=generation_id,
                error=str(exc),
            )
        event = GenerationEvent(
            seq=producer.next_seq(), event=chunk.type, payload=chunk.model_dump_json()
        )
        producer.publish(event)
        await task_manager.append_chunk(
            generation_id, chunk, tenant_id=tenant_id, correlation_id=request_id
        )

    await task_manager.update_task(generation_id, status=TaskStatus.RUNNING)
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
    stopped_reason: str | None = None
    next_control_poll = start + _CONTROL_POLL_INTERVAL_S
    # The provider's own ``done`` frame, held back so the usage block can be
    # folded into it. The SSE reader STOPS at the first ``done``/``error``, so a
    # usage frame appended after one would never be delivered.
    pending_done: StreamChunk | None = None
    # What the consumer has SEEN, for the post-receive gate. Deltas are
    # published live and cannot be recalled, so the verdict is on the assembled
    # text at end-of-stream — and on an early-stopped partial, which was
    # delivered too.
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    # TASK-959 — what the provider socket consumed, and what the engine said it
    # spent. Both are assigned inside the streaming block below and read from
    # here by `_usage_detail`, which the abort arm also calls after that block
    # has exited.
    byte_counts: ProviderByteCounts | None = None
    engine_ms: int | None = None

    def _usage_detail(*, interrupted: bool, total_ms: int | None = None) -> dict[str, Any]:
        """The block the gateway meters from, as of NOW.

        ``total_ms`` defaults to the elapsed time at the moment of the call,
        which is what the abort and rejection arms want; the clean terminal frame
        passes the same ``latency_ms`` its stats and its audit event carry, so all
        three agree.
        """
        return build_usage_detail(
            task_id=generation_id,
            request_id=request_id,
            provider=resolved_provider,
            model=resolved_model or "",
            prompt_tokens=total_input_tokens,
            completion_tokens=total_output_tokens,
            total_tokens=reported_total_tokens,
            raw=raw_usage,
            interrupted=interrupted,
            byok=byok,
            connection_id=connection_id,
            total_ms=(total_ms if total_ms is not None else int((time.monotonic() - start) * 1000)),
            engine_ms=engine_ms,
            request_bytes=(
                byte_counts.request_bytes
                if byte_counts is not None and byte_counts.observed
                else None
            ),
            response_bytes=(
                byte_counts.response_bytes
                if byte_counts is not None and byte_counts.observed
                else None
            ),
        ).model_dump(mode="json")

    def _terminal_data(data: dict[str, Any]) -> dict[str, Any]:
        """`data` plus the safety plane's own spend, when there was any.

        Omitted when absent rather than sent as an empty object: a zero row is
        indistinguishable from a free call, and a generation whose tenant opted
        out of moderation legitimately has no guardrail spend at all.
        """
        if guardrail_usage is not None:
            data["guardrail_usage"] = guardrail_usage
        return data

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

    async def _should_stop() -> str | None:
        """Explicit cancel, or a configured deadline. Never a socket state.

        Polled on a wall-clock gate rather than per delta: the in-memory flag is
        free and is what a same-pod cancel sets, the persisted flag costs one
        Redis read per :data:`_CONTROL_POLL_INTERVAL_S` and is what makes a
        cancel work across pods.
        """
        nonlocal next_control_poll
        if producer.cancelled:
            return "cancelled"
        now = time.monotonic()
        if now < next_control_poll:
            return None
        next_control_poll = now + _CONTROL_POLL_INTERVAL_S
        try:
            if await task_manager.is_cancel_requested(generation_id):
                producer.request_cancel()
                return "cancelled"
        except Exception as exc:  # noqa: BLE001 — a flag-store blip must not kill a generation
            logger.warning(
                "streaming_generation.cancel_probe_failed",
                generation_id=generation_id,
                error=str(exc),
            )
        return producer.should_abandon(effective_policy, now)

    try:
        # TASK-959 M-4 — count bytes for exactly as long as the provider socket
        # is open. The record is assigned to the enclosing scope so the terminal
        # frame (and the abort arm below, which runs after this block has exited)
        # still reads what the stream actually consumed: the binding ends here,
        # the record does not.
        with count_provider_bytes(resolved_provider, funding=funding_label(byok)) as counted_bytes:
            byte_counts = counted_bytes
            async for chunk in provider.generate_stream(request_body):
                if not first_chunk_recorded:
                    ttft = time.monotonic() - start
                    TTFT_SECONDS.labels(provider=resolved_provider, model=resolved_model).observe(
                        ttft
                    )
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
                    # The engine's OWN time, where the engine reports one. It
                    # rides on the same chunk's `engine_native`, which is the
                    # only place a native timing survives into the stream.
                    # An explicit None check, not `or`: a genuine 0 ms (a
                    # one-token completion, rounded) is an observation.
                    reported_engine_ms = engine_ms_from_stats(chunk.data)
                    if reported_engine_ms is not None:
                        engine_ms = reported_engine_ms
                if chunk.type == "done":
                    if isinstance(chunk.data, dict):
                        stream_finish_reason = (
                            chunk.data.get("finish_reason") or stream_finish_reason
                        )
                    # Hold it back; it is re-emitted below carrying the usage block.
                    pending_done = chunk
                    continue
                if chunk.content:
                    if chunk.type == "chunk":
                        content_parts.append(chunk.content)
                    elif chunk.type == "reasoning":
                        reasoning_parts.append(chunk.content)
                emit(chunk)

                stopped_reason = await _should_stop()
                if stopped_reason:
                    logger.info(
                        "streaming_generation.stopped_early",
                        generation_id=generation_id,
                        reason=stopped_reason,
                    )
                    break

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
            logger.warning(
                "streaming_generation.stats_degraded",
                generation_id=generation_id,
                error=str(exc),
            )

        # Post-receive guardrail gate (TASK-871). Screens what was delivered —
        # content and reasoning, assembled — before the terminal frame decides
        # whether this generation is a result. On rejection the terminal frame
        # is ``error`` (every consumer discards on it), the task record is
        # FAILED with a ``guardrail_rejected:`` error, and the breaker is NOT
        # tripped: a refused completion is not provider unhealth.
        try:
            await gate_completion(
                guardrail_client,
                completion=assemble_completion("".join(content_parts), "".join(reasoning_parts)),
                source_context=source_context_of(request_body),
                tenant_id=tenant_id,
                tenant_policy=request_body.guardrail_policy,
                app_state=app_state,
                where="streaming.run_generation_producer",
            )
        except OutputRejectedError as rejected:
            logger.warning(
                "streaming_generation.rejected_by_guardrail",
                generation_id=generation_id,
                code=rejected.code,
                reason=rejected.reason,
                retryable=rejected.retryable,
            )
            await emit_terminal(
                StreamChunk(
                    type="error",
                    data=_terminal_data(
                        rejected.terminal_data(
                            usage=_usage_detail(
                                interrupted=bool(stopped_reason), total_ms=latency_ms
                            )
                        )
                    ),
                )
            )
            await task_manager.update_task(
                generation_id, status=TaskStatus.FAILED, error=rejected.task_error
            )
            GENERATION_ERRORS.labels(
                provider=resolved_provider, model=resolved_model, error_type="guardrail_rejected"
            ).inc()
            GENERATION_TOTAL.labels(
                provider=resolved_provider, model=resolved_model, status="rejected"
            ).inc()
            _log_audit(
                status="rejected",
                latency_ms=latency_ms,
                finish_reason="guardrail_rejected",
                error=rejected.task_error,
            )
            return

        # The terminal frame, carrying the usage block the gateway meters from.
        # A provider that emitted no ``done`` of its own still gets one, so the
        # frame the gateway keys on is always present. An early stop is terminal
        # too — the tokens it already burned are reported, never dropped.
        done_data: dict[str, Any] = dict(
            pending_done.data if pending_done and isinstance(pending_done.data, dict) else {}
        )
        done_data.setdefault("finish_reason", stopped_reason or stream_finish_reason or "stop")
        if stopped_reason:
            done_data["stopped_reason"] = stopped_reason
        terminal_usage_detail = _usage_detail(interrupted=bool(stopped_reason), total_ms=latency_ms)
        done_data["usage"] = terminal_usage_detail
        await emit_terminal(StreamChunk(type="done", data=_terminal_data(done_data)))

        terminal_status = TaskStatus.CANCELLED if stopped_reason else TaskStatus.COMPLETED
        # TASK-890 — persist WHAT was generated and WHAT it cost, not only that it finished.
        # `GET /tasks/{id}` is how a gateway bench finalizes (it never trusts the browser to hand
        # the text back), and until this line it answered `content: null` / `usage: null` for
        # every completed generation, so a prompt-bench run scored an empty string and metered
        # nothing. The bytes are the ones already in the task's chunk stream, under the same TTL.
        await task_manager.update_task(
            generation_id,
            status=terminal_status,
            content="".join(content_parts),
            usage={
                "prompt_tokens": total_input_tokens,
                "completion_tokens": total_output_tokens,
                "total_tokens": total_input_tokens + total_output_tokens,
            },
            # J3-4 — the SAME block the terminal frame just carried. A bench that
            # finalizes by reading the task back needs the meterable form, not three
            # counts: without an `endpoint_kind` the gateway ledger records nothing
            # rather than guess an arithmetic convention.
            usage_detail=terminal_usage_detail,
        )
        GENERATION_TOTAL.labels(
            provider=resolved_provider,
            model=resolved_model,
            status="cancelled" if stopped_reason else "completed",
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
            status="cancelled" if stopped_reason else "completed",
            latency_ms=latency_ms,
            finish_reason=stopped_reason or stream_finish_reason or "stop",
            error=None,
        )
    except Exception as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        # D5: this route has no retry loop of its own (a provider generator
        # either yields or raises once), so "no retry on a deterministic
        # 4xx" already holds — the fix here is the terminal frame's `code`,
        # so a rejected-for-context-size stream reads the same as the
        # blocking `/generate` 422 instead of the opaque "internal error"
        # every other provider failure gets.
        # D-5 (TASK-993): this producer shares the `circuit_breakers` dict with
        # the blocking `/generate` route, so a vendor 429 counted here would
        # open the very breaker that route just declined to open — and the
        # clinical planes stream. Same three-way verdict, same `RATE_LIMITED`
        # token on the frame as the blocking 429's `error_code`, so a client
        # reads one vocabulary whichever way it asked for the generation.
        is_rate_limited = is_provider_rate_limited(exc)
        is_invalid_request = is_provider_invalid_request(exc)
        if is_rate_limited:
            error_type, code = RATE_LIMITED_ERROR_TYPE, RATE_LIMITED_CODE
        elif is_invalid_request:
            error_type, code = INVALID_REQUEST_ERROR_TYPE, provider_error_code_from(exc)
        else:
            error_type, code = "provider_error", None
        logger.error(
            "streaming_generation.failed",
            generation_id=generation_id,
            error=str(exc),
            error_type=error_type,
            code=code,
            exc_info=True,
        )
        await task_manager.update_task(generation_id, status=TaskStatus.FAILED, error=str(exc))
        # The interrupted stream still burned whatever tokens it had already
        # reported — emit them. Dropping the tail here is the bug
        # class: the provider bills for work whose only record we threw away.
        # The block carries the SAME id a clean completion would, so the
        # gateway's idempotency key converges instead of double-billing.
        if is_rate_limited:
            # A FIXED sentence, matching the blocking route's 429 body: the
            # vendor's own text can quote the prompt.
            error_message = "The upstream model provider is rate limiting this request."
        elif is_invalid_request:
            error_message = str(exc)
        else:
            error_message = "Generation failed due to an internal error."
        error_data: dict[str, Any] = {
            "error": error_message,
            "usage": _usage_detail(interrupted=True, total_ms=latency_ms),
        }
        if code is not None:
            error_data["code"] = code
        await emit_terminal(StreamChunk(type="error", data=_terminal_data(error_data)))
        _log_audit(
            status="failed",
            latency_ms=latency_ms,
            finish_reason="error",
            error=str(exc),
        )
        GENERATION_ERRORS.labels(
            provider=resolved_provider, model=resolved_model, error_type=error_type
        ).inc()
        GENERATION_TOTAL.labels(
            provider=resolved_provider, model=resolved_model, status="failed"
        ).inc()
        cb = (circuit_breakers or {}).get(resolved_provider)
        if cb:
            cb.record_failure(is_rate_limit=is_rate_limited)
            _update_cb_metric(resolved_provider, cb)
    finally:
        # ``emit_terminal`` normally drains the coalescer; this covers the paths
        # that never reached one (a cancellation propagating in, say). Both are
        # idempotent, so draining twice is free.
        flusher.close()
        if not flush_task.done():
            try:
                await flush_task
            except Exception as exc:  # noqa: BLE001 — durability is best-effort
                logger.warning(
                    "streaming_generation.flush_drain_failed",
                    generation_id=generation_id,
                    error=str(exc),
                )
        producer.finish()
        ACTIVE_GENERATIONS.labels(provider=resolved_provider).dec()
        MODEL_RUNNING_INSTANCES.labels(service=SERVICE_NAME, model=resolved_model).dec()
        if shutdown_manager:
            shutdown_manager.complete_task(generation_id)


async def _run_streaming_generation(
    task_manager: TaskManager,
    provider: LLMProvider,
    task_id: str,
    request_body: GenerateRequest,
    **kwargs: Any,
) -> None:
    """Run one generation to completion with **no hub and no subscribers**.

    The producer body does not require a hub — a hub only decides who can watch.
    This entry point runs it standalone and awaits it, which is what a caller
    that just wants the generation performed (and its terminal frame persisted)
    actually needs. Retained under its pre-split name and signature because that
    is exactly its contract.
    """
    producer = Producer(task_id, provider=kwargs.get("provider_name") or "unknown")
    await run_generation_producer(producer, task_manager, provider, request_body, **kwargs)
