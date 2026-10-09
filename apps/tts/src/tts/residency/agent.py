"""tts's residency agent: the shared routes over the local engines' caches (TASK-1055 wave 3).

Pinned in `tests/contracts/model-residency-task1055.fixture.json` → `wave3.ttsResidency`.

The resident set is the `ModelCache` of every LOCAL engine (`CredentialPosture.SELF_HOST`:
Kokoro, Indic Parler, Indic F5) this process holds — the request-scoped engines the router
built from a resolved spec (the ones synthesis actually uses) and the boot-registered ones.
A cloud engine (Azure, Sarvam) holds nothing in memory and never appears.

* ``model_ref`` = the AiModel slug the engine was built from (`from_spec`); a boot-registered
  engine carries no row, so it is reported under its engine name;
* ``cache`` = ``tts_<engine>``; ``device`` = ``cpu``;
* ``load_spec`` = ``{"engine": "<registered name>", "model": <TtsSpecModel wire>}``. A load
  warms the cache of the engine built for ``(engine, model_ref)`` through `ModelCache.get` —
  the same call synthesis makes — so the next request is a hit. When no request has built it
  yet (a fresh pod), ``model`` — the gateway's projection of the row, exactly
  ``ResolvedTtsCandidate.model`` — builds it through the router's own builder and engine-cache
  key (`TTSRouter.engine_for_model`), so the next request reuses that instance. Without
  ``model`` (the pre-amendment shape) such a load is MODEL_UNKNOWN; so is a cloud engine, and a
  voice-clone engine (IndicF5), which cannot be built without a request's voice.
* An unload evicts the cache entry; the engine stays, and the next request reloads it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from hope_runtime_models.residency_agent import (
    CacheBinding,
    DeviceUnavailable,
    InvalidLoadSpec,
    LoadPlan,
    ModelIdentity,
    ResidencyAgent,
    ResidencyError,
)
from hope_runtime_models.residency_api import build_residency_router

from tts.providers.base import CredentialPosture
from tts.spec import TtsSpecModel

from .wiring import SERVICE, tts_device


def _model_ref(engine: Any) -> str:
    return getattr(engine, "model_slug", None) or engine.name


def _local_engines(state: Any) -> list[Any]:
    """Every distinct LOCAL engine this process holds: spec-built first, then registered."""
    router = getattr(state, "router", None)
    # The very instances synthesis is served by, so a console load warms the one requests use.
    built = router.spec_engines() if router is not None else []
    registry = getattr(state, "provider_registry", None)
    registered = (
        [registry.get(name) for name in registry.list_providers()] if registry is not None else []
    )
    engines: list[Any] = []
    for engine in (*built, *registered):
        if any(engine is seen for seen in engines):
            continue
        if getattr(engine, "credential_posture", None) is not CredentialPosture.SELF_HOST:
            continue
        if getattr(engine, "model_cache", None) is None:
            continue
        engines.append(engine)
    return engines


def _binding(engine: Any) -> CacheBinding:
    ref = _model_ref(engine)
    return CacheBinding(
        cache=engine.model_cache, describe=lambda _key, _instance: ModelIdentity(model_ref=ref)
    )


def _read_load_spec(model_ref: str, load_spec: dict[str, Any]) -> tuple[str, TtsSpecModel | None]:
    """``(engine, model)`` from ``{"engine", "model"?}``; `InvalidLoadSpec` when unreadable."""
    engine_name = load_spec.get("engine")
    if not isinstance(engine_name, str) or not set(load_spec) <= {"engine", "model"}:
        raise InvalidLoadSpec(
            'tts expects {"engine": "<registered engine name>", "model": <TtsSpecModel>?}'
        )
    if "model" not in load_spec:
        return engine_name, None
    try:
        model = TtsSpecModel.model_validate(load_spec["model"])
    except Exception as exc:  # noqa: BLE001 — a pydantic ValidationError
        raise InvalidLoadSpec(f"model: {exc}") from exc
    if model.slug != model_ref:
        raise InvalidLoadSpec(f"model.slug {model.slug!r} is not model_ref {model_ref!r}")
    if model.provider != engine_name:
        raise InvalidLoadSpec(f"model.provider {model.provider!r} is not engine {engine_name!r}")
    return engine_name, model


def build_tts_residency_agent(state: Any) -> ResidencyAgent:
    """The agent over ``state`` (the app's `app.state`: provider registry + router)."""

    def bindings() -> list[CacheBinding]:
        return [_binding(engine) for engine in _local_engines(state)]

    async def plan(
        model_ref: str, load_spec: dict[str, Any], *, device: str | None = None
    ) -> LoadPlan | None:
        if device is not None and device != tts_device().id:
            raise DeviceUnavailable(f"{SERVICE} places models on cpu only, not {device}")
        if not load_spec:
            return None
        engine_name, model = _read_load_spec(model_ref, load_spec)
        # Only an engine built FROM a row may be loaded: a boot-registered one carries no
        # weights location of its own and would fetch whatever its settings default to.
        engine = next(
            (
                e
                for e in _local_engines(state)
                if e.name == engine_name and getattr(e, "model_slug", None) == model_ref
            ),
            None,
        )
        if engine is None and model is not None:
            try:
                engine = state.router.engine_for_model(model)
            except Exception as exc:  # noqa: BLE001 — e.g. Kokoro's unpublished-weights refusal
                raise ResidencyError(
                    "LOAD_FAILED",
                    f"{model_ref}: the {engine_name} engine failed to build: {exc}",
                    status=500,
                ) from exc
        if engine is None:
            raise ResidencyError(
                "MODEL_UNKNOWN",
                f"no local {engine_name!r} engine for {model_ref} in this process (a remote "
                "engine, a voice-clone engine, or no synthesis has used it and no model was given)",
                status=404,
            )
        cache = engine.model_cache
        # Every local engine keys its one cache entry by its engine name.
        return LoadPlan(cache=cache, key=engine_name, load=lambda: cache.get(engine_name))

    return ResidencyAgent(
        service=SERVICE, bindings=bindings, planner=plan, devices=lambda: [tts_device()]
    )


def residency_router(state: Any) -> APIRouter:
    """`/internal/residency/*` — service-token gated by `ServiceAuthMiddleware`."""
    return build_residency_router(build_tts_residency_agent(state))
