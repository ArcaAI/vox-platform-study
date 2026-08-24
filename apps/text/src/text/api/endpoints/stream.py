"""SSE streaming endpoint for consuming task chunks."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from hope_async_contract import RESUME_FROM_BEGINNING, decode_resume_token, encode_resume_token
from hope_otel.trace_propagation import extract_trace_context, inject_trace_carrier
from opentelemetry import context as context_api
from sse_starlette.sse import EventSourceResponse

from text.core.dependencies import get_task_manager
from text.models.task import TaskStatus
from text.services.task_manager import TaskManager

router = APIRouter(tags=["stream"])

# TASK-717: the resume-token transport tag for this SSE path's Redis Streams cursor.
_RESUME_TRANSPORT = "redis-stream"


def _cursor_from_last_event_id(last_event_id: str) -> str:
    """Decode a TASK-717 resume token; fall back to the raw value during rollout.

    A caller storing an OLD raw Redis message id (or the `0-0` sentinel) as its
    `Last-Event-ID` still resumes correctly — only a well-formed opaque token is
    decoded, everything else is passed through as the Redis cursor it already is.
    """
    decoded = decode_resume_token(last_event_id)
    return decoded["cursor"] if decoded else last_event_id


@router.get("/tasks/{task_id}/stream")
async def stream_task(
    task_id: str,
    request: Request,
    last_event_id: str | None = None,
    task_manager: TaskManager = Depends(get_task_manager),
) -> EventSourceResponse:
    """SSE endpoint — streams chunks from Redis Streams with resume support.

    Uses XREAD BLOCK for efficient waiting instead of polling.
    Each SSE event includes the Redis stream message ID for resume support.
    """
    state = await task_manager.get_task(task_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")

    raw_last_event_id = (
        last_event_id or request.headers.get("last-event-id") or RESUME_FROM_BEGINNING
    )
    cursor_start = _cursor_from_last_event_id(raw_last_event_id)

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        cursor = cursor_start
        while True:
            if await request.is_disconnected():
                break

            entries = await task_manager.read_chunk_entries_blocking(
                task_id, last_id=cursor, block_ms=5000
            )

            for msg_id, chunk, carrier in entries:
                cursor = msg_id
                # Relay each chunk under the trace context of
                # the GENERATION that produced it, not this SSE request's. The
                # two are separate HTTP requests — without this, the work of
                # emitting a chunk (and every log line it writes, via
                # LoggingInstrumentor's trace-id injection) is disconnected from
                # the generation it belongs to. `None` when the producer was
                # untraced, in which case this is a plain yield.
                producer_context = extract_trace_context(carrier)
                token = (
                    context_api.attach(producer_context) if producer_context is not None else None
                )
                try:
                    yield {
                        "event": chunk.type,
                        "data": chunk.model_dump_json(),
                        "id": encode_resume_token(_RESUME_TRANSPORT, msg_id),
                    }
                finally:
                    if token is not None:
                        context_api.detach(token)
                if chunk.type in ("done", "error"):
                    return

            if not entries:
                current = await task_manager.get_task(task_id)
                if current and current.status in (
                    TaskStatus.COMPLETED,
                    TaskStatus.FAILED,
                    TaskStatus.CANCELLED,
                ):
                    return

    # W3C Trace Context Level 2 `traceresponse`. SSE is
    # one-way once open, so this header is the ONLY point at which the server
    # can tell the caller which trace served the stream. The API Gateway's SSE
    # proxy relays raw chunks, so without it a caller correlating a long-lived
    # stream to server-side spans has nothing to correlate ON.
    #
    # It carries the SERVER's ids, which the caller already sent us or can
    # already see — no new information crosses the boundary, and nothing here
    # is PHI.
    carrier = inject_trace_carrier()
    headers = (
        {"traceresponse": carrier["traceparent"], "Access-Control-Expose-Headers": "traceresponse"}
        if carrier.get("traceparent")
        else None
    )
    return EventSourceResponse(event_generator(), headers=headers)
