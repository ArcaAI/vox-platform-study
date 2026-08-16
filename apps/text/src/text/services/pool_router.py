"""Degrade-away-from-unhealthy routing (TASK-725 Task 2).

design.md's worker-pool standard: "the service degrades routing away from
unhealthy pools rather than queueing into a dead engine." Wired as a check
consulted before dispatch in `api/endpoints/generate.py`, reusing
`ProviderRegistry.get()` unchanged — this module makes the ROUTING DECISION
only; it never builds or calls a provider itself.
"""

from __future__ import annotations

from text.core.exceptions import PoolUnhealthyError
from text.services.pool_health import PoolHealthTracker


def resolve_pool_route(
    provider: str,
    *,
    tracker: PoolHealthTracker,
    fallback: str | None = None,
    fallback_registered: bool = False,
) -> str:
    """Return the provider name a request should actually dispatch to.

    - Unknown health state or healthy → ``provider`` unchanged (no behavior
      change for the overwhelming majority of requests).
    - Known unhealthy + a REGISTERED ``fallback`` → the fallback name (the
      caller re-routes the request to it).
    - Known unhealthy + no usable fallback (absent, or not actually
      registered) → raises ``PoolUnhealthyError``. Never silently queues into
      the dead engine.

    ``fallback_registered`` is the caller's responsibility to establish
    (typically ``fallback in registry.list_providers()``) — this function only
    encodes the routing DECISION, not registry lookups, so it stays a plain
    hermetic function with no registry dependency.
    """
    if tracker.is_healthy(provider) is False:
        if fallback and fallback_registered:
            return fallback
        raise PoolUnhealthyError(
            f"Provider '{provider}' is marked unhealthy and no usable fallback was "
            "supplied.",
            provider=provider,
        )
    return provider
