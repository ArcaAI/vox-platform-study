"""nlp's model-residency wiring and agent (TASK-1005, TASK-1055).

The DEFAULT caches share ONE `Device` — the one `NLP_INFERENCE_DEVICE` resolves to
(TASK-1031): host RAM on the default CPU image, the NVML-probed GPU on the
`nlp-gpu` image when the device resolves to CUDA.

TASK-1055 — GPU placement. A load may name a device (`cuda:<n>` = the n-th GPU
this process sees, CUDA/PCI order; `cpu`). Each (slot, device) pair gets its own
cache, built lazily with the same retention, bound to that `Device`, and loading
its weights ON that device. No device (or the default's own id) is today's cache.
The agent reports EVERY visible GPU, not only the ones holding a model.

Footprints of torch models are parameter + buffer bytes (`measure_instance`) —
deterministic and blind to the caching allocator and to card-mates; llama.cpp
(the entailment scorer) keeps the device delta. An unload drops every reference
and hands the freed blocks back to the driver (`nlp.dependencies` unload hooks).

`load_spec` names the slot (it never carries a device — that is the planner's
`device` argument) the way the request path keys it — pinned in
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

from functools import lru_cache
from typing import Any

import prometheus_client
from fastapi import APIRouter
from hope_runtime_models import (
    CacheResidency,
    Device,
    PrometheusResidencyMetrics,
    cpu_device,
    gpu_device,
    gpu_devices,
    torch_module_bytes,
)
from hope_runtime_models.residency_agent import (
    CacheBinding,
    DeviceUnavailable,
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
    """The pool the caches load into: the RESOLVED inference device (TASK-1031).

    Accounting only — placement itself is decided by the loaders. An explicit
    device that is absent makes the LOAD fail closed (`resolve_inference_device`
    raises there); here it degrades to host RAM so the residency report still
    renders. NVML unreadable on a CUDA pod degrades the same way.
    """
    from nlp.core.config import settings
    from nlp.core.device import DevicePlacementError, cuda_index, resolve_inference_device

    try:
        resolved = resolve_inference_device(settings.service.inference_device)
    except DevicePlacementError:
        return cpu_device()
    index = cuda_index(resolved)
    if index is None:
        return cpu_device()
    # `cuda` is torch's current device, `cuda:0`. TASK-1055: the NVML index behind
    # `cuda:<n>` comes from `gpu_devices()` (CUDA_VISIBLE_DEVICES-aware); a host
    # where that enumeration fails keeps the TASK-1031 single-card probe.
    for device in gpu_devices():
        if device.id == f"cuda:{index}":
            return device
    return gpu_device(index) or cpu_device()


#: Non-default placement targets, one `Device` per id for the process lifetime —
#: a device's load serialisation and footprint epochs live on the object.
_placed_devices: dict[str, Device] = {}


def reset_placement_devices() -> None:
    """Forget the non-default devices (tests; `nlp.dependencies.reset_model_caches`)."""
    _placed_devices.clear()


def placement_device(device_id: str) -> Device:
    """The `Device` a load on ``device_id`` is accounted to; `DeviceUnavailable` if unseen."""
    default = nlp_device()
    if device_id == default.id:
        return default
    known = _placed_devices.get(device_id)
    if known is not None:
        return known
    if device_id == "cpu":
        found: Device | None = cpu_device()
    else:
        found = next((d for d in gpu_devices() if d.id == device_id), None)
    if found is None:
        raise DeviceUnavailable(f"{SERVICE} sees no device {device_id}")
    _placed_devices[device_id] = found
    return found


def resolve_placement(device: str | None) -> str | None:
    """None for the default placement (absent, or the default's own id), else the id.

    Raises `DeviceUnavailable` for a device this process cannot see.
    """
    if device is None or device == nlp_device().id:
        return None
    placement_device(device)
    return device


def nlp_devices() -> list[Device]:
    """Every device the agent reports: each visible GPU (CUDA order), then the default.

    On a CPU host that is just host RAM. The objects are the ones the caches are
    bound to wherever one exists, so reservations and footprints line up.
    """
    default = nlp_device()
    devices: list[Device] = []
    for gpu in gpu_devices():
        if gpu.id == default.id:
            devices.append(default)
        else:
            devices.append(_placed_devices.get(gpu.id, gpu))
    if all(device.id != default.id for device in devices):
        devices.append(default)
    return devices


def measure_instance(instance: Any) -> int | None:
    """Parameter + buffer bytes of every torch module ``instance`` holds (TASK-1055 E7).

    nlp services name their modules through ``torch_modules()`` (a suggester holds
    TWO models; the guard runtimes keep theirs private). Anything else is handed to
    `torch_module_bytes` as is. None = nothing torch-sized here (the device delta
    then stands).
    """
    modules = getattr(instance, "torch_modules", None)
    if not callable(modules):
        return torch_module_bytes(instance)
    sizes = [size for module in modules() if (size := torch_module_bytes(module)) is not None]
    return sum(sizes) if sizes else None


def _model_ref(key: str) -> str:
    return key.split(_KEY_SEP, 1)[0]


def nlp_cache_residency(placement: str | None = None) -> CacheResidency:
    """What every nlp cache is built with. Admission stays OFF (the default).

    ``placement`` None = the default device; otherwise the cache's own device id.
    """
    device = nlp_device() if placement is None else placement_device(placement)
    return CacheResidency(
        service=SERVICE, device=device, metrics=RESIDENCY_METRICS, model_ref=_model_ref
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


async def _plan(
    model_ref: str, load_spec: dict[str, Any], *, device: str | None = None
) -> LoadPlan | None:
    """``device``: `cuda:<n>` → a cache bound to that GPU; None → the default cache.

    An unknown device is `DeviceUnavailable` (HTTP 400), checked before the spec.
    """
    placement = resolve_placement(device)
    if not load_spec:
        return None

    from nlp import dependencies as deps

    cache_name = load_spec.get("cache")
    path = _optional_str(load_spec, "model_path")

    if cache_name in ("nlp_token_classifier", "nlp_text_classifier", "nlp_gliner2_guard"):
        _fields(load_spec, {"cache", "model_path"})
        key = deps._model_cache_key(model_ref, path)
        cache = deps._cache_for(cache_name, placement)
        if cache_name == "nlp_text_classifier":
            # Keeps the doc-type placeholder refusal of the request path.
            return LoadPlan(
                cache=cache,
                key=key,
                load=lambda: deps.get_text_classifier_for(key, device=placement),
            )
        return LoadPlan(cache=cache, key=key, load=lambda: cache.get(key))

    if cache_name == "nlp_medical_suggester":
        _fields(load_spec, {"cache", "model_path", "ner_model_name", "ner_model_path"})
        ner_name = _optional_str(load_spec, "ner_model_name")
        if not ner_name:
            raise InvalidLoadSpec("nlp_medical_suggester needs ner_model_name")
        key = deps._suggester_cache_key(
            model_ref, path, ner_name, _optional_str(load_spec, "ner_model_path")
        )
        cache = deps._cache_for(cache_name, placement)
        return LoadPlan(cache=cache, key=key, load=lambda: cache.get(key))

    if cache_name == "nlp_entailment_scorer":
        _fields(load_spec, {"cache", "model_path", "calibration"})
        from nlp.services.entailment_scorer import EntailmentCalibration

        raw = load_spec.get("calibration")
        try:
            calibration = None if raw is None else EntailmentCalibration.model_validate(raw)
        except Exception as exc:  # noqa: BLE001 — a pydantic ValidationError
            raise InvalidLoadSpec(f"calibration: {exc}") from exc
        key = deps._entailment_cache_key(model_ref, path, calibration)
        cache = deps._cache_for(cache_name, placement)

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
    return ResidencyAgent(service=SERVICE, bindings=_bindings, planner=_plan, devices=nlp_devices)


def residency_router() -> APIRouter:
    """`/internal/residency/*` — service-token gated by `ServiceAuthMiddleware`."""
    return build_residency_router(nlp_residency_agent)
