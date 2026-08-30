"""Task and generation management endpoints.

The cancel routes here are the **only** thing that stops a running generation
early (TASK-818 §3C.4). A dropped socket is not a cancel, and nothing in this
service infers one from connection state.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from text.core.dependencies import get_task_manager
from text.models.responses import TaskResponse
from text.models.task import TaskState
from text.routing.hub import get_generation_hub
from text.services.task_manager import TaskManager

router = APIRouter(tags=["tasks"])


async def _cancel(
    request: Request, generation_id: str, task_manager: TaskManager
) -> TaskState | None:
    """Signal cancellation both ways, then mark the task.

    * **Persisted flag** — survives a restart and reaches a producer on another
      pod, which is why cancellation is a flag rather than a method call.
    * **In-memory event** — the producer on THIS pod observes it on its next
      delta rather than waiting out the poll interval.

    Written before the status update so a producer that reads the flag between
    the two still stops.
    """
    await task_manager.request_cancel(generation_id)
    producer = get_generation_hub(request.app).get(generation_id)
    if producer is not None:
        producer.request_cancel()
    return await task_manager.cancel_task(generation_id)


@router.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: str,
    task_manager: TaskManager = Depends(get_task_manager),
) -> dict[str, Any]:
    state = await task_manager.get_task(task_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
    return state.model_dump(mode="json")


@router.post("/tasks/{task_id}/cancel", response_model=TaskResponse)
async def cancel_task(
    task_id: str,
    request: Request,
    task_manager: TaskManager = Depends(get_task_manager),
) -> dict[str, Any]:
    state = await _cancel(request, task_id, task_manager)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
    return state.model_dump(mode="json")


@router.post("/generations/{generation_id}/cancel", response_model=TaskResponse)
async def cancel_generation(
    generation_id: str,
    request: Request,
    task_manager: TaskManager = Depends(get_task_manager),
) -> dict[str, Any]:
    """Stop a running generation. The explicit act §3C.4 requires."""
    state = await _cancel(request, generation_id, task_manager)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Generation '{generation_id}' not found")
    return state.model_dump(mode="json")
