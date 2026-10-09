import asyncio
import functools
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

import structlog
from fastapi import Request
from hope_runtime_models import release_accelerator_memory

from nlp.core.checkpoint_family import is_gliner_checkpoint, read_checkpoint_config
from nlp.core.concurrency import (
    ResizableSemaphore,
    refresh_inference_limit,
    refresh_peer_call_limit,
)
from nlp.core.config import (
    UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL,
    MedicalSuggesterConfig,
    TextClassificationConfig,
    TokenClassificationConfig,
)
from nlp.core.websocket_manager import WebSocketManager
from nlp.core.weight_registry import get_weight_registry
from nlp.services.document_extractor import DocumentExtractor
from nlp.services.external_text_client import ExternalTextClient
from nlp.services.medical_suggester import MedicalSuggester
from nlp.services.model_cache import ModelCache, ModelUnavailableError
from nlp.services.text_classifier import TextClassifier, TransformerTextClassifier
from nlp.services.text_corrector import SymSpellCorrector, TextCorrector
from nlp.services.token_classifier import TokenClassifier, TransformerTokenClassifier

logger = structlog.get_logger(__name__)


async def get_inference_bound(request: Request) -> ResizableSemaphore:
    """The inference bound, with its limit refreshed from the control plane.

    Used as a route dependency so the ceiling tracks the control plane without a
    background poller. Cheap inside the client's TTL window, and never raises.
    """
    return await refresh_inference_limit(
        getattr(request.app.state, "effective_config_client", None)
    )


async def get_peer_call_bound(request: Request) -> ResizableSemaphore:
    """The outbound peer-call bound (with its limit refreshed
    from the control plane. A SEPARATE semaphore from `get_inference_bound` —
    see `nlp.core.concurrency.get_peer_call_semaphore` for why sharing the
    inference bound with `text` delegation was rejected. Never raises.
    """
    return await refresh_peer_call_limit(
        getattr(request.app.state, "effective_config_client", None)
    )


def get_external_text_client(request: Request) -> ExternalTextClient | None:
    """Retrieve apps/nlp's peer client to `text` from app.state.

    None only if lifespan never ran (e.g. an app built directly in a test
    without the lifespan context) — the `/classify/topic`/`/classify/intent`
    handlers fail closed (503) in that case, the same posture as a missing
    gateway-injected `model_name` on `/classify/text`.
    """
    return getattr(request.app.state, "external_text_client", None)


def get_text_corrector() -> TextCorrector:
    if globals().get("_text_corrector_instance") is None:
        globals()["_text_corrector_instance"] = SymSpellCorrector()
    return cast(TextCorrector, globals()["_text_corrector_instance"])


def get_websocket_manager() -> WebSocketManager:
    if globals().get("_websocket_manager_instance") is None:
        globals()["_websocket_manager_instance"] = WebSocketManager()
    return cast(WebSocketManager, globals()["_websocket_manager_instance"])


def get_document_extractor() -> DocumentExtractor:
    if globals().get("_document_extractor_instance") is None:
        globals()["_document_extractor_instance"] = DocumentExtractor()
    return cast(DocumentExtractor, globals()["_document_extractor_instance"])


# ---------------------------------------------------------------------------
# Per-request model selection.
#
# Every classify/diagnosis request carries a REQUIRED `model_name` (the
# gateway-injected `AiModel.sourceUri` resolved from the DB AiRoutingPolicy
# registry). Model identity is never selected by environment variables
# ; a missing/unloadable model fails closed with HTTP 503. Resolved
# instances live in a bounded, idle-TTL per-slot cache (lazily created and
# initialized on first use) and are pinned for the duration of the request so
# they cannot be evicted mid-flight. Tuning env (thresholds, GPU flags,
# tokenizer behavior, dictionary paths) still applies to each instance.
# ---------------------------------------------------------------------------


# The cache slot is keyed on the FULL weight identity
# `(model_name, model_path)`, not the id alone. An admin flipping
# `AiModel.localPath` must be a cache MISS: reusing the slot would keep serving
# the old weights under the new configuration until the TTL happened to expire.
_KEY_SEP = "\x00"


def _model_cache_key(model_name: str, model_path: str | None) -> str:
    """Compose the cache slot key from the full weight identity."""
    return f"{model_name}{_KEY_SEP}{model_path}" if model_path else model_name


def _split_cache_key(key: str) -> tuple[str, str | None]:
    """Inverse of `_model_cache_key` (the factories receive the composed key)."""
    name, sep, path = key.partition(_KEY_SEP)
    return (name, path) if sep else (name, None)


