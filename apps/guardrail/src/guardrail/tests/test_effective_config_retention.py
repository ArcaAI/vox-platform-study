"""Guardrail takes model-cache retention from the control plane.

The four clauses are the same for all three services adopted here:

1. a control-plane value beats the env default;
2. an ALREADY-LIVE cache is reconfigured, not only a freshly built one — the
   failure mode that makes the whole knob pointless;
3. an unreachable gateway falls back to env with no exception escaping;
4. the product clamp [60, 3600] is re-applied client-side.

Hermetic — `httpx.MockTransport` + `SimpleNamespace` app state; the real ONNX /
GGUF backends are never touched.

RED: written before the implementation.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from guardrail.core.config import Settings
from guardrail.services.model_cache import ModelCache

ENV_TTL_S = 600


def _payload(ttl_seconds: int | None = None, max_models: int | None = None) -> dict[str, Any]:
    """The gateway's `guardrail` subset — retention only."""
    return {
        "service": "guardrail",
        "generatedAt": "2026-07-20T00:00:00.000Z",
        "retention": {
            "ttlSeconds": ttl_seconds,
            "maxModels": max_models,
            "maxMemoryMb": None,
            "vramBudgetMb": None,
            "source": "db",
        },
    }


def _app_state(handler) -> SimpleNamespace:  # noqa: ANN001
    """App state carrying real settings + a client wired to a MockTransport."""
    from guardrail.core.effective_config import EffectiveConfigClient

    settings = Settings()
    assert settings.model_cache_ttl_s == ENV_TTL_S, "env baseline moved — update the test"

    client = EffectiveConfigClient(
        base_url="http://gateway.test/api/v1",
        token="guardrail-token",
        service="guardrail",
        transport=httpx.MockTransport(handler),
    )
    return SimpleNamespace(settings=settings, effective_config_client=client)


async def _noop_factory(_key: str) -> object:
    return object()


# ── clause 1 — the control plane wins over env ──────────────────────────────


@pytest.mark.asyncio
async def test_retention_comes_from_control_plane() -> None:
    from guardrail.core.dependencies import (
        get_gliner_cache,
        refresh_model_cache_retention,
    )

    state = _app_state(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=900, max_models=3)))

    await refresh_model_cache_retention(state)

    stats = get_gliner_cache(state).stats()
    assert stats.ttl_seconds == 900, "cache must be born with the control-plane TTL, not env"
    assert stats.max_size == 3


@pytest.mark.asyncio
async def test_both_aux_caches_adopt_the_control_plane_value() -> None:
    from guardrail.core.dependencies import (
        get_gliner_cache,
        get_groundedness_scorer_cache,
        refresh_model_cache_retention,
    )

    state = _app_state(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=1200)))

    await refresh_model_cache_retention(state)

    assert get_gliner_cache(state).stats().ttl_seconds == 1200
    assert get_groundedness_scorer_cache(state).stats().ttl_seconds == 1200


# ── clause 2 — LIVE caches are reconfigured, and keep their residents ────────


@pytest.mark.asyncio
async def test_live_cache_reconfigured_not_just_new_ones() -> None:
    """The acceptance criterion this change exists for.

    A cache that is already alive with a resident model must adopt a new
    control-plane TTL, WITHOUT dropping what it holds.
    """
    from guardrail.core.dependencies import refresh_model_cache_retention

    served = {"ttl": 900}
    state = _app_state(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=served["ttl"])))

    # A cache built BEFORE any refresh, holding a resident entry.
    live = ModelCache(factory=_noop_factory, ttl_seconds=ENV_TTL_S)
    await live.get("resident-model")
    state.gliner_cache = live
    assert live.stats().resident_models == 1

    await refresh_model_cache_retention(state)
    assert live.stats().ttl_seconds == 900

    # Now an admin moves the slider again — the SAME live instance must follow.
    served["ttl"] = 1800
    state.effective_config_client.clear_cache()
    await refresh_model_cache_retention(state)

    stats = live.stats()
    assert stats.ttl_seconds == 1800, "a live cache must follow later control-plane changes"
    assert stats.resident_models == 1, "reconfiguration must not drop resident entries"
    assert stats.keys == ["resident-model"]


# ── clause 3 — fail-safe ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gateway_unreachable_falls_back_to_env() -> None:
    from guardrail.core.dependencies import (
        get_gliner_cache,
        refresh_model_cache_retention,
    )

    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway unreachable")

    state = _app_state(boom)

    # Must NOT raise — a config refresh may never break a safety request.
    await refresh_model_cache_retention(state)

    assert get_gliner_cache(state).stats().ttl_seconds == ENV_TTL_S


@pytest.mark.asyncio
async def test_absent_client_is_a_no_op() -> None:
    """A process with no client (tests, dev bypass) keeps env behaviour."""
    from guardrail.core.dependencies import (
        get_gliner_cache,
        refresh_model_cache_retention,
    )

    state = SimpleNamespace(settings=Settings())

    await refresh_model_cache_retention(state)

    assert get_gliner_cache(state).stats().ttl_seconds == ENV_TTL_S


@pytest.mark.asyncio
async def test_null_retention_keeps_env_value() -> None:
    """A gateway with no opinion (nulls) must not reset the knob."""
    from guardrail.core.dependencies import (
        get_gliner_cache,
        refresh_model_cache_retention,
    )

    state = _app_state(lambda _r: httpx.Response(200, json=_payload()))

    await refresh_model_cache_retention(state)

    assert get_gliner_cache(state).stats().ttl_seconds == ENV_TTL_S


# ── clause 4 — the clamp is re-applied client-side ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(("served", "expected"), [(7200, 3600), (30, 60)])
async def test_clamp_applied_client_side(served: int, expected: int) -> None:
    from guardrail.core.dependencies import (
        get_gliner_cache,
        refresh_model_cache_retention,
    )

    state = _app_state(lambda _r: httpx.Response(200, json=_payload(ttl_seconds=served)))

    await refresh_model_cache_retention(state)

    assert get_gliner_cache(state).stats().ttl_seconds == expected


# ── the wire contract ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_client_requests_its_own_service_subset() -> None:
    from guardrail.core.dependencies import refresh_model_cache_retention

    seen: dict[str, str] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["service"] = request.url.params["service"]
        seen["token"] = request.headers["X-Service-Token"]
        return httpx.Response(200, json=_payload(ttl_seconds=900))

    await refresh_model_cache_retention(_app_state(capture))

    assert seen["path"] == "/api/v1/internal/effective-config"
    assert seen["service"] == "guardrail"
    assert seen["token"] == "guardrail-token"
