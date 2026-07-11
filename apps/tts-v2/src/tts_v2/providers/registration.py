"""Warm-then-register helper for local engines.

A local model that fails to load must NOT take the service down — it simply
stays unregistered (degraded, not dead), mirroring the harness's best-effort
startup posture. The provider is only registered after ``warmup()`` succeeds.
"""

from __future__ import annotations

from typing import Any, Protocol


class _Warmable(Protocol):
    async def warmup(self) -> None: ...


async def warm_and_register(
    registry: Any, name: str, provider: _Warmable, *, logger: Any | None = None
) -> bool:
    """Warm the provider's model, then register it. Returns True on success."""
    try:
        await provider.warmup()
    except Exception as exc:  # noqa: BLE001 — any load failure means "skip, stay up"
        if logger is not None:
            logger.warning("tts_v2.local_provider_load_failed", provider=name, error=str(exc))
        return False
    registry.register(name, provider)
    return True