async def _weights_source(model_name: str, model_path: str | None) -> str:
    """What `from_pretrained` should load: the staged path when usable, else the id.

    A set-but-missing path falls THROUGH to the hub id with a warning rather than
    failing the request — the same precedence the other three services apply.

    `model_name` (`AiModel.sourceUri`) may itself be an `s3://bucket/prefix` or
    `file:///abs/path` URI rather than a HuggingFace hub id — those
    two schemes are materialised to a real local directory through the mirrored
    resolver (`nlp.models.source_resolver`) before being handed to `from_pretrained`.
    An `hf:`-prefixed or bare hub id is returned UNCHANGED, exactly as before, so
    every existing HuggingFace-backed caller keeps its current fetch mechanism
    (the runtime's own hub download) untouched.
    """
    if model_path:
        if Path(model_path).exists():
            return model_path
        logger.warning(
            "nlp.model_source.local_path_missing",
            model_name=model_name,
            model_path=model_path,
            detail="configured model_path does not exist; falling back to model_name",
        )

    uri = (model_name or "").strip()
    if uri.startswith(("s3://", "file://")):
        from nlp.core.config import settings as _settings
        from nlp.models.source_resolver import (
            ModelWeightIdentity,
            config_for_model,
            config_from_settings,
            resolve_model_dir,
        )

        # Only `s3://` needs a credential ( follow-on,
        # `nlp.core.model_credentials`). `file://` stays on the
        # credential-free, gateway-independent config, so a pre-staged
        # on-prem file resolves even when the control plane cannot be
        # reached — the credential fetch would otherwise raise
        # `CredentialUnavailable` and break a resolve that never needed
        # the network at all.
        config = (
            await config_for_model(_settings.service)
            if uri.startswith("s3://")
            else config_from_settings(_settings.service)
        )
        resolved = await resolve_model_dir(
            ModelWeightIdentity(slug=model_name, source_uri=uri),
            config=config,
        )
        return str(resolved)

    return model_name


def _weight_key(cache_key: str, device: str | None) -> tuple[Any, ...]:
    """The weight registry key: the slot's weight identity, plus an explicit device.

    A copy placed on `cuda:1` is a different resident copy from the default one,
    so it never dedups against it (TASK-1055).
    """
    model_name, model_path = _split_cache_key(cache_key)
    return (model_name, model_path) if device is None else (model_name, model_path, device)


def _resolved_device(device: str | None) -> str:
    """The device a guard-plane runtime loads on: the explicit one, else the configured one.

    Both go through `resolve_inference_device`, so `cuda:<n>` past the last card
    fails closed exactly like an absent `cuda`.
    """
    from nlp.core.config import settings
    from nlp.core.device import resolve_inference_device

    return resolve_inference_device(
        device if device is not None else settings.service.inference_device
    )


def _transformers_placement(device: str | None) -> str | None:
    """Where a transformers-pipeline model loads (token / text classifier, suggester).

    Explicit (TASK-1055 planner) → that device, validated. Default → the configured
    inference device when it is a CUDA device, so the residency report (which
    accounts default caches to that device) and the weights agree; any other
    configuration keeps the pipelines' pre-TASK-1055 auto rule (None).
    """
    from nlp.core.device import DevicePlacementError

    if device is not None:
        return _resolved_device(device)
    try:
        resolved = _resolved_device(None)
    except DevicePlacementError:
        return None
    return resolved if resolved.startswith("cuda") else None


async def _create_token_classifier(cache_key: str, device: str | None = None) -> TokenClassifier:
    """The token-level runtime THIS checkpoint needs.

    F14 — `/classify/tokens` serves both families this service hosts and the
    choice is the CHECKPOINT's, read from its own `config.json`
    (`nlp.core.checkpoint_family`), never from a slug or a vendor prefix. A
    GLiNER-family checkpoint on the transformers pipeline raises "has model type
    `extractor` but Transformers does not recognize this architecture" — which
    is the 503 every workflow-lane PII node hit.
    """
    model_name, model_path = _split_cache_key(cache_key)
    source = await _weights_source(model_name, model_path)

    # Blocking (filesystem / a small cached download) — never on the event loop.
    config = await asyncio.to_thread(read_checkpoint_config, source)
    if is_gliner_checkpoint(config):
        return await _create_gliner_token_classifier(model_name, source, model_path, device=device)

    configs = TokenClassificationConfig(model_name=source, tokenizer_name=source)
    instance = TransformerTokenClassifier(configs=configs, device=_transformers_placement(device))
    await instance.initialize()
    return instance


