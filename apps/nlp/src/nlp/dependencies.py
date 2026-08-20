import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

import structlog
from fastapi import Request

from nlp.core.concurrency import ResizableSemaphore, refresh_inference_limit
from nlp.core.config import (
    UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL,
    MedicalSuggesterConfig,
    TextClassificationConfig,
    TokenClassificationConfig,
)
from nlp.core.websocket_manager import WebSocketManager
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


def get_external_text_client(request: Request) -> ExternalTextClient | None:
    """Retrieve apps/nlp's peer client to `text` from app.state (TASK-729).

    None only if lifespan never ran (e.g. an app built directly in a test
    without the lifespan context) — the `/classify/topic`/`/classify/intent`
    handlers fail closed (503) in that case, the same posture as a missing
    gateway-injected `model_name` on `/classify/text`.
    """
    return getattr(request.app.state, "external_text_client", None)


def get_text_classifier() -> TextClassifier:
    if globals().get("_text_classifier_instance") is None:
        globals()["_text_classifier_instance"] = TransformerTextClassifier()
    return cast(TextClassifier, globals()["_text_classifier_instance"])


def get_token_classifier() -> TokenClassifier:
    if globals().get("_token_classifier_instance") is None:
        globals()["_token_classifier_instance"] = TransformerTokenClassifier()
    return cast(TokenClassifier, globals()["_token_classifier_instance"])


def get_text_corrector() -> TextCorrector:
    if globals().get("_text_corrector_instance") is None:
        globals()["_text_corrector_instance"] = SymSpellCorrector()
    return cast(TextCorrector, globals()["_text_corrector_instance"])


def get_medical_suggester() -> MedicalSuggester:
    if globals().get("_medical_suggester_instance") is None:
        globals()["_medical_suggester_instance"] = MedicalSuggester(
            token_classifier=get_token_classifier()
        )
    return cast(MedicalSuggester, globals()["_medical_suggester_instance"])


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
# gateway-injected `AiModel.sourceUri` resolved from the DB AiTaskDefault
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


