"""TDD tests for TTSRouter.

TASK-879 changed WHERE the routing decision comes from, not what failover means. The router used
to be handed a locale→provider chain, an allow-list and a voice-binding map that the gateway had
resolved from `TenantTtsConfig`; it is now handed a `ResolvedTtsSpec` — the tenant's
TEXT_TO_SPEECH agent, its bound model, that model's voices, and the connection row that serves
each engine — and it executes the ordered chain the spec names.

Everything below the selection is unchanged and still asserted here: failover happens only before
the first byte, a tripped breaker skips an engine, the winning engine is stamped on every chunk,
and each synthesis is wrapped in the cross-service inference gauge.
"""

from __future__ import annotations

import pytest

import tts.routing.router as router_mod
from tts.core.config import Settings
from tts.providers.base import AudioFormat, ProviderRegistry
from tts.routing.router import (
    AllProvidersUnavailableError,
    TTSRouter,
    TtsRoutingUnconfiguredError,
)
from tts.tests.fakes import FakeEngine, candidate, spec, voice_binding

EN = voice_binding("en-female-1", locale="en-IN")
ML = voice_binding("ml-female-1", locale="ml-IN", provider_voice="ml-IN-SobhanaNeural")


@pytest.fixture(autouse=True)
def registered_engines_serve(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default these tests to the REGISTERED engine for every candidate.

    In production `_engine_for` builds a request-scoped engine from the spec (`from_spec`) and
    only falls back to the registry when this image has no adapter for the name. These tests
    inject `FakeEngine`s by name, so the default here is "no spec-built engine" — the tests that
    care about the spec-built path override this explicitly.
    """
    monkeypatch.setattr(router_mod, "_build_spec_engine", lambda *_a, **_k: None)


def _router(providers: dict, *, cb_threshold: int = 5) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in providers.items():
        reg.register(name, engine)
    return TTSRouter(reg, Settings(), cb_threshold=cb_threshold)


def _en_spec(*engines: str, auto_switch: bool = True):
    """A spec whose chain is `engines`, all speaking the same English voice."""
    head, *rest = engines
    return spec(
        candidate(head, voices=[EN], voice=EN.id),
        chain=[
            candidate(
                name, kind="platform-default", voices=[EN], voice=EN.id, version_id=f"agent-{name}"
            )
            for name in rest
        ],
        auto_switch=auto_switch,
    )


async def _collect(router: TTSRouter, resolved, **kwargs) -> list:
    return [
        chunk
        async for chunk in router.synthesize(
            spec=resolved, text=kwargs.pop("text", "Hi."), **kwargs
        )
    ]


class TestRouting:
    @pytest.mark.asyncio
    async def test_uses_the_first_candidate_in_the_resolved_chain(self) -> None:
        azure, kokoro = FakeEngine("azure", chunks=2), FakeEngine("kokoro")
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, _en_spec("azure", "kokoro"), text="Hello.")
        assert len(chunks) == 2
        assert azure.calls == 1 and kokoro.calls == 0

    @pytest.mark.asyncio
    async def test_the_engine_voice_and_locale_come_from_the_candidate_binding(self) -> None:
        azure = FakeEngine("azure")
        router = _router({"azure": azure})
        await _collect(
            router, spec(candidate("azure", voices=[ML], voice=ML.id, language="ml")), text="ഹലോ."
        )
        # `providerVoice` is the engine-native name; the catalogue id is what the AGENT names.
        assert azure.requests[0].provider_voice == "ml-IN-SobhanaNeural"
        assert azure.requests[0].locale == "ml-IN"

    @pytest.mark.asyncio
    async def test_each_candidate_speaks_its_OWN_voice_not_the_primary_s(self) -> None:
        """Failing over must never carry a voice name the next engine cannot say."""
        azure = FakeEngine("azure", fail_before_emit=True)
        kokoro = FakeEngine("kokoro", chunks=1)
        resolved = spec(
            candidate("azure", voices=[ML], voice=ML.id, language="ml"),
            chain=[
                candidate(
                    "kokoro",
                    kind="platform-default",
                    voices=[EN],
                    voice=EN.id,
                    version_id="agent-kokoro",
                )
            ],
        )
        router = _router({"azure": azure, "kokoro": kokoro})
        await _collect(router, resolved)
        assert azure.requests[0].provider_voice == "ml-IN-SobhanaNeural"
        assert kokoro.requests[0].provider_voice == "en-female-1"
        assert kokoro.requests[0].locale == "en-IN"

    @pytest.mark.asyncio
    async def test_the_sample_rate_comes_from_the_candidate(self) -> None:
        kokoro = FakeEngine("kokoro")
        router = _router({"kokoro": kokoro})
        await _collect(
            router, spec(candidate("kokoro", voices=[EN], voice=EN.id, sample_rate=16000))
        )
        assert kokoro.requests[0].sample_rate == 16000

    @pytest.mark.asyncio
    async def test_an_agent_that_named_no_rate_gets_the_one_code_default(self) -> None:
        kokoro = FakeEngine("kokoro")
        router = _router({"kokoro": kokoro})
        await _collect(
            router, spec(candidate("kokoro", voices=[EN], voice=EN.id, sample_rate=None))
        )
        assert kokoro.requests[0].sample_rate == 24000

    @pytest.mark.asyncio
    async def test_failover_before_first_byte(self) -> None:
        azure = FakeEngine("azure", fail_before_emit=True)
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, _en_spec("azure", "kokoro"))
        assert azure.calls == 1 and kokoro.calls == 1
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_no_failover_after_first_byte(self) -> None:
        azure = FakeEngine("azure", chunks=3, fail_after_chunks=1)
        kokoro = FakeEngine("kokoro", chunks=2)
        router = _router({"azure": azure, "kokoro": kokoro})
        got = []
        with pytest.raises(RuntimeError):
            async for chunk in router.synthesize(spec=_en_spec("azure", "kokoro"), text="Hi."):
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
        chunks = await _collect(router, _en_spec("azure", "kokoro"))
        assert azure.calls == 0 and kokoro.calls == 1
        assert len(chunks) == 1

    @pytest.mark.asyncio
    async def test_all_providers_unavailable(self) -> None:
        router = _router({})  # nothing registered
        with pytest.raises(AllProvidersUnavailableError):
            await _collect(router, _en_spec("azure"))

    @pytest.mark.asyncio
    async def test_sentence_adapter_synthesizes_per_sentence(self) -> None:
        engine = FakeEngine("azure", native_streaming=False, chunks=1)
        router = _router({"azure": engine})
        await _collect(router, _en_spec("azure"), text="One. Two. Three.")
        assert engine.calls == 3

    @pytest.mark.asyncio
    async def test_the_spec_built_engine_wins_over_the_registered_one(self, monkeypatch) -> None:
        """A BYO key lets a tenant use an engine the platform never registered."""
        fake = FakeEngine("azure", chunks=1)
        monkeypatch.setattr(router_mod, "_build_spec_engine", lambda settings, cand, override: fake)
        router = _router({})  # azure NOT registered at the platform
        chunks = await _collect(
            router,
            _en_spec("azure"),
            provider_overrides={"azure": {"api_key": "tenant-key", "region": "eastus"}},
        )
        assert fake.calls == 1 and len(chunks) == 1

    @pytest.mark.asyncio
    async def test_cancellation_closes_engine(self) -> None:
        azure = FakeEngine("azure", chunks=5)
        router = _router({"azure": azure})
        gen = router.synthesize(spec=_en_spec("azure"), text="Hi.", fmt=AudioFormat.PCM)
        await gen.__anext__()
        await gen.aclose()
        assert azure.closed >= 1


class TestGatewayDecisionsAreReadVerbatim:
    """The gateway already decided three things; the router must not re-derive any of them."""

    def test_a_candidate_whose_engine_has_no_enabled_connection_is_walked_past(self) -> None:
        """`connection: null` is what `tts.<engine>.enabled: false` used to say."""
        router = _router({"azure": FakeEngine("azure"), "kokoro": FakeEngine("kokoro")})
        resolved = spec(
            candidate("azure", voices=[EN], voice=EN.id, connection=False),
            chain=[
                candidate(
                    "kokoro",
                    kind="platform-default",
                    voices=[EN],
                    voice=EN.id,
                    version_id="agent-kokoro",
                )
            ],
        )
        assert [c.engine for c in router.candidates(resolved)] == ["kokoro"]

    def test_auto_switch_off_runs_the_primary_and_stops(self) -> None:
        router = _router({"azure": FakeEngine("azure"), "kokoro": FakeEngine("kokoro")})
        assert [
            c.engine for c in router.candidates(_en_spec("azure", "kokoro", auto_switch=False))
        ] == ["azure"]

    def test_a_caller_named_voice_excludes_the_candidates_that_cannot_say_it(self) -> None:
        router = _router({"azure": FakeEngine("azure"), "kokoro": FakeEngine("kokoro")})
        resolved = spec(
            candidate("azure", voices=[ML], voice=ML.id),
            chain=[
                candidate(
                    "kokoro",
                    kind="platform-default",
                    voices=[EN],
                    voice=EN.id,
                    version_id="agent-kokoro",
                )
            ],
        )
        assert [c.engine for c in router.candidates(resolved, voice_id="en-female-1")] == ["kokoro"]


class TestFailClosedRouting:
    """The router carries NO code/env vendor default.

    Which engine speaks, in which voice, from which weights, is the tenant's AGENT — resolved by
    the gateway and pushed with the request. When the resolved chain comes back empty we raise
    rather than substitute a vendor.
    """

    @pytest.mark.asyncio
    async def test_synthesize_fails_closed_when_no_candidate_is_routable(self) -> None:
        azure, kokoro = FakeEngine("azure"), FakeEngine("kokoro")
        router = _router({"azure": azure, "kokoro": kokoro})
        unroutable = spec(candidate("kokoro", voices=[EN], voice=EN.id, connection=False))
        with pytest.raises(TtsRoutingUnconfiguredError):
            async for _ in router.synthesize(spec=unroutable, text="Hi."):
                pass
        assert azure.calls == 0 and kokoro.calls == 0

    @pytest.mark.asyncio
    async def test_the_agent_s_own_engine_serves_and_no_other_is_touched(self) -> None:
        azure, kokoro = FakeEngine("azure"), FakeEngine("kokoro", chunks=2)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, _en_spec("kokoro"))
        assert kokoro.calls == 1 and azure.calls == 0
        assert len(chunks) == 2

    def test_fail_closed_error_maps_to_provider_unavailable_at_boundary(self) -> None:
        # `TtsRoutingUnconfiguredError` is a specialization of `AllProvidersUnavailableError` so
        # the endpoints' existing 503 / WS provider-unavailable handlers cover it with no extra
        # wiring.
        assert issubclass(TtsRoutingUnconfiguredError, AllProvidersUnavailableError)


class TestProviderAttribution:
    """The router stamps ``AudioChunk.provider`` with the winning candidate so a caller (the
    usage-metering endpoints) learns which engine served without re-deriving failover state."""

    @pytest.mark.asyncio
    async def test_stamps_winning_provider_on_every_chunk(self) -> None:
        azure = FakeEngine("azure", chunks=3)
        router = _router({"azure": azure})
        chunks = await _collect(router, _en_spec("azure"))
        assert [c.provider for c in chunks] == ["azure", "azure", "azure"]

    @pytest.mark.asyncio
    async def test_stamps_the_provider_that_won_failover(self) -> None:
        azure = FakeEngine("azure", fail_before_emit=True)
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, _en_spec("azure", "kokoro"))
        assert [c.provider for c in chunks] == ["kokoro"]

    @pytest.mark.asyncio
    async def test_stamps_provider_through_the_sentence_adapter(self) -> None:
        engine = FakeEngine("azure", native_streaming=False, chunks=1)
        router = _router({"azure": engine})
        chunks = await _collect(router, _en_spec("azure"), text="One. Two.")
        assert chunks and all(c.provider == "azure" for c in chunks)


class TestModelInferenceTracking:
    """Every provider synthesis call is wrapped in the cross-service ``track_model_inference``
    gauge/histogram (engine name is the "model" label — TTS has no separate per-request model
    concept)."""

    @pytest.mark.asyncio
    async def test_synthesize_tracks_model_inference(self) -> None:
        from prometheus_client import REGISTRY

        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        labels = {"service": "tts", "model": "azure"}
        before = REGISTRY.get_sample_value("model_inference_latency_seconds_count", labels) or 0.0

        await _collect(router, _en_spec("azure"))

        after = REGISTRY.get_sample_value("model_inference_latency_seconds_count", labels)
        assert after == before + 1

    @pytest.mark.asyncio
    async def test_gauge_returns_to_zero_after_synthesis(self) -> None:
        from prometheus_client import REGISTRY

        azure = FakeEngine("azure", chunks=1)
        router = _router({"azure": azure})
        labels = {"service": "tts", "model": "azure"}

        await _collect(router, _en_spec("azure"))

        assert REGISTRY.get_sample_value("model_running_instances", labels) in (0.0, None)


class TestEngineCaching:
    """A request-scoped engine is cached by WHAT IT LOADS AND AUTHENTICATES TO — never by name.

    Two tenants on the same engine with different credentials, or the same engine on different
    weights, must not share an instance; the same facts twice must not rebuild one, or a resident
    model would be reloaded on every request.
    """

    def test_same_facts_reuse_one_instance(self, monkeypatch) -> None:
        built: list[FakeEngine] = []
        monkeypatch.setattr(
            router_mod,
            "_build_spec_engine",
            lambda *_a, **_k: built.append(FakeEngine("kokoro")) or built[-1],
        )
        router = _router({})
        cand = candidate("kokoro", voices=[EN], voice=EN.id, local_path="/mnt/models/kokoro")
        assert router._engine_for(cand, None) is router._engine_for(cand, None)
        assert len(built) == 1

    def test_a_different_credential_builds_a_different_instance(self, monkeypatch) -> None:
        monkeypatch.setattr(router_mod, "_build_spec_engine", lambda *_a, **_k: FakeEngine("azure"))
        router = _router({})
        cand = candidate("azure", voices=[EN], voice=EN.id)
        first = router._engine_for(cand, {"azure": {"api_key": "tenant-a"}})
        second = router._engine_for(cand, {"azure": {"api_key": "tenant-b"}})
        assert first is not second

    def test_different_weights_build_a_different_instance(self, monkeypatch) -> None:
        monkeypatch.setattr(
            router_mod, "_build_spec_engine", lambda *_a, **_k: FakeEngine("kokoro")
        )
        router = _router({})
        a = candidate("kokoro", voices=[EN], voice=EN.id, local_path="/mnt/models/a")
        b = candidate("kokoro", voices=[EN], voice=EN.id, local_path="/mnt/models/b")
        assert router._engine_for(a, None) is not router._engine_for(b, None)


class TestAnEngineThisImageDoesNotContain:
    """The agent may name an engine this image was not built with.

    `[indic-parler]` and `[indic-f5]` are optional image variants, so a tenant whose agent binds
    one and a pod that does not ship it are both legitimate. That is a ROUTING fact — exactly what
    the fallback chain exists for — and it must never surface as a 500 or be recorded against the
    engine's own reliability.
    """

    @pytest.mark.asyncio
    async def test_falls_over_to_the_next_candidate(self) -> None:
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"kokoro": kokoro})  # indic_parler is not in this image
        resolved = spec(
            candidate("indic_parler", voices=[ML], voice=ML.id, language="ml"),
            chain=[
                candidate(
                    "kokoro",
                    kind="platform-default",
                    voices=[EN],
                    voice=EN.id,
                    version_id="agent-kokoro",
                )
            ],
        )
        chunks = await _collect(router, resolved)
        assert [c.provider for c in chunks] == ["kokoro"]

    @pytest.mark.asyncio
    async def test_does_not_trip_the_absent_engine_s_breaker(self) -> None:
        router = _router({"kokoro": FakeEngine("kokoro", chunks=1)}, cb_threshold=1)
        resolved = spec(
            candidate("indic_parler", voices=[ML], voice=ML.id, language="ml"),
            chain=[
                candidate(
                    "kokoro",
                    kind="platform-default",
                    voices=[EN],
                    voice=EN.id,
                    version_id="agent-kokoro",
                )
            ],
        )
        await _collect(router, resolved)
        assert not router.breaker("indic_parler").is_open()

    @pytest.mark.asyncio
    async def test_the_whole_chain_absent_is_provider_unavailable_not_a_crash(self) -> None:
        router = _router({})
        with pytest.raises(AllProvidersUnavailableError):
            await _collect(router, _en_spec("indic_parler"))


class TestKeylessCloudEngine:
    """A registered cloud engine with no credential is not a candidate — it would 401.

    Registration says what this PROCESS contains; the connection row says what may serve; and
    this says whether the engine can actually authenticate. All three are separate questions, and
    only the third can be answered by the engine itself.
    """

    @pytest.mark.asyncio
    async def test_it_is_walked_past(self) -> None:
        azure = FakeEngine("azure", configured=False)
        kokoro = FakeEngine("kokoro", chunks=1)
        router = _router({"azure": azure, "kokoro": kokoro})
        chunks = await _collect(router, _en_spec("azure", "kokoro"))
        assert azure.calls == 0
        assert [c.provider for c in chunks] == ["kokoro"]

    @pytest.mark.asyncio
    async def test_a_chain_of_only_keyless_engines_fails_closed(self) -> None:
        router = _router({"azure": FakeEngine("azure", configured=False)})
        with pytest.raises(AllProvidersUnavailableError):
            await _collect(router, _en_spec("azure"))

    @pytest.mark.asyncio
    async def test_a_tenant_that_brings_its_own_key_makes_it_available(self, monkeypatch) -> None:
        keyed = FakeEngine("azure", chunks=1)
        monkeypatch.setattr(
            router_mod,
            "_build_spec_engine",
            lambda _s, _c, override: keyed if override.get("api_key") else None,
        )
        router = _router({"azure": FakeEngine("azure", configured=False)})
        chunks = await _collect(
            router, _en_spec("azure"), provider_overrides={"azure": {"api_key": "byo"}}
        )
        assert [c.provider for c in chunks] == ["azure"] and keyed.calls == 1
