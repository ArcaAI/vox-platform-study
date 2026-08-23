"""Apply control-plane values to stt's live runtime state.

The bridge between the effective-config pull client and the objects that
actually consume the values: the model cache's retention knobs, the Dramatiq
worker-thread ceiling, and the streaming concurrency ceiling.

Env fallback is the floor throughout: an unserved or invalid value leaves the
service on exactly its env/bootstrap behaviour, so a gateway outage is a no-op.
"""

from __future__ import annotations

import structlog

from stt.core.effective_config import get_effective_config_client

logger = structlog.get_logger(__name__)


async def refresh_model_cache_retention() -> None:
    """Pull the current snapshot (cached) and apply retention to the model cache.

    Read-triggered and safe to call on any model-load path: it is ~free inside
    the client's TTL window and NEVER raises — a transcription must not fail
    because the config plane is unavailable.
    """
    try:
        snapshot = await get_effective_config_client().get()
        retention = snapshot.retention()
        if retention:
            from stt.models.cache import get_model_cache

            get_model_cache().apply_retention(retention)

        # Same snapshot, second consumer: the ~70 registry keys that ARE
        # settings fields (TASK-799 lane C). Applied HERE rather than only at
        # boot because this is the read-triggered path — it is what runs after
        # the invalidation listener drops the cache, so a control-plane write
        # converges within one model-load rather than waiting for a restart.
        from stt.core.config.settings import get_settings
        from stt.core.control_plane import apply_control_plane

        apply_control_plane(get_settings(), snapshot.raw)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a load
        logger.warning(
            "stt.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )


async def refresh_settings_from_control_plane() -> list[str]:
    """Overlay the pulled snapshot's generic `settings` map onto `get_settings()`.

    The companion to :func:`refresh_model_cache_retention`: that one applies the
    frozen `retention` VIEW to a live object the settings do not own, this one
    applies the ~70 registry keys that ARE settings fields (TASK-799 lane C).
    Both read the same cached snapshot, so calling them together costs one fetch.

    Read-triggered and idempotent. NEVER raises — a control-plane outage leaves
    every field on its bootstrap value, which is exactly the pre-TASK-799
    behaviour.
    """
    try:
        snapshot = await get_effective_config_client().get()
        from stt.core.config.settings import get_settings
        from stt.core.control_plane import apply_control_plane

        return apply_control_plane(get_settings(), snapshot.raw)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a request
        logger.warning(
            "stt.control_plane.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return []


async def resolve_worker_concurrency(default: int) -> int:
    """The Dramatiq worker-thread count, control-plane first, env as fallback.

    NOTE the field this feeds is `settings.worker_threads`, not
    `settings.worker_concurrency`: the latter is documented as an "alias" but has
    ZERO read sites anywhere in the service (verified 2026-07-20) — `worker_threads`
    is what actually reaches `Worker(...)`. Wiring the control plane to the alias
    would have produced a knob that silently does nothing, so it feeds the real one.
    """
    try:
        snapshot = await get_effective_config_client().get()
        served = snapshot.worker_concurrency()
        if served is not None:
            logger.info("stt.effective_config.worker_concurrency", value=served, previous=default)
            return served
    except Exception as exc:  # noqa: BLE001 — boot must not depend on the gateway
        logger.warning(
            "stt.effective_config.worker_concurrency_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
    return default


async def resolve_streaming_max_concurrent(default: int) -> int:
    """The concurrent-streaming-session ceiling, control-plane first.

    `default` is `settings.streaming_max_concurrent`, where 0 means
    "auto-detect from the hardware execution profile" — an unserved value
    preserves that sentinel exactly.
    """
    try:
        snapshot = await get_effective_config_client().get()
        served = snapshot.streaming_max_concurrent()
        if served is not None:
            logger.info(
                "stt.effective_config.streaming_max_concurrent", value=served, previous=default
            )
            return served
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "stt.effective_config.streaming_max_concurrent_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
    return default
