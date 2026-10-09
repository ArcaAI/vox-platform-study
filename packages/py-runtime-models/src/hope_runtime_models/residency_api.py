"""The residency agent's HTTP skin — one FastAPI router every service mounts (TASK-1005).

    GET  /internal/residency
    POST /internal/residency/load
    POST /internal/residency/unload
    PUT  /internal/residency/models/{model_ref}/policy

Bodies are the ``python`` block of ``tests/contracts/model-residency-agent.fixture.json``.
A refused verb answers ``{"error": {"code", "message", ...}}`` with the status the
agent chose (404 MODEL_UNKNOWN, 409 IN_FLIGHT / LOAD_IN_PROGRESS, 503
INSUFFICIENT_MEMORY + ``Retry-After``, 400/500 LOAD_FAILED).

No auth here, on purpose: every mounting service already gates ``/internal/*``
behind its ``X-Service-Token`` middleware, and a second check would be a second
thing to keep in step. Imports FastAPI, so it is NOT re-exported from the package
root — the package itself stays dependency-free.

``model_ref`` in the policy path may contain ``/`` (an nlp model is named by its
hub id, e.g. ``org/model``); the route takes the rest of the path up to
``/policy``, and a caller should still percent-encode it.
"""

from collections.abc import Callable
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .cache import UNSET
from .residency_agent import ResidencyAgent, ResidencyError

_STRICT = ConfigDict(extra="forbid", protected_namespaces=())
_DEVICE_PATTERN = r"^(cuda:\d+|cpu)$"


class LoadRequest(BaseModel):
    model_config = _STRICT

    model_ref: str = Field(min_length=1)
    load_spec: dict[str, Any] = Field(default_factory=dict)
    pin: bool = False
    ttl_seconds: int | None = Field(default=None, ge=1)
    #: TASK-1055 — the device to load ON (``cuda:<n>`` = the n-th GPU this process
    #: sees, PCI-bus order; ``cpu``). ``None`` = the service's default placement.
    device: str | None = Field(default=None, pattern=_DEVICE_PATTERN)


class UnloadRequest(BaseModel):
    model_config = _STRICT

    model_ref: str = Field(min_length=1)
    force: bool = False
    #: Not in the pinned fixture: optional, so the controller may label its own
    #: policy-engine unloads (`model_evictions_total{reason="policy"}`).
    reason: Literal["admin", "policy"] = "admin"
    #: TASK-1055 — unload only the copy on this device; ``None`` = every copy.
    device: str | None = Field(default=None, pattern=_DEVICE_PATTERN)


class PolicyRequest(BaseModel):
    """An ABSENT field is left as it is; ``ttl_seconds: null`` resets to the default."""

    model_config = _STRICT

    admin_pinned: bool | None = None
    ttl_seconds: int | None = Field(default=None, ge=1)


def _error(exc: ResidencyError) -> JSONResponse:
    headers = (
        {"Retry-After": str(exc.retry_after_seconds)}
        if exc.retry_after_seconds is not None
        else None
    )
    return JSONResponse(status_code=exc.status, content=exc.body(), headers=headers)


def build_residency_router(agent: ResidencyAgent | Callable[[], ResidencyAgent]) -> APIRouter:
    """The four residency routes over ``agent`` (or a zero-arg provider of one)."""
    router = APIRouter(prefix="/internal/residency", tags=["Residency"])

    def current() -> ResidencyAgent:
        return agent if isinstance(agent, ResidencyAgent) else agent()

    @router.get("")
    async def residency_report() -> dict[str, Any]:
        return current().report()

    @router.post("/load", response_model=None)
    async def residency_load(request: LoadRequest) -> dict[str, Any] | JSONResponse:
        try:
            return await current().load(
                request.model_ref,
                request.load_spec,
                pin=request.pin,
                ttl_seconds=request.ttl_seconds,
                device=request.device,
            )
        except ResidencyError as exc:
            return _error(exc)

    @router.post("/unload", response_model=None)
    async def residency_unload(request: UnloadRequest) -> dict[str, Any] | JSONResponse:
        try:
            return await current().unload(
                request.model_ref,
                force=request.force,
                reason=request.reason,
                device=request.device,
            )
        except ResidencyError as exc:
            return _error(exc)

    @router.put("/models/{model_ref:path}/policy", response_model=None)
    async def residency_policy(
        model_ref: str, request: PolicyRequest
    ) -> dict[str, Any] | JSONResponse:
        given = request.model_fields_set
        try:
            return await current().set_policy(
                model_ref,
                admin_pinned=request.admin_pinned if "admin_pinned" in given else UNSET,
                ttl_seconds=request.ttl_seconds if "ttl_seconds" in given else UNSET,
            )
        except ResidencyError as exc:
            return _error(exc)

    return router
