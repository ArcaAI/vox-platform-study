"""TASK-958 (wire review #4) — a DECLARED connection key fails CLOSED on the TTS plane.

``override_for`` reads ``provider_overrides`` under the candidate's
``connection_key`` first and the ENGINE NAME second. The second read is there for
COMPATIBILITY: a tenant's DEFAULT connection has ``slug == provider``, and a
payload from a gateway that stamps no key at all must resolve exactly as it did.

It was, however, a fallback for BOTH misses — and that is the money bug. The
gateway deliberately folds a sibling connection OUT of ``provider_overrides``
when it is disabled, keyless or vetoed; the absence IS the decision. Falling back
to the engine-name entry serves that candidate on the tenant's DEFAULT vendor
account: the wrong key, the wrong invoice, and a key the tenant had taken out of
play.

The rule, on both planes (``stt.models.cloud_asr.resolve_override_key`` is the
ASR half):

* ``connection_key`` DECLARED (non-empty) → the entry under it, or ``{}``.
  Nothing else is consulted, and the adapter refuses a credential-less candidate
  on its own terms — for a cloud engine that is ``from_spec`` returning ``None``,
  which the router already treats as "this candidate cannot serve" and walks on.
* ``connection_key`` ABSENT → today's engine-name read, unchanged.

For every default and platform candidate the two reads coincide, which is why
this tightens the rule without changing anything that works today.
"""

from __future__ import annotations

import pytest

import tts.routing.router as router_mod
from tts.core.config import Settings
from tts.providers.base import ProviderRegistry
from tts.routing.router import TTSRouter, override_for
from tts.tests.fakes import FakeEngine, candidate, spec, voice_binding

EN = voice_binding("en-female-1", locale="en-IN")

# The tenant's DEFAULT azure account, plus ONE named sibling. The other sibling
# (`azure-research`) is deliberately absent: that is how the gateway says
# "this connection serves nobody right now".
OVERRIDES = {
    "azure": {"api_key": "default-key"},
    "azure-clinic": {"api_key": "key-clinic"},
}


def _router(providers: dict | None = None) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in (providers or {}).items():
        reg.register(name, engine)
    return TTSRouter(reg, Settings())


def _azure(connection_key: str | None, *, kind: str = "primary", slug: str | None = None) -> object:
    return candidate(
        "azure",
        kind=kind,
        voices=[EN],
        voice=EN.id,
        slug=slug,
        version_id=f"agent-azure-{slug or 'primary'}",
        connection_key=connection_key,
        connection_slug=connection_key,
    )


def _keyed_builder(monkeypatch) -> dict[str, FakeEngine]:
    """One FakeEngine per distinct injected ``api_key``; ``None`` for a keyless candidate.

    Which keys were BUILT is the assertion: "the sibling borrowed the default's
    key" and "the sibling was walked past" are otherwise indistinguishable from
    the audio that comes out.
    """
    built: dict[str, FakeEngine] = {}

    def build(_settings, cand, override):
        key = override.get("api_key")
        if not key:
            return None
        engine = built.get(key)
        if engine is None:
            engine = FakeEngine(cand.engine or "", chunks=1)
            built[key] = engine
        return engine

    monkeypatch.setattr(router_mod, "_build_spec_engine", build)
    return built


class TestADeclaredKeyIsTheOnlyKeyRead:
    def test_a_declared_key_that_missed_does_NOT_fall_back_to_the_engine_name(self) -> None:
        """The sibling the gateway left credential-less must not spend the default's key."""
        assert override_for(_azure("azure-research"), OVERRIDES) == {}

    def test_a_declared_key_that_hit_still_returns_its_own_entry(self) -> None:
        assert override_for(_azure("azure-clinic"), OVERRIDES) == {"api_key": "key-clinic"}

    def test_the_default_connection_still_resolves_because_its_slug_IS_the_engine_name(
        self,
    ) -> None:
        assert override_for(_azure("azure"), OVERRIDES) == {"api_key": "default-key"}

    def test_no_declared_key_reads_the_engine_name_exactly_as_before(self) -> None:
        assert override_for(_azure(None), OVERRIDES) == {"api_key": "default-key"}

    def test_an_empty_declared_key_is_not_a_declaration(self) -> None:
        """`""` is what a mis-serialised field looks like; a legacy payload must still resolve."""
        assert override_for(_azure(""), OVERRIDES) == {"api_key": "default-key"}

    def test_an_empty_entry_under_the_declared_key_is_a_miss_not_a_credential(self) -> None:
        overrides = {**OVERRIDES, "azure-research": {}}

        assert override_for(_azure("azure-research"), overrides) == {}

    def test_no_overrides_at_all_is_empty_under_either_rule(self) -> None:
        assert override_for(_azure("azure-research"), None) == {}
        assert override_for(_azure(None), {}) == {}


class TestTheChainWalksPastACredentialLessSibling:
    """The primary names a connection the gateway sent no credential for.

    It must be WALKED PAST — the chain exists for exactly this — and the DEFAULT
    account's key must never be built, let alone spent.
    """

    @pytest.mark.asyncio
    async def test_the_fallback_serves_and_the_default_key_is_never_built(
        self, monkeypatch
    ) -> None:
        built = _keyed_builder(monkeypatch)
        resolved = spec(
            _azure("azure-research"),
            chain=[_azure("azure-clinic", kind="fallback-model", slug="azure-clinic-model")],
        )

        chunks = [
            chunk
            async for chunk in _router().synthesize(
                spec=resolved, text="Hi.", provider_overrides=OVERRIDES
            )
        ]

        # ONE engine, built on the sibling's OWN key. `default-key` present here
        # would mean the credential-less candidate was served on the tenant's
        # default vendor account.
        assert sorted(built) == ["key-clinic"]
        assert [c.provider for c in chunks] == ["azure"]
