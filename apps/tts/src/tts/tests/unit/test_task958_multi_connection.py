"""TASK-958 (test 29) — two connections of the SAME vendor in one fallback chain.

A tenant may now hold more than one ``AiProviderConnection`` for a given
``(service, provider)`` — two Azure Speech resources, two OpenAI accounts. The TTS
plane sees that as two candidates whose ``model.provider`` is the SAME engine name
but whose credentials are different, so the flat provider-keyed
``provider_overrides`` map can no longer say which key serves which candidate:
``overrides["azure"]`` is one entry and both candidates read it.

``ResolvedTtsCandidate.connection_key`` is the discriminator the gateway stamps —
the tenant connection's ``slug`` for a tenant row, the provider/engine name for a
platform row — and ``provider_overrides`` is keyed by it. The reader falls back to
the engine name so a payload from a gateway that predates the field resolves
EXACTLY as it does today.

What this pins:

* two same-engine candidates with distinct ``connection_key``s build two DISTINCT
  engine instances and the failover spends the SECOND key, not the first one twice;
* a legacy payload (no ``connection_key`` anywhere) still resolves its credential
  under the engine name;
* the engine cache key separates two candidates that differ only by credential, so
  one connection can never be served on another's cached engine.
"""

from __future__ import annotations

import pytest

import tts.routing.router as router_mod
from tts.core.config import Settings
from tts.providers.base import ProviderRegistry
from tts.routing.router import TTSRouter, _engine_cache_key
from tts.tests.fakes import FakeEngine, candidate, spec, voice_binding

EN = voice_binding("en-female-1", locale="en-IN")


def _router(providers: dict | None = None) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in (providers or {}).items():
        reg.register(name, engine)
    return TTSRouter(reg, Settings())


def _two_azure_connections():
    """One chain, one engine, two tenant connections."""
    primary = candidate(
        "azure",
        voices=[EN],
        voice=EN.id,
        connection_id="conn-1",
        connection_slug="azure-clinic",
        connection_key="azure-clinic",
    )
    sibling = candidate(
        "azure",
        kind="fallback-model",
        voices=[EN],
        voice=EN.id,
        slug="azure-research-model",
        version_id="agent-azure-2",
        connection_id="conn-2",
        connection_slug="azure-research",
        connection_key="azure-research",
    )
    return spec(primary, chain=[sibling])


def _keyed_builder(monkeypatch, *, failing_key: str | None = None) -> dict[str, FakeEngine]:
    """Build one FakeEngine per distinct injected ``api_key``.

    This is the whole point of the test: the engine a candidate gets is a function
    of the CREDENTIAL it was handed, so "both candidates ran on one key" and "each
    candidate ran on its own key" are distinguishable outcomes.
    """
    built: dict[str, FakeEngine] = {}

    def build(_settings, cand, override):
        key = override.get("api_key")
        if not key:
            return None
        engine = built.get(key)
        if engine is None:
            engine = FakeEngine(cand.engine or "", chunks=1, fail_before_emit=(key == failing_key))
            built[key] = engine
        return engine

    monkeypatch.setattr(router_mod, "_build_spec_engine", build)
    return built


async def _collect(router: TTSRouter, resolved, **kwargs) -> list:
    return [chunk async for chunk in router.synthesize(spec=resolved, text="Hi.", **kwargs)]


class TestTwoConnectionsOfOneVendor:
    @pytest.mark.asyncio
    async def test_the_fallback_spends_the_SECOND_connection_s_key(self, monkeypatch) -> None:
        built = _keyed_builder(monkeypatch, failing_key="key-clinic")
        chunks = await _collect(
            _router(),
            _two_azure_connections(),
            provider_overrides={
                "azure-clinic": {"api_key": "key-clinic", "connection_id": "conn-1"},
                "azure-research": {"api_key": "key-research", "connection_id": "conn-2"},
            },
        )
        # Two DISTINCT engine instances — not one instance reached twice.
        assert sorted(built) == ["key-clinic", "key-research"]
        assert built["key-clinic"] is not built["key-research"]
        # The primary's key was tried and failed; the sibling's key served.
        assert built["key-clinic"].calls == 1
        assert built["key-research"].calls == 1
        assert [c.provider for c in chunks] == ["azure"]

    @pytest.mark.asyncio
    async def test_a_legacy_payload_with_no_connection_key_resolves_under_the_engine_name(
        self, monkeypatch
    ) -> None:
        """A gateway that predates the field must keep working byte-for-byte."""
        built = _keyed_builder(monkeypatch)
        legacy = spec(candidate("azure", voices=[EN], voice=EN.id))
        chunks = await _collect(
            _router(), legacy, provider_overrides={"azure": {"api_key": "platform-key"}}
        )
        assert sorted(built) == ["platform-key"]
        assert [c.provider for c in chunks] == ["azure"]

    @pytest.mark.asyncio
    async def test_a_connection_keyed_override_never_leaks_to_the_sibling(
        self, monkeypatch
    ) -> None:
        """Only one of the two connections is keyed — the other must NOT borrow it."""
        built = _keyed_builder(monkeypatch)
        chunks = await _collect(
            _router({"azure": FakeEngine("azure", configured=False)}),
            _two_azure_connections(),
            provider_overrides={"azure-research": {"api_key": "key-research"}},
        )
        # The primary had no entry of its own: it is walked past (the registered
        # engine is keyless), and only the sibling's key ever built an engine.
        assert sorted(built) == ["key-research"]
        assert [c.provider for c in chunks] == ["azure"]

    def test_the_engine_cache_key_separates_two_credentials_of_one_engine(self) -> None:
        spec_ = _two_azure_connections()
        first = _engine_cache_key(spec_.primary, {"api_key": "key-clinic"})
        second = _engine_cache_key(spec_.fallback.chain[0], {"api_key": "key-research"})
        assert first != second


