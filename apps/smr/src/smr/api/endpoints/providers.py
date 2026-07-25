"""Provider listing endpoint.

Probe contract. Every registered provider is probed IN PARALLEL
under a per-provider ``SMR_PROVIDER_PROBE_TIMEOUT_S`` cap (default 5 s), and
each entry reports its own ``probe_status`` (``ok`` / ``timeout`` / ``error``),
``probe_latency_ms`` and ``probe_error``. Consequences, all deliberate:

* one hung or down engine NEVER stalls or 500s the listing — it degrades to a
  single entry with ``status: "unavailable"`` and the reason attached;
* the emitted ``name`` is the REGISTRY KEY, not ``ProviderInfo.name``.
  ``main.py`` registers the LM Studio instance under both ``lm-studio`` and
  ``openai_compat`` and the shared instance reports ``openai_compat`` for both,
  so the key is the only stable identity the gateway discovery merge
  (``admin/ai-models/discovery``) can join on.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends, Request

from smr.core.dependencies import get_provider_registry
from smr.models.provider import ProviderInfo
from smr.providers.base import ProviderRegistry

router = APIRouter(tags=["providers"])


def _unavailable(name: str) -> dict[str, Any]:
    """A well-formed ProviderInfo payload for a provider that did not answer."""
    return ProviderInfo(
        name=name,
        display_name=name,
        status="unavailable",
        default_model="",
    ).model_dump()


async def _probe(registry: ProviderRegistry, name: str, timeout_s: float) -> dict[str, Any]:
    start = time.monotonic()
    probe_status = "ok"
    probe_error: str | None = None
    try:
        provider = registry.get(name)
        info = await asyncio.wait_for(provider.get_info(), timeout=timeout_s)
        payload = info.model_dump()
    except TimeoutError:
        payload = _unavailable(name)
        probe_status = "timeout"
        probe_error = f"probe exceeded {timeout_s}s"
    except Exception as exc:  # noqa: BLE001 — one bad provider must not fail the listing
        payload = _unavailable(name)
        probe_status = "error"
        probe_error = str(exc)

    payload["name"] = name
    payload["probe_status"] = probe_status
    payload["probe_latency_ms"] = int((time.monotonic() - start) * 1000)
    payload["probe_error"] = probe_error
    return payload


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers(
    request: Request,
    registry: ProviderRegistry = Depends(get_provider_registry),
) -> list[dict[str, Any]]:
    timeout_s = float(request.app.state.settings.provider_probe_timeout_s)
    names = registry.list_providers()
    return list(await asyncio.gather(*(_probe(registry, name, timeout_s) for name in names)))
