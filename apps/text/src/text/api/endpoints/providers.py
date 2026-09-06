"""Provider listing endpoint.

Probe contract. Every registered provider is probed IN PARALLEL
under the per-provider probe cap in ``core/runtime_defaults.py`` (5 s), and
each entry reports its own ``probe_status`` (``ok`` / ``timeout`` / ``error`` /
``skipped``), ``probe_latency_ms`` and ``probe_error``. ``skipped`` is the
no-connection case: the adapter answered ``unavailable`` and nothing was
addressed, so there is no engine to blame. An adapter that swallows its
transport error into ``status: "unavailable"`` never reports ``ok`` — see the
downgrade in ``_probe``. Consequences, all deliberate:

* one hung or down engine NEVER stalls or 500s the listing — it degrades to a
  single entry with ``status: "unavailable"`` and the reason attached;
* the emitted ``name`` is the REGISTRY KEY, not ``ProviderInfo.name``. An
  adapter reports its own engine name and a registration may legitimately
  disagree with it (``azure-openai``/``azure`` are still one instance under two
  keys), so the key is the only stable identity the gateway discovery merge
  (``admin/ai-models/discovery``) can join on.

Two surfaces, one probe body. ``GET /providers`` reports each adapter's own
process memo (``_last_base_url``) and is unchanged. ``POST /providers/probe``
takes the connection the GATEWAY resolved per provider through the one tenant →
SYSTEM cascade and enumerates THAT instance instead — which is what lets model
discovery show a tenant its own LM Studio / Ollama rather than the platform's.
Text stays the single aggregator either way: the gateway supplies an address and
never opens an engine connection of its own.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends, Request

from text.core.dependencies import get_pool_health_tracker, get_provider_registry
from text.core.metrics import ACTIVE_GENERATIONS
from text.core.runtime_defaults import PROVIDER_PROBE_TIMEOUT_S
from text.models.probe import ProbeConnection, ProviderProbeRequest
from text.models.provider import ProviderInfo
from text.providers.base import ConnectionAwareProbe, LLMProvider, ProviderRegistry
from text.services.pool_health import PoolHealthTracker

router = APIRouter(tags=["providers"])


def _unavailable(name: str) -> dict[str, Any]:
    """A well-formed ProviderInfo payload for a provider that did not answer."""
    return ProviderInfo(
        name=name,
        display_name=name,
        status="unavailable",
        default_model="",
    ).model_dump()


async def _describe(provider: LLMProvider, connection: ProbeConnection | None) -> ProviderInfo:
    """Enumerate the engine the CALLER resolved, falling back to the process memo.

    ``get_info()`` reports on ``_last_base_url`` — the endpoint this process last
    served a generation from — which can only ever describe one engine per
    provider name. A ``connection`` says which instance the gateway's tenant →
    SYSTEM cascade actually resolved for this caller, so a tenant sees ITS LM
    Studio / Ollama rather than the platform's.

    An adapter that cannot be enumerated per connection (every cloud provider)
    falls through to ``get_info()`` unchanged, so this is strictly additive.
    """
    if connection is not None and isinstance(provider, ConnectionAwareProbe):
        return await provider.discover_models(connection)
    return await provider.get_info()


async def _probe(
    registry: ProviderRegistry,
    name: str,
    timeout_s: float,
    *,
    pool_health_tracker: PoolHealthTracker,
    connection: ProbeConnection | None = None,
) -> dict[str, Any]:
    start = time.monotonic()
    probe_status = "ok"
    probe_error: str | None = None
    try:
        provider = registry.get(name)
        info = await asyncio.wait_for(_describe(provider, connection), timeout=timeout_s)
        payload = info.model_dump()
    except TimeoutError:
        payload = _unavailable(name)
        probe_status = "timeout"
        probe_error = f"probe exceeded {timeout_s}s"
    except Exception as exc:  # noqa: BLE001 — one bad provider must not fail the listing
        payload = _unavailable(name)
        probe_status = "error"
        probe_error = str(exc)

    if probe_status == "ok" and payload.get("status") == "unavailable":
        # A SWALLOWED failure. Every adapter catches its own transport error and
        # returns a well-formed ``ProviderInfo(status="unavailable")`` instead of
        # raising, so the ``try`` above completes and would stamp ``ok`` — a probe
        # that came back holding `unavailable` reported as a successful probe.
        # ``probe_status`` answers "how did the probe go", so it is downgraded
        # here, and the two outcomes are distinguished by whether there was
        # anything to probe AT ALL:
        #
        #   * a connection WAS resolved for this provider -> ``error``: an address
        #     was given and nothing usable came back.
        #   * no connection -> ``skipped``: nothing was addressed, so calling it
        #     an error would blame an engine nobody asked for. This is the normal
        #     state of every provider a deployment has not configured.
        #
        # Never overwrites a raised error's own message: this branch runs only
        # while ``probe_status`` is still ``ok``.
        probe_status = "error" if connection is not None else "skipped"
        probe_error = (
            "the engine did not answer this probe (the adapter reported "
            "status='unavailable' without raising)"
            if connection is not None
            else "no connection is configured for this provider; nothing was probed"
        )

    payload["name"] = name
    payload["probe_status"] = probe_status
    payload["probe_latency_ms"] = int((time.monotonic() - start) * 1000)
    payload["probe_error"] = probe_error

    # admin introspection: the SAME degrade-routing cache
    # `/generate` consults , plus current in-flight sync requests.
    checked_at = pool_health_tracker.checked_at(name)
    payload["pool_health"] = pool_health_tracker.is_healthy(name)
    payload["pool_health_checked_at"] = checked_at.isoformat() if checked_at else None
    payload["in_flight_requests"] = int(ACTIVE_GENERATIONS.labels(provider=name)._value.get())

    return payload


async def _probe_all(
    registry: ProviderRegistry,
    pool_health_tracker: PoolHealthTracker,
    connections: dict[str, ProbeConnection],
) -> list[dict[str, Any]]:
    timeout_s = float(PROVIDER_PROBE_TIMEOUT_S)
    names = registry.list_providers()
    return list(
        await asyncio.gather(
            *(
                _probe(
                    registry,
                    name,
                    timeout_s,
                    pool_health_tracker=pool_health_tracker,
                    connection=connections.get(name),
                )
                for name in names
            )
        )
    )


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers(
    request: Request,
    registry: ProviderRegistry = Depends(get_provider_registry),
    pool_health_tracker: PoolHealthTracker = Depends(get_pool_health_tracker),
) -> list[dict[str, Any]]:
    return await _probe_all(registry, pool_health_tracker, {})


@router.post("/providers/probe", response_model=list[ProviderInfo])
async def probe_providers(
    request: Request,
    body: ProviderProbeRequest,
    registry: ProviderRegistry = Depends(get_provider_registry),
    pool_health_tracker: PoolHealthTracker = Depends(get_pool_health_tracker),
) -> list[dict[str, Any]]:
    """The CONNECTION-AWARE twin of `GET /providers`.

    Same response shape, same per-provider isolation and same probe cap; the only
    difference is that each provider is enumerated against the endpoint the
    GATEWAY resolved for the calling tenant (tenant → SYSTEM, resolved once by
    `AiProviderConnectionService` — Text does not resolve, cache or store it).
    Text remains the single probe aggregator: the gateway hands down an address
    and never opens an engine connection itself.

    A POST rather than a GET because the body carries credential material for a
    keyed self-hosted engine, which must never travel in a URL or a query string.
    `ProviderInfo` has no credential field, so nothing comes back.
    """
    return await _probe_all(registry, pool_health_tracker, body.connections)