def _weights_source(model_name: str, model_path: str | None) -> str:
    """What `from_pretrained` should load: the staged path when usable, else the id.

    A set-but-missing path falls THROUGH to the hub id with a warning rather than
    failing the request — the same precedence the other three services apply.
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
    return model_name


async def _create_token_classifier(cache_key: str) -> TokenClassifier:
    model_name, model_path = _split_cache_key(cache_key)
    source = _weights_source(model_name, model_path)
    configs = TokenClassificationConfig(model_name=source, tokenizer_name=source)
    instance = TransformerTokenClassifier(configs=configs)
    await instance.initialize()
    return instance


async def _create_text_classifier(cache_key: str) -> TextClassifier:
    model_name, model_path = _split_cache_key(cache_key)
    model_name = _weights_source(model_name, model_path)
    config = TextClassificationConfig(model_name=model_name, tokenizer_name=model_name)
    instance = TransformerTextClassifier(config=config)
    await instance.initialize()
    if not instance.is_initialized:
        # Only the placeholder sentinel initializes "successfully" without
        # loading — refuse to cache a non-functional classifier.
        raise RuntimeError(f"text classification model failed to load: {model_name}")
    return instance


async def _create_medical_suggester(cache_key: str) -> MedicalSuggester:
    model_name, model_path = _split_cache_key(cache_key)
    model_name = _weights_source(model_name, model_path)
    # Overrides ONLY the disease-classification model — the internal NER stays
    # the default token classifier (already initialized; initialize() is
    # idempotent so the shared instance is never reloaded).
    config = MedicalSuggesterConfig(model_name=model_name, tokenizer_name=model_name)
    instance = MedicalSuggester(config=config, token_classifier=get_token_classifier())
    await instance.initialize()
    return instance


# The three singletons are built FROM the resolved retention
# config instead of silently taking the module defaults, and are reconfigurable
# at runtime from the control plane.
_CACHE_GLOBALS = (
    "_token_classifier_cache_instance",
    "_text_classifier_cache_instance",
    "_medical_suggester_cache_instance",
    # TASK-735 Phases 3 & 6 — the guardrail-class models moved here.
    "_gliner2_guard_cache_instance",
    "_entailment_scorer_cache_instance",
)


# Last retention seen from the control plane. Held here so a cache built AFTER
# a refresh is born with the current values rather than the bootstrap ones —
# the caches are lazy, so most are constructed long after the first refresh.
_current_retention: dict[str, int] = {}


def _retention_kwargs() -> dict[str, Any]:
    """Resolved retention: control-plane value when known, else settings."""
    from nlp.core.config import settings
    from nlp.core.metrics import build_model_cache_metrics_sink

    return {
        "ttl_seconds": _current_retention.get(
            "ttl_seconds", settings.service.model_cache_ttl_seconds
        ),
        "max_size": _current_retention.get("max_models", settings.service.model_cache_max_models),
        "metrics": build_model_cache_metrics_sink(),
    }


def _live_caches() -> list[ModelCache[Any]]:
    """Every INSTANTIATED cache singleton (never forces construction)."""
    return [cache for name in _CACHE_GLOBALS if (cache := globals().get(name)) is not None]


# Health-check component name -> its backing cache global. These three
# components are served per-request from a ModelCache (see `pinned_*`), NOT from
# the `get_*` singletons, so their health must be read from the cache — the
# singletons are never initialized by REST inference (BUG-010).
_COMPONENT_CACHE_GLOBALS = {
    "text_classifier": "_text_classifier_cache_instance",
    "token_classifier": "_token_classifier_cache_instance",
    "medical_suggester": "_medical_suggester_cache_instance",
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
        snapshot[component] = cache.cached_models() if cache is not None else []
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
    _current_retention.clear()


def _token_classifier_cache() -> ModelCache[TokenClassifier]:
    if globals().get("_token_classifier_cache_instance") is None:
        globals()["_token_classifier_cache_instance"] = ModelCache(
            factory=_create_token_classifier, name="nlp_token_classifier", **_retention_kwargs()
        )
    return cast("ModelCache[TokenClassifier]", globals()["_token_classifier_cache_instance"])


def _text_classifier_cache() -> ModelCache[TextClassifier]:
    if globals().get("_text_classifier_cache_instance") is None:
        globals()["_text_classifier_cache_instance"] = ModelCache(
            factory=_create_text_classifier, name="nlp_text_classifier", **_retention_kwargs()
        )
    return cast("ModelCache[TextClassifier]", globals()["_text_classifier_cache_instance"])


def _medical_suggester_cache() -> ModelCache[MedicalSuggester]:
    if globals().get("_medical_suggester_cache_instance") is None:
        globals()["_medical_suggester_cache_instance"] = ModelCache(
            factory=_create_medical_suggester, name="nlp_medical_suggester", **_retention_kwargs()
        )
    return cast("ModelCache[MedicalSuggester]", globals()["_medical_suggester_cache_instance"])


async def get_token_classifier_for(model_name: str) -> TokenClassifier:
    """Resolve (lazily loading) the token classifier for a required model name."""
    return await _token_classifier_cache().get(model_name)


async def get_text_classifier_for(model_name: str) -> TextClassifier:
    """Resolve (lazily loading) the doc-type text classifier for a required model name."""
    if model_name == UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL:
        # The placeholder sentinel is never a loadable model — the doc-type
        # classifier stays fail-closed until a real model is configured in DB.
        raise RuntimeError("the doc-type classifier placeholder sentinel is not a loadable model")
    return await _text_classifier_cache().get(model_name)


async def get_medical_suggester_for(model_name: str) -> MedicalSuggester:
    """Resolve (lazily loading) the medical suggester for a required classification model."""
    return await _medical_suggester_cache().get(model_name)


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
    key = _model_cache_key(model_name, model_path)
    cache = _token_classifier_cache()
    await cache.pin(key)
    try:
        try:
            service = await get_token_classifier_for(key)
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
    key = _model_cache_key(model_name, model_path)
    cache = _text_classifier_cache()
    await cache.pin(key)
    try:
        try:
            service = await get_text_classifier_for(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


@asynccontextmanager
async def pinned_medical_suggester(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[MedicalSuggester]:
    # Pin the (model_name, model_path) slot; `model_path` defaults to
    # None so every existing caller keeps its exact slot and behaviour.
    key = _model_cache_key(model_name, model_path)
    cache = _medical_suggester_cache()
    await cache.pin(key)
    try:
        try:
            service = await get_medical_suggester_for(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield service
    finally:
        await cache.unpin(key)


# ---------------------------------------------------------------------------
# Guardrail-class models (TASK-735 Phases 3 & 6).
#
# `apps/guardrail` holds ZERO resident weights: its GLiNER detector and its
# MiniCheck groundedness scorer live here now, behind the same per-slot,
# idle-TTL, pin-while-active cache the NER/classifier models use. Both are
# selected BY THE CALLER (`AiTaskDefault` ⋈ `AiModel`, tenant-first) and
# arrive per request — no model id is named in this file.
# ---------------------------------------------------------------------------


async def _create_gliner2_guard(cache_key: str) -> Any:
    from nlp.core.config import settings
    from nlp.core.device import parse_cpu_only_modules, resolve_inference_device
    from nlp.core.guard_model_reference import resolve_guard_weights_source
    from nlp.services.gliner2_guard import Gliner2GuardService

    model_name, model_path = _split_cache_key(cache_key)
    # NOT `_weights_source`: that helper (mirrored from apps/stt) treats a
    # set-but-missing path as a warning and falls through to the hub id, which
    # for the safety plane means silently serving a different model than the
    # admin configured — and pulling it from the internet on a host that
    # deliberately staged its weights. The guard plane fails CLOSED instead
    # (owner addition, TASK-778); the reference may be a hub id OR a local path.
    # Placement is decided HERE, from configuration, before a single tensor
    # executes: an op the accelerator does not support aborts the process
    # instead of raising, so there is no "try it and fall back" (TASK-782).
    service = Gliner2GuardService(
        weights_source=resolve_guard_weights_source(model_name, model_path),
        model_id=model_name,
        device=resolve_inference_device(settings.service.inference_device),
        cpu_only_modules=parse_cpu_only_modules(
            settings.service.inference_device_cpu_only_modules
        ),
    )
    # GLiNER2 load is blocking/CPU-bound — keep the event loop responsive.
    await asyncio.to_thread(service.load)
    return service


async def _create_entailment_scorer(cache_key: str) -> Any:
    from nlp.services.entailment_scorer import MiniCheckLoadSpec, load_minicheck_scorer

    model_name, model_path = _split_cache_key(cache_key)
    # The clinical gate NEVER auto-downloads: the GGUF must be staged, and the
    # path comes from the caller's registry row, not from an env var here.
    spec = MiniCheckLoadSpec(model_id=model_name, model_path=model_path)
    return await asyncio.to_thread(load_minicheck_scorer, spec)


def _gliner2_guard_cache() -> ModelCache[Any]:
    if globals().get("_gliner2_guard_cache_instance") is None:
        globals()["_gliner2_guard_cache_instance"] = ModelCache(
            factory=_create_gliner2_guard, name="nlp_gliner2_guard", **_retention_kwargs()
        )
    return cast("ModelCache[Any]", globals()["_gliner2_guard_cache_instance"])


def _entailment_scorer_cache() -> ModelCache[Any]:
    if globals().get("_entailment_scorer_cache_instance") is None:
        globals()["_entailment_scorer_cache_instance"] = ModelCache(
            factory=_create_entailment_scorer, name="nlp_entailment_scorer", **_retention_kwargs()
        )
    return cast("ModelCache[Any]", globals()["_entailment_scorer_cache_instance"])


@asynccontextmanager
async def pinned_gliner2_guard(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the GLiNER2 guard runtime for one request."""
    key = _model_cache_key(model_name, model_path)
    cache = _gliner2_guard_cache()
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
async def pinned_entailment_scorer(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    """Resolve + lazily load + pin the MiniCheck NLI scorer for one request."""
    key = _model_cache_key(model_name, model_path)
    cache = _entailment_scorer_cache()
    await cache.pin(key)
    try:
        try:
            scorer = await cache.get(key)
        except Exception as e:
            raise ModelUnavailableError(str(e)) from e
        yield scorer
    finally:
        await cache.unpin(key)