class TestTheSpecCarriesTheConnectionIdentity:
    def test_the_candidate_exposes_its_connection_key_and_id(self) -> None:
        spec_ = _two_azure_connections()
        assert spec_.primary.connection_key == "azure-clinic"
        assert spec_.primary.connection is not None
        assert spec_.primary.connection.connection_id == "conn-1"
        assert spec_.primary.connection.connection_slug == "azure-clinic"
        assert spec_.fallback.chain[0].connection_key == "azure-research"

    def test_a_candidate_without_the_fields_reads_them_as_None(self) -> None:
        legacy = candidate("azure", voices=[EN], voice=EN.id)
        assert legacy.connection_key is None
        assert legacy.connection is not None
        assert legacy.connection.connection_id is None
        assert legacy.connection.connection_slug is None

    def test_unset_connection_fields_are_OMITTED_from_the_wire_not_serialised_as_null(
        self,
    ) -> None:
        """The two halves must stay independently deployable against ``extra='forbid'``.

        A sender that predates these fields omits them; echoing them back as
        ``null`` would make the mirror's dump differ from the bytes that arrived,
        which is exactly what the committed contract fixture round-trip asserts
        must never happen.
        """
        dumped = candidate("azure", voices=[EN], voice=EN.id).model_dump(by_alias=True)
        assert "connectionKey" not in dumped
        assert "connectionId" not in dumped["connection"]
        assert "connectionSlug" not in dumped["connection"]

    def test_a_stamped_connection_key_DOES_survive_the_round_trip(self) -> None:
        dumped = _two_azure_connections().primary.model_dump(by_alias=True)
        assert dumped["connectionKey"] == "azure-clinic"
        assert dumped["connection"]["connectionId"] == "conn-1"
        assert dumped["connection"]["connectionSlug"] == "azure-clinic"


class TestUsageAttributionNamesTheConnection:
    """D-7 — a tenant that brought two keys must be able to see which one it spent."""

    @pytest.mark.asyncio
    async def test_the_chunk_carries_the_connection_that_served_it(self, monkeypatch) -> None:
        _keyed_builder(monkeypatch, failing_key="key-clinic")
        chunks = await _collect(
            _router(),
            _two_azure_connections(),
            provider_overrides={
                "azure-clinic": {"api_key": "key-clinic"},
                "azure-research": {"api_key": "key-research"},
            },
        )
        # The FAILOVER's connection, not the primary's — the two share a provider name,
        # so `provider` alone would attribute the spend to the key that failed.
        assert [c.connection_id for c in chunks] == ["conn-2"]

    @pytest.mark.asyncio
    async def test_a_legacy_payload_leaves_the_connection_unstamped(self, monkeypatch) -> None:
        _keyed_builder(monkeypatch)
        legacy = spec(candidate("azure", voices=[EN], voice=EN.id))
        chunks = await _collect(
            _router(), legacy, provider_overrides={"azure": {"api_key": "platform-key"}}
        )
        # `None`, never a provider name standing in for a connection id.
        assert [c.connection_id for c in chunks] == [None]

    @pytest.mark.asyncio
    async def test_the_speech_endpoint_answers_the_connection_header(self, monkeypatch) -> None:
        import pytest_asyncio  # noqa: F401  (imported for parity with the endpoint suite)
        from httpx import ASGITransport, AsyncClient

        from tts.main import create_app
        from tts.tests.fakes import spec_json

        _keyed_builder(monkeypatch, failing_key="key-clinic")
        app = create_app(settings_override=Settings(debug=True, internal_access_token=""))
        body = {
            "input": "Hello.",
            "voice": EN.id,
            "response_format": "pcm",
            "resolved_spec": _two_azure_connections().model_dump(by_alias=True, mode="json"),
            "provider_overrides": {
                "azure-clinic": {"api_key": "key-clinic"},
                "azure-research": {"api_key": "key-research"},
            },
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post("/api/v1/audio/speech", json=body)
        assert r.status_code == 200
        assert r.headers["X-Tts-Provider"] == "azure"
        assert r.headers["X-Tts-Connection-Id"] == "conn-2"

        # A legacy request states no connection, and the header is ABSENT rather than
        # empty: the gateway writes a nullable ledger column from it.
        legacy_body = {
            "input": "Hello.",
            "voice": EN.id,
            "response_format": "pcm",
            "resolved_spec": spec_json(candidate("azure", voices=[EN], voice=EN.id)),
            "provider_overrides": {"azure": {"api_key": "platform-key"}},
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r2 = await c.post("/api/v1/audio/speech", json=legacy_body)
        assert r2.status_code == 200
        assert "X-Tts-Connection-Id" not in r2.headers
