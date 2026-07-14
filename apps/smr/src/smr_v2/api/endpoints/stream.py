"""SSE streaming endpoint for consuming task chunks."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from smr_v2.core.dependencies import get_task_manager
from smr_v2.models.task import TaskStatus
from smr_v2.services.task_manager import TaskManager

router = APIRouter(tags=["stream"])


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

    cursor_start = last_event_id or request.headers.get("last-event-id") or "0-0"

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        cursor = cursor_start
        while True:
            if await request.is_disconnected():
                break

            entries = await task_manager.read_chunks_blocking(
                task_id, last_id=cursor, block_ms=5000
            )

            for msg_id, chunk in entries:
                cursor = msg_id
                yield {"event": chunk.type, "data": chunk.model_dump_json(), "id": msg_id}
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

    return EventSourceResponse(event_generator())
