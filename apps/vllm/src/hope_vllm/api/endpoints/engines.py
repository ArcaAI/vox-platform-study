"""``POST /api/v1/engines/warm`` and ``GET /api/v1/engines`` — the house control routes (C-3).

``warm`` loads the engine ``{"model": <slug>}`` resolves to for the calling tenant BEFORE
traffic arrives — the scale-out contract: a router warms a new replica, then routes to it,
so the cold start is paid off the request path. ``engines`` is the pool snapshot.

House error shape (``{"detail": {"code", "message"}}``), not the OpenAI one: these routes
are HOPE's own, called by HOPE tooling.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from hope_vllm.core.serving_spec_client import (
    ModelNotFound,
    ModelNotServable,
    ServingSpecUnavailable,
)
from hope_vllm.engine.base import EngineBuildRefused
from hope_vllm.engine.pool import (
    EngineCapacityError,
    EngineLoadError,
    EnginePool,
    RuntimeKeySpecMismatchError,
)

router = APIRouter(tags=["engines"])

_RETRY_AFTER_S = "1"


class WarmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1)


class WarmResponse(BaseModel):
    runtime_key: str
    already_resident: bool
    load_seconds: float


def _error(
    status: int, code: str, message: str, headers: dict[str, str] | None = None
) -> HTTPException:
    return HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=headers
    )


def require_tenant(x_tenant_id: Annotated[str | None, Header()] = None) -> str:
    """``X-Tenant-Id`` is mandatory on tenant-scoped internal work (owner directive)."""
    tenant = (x_tenant_id or "").strip()
    if not tenant:
        raise _error(400, "TENANT_ID_REQUIRED", "X-Tenant-Id header is required")
    return tenant


@router.post("/engines/warm", response_model=WarmResponse)
async def warm(
    body: WarmRequest,
    request: Request,
    tenant_id: Annotated[str, Depends(require_tenant)],
) -> WarmResponse:
    reason = request.app.state.engine_factory.availability()
    if reason is not None:
        raise _error(503, "ENGINE_BACKEND_UNAVAILABLE", reason)
    try:
        spec = await request.app.state.serving_spec_client.resolve(body.model, tenant_id)
    except ModelNotFound as exc:
        raise _error(404, "MODEL_NOT_FOUND", str(exc)) from None
    except ModelNotServable as exc:
        raise _error(409, "MODEL_NOT_SERVABLE", f"{exc.reason}: {exc}") from None
    except ServingSpecUnavailable as exc:
        raise _error(
            503, "SERVING_SPEC_UNAVAILABLE", str(exc), headers={"Retry-After": _RETRY_AFTER_S}
        ) from None
    pool: EnginePool = request.app.state.engine_pool
    try:
        load_seconds, already = await pool.warm(spec)
    except ModelNotServable as exc:
        raise _error(409, "MODEL_NOT_SERVABLE", f"{exc.reason}: {exc}") from None
    except EngineCapacityError:
        raise _error(
            503,
            "ENGINE_CAPACITY",
            "every resident engine is busy and this pool has no room for another",
            headers={"Retry-After": _RETRY_AFTER_S},
        ) from None
    except RuntimeKeySpecMismatchError:
        raise _error(
            409,
            "RUNTIME_KEY_SPEC_MISMATCH",
            f"runtime key {spec.runtime_key} is resident with different weights",
        ) from None
    except (EngineLoadError, EngineBuildRefused) as exc:
        raise _error(503, exc.code, str(exc)) from None
    return WarmResponse(
        runtime_key=spec.runtime_key, already_resident=already, load_seconds=round(load_seconds, 3)
    )


@router.get("/engines")
async def engines(request: Request) -> dict[str, Any]:
    snapshot: dict[str, Any] = request.app.state.engine_pool.snapshot()
    return snapshot
