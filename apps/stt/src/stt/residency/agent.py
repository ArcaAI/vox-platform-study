"""stt's residency agent: the shared routes over stt's one model cache (TASK-1005).

`load_spec` is ``{"resolved_spec": <ResolvedAsrSpec>}`` — the spec the gateway
resolves for a session. The agent loads its PRIMARY ASR model through
`bundle_from_resolved` → `ModelCache.get_or_load`, the very path a session create
and the boot warm (`stt.main._warm_default_asr_model`) take, so the model is keyed
and budgeted exactly as a served one. Pinned in
`tests/contracts/model-residency-agent.fixture.json` → `loadSpecExamples.stt`.

TASK-1055 wave 3 — a second shape, ``{"model": <one ResolvedAsrSpec model object>}``
(contract ``wave3.sttModelOnly``), loads a single model of any role under its slug.

stt keeps no catalogue (no DB on the agent path since TASK-861), so a bare
`model_ref` with an empty `load_spec` can only answer for a model already resident.

TASK-1055 — `device` (``cuda:<i>``, the i-th GPU this process sees) places the load
on that GPU, through that device's own model cache (`get_model_cache(device)`), so
the same model on two GPUs is two entries. ``None`` keeps the default cache and
today's placement. The report lists every GPU the process sees.
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

from . import wiring
from .wiring import SERVICE

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
    from stt.models.cache import device_model_caches

    return [CacheBinding(cache=cache, describe=_describe) for cache in device_model_caches()]


def _devices() -> list[Any]:
    """Every device this process can place on — reported even while it holds nothing."""
    return list(wiring.stt_devices())


async def _plan(
    model_ref: str, load_spec: dict[str, Any], *, device: str | None = None
) -> LoadPlan | None:
    if device is not None and wiring.stt_device_by_id(device) is None:
        raise DeviceUnavailable(f"{SERVICE} sees no device {device}")
    if not load_spec:
        return None
    keys = set(load_spec)
    if keys not in ({"resolved_spec"}, {"model"}):
        raise InvalidLoadSpec(
            'stt expects {"resolved_spec": <ResolvedAsrSpec>} or '
            '{"model": <one ResolvedAsrSpec model object>}'
        )

    from stt.models.cache import get_model_cache
    from stt.pipeline.spec import AsrSpecModel, bundle_from_resolved, to_ai_model_config

    if "model" in keys:
        # TASK-1055 wave 3 — one model of any role (asr, vad, denoise, embedding, …),
        # keyed by slug in the same cache a session uses, so sessions reuse the weights.
        try:
            model = AsrSpecModel.model_validate(load_spec["model"])
            slug = model.slug
            if slug != model_ref:
                raise InvalidLoadSpec(f"the model is {slug}, not {model_ref}")
            model_config = to_ai_model_config(model)
        except InvalidLoadSpec:
            raise
        except Exception as exc:  # noqa: BLE001 — pydantic / unsupported-format errors alike
            raise InvalidLoadSpec(str(exc)) from exc
    else:
        try:
            bundle = bundle_from_resolved(load_spec["resolved_spec"])
        except Exception as exc:  # noqa: BLE001 — pydantic / unsupported-spec errors alike
            raise InvalidLoadSpec(str(exc)) from exc

        slug = bundle.spec.models.asr.slug
        if slug != model_ref:
            raise InvalidLoadSpec(f"the spec's primary ASR model is {slug}, not {model_ref}")
        found = bundle.model_configs.get(slug)
        if found is None:
            raise InvalidLoadSpec(f"the spec maps no model config for {slug}")
        model_config = found

    if device is not None and device != wiring.stt_device().id:
        try:  # every cache carries the same loader registry; ask before building one
            loader = get_model_cache().loader_for(model_config)
        except Exception:  # noqa: BLE001 — an unservable row fails at load, as before
            loader = None
        if loader is not None and getattr(loader, "places_on_device_index", False) is not True:
            raise DeviceUnavailable(
                f"{slug} is served by {type(loader).__name__}, which cannot choose a GPU; "
                f"it runs on the default device {wiring.stt_device().id}, not {device}"
            )
    cache = get_model_cache(device)
    return LoadPlan(cache=cache, key=slug, load=lambda: cache.get_or_load(model_config))


@lru_cache(maxsize=1)
def stt_residency_agent() -> ResidencyAgent:
    return ResidencyAgent(service=SERVICE, bindings=_bindings, planner=_plan, devices=_devices)


def residency_router() -> APIRouter:
    """`/internal/residency/*` — service-token gated by `ServiceAuthMiddleware`."""
    return build_residency_router(stt_residency_agent)
