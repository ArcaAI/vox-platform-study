"""Per-slot model instance cache for per-request model selection (TASK-506).

TASK-529 — the policy (single-flight load, idle TTL clamped to [60s, 3600s],
pin/unpin refcounting, LRU bound, periodic sweep, VRAM-aware eviction) now lives
in the shared contract `hope_runtime_models.ModelCache`, which every HOPE
service composes. See `packages/py-runtime-models/README.md` for the contract
and its conformance clauses.

This module is the nlp-facing surface of that contract. It keeps the local
`cached_models()` spelling that nlp callers and tests already use, and nothing
else: the previous 200-line copy of the policy is gone.

Retention is admin-controlled — `nlp.dependencies` resolves ttl/max from the
control plane and reconfigures these caches without a redeploy (D-07).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from hope_runtime_models import ModelCache as _SharedModelCache
from hope_runtime_models import ModelUnavailableError, clamp_cache_ttl_seconds

T = TypeVar("T")


def _shutdown_on_evict(_key: str, instance: Any) -> Any:
    """Default unload hook: call the instance's ``shutdown`` if it has one.

    Returns the (possibly awaitable) result — the shared cache awaits it when
    needed, so BOTH sync and async ``shutdown`` hooks work. The pre-TASK-529 nlp
    copy awaited unconditionally, so a sync hook raised ``TypeError`` and was
    silently swallowed; converging on the shared contract fixes that delta.
    """
    shutdown = getattr(instance, "shutdown", None)
    return None if shutdown is None else shutdown()

# Per-slot bound on cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 3

# OD-5 program default. NOTE this changed from 3600 to 600 in TASK-529 — a
# deliberate, owner-approved behaviour change. Runtime value comes from the
# control plane; this is the bootstrap fallback only.
DEFAULT_TTL_SECONDS = 600

__all__ = [
    "DEFAULT_MAX_SIZE",
    "DEFAULT_TTL_SECONDS",
    "ModelCache",
    "ModelUnavailableError",
    "clamp_cache_ttl_seconds",
]


class ModelCache(_SharedModelCache[T], Generic[T]):
    """The shared cache with nlp's defaults and its `cached_models()` spelling."""

    def __init__(
        self,
        *,
        factory: Callable[[str], Awaitable[T]],
        max_size: int = DEFAULT_MAX_SIZE,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        **kwargs: Any,  # pass-through for metrics / vram_probe / time_func
    ) -> None:
        super().__init__(
            factory=factory,
            max_size=max_size,
            ttl_seconds=ttl_seconds,
            name=kwargs.pop("name", "nlp_model_cache"),
            unload=kwargs.pop("unload", _shutdown_on_evict),
            **kwargs,
        )

    def cached_models(self) -> list[str]:
        """Cached model names, oldest → most recently used (nlp's spelling)."""
        return self.cached_keys()