async def _create_gliner_token_classifier(
    model_name: str, source: str, model_path: str | None = None, device: str | None = None
) -> TokenClassifier:
    """The `gliner2` extractor behind the token-classification contract.

    Placement is decided HERE, from configuration, before a tensor executes —
    the same rule `_create_gliner2_guard` follows, and for the same reason: an
    op the accelerator does not support aborts the PROCESS rather than raising.
    """
    from nlp.core.config import settings
    from nlp.core.device import parse_cpu_only_modules
    from nlp.services.gliner2_guard import Gliner2GuardService
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

    async def load() -> Gliner2GuardService:
        runtime = Gliner2GuardService(
            weights_source=source,
            model_id=model_name,
            device=_resolved_device(device),
            cpu_only_modules=parse_cpu_only_modules(
                settings.service.inference_device_cpu_only_modules
            ),
        )
        await asyncio.to_thread(runtime.load)
        return runtime

    # TASK-1047 C8: the guard cache may already hold these exact weights (on this device).
    runtime = await get_weight_registry().get_or_load(
        _weight_key(_model_cache_key(model_name, model_path), device), load
    )
    instance = Gliner2TokenClassifier(model_name=model_name, runtime=runtime)
    await instance.initialize()
    return instance


async def _create_text_classifier(cache_key: str, device: str | None = None) -> TextClassifier:
    model_name, model_path = _split_cache_key(cache_key)
    model_name = await _weights_source(model_name, model_path)
    config = TextClassificationConfig(model_name=model_name, tokenizer_name=model_name)
    instance = TransformerTextClassifier(config=config, device=_transformers_placement(device))
    await instance.initialize()
    if not instance.is_initialized:
        # Only the placeholder sentinel initializes "successfully" without
        # loading — refuse to cache a non-functional classifier.
        raise RuntimeError(f"text classification model failed to load: {model_name}")
    return instance


# The suggester runs TWO models, so its slot key carries BOTH weight
# identities: the disease classifier AND the NER it extracts symptoms with.
# Keying on the disease model alone would serve a cached instance whose NER is
# whichever one an earlier request happened to select.
def _suggester_cache_key(
    model_name: str, model_path: str | None, ner_model_name: str, ner_model_path: str | None
) -> str:
    return _KEY_SEP.join((model_name, model_path or "", ner_model_name, ner_model_path or ""))


def _split_suggester_cache_key(key: str) -> tuple[str, str | None, str, str | None]:
    """Inverse of `_suggester_cache_key` (the factory receives the composed key)."""
    model_name, model_path, ner_model_name, ner_model_path = key.split(_KEY_SEP)
    return model_name, model_path or None, ner_model_name, ner_model_path or None


async def _create_medical_suggester(cache_key: str, device: str | None = None) -> MedicalSuggester:
    model_name, model_path, ner_model_name, ner_model_path = _split_suggester_cache_key(cache_key)
    source = await _weights_source(model_name, model_path)
    config = MedicalSuggesterConfig(model_name=source, tokenizer_name=source)
    # The internal NER is the caller's selection too. It used to be the process
    # singleton — i.e. the hardcoded default — which is how half of this route
    # stayed un-configurable while the other half was gateway-injected. A
    # DEDICATED instance, not one borrowed from the token-classifier cache: the
    # suggester's own eviction calls `shutdown()` on it, which would unload
    # weights that cache still believes it is serving.
    ner_source = await _weights_source(ner_model_name, ner_model_path)
    # Both models of one slot live on ONE device — the slot's.
    placement = _transformers_placement(device)
    instance = MedicalSuggester(
        config=config,
        token_classifier=TransformerTokenClassifier(
            configs=TokenClassificationConfig(model_name=ner_source, tokenizer_name=ner_source),
            device=placement,
        ),
        device=placement,
    )
    # `MedicalSuggester.initialize()` initializes its NER as well.
    await instance.initialize()
    return instance


# The three singletons are built FROM the resolved retention
# config instead of silently taking the module defaults, and are reconfigurable
# at runtime from the control plane.
_CACHE_GLOBALS = (
    "_token_classifier_cache_instance",
    "_text_classifier_cache_instance",
    "_medical_suggester_cache_instance",
    # Phases 3 & 6 — the guardrail-class models moved here.
    "_gliner2_guard_cache_instance",
    "_entailment_scorer_cache_instance",
    # TASK-1049 R2 — the sequence-classification guard runtime.
    "_seq_cls_guard_cache_instance",
    # TASK-1050 §12 — the generative guard judge (qwen3guard_native).
    "_judge_guard_cache_instance",
)


# Last retention seen from the control plane. Held here so a cache built AFTER
# a refresh is born with the current values rather than the bootstrap ones —
# the caches are lazy, so most are constructed long after the first refresh.
_current_retention: dict[str, int] = {}


