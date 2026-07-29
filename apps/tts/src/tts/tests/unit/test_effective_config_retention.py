"""tts takes local-engine retention from the control plane.

`configure_retention` on kokoro / indic_parler / indic_f5 must actually be
called so `tts.modelCache.ttlSeconds` reaches a pipeline.

The trap worth a dedicated test: the gateway maps service `tts` to the
KEY prefix `tts` (`effective-config.service.ts:116`). A client that asks for
`service=tts` gets rejected; one that expects keys named `tts.modelCache.*`
finds nothing. Both directions must not be a silent no-op.

Hermetic — `httpx.MockTransport` + fake pipeline factories; no weights, no
network.

RED: written before the implementation.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from tts.core.config import Settings
from tts.providers.base import ProviderRegistry

ENV_TTL_S = 600
LOCAL_ENGINES = ("kokoro", "indic_parler", "indic_f5")


def _payload(ttl_seconds: int | None = None) -> dict[str, Any]:
    """The gateway's `tts` subset — resolved from the `tts` key prefix."""
    return {
        "service": "tts",
        "generatedAt": "2026-07-20T00:00:00.000Z",
        "retention": {
            "ttlSeconds": ttl_seconds,
            "maxModels": None,
            "maxMemoryMb": None,
            "vramBudgetMb": None,
            "source": "db",
        },
    }


def _client(handler):  # noqa: ANN001,ANN202
    from tts.core.effective_config import EffectiveConfigClient

    return EffectiveConfigClient(
        base_url="http://gateway.test/api/v1",
        token="tts-token",
        transport=httpx.MockTransport(handler),
    )


class _FakePipeline:
    def __call__(self, text: str, voice: str | None = None):  # noqa: ANN204
        import numpy as np

        return [(None, None, np.zeros(240, dtype=np.float32))]


def _make_provider(engine: str, ttl_seconds: int = ENV_TTL_S):  # noqa: ANN202
    if engine == "kokoro":
        from tts.core.config import KokoroConfig
        from tts.providers.kokoro import KokoroProvider

        return KokoroProvider(
            KokoroConfig(), pipeline_factory=_FakePipeline, ttl_seconds=ttl_seconds
        )
    if engine == "indic_parler":
        from tts.core.config import IndicParlerConfig
        from tts.providers.indic_parler import IndicParlerProvider

        return IndicParlerProvider(
            IndicParlerConfig(), generate_factory=lambda: None, ttl_seconds=ttl_seconds
        )

    from tts.core.config import IndicF5Config
    from tts.providers.indic_f5 import IndicF5Provider

    return IndicF5Provider(IndicF5Config(), generate_factory=lambda: None, ttl_seconds=ttl_seconds)


def _app_state(handler, *, engines=LOCAL_ENGINES):  # noqa: ANN001,ANN202
    registry = ProviderRegistry()
    providers = {name: _make_provider(name) for name in engines}
    for name, provider in providers.items():
        registry.register(name, provider)

    settings = Settings()
    assert settings.model_cache_ttl_seconds == ENV_TTL_S, "env baseline moved"

    state = SimpleNamespace(
        settings=settings,
        provider_registry=registry,
        effective_config_client=_client(handler),
    )
    return state, providers


def _ttl(provider) -> int:  # noqa: ANN001
    return provider._cache.stats().ttl_seconds


# ── clause 1 — the control plane wins over env ──────────────────────────────


@pytest.mark.asyncio
async def test_retention_comes_from_control_plane() -> None:
    from tts.core.effective_config import refresh_model_cache_retention

    state, providers = _app_state(lambda _r: httpx.Response(200, json=_payload(900)))

    await refresh_model_cache_retention(state)

    for name, provider in providers.items():
        assert _ttl(provider) == 900, f"{name} kept the env TTL"


# ── clause 2 — LIVE caches reconfigured, residents kept ─────────────────────


