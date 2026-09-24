"""nlp's model-residency wiring and agent (TASK-1005).

nlp runs on the CPU (plan D-10), so all five caches share ONE host `Device`:
footprints are the process-RSS delta around a load, and a load that overlaps
another (or an unload) is reported as unmeasured rather than mis-attributed.

`load_spec` names the slot the way the request path keys it — pinned in
`tests/contracts/model-residency-agent.fixture.json` → `loadSpecExamples.nlp`:

    {"cache": "nlp_token_classifier" | "nlp_text_classifier" | "nlp_gliner2_guard"
              | "nlp_medical_suggester" | "nlp_entailment_scorer",
     "model_path": <AiModel.localPath> | null,
     "ner_model_name": ..., "ner_model_path": ...,   # nlp_medical_suggester only
     "calibration": {...}}                           # nlp_entailment_scorer only

and `model_ref` is the model NAME nlp is handed per request (the gateway-injected
`AiModel.sourceUri`). Resolution is the existing one in `nlp.dependencies` — no
new lookup, no database read — so an agent load makes the next request a hit.

Imported by `nlp.dependencies` (for `nlp_cache_residency`), so every reference
back to that module is a deferred import.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Any

import prometheus_client
from fastapi import APIRouter
from hope_runtime_models import (
    CacheResidency,
    Device,
    PrometheusResidencyMetrics,
    cpu_device,
)
from hope_runtime_models.residency_agent import (
    CacheBinding,
    InvalidLoadSpec,
    LoadPlan,
    ModelIdentity,
    ResidencyAgent,
)
from hope_runtime_models.residency_api import build_residency_router

SERVICE = "nlp"

#: Every nlp slot key STARTS with the (primary) model name; the rest — a local
#: path, a second model, a calibration — follows after this separator
#: (`nlp.dependencies._KEY_SEP`).
_KEY_SEP = "\x00"

RESIDENCY_METRICS = PrometheusResidencyMetrics.create(prometheus_client)


@lru_cache(maxsize=1)
def nlp_device() -> Device:
    return cpu_device()


def _model_ref(key: str) -> str:
    return key.split(_KEY_SEP, 1)[0]


def nlp_cache_residency() -> CacheResidency:
    """What every nlp cache is built with. Admission stays OFF (the default)."""
    return CacheResidency(
        service=SERVICE, device=nlp_device(), metrics=RESIDENCY_METRICS, model_ref=_model_ref
    )


def _describe(key: str, _instance: Any) -> ModelIdentity:
    return ModelIdentity(model_ref=_model_ref(key))


def _bindings() -> list[CacheBinding]:
    from nlp import dependencies

    return [CacheBinding(cache=c, describe=_describe) for c in dependencies._live_caches()]


def _fields(load_spec: dict[str, Any], allowed: set[str]) -> None:
    unexpected = set(load_spec) - allowed
    if unexpected:
        raise InvalidLoadSpec(f"unexpected load_spec keys {sorted(unexpected)}")


def _optional_str(load_spec: dict[str, Any], name: str) -> str | None:
    value = load_spec.get(name)
    if value is not None and not isinstance(value, str):
        raise InvalidLoadSpec(f"{name} must be a string or null")
    return value


async def _plan(model_ref: str, load_spec: dict[str, Any]) -> LoadPlan | None:
    if not load_spec:
        return None

    from nlp import dependencies as deps

    cache_name = load_spec.get("cache")
    path = _optional_str(load_spec, "model_path")
    simple: dict[str, tuple[Callable[[], Any], Callable[[str], Awaitable[Any]]]] = {
        "nlp_token_classifier": (deps._token_classifier_cache, deps.get_token_classifier_for),
        "nlp_text_classifier": (deps._text_classifier_cache, deps.get_text_classifier_for),
    }

    if cache_name in simple:
        _fields(load_spec, {"cache", "model_path"})
        accessor, loader = simple[cache_name]
        key = deps._model_cache_key(model_ref, path)
        return LoadPlan(cache=accessor(), key=key, load=lambda: loader(key))

    if cache_name == "nlp_gliner2_guard":
        _fields(load_spec, {"cache", "model_path"})
        key = deps._model_cache_key(model_ref, path)
        cache = deps._gliner2_guard_cache()
        return LoadPlan(cache=cache, key=key, load=lambda: cache.get(key))

    if cache_name == "nlp_medical_suggester":
        _fields(load_spec, {"cache", "model_path", "ner_model_name", "ner_model_path"})
        ner_name = _optional_str(load_spec, "ner_model_name")
        if not ner_name:
            raise InvalidLoadSpec("nlp_medical_suggester needs ner_model_name")
        key = deps._suggester_cache_key(
            model_ref, path, ner_name, _optional_str(load_spec, "ner_model_path")
        )
        return LoadPlan(
            cache=deps._medical_suggester_cache(),
            key=key,
            load=lambda: deps.get_medical_suggester_for(key),
        )

    if cache_name == "nlp_entailment_scorer":
        _fields(load_spec, {"cache", "model_path", "calibration"})
        from nlp.services.entailment_scorer import EntailmentCalibration

        raw = load_spec.get("calibration")
        try:
            calibration = None if raw is None else EntailmentCalibration.model_validate(raw)
        except Exception as exc:  # noqa: BLE001 — a pydantic ValidationError
            raise InvalidLoadSpec(f"calibration: {exc}") from exc
        key = deps._entailment_cache_key(model_ref, path, calibration)
        cache = deps._entailment_scorer_cache()

        async def load() -> Any:
            # The same hand-off `pinned_entailment_scorer` makes: the factory
            # consumes the calibration by slot key (absent ⇒ it fails closed).
            if calibration is not None:
                deps._pending_entailment_calibration[key] = calibration
            return await cache.get(key)

        return LoadPlan(cache=cache, key=key, load=load)

    raise InvalidLoadSpec(
        f"unknown cache {cache_name!r}; one of nlp_token_classifier, nlp_text_classifier, "
        "nlp_gliner2_guard, nlp_medical_suggester, nlp_entailment_scorer"
    )


@lru_cache(maxsize=1)
def nlp_residency_agent() -> ResidencyAgent:
    return ResidencyAgent(
        service=SERVICE, bindings=_bindings, planner=_plan, devices=lambda: [nlp_device()]
    )


def residency_router() -> APIRouter:
    """`/internal/residency/*` — service-token gated by `ServiceAuthMiddleware`."""
    return build_residency_router(nlp_residency_agent)