def _retention_kwargs(placement: str | None = None) -> dict[str, Any]:
    """Resolved retention: control-plane value when known, else settings.

    ``placement`` binds the residency wiring to that device (TASK-1055); every
    other value is the same for every device's cache.
    """
    from nlp.core.config import settings
    from nlp.core.metrics import build_model_cache_metrics_sink
    from nlp.residency import nlp_cache_residency

    return {
        "ttl_seconds": _current_retention.get(
            "ttl_seconds", settings.service.model_cache_ttl_seconds
        ),
        "max_size": _current_retention.get("max_models", settings.service.model_cache_max_models),
        "metrics": build_model_cache_metrics_sink(),
        # TASK-1005 — measured RSS footprints + residency metrics; admission off.
        "residency": nlp_cache_residency(placement),
    }


#: slot (= cache name on the residency report) → (default-device cache global,
#: factory attribute). Factories are looked up when a cache is BUILT, so a test
#: that replaces one before first use is honoured.
_SLOTS: dict[str, tuple[str, str]] = {
    "nlp_token_classifier": ("_token_classifier_cache_instance", "_create_token_classifier"),
    "nlp_text_classifier": ("_text_classifier_cache_instance", "_create_text_classifier"),
    "nlp_medical_suggester": ("_medical_suggester_cache_instance", "_create_medical_suggester"),
    "nlp_gliner2_guard": ("_gliner2_guard_cache_instance", "_create_gliner2_guard"),
    "nlp_entailment_scorer": ("_entailment_scorer_cache_instance", "_create_entailment_scorer"),
    "nlp_seq_cls_guard": ("_seq_cls_guard_cache_instance", "_create_seq_cls_guard"),
    "nlp_judge_guard": ("_judge_guard_cache_instance", "_create_judge_guard"),
}

#: llama.cpp holds no torch parameters: its footprint stays the device delta.
_UNMEASURED_SLOTS = frozenset({"nlp_entailment_scorer"})

#: TASK-1055 — (slot, explicit device) → its cache. The default device's caches
#: stay in the `_CACHE_GLOBALS` singletons.
_device_caches: dict[tuple[str, str], ModelCache[Any]] = {}


async def _call_shutdown(obj: Any) -> None:
    """``obj.shutdown()`` — awaited when async, off the event loop when sync."""
    shutdown = getattr(obj, "shutdown", None)
    if shutdown is None:
        return
    if inspect.iscoroutinefunction(shutdown):
        await shutdown()
        return
    result = await asyncio.to_thread(shutdown)
    if inspect.isawaitable(result):
        await result


async def _shutdown_instance(slot: str, key: str, instance: Any, placement: str | None) -> None:
    """Drop every reference ``instance`` holds — the shared GLiNER2 runtime last.

    The guard cache's instance IS the shared runtime; the token-classifier cache's
    GLiNER adapter merely holds it. Either way the runtime is shut down only when
    the weight registry says this was its LAST holder.
    """
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

    registry = get_weight_registry()
    if slot == "nlp_gliner2_guard":
        if registry.release(_weight_key(key, placement), instance):
            await _call_shutdown(instance)
        return
    if isinstance(instance, Gliner2TokenClassifier):
        runtime = instance.runtime
        await _call_shutdown(instance)
        if runtime is not None and registry.release(_weight_key(key, placement), runtime):
            await _call_shutdown(runtime)
        return
    await _call_shutdown(instance)


def _unload_hook(
    slot: str, device_id: str, placement: str | None
) -> Callable[[str, Any], Awaitable[None]]:
    """The cache's ``unload=``: real shutdown, then the freed blocks back to the driver.

    TASK-1055 E6: without the release, torch's caching allocator keeps the blocks
    reserved and the card's free memory never rises — the unload "succeeded" and
    the next load's measured footprint was wrong. The release runs even when the
    shutdown raised (the cache logs that failure and still drops the entry).
    """

    async def unload(key: str, instance: Any) -> None:
        try:
            await _shutdown_instance(slot, key, instance, placement)
        finally:
            await asyncio.to_thread(release_accelerator_memory, device_id)

    return unload


def _build_cache(slot: str, placement: str | None) -> ModelCache[Any]:
    from nlp.residency import measure_instance

    factory = globals()[_SLOTS[slot][1]]
    if placement is not None:
        factory = functools.partial(factory, device=placement)
    kwargs = _retention_kwargs(placement)
    return ModelCache(
        factory=factory,
        name=slot,
        unload=_unload_hook(slot, kwargs["residency"].device.id, placement),
        measure=None if slot in _UNMEASURED_SLOTS else measure_instance,
        **kwargs,
    )


