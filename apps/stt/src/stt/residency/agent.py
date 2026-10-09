"""stt's residency agent: the shared routes over stt's one model cache (TASK-1005).

`load_spec` is ``{"resolved_spec": <ResolvedAsrSpec>}`` — the spec the gateway
resolves for a session. The agent loads its PRIMARY ASR model through
`bundle_from_resolved` → `ModelCache.get_or_load`, the very path a session create
and the boot warm (`stt.main._warm_default_asr_model`) take, so the model is keyed
and budgeted exactly as a served one. Pinned in
`tests/contracts/model-residency-agent.fixture.json` → `loadSpecExamples.stt`.

stt keeps no catalogue (no DB on the agent path since TASK-861), so a bare
`model_ref` with an empty `load_spec` can only answer for a model already resident.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from fastapi import APIRouter
from hope_runtime_models.residency_agent import (
    CacheBinding,
    DeviceUnavailable,
    InvalidLoadSpec,
    LoadPlan,
    ModelIdentity,
    ResidencyAgent,
)
from hope_runtime_models.residency_api import build_residency_router

from .wiring import SERVICE, stt_device

#: `to_ai_model_config` stamps `agent-model:<slug>` as the config id when the model
#: came from a resolved spec — a label, not an `AiModel` id, so it is not reported
#: as one.
_SYNTHETIC_ID_PREFIX = "agent-model:"


def _describe(key: str, instance: Any) -> ModelIdentity:
    model_id = getattr(instance, "model_id", None)
    if not isinstance(model_id, str) or model_id.startswith(_SYNTHETIC_ID_PREFIX):
        model_id = None
    return ModelIdentity(model_ref=key, ai_model_id=model_id)


def _bindings() -> list[CacheBinding]:
    from stt.models.cache import get_model_cache

    return [CacheBinding(cache=get_model_cache(), describe=_describe)]


def _default_device_id() -> str:
    return stt_device().id


async def _plan(
    model_ref: str, load_spec: dict[str, Any], *, device: str | None = None
) -> LoadPlan | None:
    # TASK-1055 wave-0 contract: `device` is accepted; placing on a chosen GPU is
    # implemented by the device lane. Until then only the default device is honoured.
    if device is not None and device != _default_device_id():
        raise DeviceUnavailable(f"{SERVICE} cannot place a load on {device} yet")
    if not load_spec:
        return None
    if set(load_spec) != {"resolved_spec"}:
        raise InvalidLoadSpec('stt expects {"resolved_spec": <ResolvedAsrSpec>}')

    from stt.models.cache import get_model_cache
    from stt.pipeline.spec import bundle_from_resolved

    try:
        bundle = bundle_from_resolved(load_spec["resolved_spec"])
    except Exception as exc:  # noqa: BLE001 — pydantic / unsupported-spec errors alike
        raise InvalidLoadSpec(str(exc)) from exc

    slug = bundle.spec.models.asr.slug
    if slug != model_ref:
        raise InvalidLoadSpec(f"the spec's primary ASR model is {slug}, not {model_ref}")
    model_config = bundle.model_configs.get(slug)
    if model_config is None:
        raise InvalidLoadSpec(f"the spec maps no model config for {slug}")

    cache = get_model_cache()
    return LoadPlan(cache=cache, key=slug, load=lambda: cache.get_or_load(model_config))


@lru_cache(maxsize=1)
def stt_residency_agent() -> ResidencyAgent:
    return ResidencyAgent(
        service=SERVICE, bindings=_bindings, planner=_plan, devices=lambda: [stt_device()]
    )


def residency_router() -> APIRouter:
    """`/internal/residency/*` — service-token gated by `ServiceAuthMiddleware`."""
    return build_residency_router(stt_residency_agent)
