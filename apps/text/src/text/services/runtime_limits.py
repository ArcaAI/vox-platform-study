"""Apply control-plane limits to Text's live runtime state.

The bridge between the effective-config pull client and the objects the request
path actually uses: per-provider concurrency semaphores, request timeouts, vendor
rate-limit trackers, generation defaults and the input-moderation posture.

Two invariants:
  * **The in-code FLOOR is the fallback.** A provider absent from the snapshot,
    or carrying a null/invalid value, keeps the resource-safety floor from
    `core/runtime_defaults.py`. A down gateway therefore leaves the service
    byte-identical to a gateway with no opinion.
  * **Selection stays out.** Only capacity, timeouts, budgets and posture are
    applied. Text does not select a provider or model (`core/config.py` module
    docstring) — any selection-shaped field in the payload is deliberately inert
    here; a selection arrives PUSHED, per request.
"""

from __future__ import annotations

from typing import Any

import structlog

from text.core.defaults import apply_generation_defaults
from text.core.effective_config import EffectiveConfigSnapshot
from text.core.guardrail_posture import platform_posture
from text.services.resizable_semaphore import ResizableSemaphore

logger = structlog.get_logger(__name__)


def apply_provider_limits(
    snapshot: EffectiveConfigSnapshot,
    semaphores: dict[str, ResizableSemaphore],
    timeouts: dict[str, int],
    rate_limiters: dict[str, Any] | None = None,
) -> None:
    """Move live limits to match `snapshot`. Never raises; never revokes permits."""
    if not snapshot.ok:
        # Negative-cached (gateway down) — leave every live value exactly as-is.
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

        # Vendor account quotas. `RateLimitTracker.update_limits` already treats
        # `None` as "leave it alone", so an absent key is a no-op rather than a
        # reset to unlimited.
        if rate_limiters is not None and ("tpm_limit" in limits or "rpm_limit" in limits):
            tracker = rate_limiters.get(provider)
            update = getattr(tracker, "update_limits", None)
            if update is not None:
                update(rpm_limit=limits.get("rpm_limit"), tpm_limit=limits.get("tpm_limit"))


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
        # Negative-cached (gateway down) — keep live values, same as concurrency.
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
                "text.effective_config.retention_apply_error",
                provider=name,
                error=str(exc),
                error_type=type(exc).__name__,
            )


def apply_lane_budgets(snapshot: EffectiveConfigSnapshot, state: Any) -> None:
    """Publish the resolved `(provider, lane)` budgets onto app state.

    Read by the judge lane (`api/endpoints/judge.py`) and the user-facing queue
    wait, replacing `TEXT_JUDGE_*` / `TEXT_QUEUE_*` / `TEXT_CB_*`. Stored rather
    than applied in place because — unlike a semaphore's ceiling — a breaker
    threshold is consulted at call time, so there is no live object to resize.
    """
    if not snapshot.ok:
        return
    state.lane_budgets = snapshot.lane_budgets()


def apply_platform_posture(snapshot: EffectiveConfigSnapshot, state: Any) -> None:
    """Adopt the platform generation defaults and input-moderation posture."""
    if not snapshot.ok:
        return
    apply_generation_defaults(snapshot.generation_defaults())
    state.guardrail_posture = platform_posture(snapshot.external_guardrail())


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
        semaphores: dict[str, ResizableSemaphore] = (
            semaphores_attr if isinstance(semaphores_attr, dict) else {}
        )
        # isinstance, NOT `or {}`: an EMPTY provider_timeouts dict is the normal
        # initial state, and `or` would swap in a throwaway so the first override
        # never reached app.state.
        timeouts_attr = getattr(state, "provider_timeouts", None)
        timeouts: dict[str, int] = timeouts_attr if isinstance(timeouts_attr, dict) else {}
        limiters_attr = getattr(state, "rate_limiters", None)
        limiters = limiters_attr if isinstance(limiters_attr, dict) else None
        apply_provider_limits(snapshot, semaphores, timeouts, limiters)

        # Same refresh, same fail-safe posture.
        registry = getattr(state, "provider_registry", None)
        if registry is not None:
            apply_provider_retention(snapshot, registry)

        apply_lane_budgets(snapshot, state)
        apply_platform_posture(snapshot, state)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a request
        logger.warning(
            "text.effective_config.apply_error", error=str(exc), error_type=type(exc).__name__
        )


def lane_budget(state: Any, provider: str, lane: str) -> Any:
    """The effective budget for one `(provider, lane)`: served over the floor."""
    from text.core.runtime_defaults import LANE_FLOORS, USER_LANE_FLOOR

    floor = LANE_FLOORS.get(lane, USER_LANE_FLOOR)
    budgets = getattr(state, "lane_budgets", None)
    if not isinstance(budgets, dict):
        return floor
    served = budgets.get((provider, lane))
    return floor.merged(served) if isinstance(served, dict) else floor


def _resize(provider: str, semaphore: ResizableSemaphore, limit: int) -> None:
    if semaphore.limit == limit:
        return
    try:
        previous = semaphore.limit
        semaphore.set_limit(limit)
    except ValueError:
        # A nonsensical served value must never take a provider offline.
        logger.warning(
            "text.effective_config.invalid_max_concurrent", provider=provider, value=limit
        )
        return

    logger.info(
        "text.effective_config.semaphore_resized",
        provider=provider,
        previous=previous,
        current=limit,
        in_flight=semaphore.in_flight,
    )