def _cache_for(slot: str, device: str | None = None) -> ModelCache[Any]:
    """The ``slot`` cache bound to ``device`` (None / the default id = the default cache).

    One cache per (slot, device), built lazily; an unseen device raises
    `DeviceUnavailable`.
    """
    from nlp.residency import resolve_placement

    placement = resolve_placement(device)
    if placement is None:
        global_name = _SLOTS[slot][0]
        if globals().get(global_name) is None:
            globals()[global_name] = _build_cache(slot, None)
        return cast("ModelCache[Any]", globals()[global_name])
    cache = _device_caches.get((slot, placement))
    if cache is None:
        cache = _device_caches[(slot, placement)] = _build_cache(slot, placement)
    return cache


def _route(slot: str, key: str) -> ModelCache[Any]:
    """The cache a REQUEST for ``key`` uses (TASK-1055).

    The default device's, unless the model is resident only on another device —
    an admin who loaded it on `cuda:1` gets it served from there instead of a
    second copy cold-loaded onto the default card.

    Loaded wins over loading: the default copy, then another device's; then a load
    IN FLIGHT — the default's, then another device's (review R1-F6: an admin's
    placed load still running is joined through its single-flight future, never
    raced by a second cold load here). Only when no device has the model loaded
    or loading does the request load on the default cache.
    """
    default = _cache_for(slot)
    if key in default.cached_keys():
        return default
    siblings = [cache for (cache_slot, _d), cache in _device_caches.items() if cache_slot == slot]
    for cache in siblings:
        if key in cache.cached_keys():
            return cache
    if _in_flight(default, key):
        return default
    for cache in siblings:
        if _in_flight(cache, key):
            return cache
    return default


#: Slots whose key is exactly `_model_cache_key(model_name, model_path)`. The
#: suggester (two weight identities) and the entailment scorer (calibration folded
#: in) compose other keys and are never aliased.
_WEIGHT_KEYED_SLOTS = frozenset(
    {
        "nlp_token_classifier",
        "nlp_text_classifier",
        "nlp_gliner2_guard",
        "nlp_seq_cls_guard",
        "nlp_judge_guard",
    }
)


def _serving_key(slot: str, key: str) -> str:
    """The key a REQUEST for ``key`` is served under (TASK-1055 cluster e2e).

    A request that names NO path asks for the model's own weights. The residency
    agent loads with the row's derived path, while the clinical NER callers
    (`resolveNerModelInjection`, the harness `_extract_clinical_entities`) send the
    name alone — so the admin's copy sat under `name\\x00path` and a live request
    keyed `name` cold-loaded a second one. Such a request is served by the resident
    (or in-flight) copy of the same `model_name` when exactly ONE path variant of it
    exists on any device; with none, or with two that disagree, it keeps its own
    key. A request that names a path is never aliased: a different path is
    different weights, and a name-only copy's weights are whatever the id resolved
    to, which this service cannot prove equal to the named path.
    """
    if slot not in _WEIGHT_KEYED_SLOTS or _KEY_SEP in key:
        return key
    caches = [_cache_for(slot)] + [c for (s, _d), c in _device_caches.items() if s == slot]
    if any(key in c.cached_keys() or _in_flight(c, key) for c in caches):
        return key
    prefix = f"{key}{_KEY_SEP}"
    variants = {
        candidate
        for cache in caches
        for candidate in [*cache.cached_keys(), *getattr(cache, "_inflight", {})]
        if candidate.startswith(prefix)
    }
    return variants.pop() if len(variants) == 1 else key


def _in_flight(cache: ModelCache[Any], key: str) -> bool:
    """Whether ``cache`` has a load of ``key`` running (its single-flight future).

    The shared cache exposes no public accessor for this; `_inflight` is set the
    moment a load is claimed (before admission and the factory), which is exactly
    the window a racing request must see.
    """
    return key in getattr(cache, "_inflight", {})


def _live_caches() -> list[ModelCache[Any]]:
    """Every INSTANTIATED cache, every device (never forces construction)."""
    defaults = [cache for name in _CACHE_GLOBALS if (cache := globals().get(name)) is not None]
    return defaults + list(_device_caches.values())


# Health-check component name -> its backing cache global. These three
# components are served per-request from a ModelCache (see `pinned_*`), NOT from
# the `get_*` singletons, so their health must be read from the cache — the
# singletons are never initialized by REST inference (BUG-010).
_COMPONENT_CACHE_GLOBALS = {
    "text_classifier": "_text_classifier_cache_instance",
    "token_classifier": "_token_classifier_cache_instance",
    "medical_suggester": "_medical_suggester_cache_instance",
}
_COMPONENT_SLOTS = {
    "text_classifier": "nlp_text_classifier",
    "token_classifier": "nlp_token_classifier",
    "medical_suggester": "nlp_medical_suggester",
}


