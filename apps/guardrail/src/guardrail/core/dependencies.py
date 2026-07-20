"""FastAPI dependency injection for Guardrail service."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, cast

from fastapi import Request

from guardrail.core.logging import get_logger
from guardrail.core.metrics import build_model_cache_metrics_sink
from guardrail.services.model_cache import ModelCache, ModelUnavailableError

logger = get_logger(__name__)

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from guardrail.core.config import Settings
    from guardrail.providers.gliner import GlinerProvider
    from guardrail.providers.guardian import GuardianProvider
    from guardrail.providers.ollama import OllamaProvider
    from guardrail.providers.openai_compat import (
        OpenAICompatGuardianProvider,
        OpenAICompatProvider,
    )
    from guardrail.services.groundedness_nli import GroundednessNliVerifier, NliScorer
    from guardrail.services.job_processor import JobProcessor

    # The active content/guardian providers depend on the selected LLM engine.
    ContentProvider = OllamaProvider | OpenAICompatProvider
    GuardianLike = GuardianProvider | OpenAICompatGuardianProvider


def get_settings(request: Request) -> Settings:
    """Retrieve settings from app.state (set during lifespan)."""
    return cast("Settings", request.app.state.settings)


def get_http_client(request: Request) -> httpx.AsyncClient:
    """Retrieve shared httpx AsyncClient from app.state."""
    return cast("httpx.AsyncClient", request.app.state.http_client)


def get_redis(request: Request) -> aioredis.Redis:
    """Retrieve shared Redis client from app.state."""
    return cast("aioredis.Redis", request.app.state.redis)


def get_ollama_provider(request: Request) -> ContentProvider:
    """Retrieve the active content-analysis provider for the selected engine."""
    return cast("ContentProvider", request.app.state.ollama_provider)


def get_guardian_provider(request: Request) -> GuardianLike:
    """Retrieve the env-configured guardian provider for the selected engine."""
    return cast("GuardianLike", request.app.state.guardian_provider)


async def get_resolved_guardian_provider(request: Request) -> GuardianLike:
    """Resolve the guardian provider from SYSTEM AiTaskDefault.

    When ``db_config_enabled`` is false (dev-only escape hatch), returns the
    env-configured guardian. When enabled (default), reads
    ``AiTaskDefault`` ⋈ ``AiModel`` for ``guardrail.validate`` and **fails
    closed** (HTTP 503) if SYSTEM selection is missing — no silent env fallback.
    """
    from fastapi import HTTPException

    settings = request.app.state.settings
    default_provider: GuardianLike = request.app.state.guardian_provider

    if not settings.db.db_config_enabled:
        return default_provider

    resolver = getattr(request.app.state, "tenant_config_resolver", None)
    if resolver is None:
        raise HTTPException(
            status_code=503,
            detail="SYSTEM AiTaskDefault for 'guardrail.validate' is unavailable (resolver not wired).",
        )

    from guardrail.core.tenant_config import (
        build_guardian_provider,
        resolve_guardian_engine,
    )

    tenant_id = request.headers.get("X-Tenant-Id")
    tenant_cfg = await resolver.resolve(tenant_id)

    # Fail closed when DB selection is missing (no env fallback).
    if tenant_cfg.provider is None and tenant_cfg.model is None:
        raise HTTPException(
            status_code=503,
            detail="SYSTEM AiTaskDefault for 'guardrail.validate' is missing. Run db:seed.",
        )

    provider_name, engine_cfg = resolve_guardian_engine(settings, tenant_cfg)
    return build_guardian_provider(  # type: ignore[return-value]
        provider_name, engine_cfg, request.app.state.http_client
    )


def get_job_processor(request: Request) -> JobProcessor:
    """Retrieve job processor from app.state."""
    return cast("JobProcessor", request.app.state.job_processor)


# ---------------------------------------------------------------------------
# lazy, DB-selected aux models (GLiNER + MiniCheck) with idle-TTL.
#
# GLiNER (content safety) and MiniCheck (groundedness) are NOT loaded in the
# lifespan. Their runtime model id is resolved per request from the SYSTEM
# ``AiTaskDefault`` registry (``guardrail.safety`` / ``guardrail.groundedness``)
# and the instance is loaded on the fly through a bounded, idle-TTL model cache
# (pinned for the request). Model IDENTITY is DB-only and fails closed — there
# is no env fallback except the ``db_config_enabled=False`` dev escape hatch
# (mirrors ``get_resolved_guardian_provider``). Precision / thresholds / thread
# and staging paths remain infra tuning.
# ---------------------------------------------------------------------------


# TASK-535 (R1) — retention comes from the control plane, not env.
#
# Two halves, both required: a cache built AFTER a refresh is born with the
# current values (`_retention_kwargs`), and a cache that is ALREADY LIVE adopts
# later changes (`apply_model_cache_retention`). Applying only at construction
# would leave the admin knob dead for every resident cache — §3.2.
_RETENTION_STATE_ATTR = "model_cache_retention"
_CACHE_ATTRS = ("gliner_cache", "groundedness_scorer_cache")


def _retention_kwargs(app_state: Any) -> dict[str, int]:
    """Resolved retention: the control-plane value when known, else settings."""
    settings = app_state.settings
    current: dict[str, int] = getattr(app_state, _RETENTION_STATE_ATTR, None) or {}
    return {
        "ttl_seconds": current.get("ttl_seconds", settings.model_cache_ttl_s),
        "max_size": current.get("max_models", settings.model_cache_max_models),
    }


def _live_caches(app_state: Any) -> list[ModelCache[Any]]:
    """Every INSTANTIATED aux cache (never forces construction)."""
    return [cache for attr in _CACHE_ATTRS if (cache := getattr(app_state, attr, None)) is not None]


def apply_model_cache_retention(app_state: Any, retention: dict[str, int]) -> None:
    """Adopt control-plane retention across both aux caches.

    An ABSENT key keeps the current value, so a gateway outage leaves behaviour
    byte-identical. Resident models are never dropped — the new limits take
    effect on the next sweep or access. The product clamp [60, 3600] is
    re-applied inside the shared cache (defense in depth, §3.3).
    """
    ttl_seconds = retention.get("ttl_seconds")
    max_models = retention.get("max_models")
    if ttl_seconds is None and max_models is None:
        return

    current: dict[str, int] = dict(getattr(app_state, _RETENTION_STATE_ATTR, None) or {})
    current.update(
        {k: v for k, v in retention.items() if k in ("ttl_seconds", "max_models") and v is not None}
    )
    setattr(app_state, _RETENTION_STATE_ATTR, current)

    for cache in _live_caches(app_state):
        cache.configure(ttl_seconds=ttl_seconds, max_size=max_models)


async def refresh_model_cache_retention(app_state: Any) -> None:
    """Pull the control-plane retention (cached; cheap) and apply it.

    NEVER raises: a safety request must not fail because the config plane is
    unavailable. No client, or no opinion from the control plane, ⇒ the env
    values stay in force — exactly the pre-TASK-535 behaviour.
    """
    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return

    try:
        snapshot = await client.get()
        apply_model_cache_retention(app_state, snapshot.retention())
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a request
        logger.warning(
            "guardrail.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )


def get_gliner_cache(app_state: Any) -> ModelCache[GlinerProvider]:
    """Return (lazily creating) the per-app GLiNER aux-model cache."""
    cache = getattr(app_state, "gliner_cache", None)
    if cache is None:
        settings = app_state.settings

        async def factory(model_id: str) -> GlinerProvider:
            from guardrail.providers.gliner import GlinerProvider

            cfg = settings.gliner.model_copy(update={"model_id": model_id})
            provider = GlinerProvider(config=cfg)
            # ONNX load is blocking/CPU-bound — keep the event loop responsive.
            await asyncio.to_thread(provider.load)
            return provider

        cache = ModelCache(
            factory=factory,
            metrics=build_model_cache_metrics_sink(),
            **_retention_kwargs(app_state),
        )
        app_state.gliner_cache = cache
    return cast("ModelCache[GlinerProvider]", cache)


def get_groundedness_scorer_cache(app_state: Any) -> ModelCache[NliScorer]:
    """Return (lazily creating) the per-app MiniCheck groundedness scorer cache."""
    cache = getattr(app_state, "groundedness_scorer_cache", None)
    if cache is None:
        settings = app_state.settings

        async def factory(model_id: str) -> NliScorer:
            from guardrail.services.groundedness_scorer_minicheck import (
                load_minicheck_scorer,
            )

            # TASK-527 (D-12) — the weight path is resolved DB-first (registry
            # `localPath` / file:// / s3://) with the env path as fallback. The
            # clinical-gate posture is unchanged: `allow_network=False` inside
            # the resolver means an hf:-only row never auto-downloads.
            update: dict[str, Any] = {"model_id": model_id}
            resolver = getattr(app_state, "tenant_config_resolver", None)
            if resolver is not None:
                from guardrail.core.model_source import (
                    ModelSourceConfig,
                    resolve_groundedness_model_path,
                )

                resolved_path = await resolve_groundedness_model_path(
                    resolver,
                    env_path=settings.groundedness.model_path,
                    tenant_id=None,
                    config=ModelSourceConfig(
                        cache_dir=settings.groundedness.model_cache_dir,
                        s3_endpoint=settings.model_s3_endpoint,
                        s3_access_key=(
                            settings.model_s3_access_key.get_secret_value()
                            if settings.model_s3_access_key
                            else None
                        ),
                        s3_secret_key=(
                            settings.model_s3_secret_key.get_secret_value()
                            if settings.model_s3_secret_key
                            else None
                        ),
                        s3_secure=settings.model_s3_secure,
                    ),
                )
                update["model_path"] = resolved_path

            cfg = settings.groundedness.model_copy(update=update)
            # Loading a GGUF under llama.cpp is blocking — offload it.
            return await asyncio.to_thread(load_minicheck_scorer, cfg)

        cache = ModelCache(
            factory=factory,
            metrics=build_model_cache_metrics_sink(),
            **_retention_kwargs(app_state),
        )
        app_state.groundedness_scorer_cache = cache
    return cast("ModelCache[NliScorer]", cache)


async def _resolve_aux_model_id(app_state: Any, tenant_id: str | None, task_key: str) -> str:
    """Resolve an aux-model runtime id from the SYSTEM ``AiTaskDefault`` registry.

    Fail-closed: raises :class:`ModelUnavailableError` when DB selection is
    missing (mapped to HTTP 503 by callers). The ``db_config_enabled=False``
    dev escape hatch returns the env-configured id (same posture as the guardian
    resolver); it never applies in the default DB-on deployment.
    """
    from guardrail.core.tenant_config import (
        TASK_KEY_GUARDRAIL_GROUNDEDNESS,
        TASK_KEY_GUARDRAIL_SAFETY,
    )

    settings = cast("Settings", app_state.settings)

    if not settings.db.db_config_enabled:
        if task_key == TASK_KEY_GUARDRAIL_SAFETY:
            return settings.gliner.model_id
        if task_key == TASK_KEY_GUARDRAIL_GROUNDEDNESS:
            return settings.groundedness.model_id
        raise ModelUnavailableError(f"no env id for task key {task_key!r}")

    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        raise ModelUnavailableError(
            f"SYSTEM AiTaskDefault for {task_key!r} is unavailable (resolver not wired)."
        )
    model_id: str | None = await resolver.resolve_model_id(tenant_id, task_key)
    if not model_id:
        raise ModelUnavailableError(
            f"SYSTEM AiTaskDefault for {task_key!r} is missing. Run db:seed."
        )
    return model_id


@asynccontextmanager
async def pinned_gliner_provider(
    app_state: Any, tenant_id: str | None = None, model_id: str | None = None
) -> AsyncIterator[GlinerProvider]:
    """Resolve + lazily load + pin the GLiNER provider for a request/job.

    ``model_id`` may be pre-resolved (e.g. by the ``get_gliner_model_id``
    dependency) to avoid a second DB lookup; otherwise it is resolved here.
    Raises :class:`ModelUnavailableError` when the ``guardrail.safety`` DB
    selection is missing (HTTP endpoints map it to 503; the job processor marks
    the job failed). The resolved model is pinned so idle-TTL / LRU can't evict
    it mid-flight, and unpinned when the block exits.
    """
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY

    if model_id is None:
        model_id = await _resolve_aux_model_id(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    # Read-triggered retention refresh (TTL-cached, single-flight, fail-safe) —
    # a service that never analyzes never polls.
    await refresh_model_cache_retention(app_state)
    cache = get_gliner_cache(app_state)
    await cache.pin(model_id)
    try:
        yield await cache.get(model_id)
    finally:
        await cache.unpin(model_id)


async def get_gliner_model_id(request: Request) -> str:
    """FastAPI dependency: DB-resolve the GLiNER model id (fail-closed → 503)."""
    from fastapi import HTTPException

    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY

    try:
        return await _resolve_aux_model_id(
            request.app.state,
            request.headers.get("X-Tenant-Id"),
            TASK_KEY_GUARDRAIL_SAFETY,
        )
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@asynccontextmanager
async def acquire_groundedness_verifier(
    request: Request,
) -> AsyncIterator[GroundednessNliVerifier]:
    """Yield a groundedness verifier, DB-selecting + pinning MiniCheck when enabled.

    Resolution order:
      1. a pre-seeded ``app.state.groundedness_verifier`` (test seam) is used verbatim;
      2. a disabled gate builds a verifier that degrades honestly (no DB / no model);
      3. otherwise the ``guardrail.groundedness`` DB selection drives the model id
         (fail-closed :class:`ModelUnavailableError` when missing) and the MiniCheck
         scorer is lazily loaded + pinned via the idle-TTL cache. If the model is
         configured but not staged/loadable, the verifier degrades to ``unverified``
         (fail-closed groundedness) rather than 503 — 503 is reserved for a MISSING
         DB selection.
    """
    from guardrail.services.groundedness_nli import GroundednessNliVerifier

    app_state = request.app.state
    pre_seeded = getattr(app_state, "groundedness_verifier", None)
    if pre_seeded is not None:
        yield pre_seeded
        return

    settings = app_state.settings
    if not settings.groundedness.enabled:
        # Dev/CI bypass — degrades to `groundedness_disabled`, no model needed.
        yield GroundednessNliVerifier(settings.groundedness)
        return

    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_GROUNDEDNESS

    model_id = await _resolve_aux_model_id(
        app_state, request.headers.get("X-Tenant-Id"), TASK_KEY_GUARDRAIL_GROUNDEDNESS
    )
    config = settings.groundedness.model_copy(update={"model_id": model_id})
    await refresh_model_cache_retention(app_state)
    cache = get_groundedness_scorer_cache(app_state)
    await cache.pin(model_id)
    try:
        try:
            scorer = await cache.get(model_id)
        except Exception:
            # DB identity known but the GGUF is not staged/loadable → degrade
            # fail-closed to `unverified` (the verifier's default factory reports
            # `nli_model_unavailable`); never a 503 and never `grounded`.
            yield GroundednessNliVerifier(config)
            return
        yield GroundednessNliVerifier(config, scorer=scorer)
    finally:
        await cache.unpin(model_id)
