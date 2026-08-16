"""Admin introspection — per-provider health, degrade-routing state, and
GPU/device classification (TASK-726 Task 4/5).

`/health/ready` (health.py) stays the k8s probe surface, deliberately
collapsing per-provider state into one pass/degraded/fail signal. This is
the operator/KEDA-adjacent view: per-provider `healthy` (the SAME
`TTSEngine.health()` readiness already calls), `breaker_open` (the
PRE-EXISTING per-provider `CircuitBreaker` in `routing/router.py` that
`TTSRouter.candidates()` already excludes tripped providers with — this
endpoint surfaces its live state, it does not add new degrade-routing logic;
see docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md §(c)),
and the GPU/device classification the deployment repo pins node pools
against (§(b)).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(tags=["providers"])

# Static per-engine classification (design-notes.md §(b)) — a local ML engine
# that loads weights into device memory vs. an API-bound cloud engine with no
# local device at all. A static fact about the ENGINE, not a per-request
# routing decision, so it is a plain module constant rather than instance
# introspection or a shared package (karpathy: no speculative abstraction for
# a single reuse).
GPU_BOUND_PROVIDERS: frozenset[str] = frozenset({"kokoro", "indic_parler", "indic_f5"})
API_BOUND_PROVIDERS: frozenset[str] = frozenset({"azure", "sarvam"})


def _resolved_device(provider: Any) -> str | None:
    """Best-effort: the device value a LOCAL engine's config actually holds
    (`KokoroConfig.device` etc., already wired to the loader — config.py).

    Informational only — never raises, never affects health/readiness. Cloud
    engines have no `_config.device` and correctly report None.
    """
    try:
        return getattr(provider._config, "device", None)  # noqa: SLF001
    except Exception:
        return None


@router.get("/providers")
async def list_provider_status(request: Request) -> dict[str, Any]:
    """Per-provider health, breaker state, and GPU/device classification."""
    registry = getattr(request.app.state, "provider_registry", None)
    tts_router = getattr(request.app.state, "router", None)
    providers: list[dict[str, Any]] = []

    if registry is not None:
        for name in registry.list_providers():
            provider = registry.get(name)
            try:
                healthy = await provider.health()
            except Exception:
                healthy = False

            breaker_open = False
            if tts_router is not None:
                try:
                    breaker_open = tts_router.breaker(name).is_open()
                except Exception:
                    breaker_open = False

            providers.append(
                {
                    "name": name,
                    "healthy": healthy,
                    "is_configured": getattr(provider, "is_configured", True),
                    "breaker_open": breaker_open,
                    "gpu_bound": name in GPU_BOUND_PROVIDERS,
                    "resolved_device": _resolved_device(provider),
                }
            )

    return {"providers": providers}