def model_cache_snapshot() -> dict[str, list[str]]:
    """Resident model ids per cache-backed component, for the health endpoint.

    Reads the cache singletons WITHOUT forcing construction: a component whose
    cache has never been touched (a cold, freshly-booted worker) reports an
    empty list, which is the correct lazy state — not a fault.
    """
    snapshot: dict[str, list[str]] = {}
    for component, global_name in _COMPONENT_CACHE_GLOBALS.items():
        cache = globals().get(global_name)
        models = cache.cached_models() if cache is not None else []
        # TASK-1055: a model loaded on another device is resident too.
        for (slot, _device), placed in _device_caches.items():
            if slot == _COMPONENT_SLOTS[component]:
                models += [key for key in placed.cached_models() if key not in models]
        snapshot[component] = models
    return snapshot


def apply_model_cache_retention(retention: dict[str, int]) -> None:
    """Adopt control-plane retention across all three caches.

    An ABSENT key keeps the current value, so a gateway outage leaves behaviour
    byte-identical. Resident models are never dropped — the new limits take
    effect on the next sweep or access. The product clamp [60, 3600] is
    re-applied inside the shared cache.
    """
    ttl_seconds = retention.get("ttl_seconds")
    max_models = retention.get("max_models")
    if ttl_seconds is None and max_models is None:
        return

    _current_retention.update(
        {k: v for k, v in retention.items() if k in ("ttl_seconds", "max_models") and v is not None}
    )

    for cache in _live_caches():
        cache.configure(ttl_seconds=ttl_seconds, max_size=max_models)


async def sweep_model_caches() -> int:
    """Release idle-expired models across all three caches; returns how many.

    Driven by a periodic task so an idle model whose key is never requested
    again is still released — a cache that only evicts lazily on access would
    retain such a model forever despite its TTL.
    """
    swept = 0
    for cache in _live_caches():
        swept += await cache.sweep()
    return swept


def reset_model_caches() -> None:
    """Drop the cache singletons (tests only — does not unload live models)."""
    for name in _CACHE_GLOBALS:
        globals()[name] = None
    _device_caches.clear()
    _current_retention.clear()
    from nlp.residency import reset_placement_devices

    reset_placement_devices()
    # TASK-1049 F10: results derived from those models go with them.
    from nlp.services.ner_result_cache import reset_ner_result_cache

    reset_ner_result_cache()


def _token_classifier_cache(device: str | None = None) -> ModelCache[TokenClassifier]:
    return cast("ModelCache[TokenClassifier]", _cache_for("nlp_token_classifier", device))


def _text_classifier_cache(device: str | None = None) -> ModelCache[TextClassifier]:
    return cast("ModelCache[TextClassifier]", _cache_for("nlp_text_classifier", device))


def _medical_suggester_cache(device: str | None = None) -> ModelCache[MedicalSuggester]:
    return cast("ModelCache[MedicalSuggester]", _cache_for("nlp_medical_suggester", device))


async def get_token_classifier_for(model_name: str, device: str | None = None) -> TokenClassifier:
    """Resolve (lazily loading) the token classifier for a required model name."""
    return await _token_classifier_cache(device).get(model_name)


def _refuse_doc_type_sentinel(model_name: str) -> None:
    if model_name == UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL:
        # The placeholder sentinel is never a loadable model — the doc-type
        # classifier stays fail-closed until a real model is configured in DB.
        raise RuntimeError("the doc-type classifier placeholder sentinel is not a loadable model")


async def get_text_classifier_for(model_name: str, device: str | None = None) -> TextClassifier:
    """Resolve (lazily loading) the doc-type text classifier for a required model name."""
    _refuse_doc_type_sentinel(model_name)
    return await _text_classifier_cache(device).get(model_name)


async def get_medical_suggester_for(model_name: str, device: str | None = None) -> MedicalSuggester:
    """Resolve (lazily loading) the medical suggester for a required classification model."""
    return await _medical_suggester_cache(device).get(model_name)


# ---------------------------------------------------------------------------
# Pin-while-active resolvers.
#
# Route handlers use these async context managers: the resolved model is pinned
# for the request duration (never evicted mid-flight) and unpinned afterwards.
# A load failure surfaces as `ModelUnavailableError` so the route can fail
# closed with HTTP 503.
# ---------------------------------------------------------------------------


