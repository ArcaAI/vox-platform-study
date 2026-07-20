"""Registration helper for local engines.

TASK-529 (D-09) — registration is NO LONGER gated on a successful model load.

Before: `warm_and_register` called `provider.warmup()` at boot and registered the
provider only if it succeeded. That made every local engine eager (weights
pinned for the life of the process, never unloaded) AND made a broken model
present as a missing provider.

After: the provider always registers; its weights load on the first synth
request and are released by the idle-TTL sweep. Operators who prefer
fail-at-boot set `TTS_WARMUP_ENABLED=true`, which restores the warm-at-boot
call — but even then a load failure leaves the provider registered, so the
failure surfaces as a 503 on the affected route rather than silently removing a
route from the service.
"""

from __future__ import annotations

from typing import Any, Protocol


class _Warmable(Protocol):
    async def warmup(self) -> None: ...


async def register_local_provider(
    registry: Any,
    name: str,
    provider: _Warmable,
    *,
    warmup: bool = False,
    logger: Any | None = None,
) -> bool:
    """Register a local engine; optionally pre-warm it. Returns True always.

    The return value is kept for call-site symmetry with the old helper, but a
    warmup failure is no longer a registration failure — it is logged loudly and
    the provider stays registered (degraded, not absent).
    """
    if warmup:
        try:
            await provider.warmup()
        except Exception as exc:  # noqa: BLE001 — a load failure must not unregister
            if logger is not None:
                logger.warning(
                    "tts_v2.local_provider_warmup_failed",
                    provider=name,
                    error=str(exc),
                    detail="provider stays registered; failure will surface as a 503 on first use",
                )

    registry.register(name, provider)
    return True
