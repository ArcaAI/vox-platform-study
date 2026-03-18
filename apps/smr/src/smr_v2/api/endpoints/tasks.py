"""Task management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from smr_v2.core.dependencies import get_task_manager
from smr_v2.models.responses import TaskResponse
from smr_v2.services.task_manager import TaskManager

router = APIRouter(tags=["tasks"])


@router.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: str,
    task_manager: TaskManager = Depends(get_task_manager),
) -> dict:
    state = await task_manager.get_task(task_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
    return state.model_dump(mode="json")


@router.post("/tasks/{task_id}/cancel", response_model=TaskResponse)
async def cancel_task(
    task_id: str,
    task_manager: TaskManager = Depends(get_task_manager),
) -> dict:
    state = await task_manager.cancel_task(task_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
    return state.model_dump(mode="json")
