"""TASK-958 (test 32) — the Text lane names WHICH connection served.

A tenant may now hold several ``AiProviderConnection`` rows for one
``(service, provider)``. On this plane the fallback CHAIN is walked by the gateway,
one ``apps/text`` request per candidate, so ``provider_overrides`` stays keyed by
provider NAME — there is only ever one candidate per request and nothing to
disambiguate (§2.3 of the ticket). What the entry could not say is which of the
tenant's accounts it is, and that is what the ledger needs: ``byok`` answers "did the
tenant pay", ``connection_id`` answers "with which of its keys".

Both are read off the SAME entry, in one function, deliberately: a second derivation
is how two answers about one credential start disagreeing.
"""

from __future__ import annotations

from text.api.endpoints.generate import _credential_attribution
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.usage import build_usage_detail


def _request(provider: str, overrides: dict | None = None) -> GenerateRequest:
    return GenerateRequest(prompt="hi", provider=provider, provider_overrides=overrides)


class TestProviderOverrideCarriesItsConnection:
    def test_the_fields_default_to_None(self) -> None:
        override = ProviderOverride(api_key="k")
        assert override.connection_id is None
        assert override.connection_slug is None

    def test_they_are_not_secrets_and_survive_model_dump(self) -> None:
        """Attribution has to be re-derivable from a dumped entry, like ``funding``."""
        override = ProviderOverride(api_key="k", connection_id="c-1", connection_slug="openai-eu")
        dumped = override.model_dump()
        assert dumped["connection_id"] == "c-1"
        assert dumped["connection_slug"] == "openai-eu"

    def test_the_names_are_snake_case_on_the_wire_like_every_sibling_field(self) -> None:
        """The gateway sends snake_case here (`api_key`, `base_url`, `funding`, …).

        `ProviderOverride` does not forbid extras, so a camelCase misspelling would be
        silently DROPPED rather than rejected — which is precisely why the accepted
        spelling is pinned by a test instead of left to the reader.
        """
        assert ProviderOverride(**{"api_key": "k", "connection_id": "c-1"}).connection_id == "c-1"
        assert ProviderOverride(**{"api_key": "k", "connectionId": "c-1"}).connection_id is None


class TestCredentialAttribution:
    def test_a_tenant_entry_yields_byok_and_its_connection(self) -> None:
        req = _request(
            "azure",
            {"azure": {"api_key": "k", "funding": "tenant", "connection_id": "conn-2"}},
        )
        assert _credential_attribution(req) == (True, "conn-2")

    def test_a_platform_entry_is_not_byok_but_still_names_its_connection(self) -> None:
        req = _request(
            "azure",
            {"azure": {"api_key": "k", "funding": "platform", "connection_id": "conn-sys"}},
        )
        assert _credential_attribution(req) == (False, "conn-sys")

    def test_no_override_yields_no_connection(self) -> None:
        assert _credential_attribution(_request("azure")) == (False, None)

    def test_an_override_for_another_provider_is_not_read(self) -> None:
        req = _request("azure", {"bedrock": {"api_key": "k", "connection_id": "conn-b"}})
        assert _credential_attribution(req) == (False, None)

    def test_an_entry_without_a_connection_id_keeps_todays_funding_answer(self) -> None:
        """A gateway that predates the field is unchanged: BYOK, no connection."""
        req = _request("azure", {"azure": {"api_key": "k"}})
        assert _credential_attribution(req) == (True, None)


class TestUsageDetailCarriesTheConnection:
    def test_the_connection_rides_the_usage_detail(self) -> None:
        detail = build_usage_detail(
            task_id="t-1",
            request_id="r-1",
            provider="azure",
            model="gpt-5.4",
            prompt_tokens=10,
            completion_tokens=5,
            total_tokens=15,
            byok=True,
            connection_id="conn-2",
        )
        assert detail.connection_id == "conn-2"
        # `cost_basis` is still derived from `byok` alone — a connection id says WHICH
        # key, never WHOSE money.
        assert detail.cost_basis == "BYOK_NOTIONAL"

    def test_it_defaults_to_None_and_dumps(self) -> None:
        detail = build_usage_detail(
            task_id="t-1",
            request_id=None,
            provider="azure",
            model="gpt-5.4",
            prompt_tokens=1,
            completion_tokens=1,
            total_tokens=2,
        )
        assert detail.connection_id is None
        assert "connection_id" in detail.model_dump(mode="json")
