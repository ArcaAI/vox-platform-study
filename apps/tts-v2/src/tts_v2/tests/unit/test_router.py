"""TDD tests for TTSRouter."""

from __future__ import annotations

import pytest

import tts_v2.routing.router as router_mod
from tts_v2.catalog.voices import VoiceCatalog
from tts_v2.core.config import Settings
from tts_v2.providers.base import AudioFormat, ProviderRegistry
from tts_v2.routing.router import AllProvidersUnavailableError, TTSRouter
from tts_v2.tests.fakes import FakeEngine


def _router(providers: dict, *, cb_threshold: int = 5) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in providers.items():
        reg.register(name, engine)
    return TTSRouter(reg, VoiceCatalog(), Settings(), cb_threshold=cb_threshold)


async def _collect(router: TTSRouter, **kwargs) -> list:
    return [chunk async for chunk in router.synthesize(**kwargs)]


class TestRouting:
    @pytest.mark.asyncio
    async def test_uses_first_provider_in_chain(self) -> None:
        azure, kokoro = FakeEngine("azure", chunks=2), FakeEngine("kokoro")
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, voice_id="en-female-1", text="Hello.")
        assert len(chunks) == 2
        assert azure.calls == 1 and kokoro.calls == 0

    @pytest.mark.asyncio
    async def test_ml_voice_uses_ml_binding_and_locale(self) -> None:
        azure = FakeEngine("azure")
        router = _router({"azure": azure})
        await _collect(router, voice_id="ml-female-1", text="ഹലോ.")
        assert azure.requests[0].provider_voice == "ml-IN-SobhanaNeural"
        assert azure.requests[0].locale == "ml-IN"

    @pytest.mark.asyncio
    async def test_failover_before_first_byte(self) -> None:
        azure = FakeEngine("azure", fail_before_emit=True)
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, voice_id="en-female-1", text="Hi.")
        assert azure.calls == 1 and kokoro.calls == 1
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_no_failover_after_first_byte(self) -> None:
        azure = FakeEngine("azure", chunks=3, fail_after_chunks=1)
        kokoro = FakeEngine("kokoro", chunks=2)
        router = _router({"azure": azure, "kokoro": kokoro})
        got = []
        with pytest.raises(RuntimeError):
            async for chunk in router.synthesize(voice_id="en-female-1", text="Hi."):
                got.append(chunk)
        assert len(got) == 1  # one chunk emitted before the failure
        assert kokoro.calls == 0  # never switched mid-stream

    @pytest.mark.asyncio
    async def test_open_breaker_skips_provider(self) -> None:
        azure = FakeEngine("azure")
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro}, cb_threshold=1)
        router.breaker("azure").record_failure()  # trips at threshold 1
        assert router.breaker("azure").is_open()
        chunks = await _collect(router, voice_id="en-female-1", text="Hi.")
        assert azure.calls == 0 and kokoro.calls == 1
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_all_providers_unavailable(self) -> None:
        router = _router({})  # nothing registered
        with pytest.raises(AllProvidersUnavailableError):
            await _collect(router, voice_id="en-female-1", text="Hi.")

    @pytest.mark.asyncio
    async def test_sentence_adapter_synthesizes_per_sentence(self) -> None:
        engine = FakeEngine("azure", native_streaming=False, chunks=1)
        router = _router({"azure": engine})
        await _collect(router, voice_id="en-female-1", text="One. Two. Three.")
        assert engine.calls == 3

    @pytest.mark.asyncio
    async def test_routing_override_reorders_chain(self) -> None:
        # A per-request routing_en override (gateway-injected from the
        # tenant config) wins over the static settings chain.
        azure, kokoro = FakeEngine("azure"), FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(
            router, voice_id="en-female-1", text="Hi.", routing_en=["kokoro", "azure"]
        )
        assert kokoro.calls == 1 and azure.calls == 0
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_allowed_providers_whitelist_filters_chain(self) -> None:
        # allowed_providers bounds the chain; azure (first by default)
        # is dropped when not whitelisted.
        azure, kokoro = FakeEngine("azure"), FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(
            router, voice_id="en-female-1", text="Hi.", allowed_providers=["kokoro"]
        )
        assert azure.calls == 0 and kokoro.calls == 1
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_provider_override_builds_per_tenant_engine(self, monkeypatch) -> None:
        # A BYO key lets a tenant use a provider the platform did NOT
        # register; the router builds a per-tenant engine from the injected creds.
        fake = FakeEngine("azure", chunks=1)
        monkeypatch.setattr(router_mod, "_build_override_engine", lambda settings, name, override: fake)
        router = _router({})  # azure NOT registered at the platform
        chunks = await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            provider_overrides={"azure": {"api_key": "tenant-key", "region": "eastus"}},
        )
        assert fake.calls == 1 and len(chunks) == 1

    @pytest.mark.asyncio
    async def test_cancellation_closes_engine(self) -> None:
        azure = FakeEngine("azure", chunks=5)
        router = _router({"azure": azure})
        gen = router.synthesize(voice_id="en-female-1", text="Hi.", fmt=AudioFormat.PCM)
        await gen.__anext__()
        await gen.aclose()
        assert azure.closed >= 1