@pytest.mark.asyncio
async def test_live_cache_reconfigured_not_just_new_ones() -> None:
    """§3.2 — a provider already holding a loaded pipeline must follow changes."""
    from tts.core.effective_config import refresh_model_cache_retention
    from tts.providers.base import AudioFormat, SynthesisRequest

    served = {"ttl": 900}
    state, providers = _app_state(
        lambda _r: httpx.Response(200, json=_payload(served["ttl"])), engines=("kokoro",)
    )
    kokoro = providers["kokoro"]

    # Load the pipeline: the cache is now LIVE with a resident model.
    async for _ in kokoro.synthesize(
        SynthesisRequest(
            text="hello",
            locale="en-US",
            fmt=AudioFormat.PCM,
            provider_voice=None,
            sample_rate=24000,
        )
    ):
        pass
    assert kokoro._cache.stats().resident_models == 1

    await refresh_model_cache_retention(state)
    assert _ttl(kokoro) == 900

    served["ttl"] = 1800
    state.effective_config_client.clear_cache()
    await refresh_model_cache_retention(state)

    stats = kokoro._cache.stats()
    assert stats.ttl_seconds == 1800, "a live cache must follow later changes"
    assert stats.resident_models == 1, "reconfiguration must not drop the loaded pipeline"


# ── clause 3 — fail-safe ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gateway_unreachable_falls_back_to_env() -> None:
    from tts.core.effective_config import refresh_model_cache_retention

    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway unreachable")

    state, providers = _app_state(boom)

    # Must NOT raise — a config refresh may never break a synthesis request.
    await refresh_model_cache_retention(state)

    for provider in providers.values():
        assert _ttl(provider) == ENV_TTL_S


@pytest.mark.asyncio
async def test_absent_client_is_a_no_op() -> None:
    from tts.core.effective_config import refresh_model_cache_retention

    state, providers = _app_state(lambda _r: httpx.Response(200, json=_payload(900)))
    state.effective_config_client = None

    await refresh_model_cache_retention(state)

    for provider in providers.values():
        assert _ttl(provider) == ENV_TTL_S


@pytest.mark.asyncio
async def test_cloud_providers_without_the_seam_are_skipped() -> None:
    """Azure / Sarvam hold no weights and expose no `configure_retention`."""
    from tts.core.effective_config import refresh_model_cache_retention

    state, providers = _app_state(
        lambda _r: httpx.Response(200, json=_payload(900)), engines=("kokoro",)
    )
    state.provider_registry.register("azure", SimpleNamespace())

    await refresh_model_cache_retention(state)

    assert _ttl(providers["kokoro"]) == 900


# ── clause 4 — the clamp is re-applied client-side ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(("served", "expected"), [(7200, 3600), (30, 60)])
async def test_clamp_applied_client_side(served: int, expected: int) -> None:
    from tts.core.effective_config import refresh_model_cache_retention

    state, providers = _app_state(lambda _r: httpx.Response(200, json=_payload(served)))

    await refresh_model_cache_retention(state)

    for provider in providers.values():
        assert _ttl(provider) == expected


# ── §3.4 — the service/key namespace trap ───────────────────────────────────


@pytest.mark.asyncio
async def test_service_param_and_key_namespace() -> None:
    """The client asks for `tts`; the KEYS resolve server-side under `tts`.

    The gateway's `InternalServiceTokenGuard` registers the service as `tts`
    and `EffectiveConfigService` maps that case to `resolveRetention('tts')`, so
    the client must send `tts` and read a plain `retention` group. Asking for
    `tts` is a 401/400; expecting `tts.modelCache.*` keys in the body finds
    nothing. Both are silent no-ops.
    """
    from tts.core.effective_config import (
        SERVICE_NAME,
        refresh_model_cache_retention,
    )

    assert SERVICE_NAME == "tts", "the gateway registers this service as `tts`"

    seen: dict[str, str] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["service"] = request.url.params["service"]
        seen["token"] = request.headers["X-Service-Token"]
        # The body carries a flat `retention` group — NOT `tts.modelCache.*`.
        return httpx.Response(200, json=_payload(900))

    state, providers = _app_state(capture, engines=("kokoro",))
    await refresh_model_cache_retention(state)

    assert seen["path"] == "/api/v1/internal/effective-config"
    assert seen["service"] == "tts", "must NOT send the `tts` key prefix as the service"
    assert seen["token"] == "tts-token"
    assert _ttl(providers["kokoro"]) == 900
