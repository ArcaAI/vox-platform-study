"""Funding attribution on the SMR lane.

RED before GREEN. Before this ticket, `_used_byok_credential` decided a call's
billing tier from the mere PRESENCE of an override entry for the resolved
provider. That is correct only while every override the gateway can inject is
the caller tenant's own credential. Once the platform-default (SYSTEM-tenant)
cascade exists, a platform-funded call carries an override too — and would be
stamped `byok=True`, which downstream becomes `deployment=BYOK` +
`costBasis=BYOK_NOTIONAL`, a zero contribution to platform COGS and a
never-invoiced call.

The fix is an EXPLICIT funding origin on the wire, per provider entry:
`provider_overrides[<provider>].funding ∈ {"tenant", "platform"}`. Absent ⇒
`"tenant"`, which is exactly correct for every gateway that predates R3 (such a
gateway can only ever inject the caller's own credential).

Per-ENTRY rather than one field on the request body because the cascade merges
tenant-over-platform PER PROVIDER: a single request can legitimately carry one
tenant-funded and one platform-funded entry, and a request-level field cannot
express that.
"""

from __future__ import annotations

from smr.api.endpoints.generate import _used_byok_credential
from smr.models.requests import GenerateRequest, ProviderOverride


def _request(provider: str, overrides: dict | None = None) -> GenerateRequest:
    return GenerateRequest(prompt="hi", provider=provider, provider_overrides=overrides)


class TestProviderOverrideFundingField:
    def test_funding_defaults_to_tenant(self):
        override = ProviderOverride(api_key="k")
        assert override.funding == "tenant"

    def test_funding_accepts_platform(self):
        override = ProviderOverride(api_key="k", funding="platform")
        assert override.funding == "platform"

    def test_funding_is_not_a_secret_and_survives_model_dump(self):
        """`funding` is non-secret metadata — unlike `api_key` it must remain
        readable after a dump, or the attribution cannot be re-derived."""
        override = ProviderOverride(api_key="k", funding="platform")
        assert override.model_dump()["funding"] == "platform"


class TestUsedByokCredential:
    def test_no_overrides_is_not_byok(self):
        assert _used_byok_credential(_request("azure")) is False

    def test_override_for_another_provider_is_not_byok(self):
        req = _request("azure", {"bedrock": {"api_key": "k"}})
        assert _used_byok_credential(req) is False

    def test_tenant_funded_override_is_byok(self):
        req = _request("azure", {"azure": {"api_key": "k", "funding": "tenant"}})
        assert _used_byok_credential(req) is True

    def test_absent_funding_preserves_todays_rule(self):
        req = _request("azure", {"azure": {"api_key": "k"}})
        assert _used_byok_credential(req) is True

    def test_platform_funded_override_is_NOT_byok(self):
        """The load-bearing case. A SYSTEM-tenant credential is platform-funded
        vendor spend: it meters as CLOUD/INTERNAL (OD-2), so `byok` is False
        even though an override entry is present."""
        req = _request("azure", {"azure": {"api_key": "k", "funding": "platform"}})
        assert _used_byok_credential(req) is False

    def test_mixed_map_is_attributed_by_the_resolved_provider(self):
        overrides = {
            "azure": {"api_key": "platform-key", "funding": "platform"},
            "bedrock": {"api_key": "tenant-key", "funding": "tenant"},
        }
        assert _used_byok_credential(_request("azure", overrides)) is False
        assert _used_byok_credential(_request("bedrock", overrides)) is True
