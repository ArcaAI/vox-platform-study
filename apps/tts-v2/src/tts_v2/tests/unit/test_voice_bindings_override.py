"""TDD tests for gateway-injected per-request voice-binding overrides.

``voice_bindings`` (``{internalVoiceId: {provider: providerVoiceName}}``) is
resolved by the gateway from the AiModel registry / tenant TTS config and
injected per request. When present for the requested voice id it MERGES OVER
that voice's binding map from ``DEFAULT_VOICES`` — mentioned providers get the
overridden voice name, unmentioned providers keep their catalog binding (and
therefore their failover eligibility; "empty = inherit"). The global catalog
is never mutated.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from tts_v2.api.endpoints.stream_ws import _voice_bindings
from tts_v2.catalog.voices import DEFAULT_VOICES, VoiceCatalog
from tts_v2.core.config import Settings
from tts_v2.main import create_app
from tts_v2.providers.base import ProviderRegistry
from tts_v2.routing.router import TTSRouter, _apply_voice_bindings
from tts_v2.tests.fakes import FakeEngine


def _router(providers: dict) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in providers.items():
        reg.register(name, engine)
    return TTSRouter(reg, VoiceCatalog(), Settings())


async def _collect(router: TTSRouter, **kwargs) -> list:
    return [chunk async for chunk in router.synthesize(**kwargs)]


class TestSynthesizeOverride:
    @pytest.mark.asyncio
    async def test_override_replaces_provider_voice_name(self) -> None:
        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hello.",
            voice_bindings={"en-female-1": {"azure": "en-IN-AartiNeural"}},
        )
        assert azure.requests[0].provider_voice == "en-IN-AartiNeural"

    @pytest.mark.asyncio
    async def test_partial_override_merges_over_catalog_bindings(self) -> None:
        # Catalog binds en-female-1 to azure AND kokoro; the override lists only
        # kokoro → azure STAYS eligible with its catalog voice (merge, not
        # replace) and kokoro carries the overridden name (Finding D).
        azure, kokoro = FakeEngine("azure", chunks=1), FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        merged = _apply_voice_bindings(
            VoiceCatalog().get("en-female-1"), {"en-female-1": {"kokoro": "af_bella"}}
        )
        assert merged.bindings == {"azure": "en-IN-NeerjaNeural", "kokoro": "af_bella"}
        assert router.candidates(merged) == ["azure", "kokoro"]
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            voice_bindings={"en-female-1": {"kokoro": "af_bella"}},
        )
        # Azure heads the chain and serves with its catalog voice name.
        assert azure.calls == 1 and kokoro.calls == 0
        assert azure.requests[0].provider_voice == "en-IN-NeerjaNeural"

    @pytest.mark.asyncio
    async def test_partial_override_preserves_failover(self) -> None:
        # A tenant overriding only kokoro's voice must NOT lose the azure
        # binding: when azure fails before the first byte, failover still
        # reaches kokoro, which uses the overridden voice name.
        azure = FakeEngine("azure", fail_before_emit=True)
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            voice_bindings={"en-female-1": {"kokoro": "af_bella"}},
        )
        assert azure.calls == 1 and kokoro.calls == 1  # both were candidates
        assert kokoro.requests[0].provider_voice == "af_bella"

    @pytest.mark.asyncio
    async def test_absent_and_empty_override_keep_catalog_bindings(self) -> None:
        for bindings in (None, {}, {"ml-female-1": {"azure": "other-voice"}}):
            azure = FakeEngine("azure", chunks=1)
            router = _router({"azure": azure})
            await _collect(
                router,
                voice_id="en-female-1",
                text="Hi.",
                voice_bindings=bindings,
            )
            assert azure.requests[0].provider_voice == "en-IN-NeerjaNeural"

    @pytest.mark.asyncio
    async def test_unknown_provider_in_override_keeps_catalog_providers(self) -> None:
        # Merge semantics: an unknown provider in the override is simply never
        # a candidate (not registered); the catalog providers stay eligible.
        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            voice_bindings={"en-female-1": {"not-a-provider": "x"}},
        )
        assert azure.calls == 1
        assert azure.requests[0].provider_voice == "en-IN-NeerjaNeural"

    @pytest.mark.asyncio
    async def test_malformed_entries_are_ignored(self) -> None:
        # Non-string provider names / voice names are dropped; when nothing
        # valid remains the catalog bindings stay in effect.
        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            voice_bindings={"en-female-1": {42: "x", "azure": 123}},  # type: ignore[dict-item]
        )
        assert azure.requests[0].provider_voice == "en-IN-NeerjaNeural"

    @pytest.mark.asyncio
    async def test_override_does_not_mutate_global_catalog(self) -> None:
        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        await _collect(
            router,
            voice_id="en-female-1",
            text="Hi.",
            voice_bindings={"en-female-1": {"azure": "en-IN-AartiNeural"}},
        )
        assert router._catalog.get("en-female-1").bindings["azure"] == "en-IN-NeerjaNeural"
        default = next(v for v in DEFAULT_VOICES if v.id == "en-female-1")
        assert default.bindings["azure"] == "en-IN-NeerjaNeural"


class TestStreamOverride:
    @pytest.mark.asyncio
    async def test_stream_path_applies_override(self) -> None:
        azure = FakeEngine("azure", native_streaming=False, chunks=1)
        router = _router({"azure": azure})
        stream = router.stream(
            voice_id="en-female-1",
            voice_bindings={"en-female-1": {"azure": "en-IN-AartiNeural"}},
        )
        await stream.push_text("Hello there. ")
        await stream.end_input()
        frames = [chunk async for chunk in stream]
        assert frames
        assert azure.requests[0].provider_voice == "en-IN-AartiNeural"


class TestSpeechEndpointOverride:
    @pytest.mark.asyncio
    async def test_request_field_reroutes_binding(self) -> None:
        app = create_app(settings_override=Settings(debug=True))
        azure = FakeEngine("azure", chunks=1, payload=b"PCM")
        app.state.provider_registry.register("azure", azure)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                "/api/v1/audio/speech",
                json={
                    "input": "Hello.",
                    "voice": "en-female-1",
                    "response_format": "pcm",
                    "voice_bindings": {"en-female-1": {"azure": "en-IN-AartiNeural"}},
                },
            )
        assert r.status_code == 200
        assert azure.requests[0].provider_voice == "en-IN-AartiNeural"


class TestWsInitCoercion:
    def test_valid_mapping_passes_through(self) -> None:
        assert _voice_bindings({"en-female-1": {"azure": "voice-x"}}) == {
            "en-female-1": {"azure": "voice-x"}
        }

    def test_malformed_entries_dropped(self) -> None:
        assert _voice_bindings(
            {"en-female-1": {"azure": 123}, "ml-male-1": "nope", 7: {"a": "b"}}
        ) is None

    def test_non_dict_or_empty_is_none(self) -> None:
        assert _voice_bindings(None) is None
        assert _voice_bindings([]) is None
        assert _voice_bindings({}) is None
