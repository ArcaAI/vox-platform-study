"""Idle-TTL + pin model instance cache for the guardrail aux models.

Guardrail's auxiliary ML models — the GLiNER content-safety detector and the
MiniCheck groundedness scorer — are loaded LAZILY on first use (never in the
lifespan) and released when they go idle, so a freshly-booted worker holds no
ML weights.

TASK-529 — the policy itself (single-flight load, idle TTL clamped to
[60s, 3600s], pin/unpin refcounting, LRU bound, periodic sweep, VRAM-aware
eviction) now lives in the shared contract `hope_runtime_models.ModelCache`,
which every HOPE service composes. See `packages/py-runtime-models/README.md`
for the contract and its conformance clauses.

This module is the guardrail-facing surface of that contract: guardrail's
defaults, its `cached_models()` spelling, and the shutdown-on-evict hook. The
previous 200-line copy of the policy is gone.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from hope_runtime_models import ModelCache as _SharedModelCache
from hope_runtime_models import ModelUnavailableError, clamp_cache_ttl_seconds

T = TypeVar("T")

# Per-cache bound on cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 2

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


def _shutdown_on_evict(_key: str, instance: Any) -> Any:
    """Default unload hook: call the instance's ``shutdown`` if it has one.

    Returns the (possibly awaitable) result — the shared cache awaits it when
    needed, so BOTH sync hooks (GLiNER's thread-pool ``shutdown``) and async
    ones work. Instances with no hook (the MiniCheck scorer, whose llama handle
    is freed on GC) are a no-op.
    """
    shutdown = getattr(instance, "shutdown", None)
    return None if shutdown is None else shutdown()


class ModelCache(_SharedModelCache[T], Generic[T]):
    """The shared cache with guardrail's defaults and `cached_models()`."""

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
            name=kwargs.pop("name", "guardrail_model_cache"),
            unload=kwargs.pop("unload", _shutdown_on_evict),
            **kwargs,
        )

    def cached_models(self) -> list[str]:
        """Cached model ids, oldest → most recently used (guardrail's spelling)."""
        return self.cached_keys()
