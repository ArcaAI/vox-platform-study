"""Apply control-plane limits to SMR's live runtime state.

The bridge between the effective-config pull client and the objects the request
path actually uses: per-provider concurrency semaphores and request timeouts.

Two invariants:
  * **Env fallback is the floor.** A provider absent from the snapshot, or
    carrying a null/invalid value, keeps whatever its env/pydantic config set.
    A down gateway therefore leaves the service byte-identical to today.
  * **Selection stays out.** Only capacity and timeout are applied. SMR does not
    select a provider or model (`core/config.py` module docstring) — any
    selection-shaped field in the payload is deliberately inert here.
"""

from __future__ import annotations

from typing import Any

import structlog

from smr.core.effective_config import EffectiveConfigSnapshot
from smr.services.resizable_semaphore import ResizableSemaphore

logger = structlog.get_logger(__name__)


def apply_provider_limits(
    snapshot: EffectiveConfigSnapshot,
    semaphores: dict[str, ResizableSemaphore],
    timeouts: dict[str, int],
) -> None:
    """Move live limits to match `snapshot`. Never raises; never revokes permits."""
    if not snapshot.ok:
        # Negative-cached (gateway down) — leave every env value exactly as-is.
        return

    for provider, limits in snapshot.provider_limits().items():
        max_concurrent = limits.get("max_concurrent")
        if max_concurrent is not None:
            semaphore = semaphores.get(provider)
            # A provider this process does not serve is simply skipped — the
            # control plane may describe more providers than are registered.
            if semaphore is not None:
                _resize(provider, semaphore, max_concurrent)

        timeout_s = limits.get("timeout_s")
        if timeout_s is not None:
            timeouts[provider] = timeout_s


def apply_provider_retention(snapshot: EffectiveConfigSnapshot, registry: Any) -> None:
    """Push the retention TTL into every live provider.

    Providers are lazily built and memoized by `ProviderRegistry`, so this runs
    on every refresh rather than only at construction. A provider instantiated
    AFTER the last refresh carries the bootstrap TTL for at most one request —
    a bounded, documented lag, not a correctness problem: the value is a
    residency hint to the engine, never part of the response.

    Providers with no `apply_retention` (Azure, Bedrock — managed services with
    no residency to control) are skipped.
    """
    if not snapshot.ok:
        # Negative-cached (gateway down) — keep env values, same as concurrency.
        return

    retention = snapshot.retention()
    if not retention:
        return

    for name, provider in getattr(registry, "_providers", {}).items():
        apply = getattr(provider, "apply_retention", None)
        if apply is None:
            continue
        try:
            apply(retention)
        except Exception as exc:  # noqa: BLE001 — never break a request path
            logger.warning(
                "smr.effective_config.retention_apply_error",
                provider=name,
                error=str(exc),
                error_type=type(exc).__name__,
            )


def _resize(provider: str, semaphore: ResizableSemaphore, limit: int) -> None:
    if semaphore.limit == limit:
        return
    try:
        previous = semaphore.limit
        semaphore.set_limit(limit)
    except ValueError:
        # A nonsensical served value must never take a provider offline.
        logger.warning("smr.effective_config.invalid_max_concurrent", provider=provider, value=limit)
        return

    logger.info(
        "smr.effective_config.semaphore_resized",
        provider=provider,
        previous=previous,
        current=limit,
        in_flight=semaphore.in_flight,
    )


async def refresh_runtime_limits(state: Any) -> None:
    """Pull the current snapshot (cached) and apply it. Safe on every request.

    Cheap inside the client's TTL window, so request paths can call this
    unconditionally. It NEVER raises: the request path must not fail because the
    control plane is unavailable.
    """
    client = getattr(state, "effective_config_client", None)
    if client is None:
        return

    try:
        snapshot = await client.get()
        semaphores_attr = getattr(state, "provider_semaphores", None)
        semaphores: dict[str, ResizableSemaphore] = semaphores_attr if isinstance(semaphores_attr, dict) else {}
        # isinstance, NOT `or {}`: an EMPTY provider_timeouts dict is the normal
        # initial state, and `or` would swap in a throwaway so the first override
        # never reached app.state.
        timeouts_attr = getattr(state, "provider_timeouts", None)
        timeouts: dict[str, int] = timeouts_attr if isinstance(timeouts_attr, dict) else {}
        apply_provider_limits(snapshot, semaphores, timeouts)

        # Same refresh, same fail-safe posture.
        registry = getattr(state, "provider_registry", None)
        if registry is not None:
            apply_provider_retention(snapshot, registry)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a request
        logger.warning("smr.effective_config.apply_error", error=str(exc), error_type=type(exc).__name__)