@asynccontextmanager
async def pinned_token_classifier(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[TokenClassifier]:
    # Pin the (model_name, model_path) slot; `model_path` defaults to
    # None so every existing caller keeps its exact slot and behaviour.
    key = _serving_key("nlp_token_classifier", _model_cache_key(model_name, model_path))
    cache = cast("ModelCache[TokenClassifier]", _route("nlp_token_classifier", key))
    await cache.pin(key)
    try:
        try:
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


@asynccontextmanager
async def pinned_text_classifier(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[TextClassifier]:
    # Pin the (model_name, model_path) slot; `model_path` defaults to
    # None so every existing caller keeps its exact slot and behaviour.
    key = _serving_key("nlp_text_classifier", _model_cache_key(model_name, model_path))
    cache = cast("ModelCache[TextClassifier]", _route("nlp_text_classifier", key))
    await cache.pin(key)
    try:
        try:
            _refuse_doc_type_sentinel(key)
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


@asynccontextmanager
async def pinned_medical_suggester(
    model_name: str,
    model_path: str | None,
    ner_model_name: str,
    ner_model_path: str | None = None,
) -> AsyncIterator[MedicalSuggester]:
    # Pin the (disease model, NER model) slot — both selections are required.
    key = _suggester_cache_key(model_name, model_path, ner_model_name, ner_model_path)
    cache = cast("ModelCache[MedicalSuggester]", _route("nlp_medical_suggester", key))
    await cache.pin(key)
    try:
        try:
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


# ---------------------------------------------------------------------------
# Guardrail-class models ( Phases 3 & 6).
#
# `apps/guardrail` holds ZERO resident weights: its GLiNER detector and its
# MiniCheck groundedness scorer live here now, behind the same per-slot,
# idle-TTL, pin-while-active cache the NER/classifier models use. Both are
# selected BY THE CALLER (`AiRoutingPolicy` ⋈ `AiModel`, tenant-first) and
# arrive per request — no model id is named in this file.
# ---------------------------------------------------------------------------


async def _create_gliner2_guard(cache_key: str, device: str | None = None) -> Any:
    from nlp.core.config import settings
    from nlp.core.device import parse_cpu_only_modules
    from nlp.core.guard_model_reference import resolve_guard_weights_source
    from nlp.services.gliner2_guard import Gliner2GuardService

    model_name, model_path = _split_cache_key(cache_key)
    # NOT `_weights_source`: that helper (mirrored from apps/stt) treats a
    # set-but-missing path as a warning and falls through to the hub id, which
    # for the safety plane means silently serving a different model than the
    # admin configured — and pulling it from the internet on a host that
    # deliberately staged its weights. The guard plane fails CLOSED instead
    # (owner addition); the reference may be a hub id OR a local path.
    # Placement is decided HERE, from configuration, before a single tensor
    # executes: an op the accelerator does not support aborts the process
    # instead of raising, so there is no "try it and fall back".
    # Resolved (and fail-closed validated) BEFORE the shared registry is
    # consulted, so reuse can never serve weights for a reference that does not
    # resolve.
    weights_source = resolve_guard_weights_source(model_name, model_path)

    async def load() -> Gliner2GuardService:
        service = Gliner2GuardService(
            weights_source=weights_source,
            model_id=model_name,
            device=_resolved_device(device),
            cpu_only_modules=parse_cpu_only_modules(
                settings.service.inference_device_cpu_only_modules
            ),
        )
        # GLiNER2 load is blocking/CPU-bound — keep the event loop responsive.
        await asyncio.to_thread(service.load)
        return service

    # TASK-1047 C8: one resident copy per weight identity (and device), shared
    # with the token-classifier cache.
    return await get_weight_registry().get_or_load(_weight_key(cache_key, device), load)


async def _create_seq_cls_guard(cache_key: str, device: str | None = None) -> Any:
    """The sequence-classification guard runtime (TASK-1049 R2).

    Same fail-closed reference resolution as `_create_gliner2_guard` — a staged
    path that is missing raises instead of falling through to a hub download.
    NOT routed through the weight registry: no other cache serves these weights,
    and a registry entry keyed only by `(model_name, model_path)` could hand a
    GLiNER2 slot this object (or the reverse) under a misconfigured row.
    """
    from nlp.core.guard_model_reference import resolve_guard_weights_source
    from nlp.services.seq_cls_guard import SeqClsGuardService

    model_name, model_path = _split_cache_key(cache_key)
    service = SeqClsGuardService(
        weights_source=resolve_guard_weights_source(model_name, model_path),
        model_id=model_name,
        device=_resolved_device(device),
    )
    await asyncio.to_thread(service.load)
    return service


async def _create_judge_guard(cache_key: str, device: str | None = None) -> Any:
    """The generative guard judge (TASK-1050 §12, `qwen3guard_native`).

    Fail-closed reference resolution, exactly as the other guard runtimes.
    """
    from nlp.core.guard_model_reference import resolve_guard_weights_source
    from nlp.services.qwen3guard_judge import Qwen3GuardJudgeService

    model_name, model_path = _split_cache_key(cache_key)
    service = Qwen3GuardJudgeService(
        weights_source=resolve_guard_weights_source(model_name, model_path),
        model_id=model_name,
        device=_resolved_device(device),
    )
    await asyncio.to_thread(service.load)
    return service


#: `cache_key -> EntailmentCalibration` for the load currently being requested.
#: The cache factory receives only the slot key, but the calibration is part of
#: the slot's IDENTITY (it is folded into the key by `_entailment_cache_key`), so
#: a changed calibration is a cache MISS and this map is read exactly once per
#: construction. Entries are dropped as soon as the factory has consumed them.
_pending_entailment_calibration: dict[str, Any] = {}


async def _create_entailment_scorer(cache_key: str, device: str | None = None) -> Any:
    from nlp.core.config import settings
    from nlp.core.device import cuda_index
    from nlp.services.entailment_scorer import MiniCheckLoadSpec, load_minicheck_scorer

    model_name, model_path = _split_cache_key(cache_key)
    # The clinical gate NEVER auto-downloads: the GGUF must be staged, and the
    # path comes from the caller's registry row, not from an env var here. The
    # calibration comes from that same row — absent ⇒ `load_minicheck_scorer`
    # refuses (fail-closed), it does not substitute a MiniCheck default.
    # Host fact, like `inference_device` (TASK-1031): 0 on the CPU image.
    n_gpu_layers = settings.service.entailment_n_gpu_layers
    main_gpu: int | None = None
    if device is not None:
        # TASK-1055: an explicit placement pins the WHOLE model to that card
        # (llama.cpp would otherwise split layers across every visible GPU);
        # an explicit `cpu` offloads nothing.
        placed = _resolved_device(device)
        main_gpu = cuda_index(placed)
        if main_gpu is None:
            n_gpu_layers = 0
    elif n_gpu_layers != 0:
        # An unplaced GPU-offloaded load stays whole on the first card: with both
        # GPUs visible, llama.cpp would otherwise split its layers across them.
        main_gpu = 0
    spec = MiniCheckLoadSpec(
        model_id=model_name,
        model_path=model_path,
        calibration=_pending_entailment_calibration.pop(cache_key, None),
        n_gpu_layers=n_gpu_layers,
        main_gpu=main_gpu,
    )
    return await asyncio.to_thread(load_minicheck_scorer, spec)


def _gliner2_guard_cache(device: str | None = None) -> ModelCache[Any]:
    return _cache_for("nlp_gliner2_guard", device)


def _seq_cls_guard_cache(device: str | None = None) -> ModelCache[Any]:
    return _cache_for("nlp_seq_cls_guard", device)


def _judge_guard_cache(device: str | None = None) -> ModelCache[Any]:
    return _cache_for("nlp_judge_guard", device)


def _entailment_scorer_cache(device: str | None = None) -> ModelCache[Any]:
    return _cache_for("nlp_entailment_scorer", device)


@asynccontextmanager
async def pinned_gliner2_guard(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the GLiNER2 guard runtime for one request."""
    key = _serving_key("nlp_gliner2_guard", _model_cache_key(model_name, model_path))
    cache = _route("nlp_gliner2_guard", key)
    await cache.pin(key)
    try:
        try:
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


@asynccontextmanager
async def pinned_seq_cls_guard(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the sequence-classification guard for one request."""
    key = _serving_key("nlp_seq_cls_guard", _model_cache_key(model_name, model_path))
    cache = _route("nlp_seq_cls_guard", key)
    await cache.pin(key)
    try:
        try:
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


@asynccontextmanager
async def pinned_judge_guard(model_name: str, model_path: str | None = None) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the generative guard judge for one request."""
    key = _serving_key("nlp_judge_guard", _model_cache_key(model_name, model_path))
    cache = _route("nlp_judge_guard", key)
    await cache.pin(key)
    try:
        try:
            service = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


def _entailment_cache_key(model_name: str, model_path: str | None, calibration: Any) -> str:
    """Slot key = weight identity + calibration identity.

    The calibration is part of what the loaded object IS (it is what the
    fail-closed self-check was run against), so an admin retuning the tolerances
    must be a cache MISS. Keying on the weights alone would keep serving a scorer
    validated against the OLD bounds under the new configuration.
    """
    base = _model_cache_key(model_name, model_path)
    return base if calibration is None else f"{base}{_KEY_SEP}{calibration.model_dump_json()}"


@asynccontextmanager
async def pinned_entailment_scorer(
    model_name: str, model_path: str | None = None, calibration: Any = None
) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the MiniCheck NLI scorer for one request."""
    key = _entailment_cache_key(model_name, model_path, calibration)
    if calibration is not None:
        _pending_entailment_calibration[key] = calibration
    cache = _route("nlp_entailment_scorer", key)
    await cache.pin(key)
    try:
        try:
            scorer = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield scorer
    finally:
        await cache.unpin(key)
