"""TASK-991 OD-3 / OD-4 — the embeddings model and endpoint are PLATFORM-FIXED.

Owner decision, 2026-09-19:

> **OD-3** — the TEXT embedding model used for text feature extraction is FIXED
> for every tenant. No tenant may change it. It stays CONFIG (platform admin,
> SYSTEM tier), not a literal.
> **OD-4** — the embeddings ENDPOINT is fixed together with the model. A tenant
> may NOT point embeddings at its own account.

This is a DELIBERATE, owner-approved narrowing of the repo's tenant-first rule,
of exactly the kind `00-project-context.md` admits as a documented exception —
not a rule violation, and not something to "fix" back into a cascade. The reason
is that both failure modes it prevents are SILENT:

1. the model and the stored vectors are one coupled artifact, so embedding a
   corpus with one model and querying it with another returns nonsense rather
   than an error;
2. a platform-chosen model id sent to a tenant's own account that has never heard
   of it fails per-tenant at RETRIEVAL time, long after ingest wrote the vectors.

What is pinned here:

* `resolve_embeddings_credential` asks for the PLATFORM provider and NOTHING
  else — including for a tenant that already holds an `embeddings:openai` row
  (rows written before this decision are now inert, and the gateway refuses new
  ones);
* the platform row's outcome passes through UNCHANGED, so every fail-closed
  property of the four-outcome contract survives the collapse to one lane;
* `require_embeddings_model` is STILL fail-closed — an unresolved model RAISES,
  and nothing anywhere substitutes a default.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from pydantic import SecretStr

import harness.api.endpoints.knowledge as knowledge
from harness.core.config import Settings
from harness.core.provider_credentials import (
    EMBEDDINGS_PLATFORM_PROVIDER,
    CredentialOutcome,
    CredentialUnavailable,
    DenialCause,
    ProviderCredential,
    apply_embeddings_credential,
    require_embeddings_model,
    resolve_embeddings_credential,
)
from harness.temporal import activities

TENANT = "11111111-1111-1111-1111-111111111111"

#: Every `AiProviderConnection.provider` a TENANT could hold under `embeddings`
#: (`CLOUD_BYO_PROVIDERS.embeddings` on the gateway). Not one of them may be
#: asked for: that is the whole of OD-3/OD-4 on this side.
TENANT_BYO_PROVIDERS = ("openai", "azure")


def _platform_row() -> ProviderCredential:
    """What the SYSTEM `embeddings:tei-embed` row resolves to."""
    return ProviderCredential(
        outcome=CredentialOutcome.RESOLVED,
        funding="platform",
        api_key=SecretStr("not-needed"),
        base_url="http://localhost:8871/v1",
        model="BAAI/bge-m3",
    )


def _tenant_row() -> ProviderCredential:
    """What a PRE-EXISTING tenant `embeddings:openai` row would resolve to.

    Kept as a fixture precisely so the tests can prove it is never reached: a
    deployment that already carries such a row must embed on the platform's
    model regardless of what the row says.
    """
    return ProviderCredential(
        outcome=CredentialOutcome.RESOLVED,
        funding="tenant",
        api_key=SecretStr("sk-tenant"),
        base_url="https://api.tenant.example/v1",
        model="text-embedding-3-large",
    )


def _tenant_veto() -> ProviderCredential:
    """A tenant that DISABLED its own `embeddings:openai` row.

    Under the two-lane chain this vetoed the capability outright. It is now a
    statement about a row nobody reads — see the test below, which is the
    behaviour change an existing database will show.
    """
    return ProviderCredential(
        outcome=CredentialOutcome.DENIED,
        denial=DenialCause.TENANT_VETO,
        reason="tenant veto: 'openai' is disabled for service 'embeddings'",
    )


class _Recorder:
    """A `resolve` double that records every `(service, provider)` asked for."""

    def __init__(self, answers: dict[str, ProviderCredential]):
        self.answers = answers
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, service: str, provider: str) -> ProviderCredential:
        self.calls.append((service, provider))
        return self.answers[provider]

    @property
    def providers(self) -> list[str]:
        return [provider for _service, provider in self.calls]


# ───────────────────────── the lane itself ─────────────────────────


class TestOnlyThePlatformLaneIsConsulted:
    @pytest.mark.asyncio
    async def test_the_platform_row_is_the_only_provider_asked_for(self):
        resolve = _Recorder({EMBEDDINGS_PLATFORM_PROVIDER: _platform_row()})

        out = await resolve_embeddings_credential(resolve)

        assert resolve.calls == [("embeddings", EMBEDDINGS_PLATFORM_PROVIDER)]
        assert out.model == "BAAI/bge-m3"
        assert out.base_url == "http://localhost:8871/v1"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("byo_provider", TENANT_BYO_PROVIDERS)
    async def test_a_tenant_byo_row_is_never_consulted(self, byo_provider):
        """OD-4. A tenant row is not merely out-ranked — it is not READ, so a
        tenant cannot point embeddings at its own account by writing one."""
        resolve = _Recorder(
            {
                EMBEDDINGS_PLATFORM_PROVIDER: _platform_row(),
                byo_provider: _tenant_row(),
            }
        )

        out = await resolve_embeddings_credential(resolve)

        assert byo_provider not in resolve.providers
        assert out.funding == "platform"
        assert out.model == "BAAI/bge-m3"

    @pytest.mark.asyncio
    async def test_a_pre_existing_tenant_veto_no_longer_blocks_retrieval(self):
        """THE BEHAVIOUR CHANGE an existing database will show.

        A disabled `embeddings:openai` row used to veto the capability in both
        tiers. It is now a statement about a pair nothing resolves: the tenant
        has no say over embeddings at all, so the platform's own server serves.
        """
        resolve = _Recorder(
            {
                EMBEDDINGS_PLATFORM_PROVIDER: _platform_row(),
                "openai": _tenant_veto(),
            }
        )

        out = await resolve_embeddings_credential(resolve)

        assert resolve.providers == [EMBEDDINGS_PLATFORM_PROVIDER]
        assert out.outcome is CredentialOutcome.RESOLVED

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "platform",
        [
            ProviderCredential(outcome=CredentialOutcome.ABSENT),
            ProviderCredential(outcome=CredentialOutcome.DENIED, reason="pinned"),
            ProviderCredential(outcome=CredentialOutcome.UNAVAILABLE, reason="gateway down"),
        ],
    )
    async def test_the_platform_outcome_passes_through_unchanged(self, platform):
        """Collapsing to one lane must not have softened the contract: whatever
        the gateway answers is what the caller sees, and there is deliberately no
        branch that downgrades a fault or a denial into 'use something else'."""
        resolve = _Recorder({EMBEDDINGS_PLATFORM_PROVIDER: platform})

        out = await resolve_embeddings_credential(resolve)

        assert out is platform
        assert resolve.providers == [EMBEDDINGS_PLATFORM_PROVIDER]

    def test_ingest_and_retrieval_share_this_one_rule(self):
        """Both construction sites bind the SAME function object, so a corpus and
        the queries against it can never resolve different models — and a future
        tenant lane could not be added to one site without the other."""
        assert knowledge.resolve_embeddings_credential is resolve_embeddings_credential
        assert activities.resolve_embeddings_credential is resolve_embeddings_credential


# ───────────────────────── fail-closed is UNCHANGED ─────────────────────────


class TestTheModelIsStillFailClosed:
    """OD-3 moved the model's OWNER, not its failure mode. Selection is
    `failMode: closed`: unresolved RAISES, and nothing substitutes a default."""

    def test_the_config_carries_no_model_default(self):
        assert Settings().retrieval.embeddings_model is None

    def test_require_raises_when_the_platform_row_supplied_none(self):
        with pytest.raises(CredentialUnavailable) as exc:
            require_embeddings_model(Settings().retrieval)
        message = str(exc.value)
        assert "extraJson.model" in message
        assert EMBEDDINGS_PLATFORM_PROVIDER in message

    def test_require_returns_the_platform_model(self):
        folded = apply_embeddings_credential(Settings().retrieval, _platform_row())
        assert require_embeddings_model(folded) == "BAAI/bge-m3"

    @pytest.mark.asyncio
    async def test_an_absent_platform_row_degrades_rather_than_inventing_a_model(
        self, monkeypatch
    ):
        async def _absent(*_a, **_k):
            return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        monkeypatch.setattr(activities, "_resolve_provider_credential", _absent)
        monkeypatch.setattr(activities, "_consent_client", lambda _s: _AllowConsentClient())

        with patch("qdrant_client.QdrantClient"):
            out = await activities.retrieve_context(_retrieve_input())

        assert out.degraded is True
        assert out.chunks == []


# ───────────────────────── end to end through the activity ─────────────────────────


class _FakeRetriever:
    async def retrieve(self, *, query: str, tenant_id: str):  # noqa: ARG002
        from harness.guides.retrieval.retriever import RetrievalResult

        return RetrievalResult(chunks=[], degraded=False)


class _AllowConsentClient:
    """`retrieve_context` gates on consent BEFORE any credential is resolved, so
    stubbing it is what makes 'did not degrade' mean 'the lane worked'."""

    async def check(self, **_kwargs):  # noqa: ANN201
        from harness.core.consent_client import ConsentDecision

        return ConsentDecision(allowed=True)


def _retrieve_input():
    from harness.temporal.models import RetrieveContextInput

    return RetrieveContextInput(
        tenant_id=TENANT,
        entities=[],
        retrieval_enabled=True,
        external_patient_id="PAT-1",
        consultation_id="c-1",
    )


class TestTheActivityEmbedsWithThePlatformModel:
    @staticmethod
    def _answers(monkeypatch, platform: ProviderCredential, asked: list[str]):
        async def _by_provider(_settings, service, provider, _tenant_id):
            if service != "embeddings":
                return ProviderCredential(outcome=CredentialOutcome.ABSENT)
            asked.append(provider)
            return platform

        monkeypatch.setattr(activities, "_resolve_provider_credential", _by_provider)
        monkeypatch.setattr(activities, "_consent_client", lambda _s: _AllowConsentClient())

    @pytest.mark.asyncio
    async def test_the_client_is_built_on_the_platform_endpoint_and_model(self, monkeypatch):
        asked: list[str] = []
        self._answers(monkeypatch, _platform_row(), asked)

        built: dict[str, Any] = {}
        real_factory = activities._hybrid_retriever

        def _spy(settings, *credentials):
            retriever = real_factory(settings, *credentials)
            built["model"] = retriever._embeddings.model
            built["base_url"] = retriever._embeddings._base_url
            return _FakeRetriever()

        with patch("qdrant_client.QdrantClient"):
            monkeypatch.setattr(activities, "_hybrid_retriever", _spy)
            out = await activities.retrieve_context(_retrieve_input())

        assert out.degraded is False
        assert asked == [EMBEDDINGS_PLATFORM_PROVIDER]
        assert built == {"model": "BAAI/bge-m3", "base_url": "http://localhost:8871/v1"}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    async def test_an_unusable_platform_row_degrades_and_builds_nothing(
        self, monkeypatch, outcome
    ):
        """One lane means no fallback — which must degrade VISIBLY rather than
        embed on something else."""
        asked: list[str] = []
        self._answers(monkeypatch, ProviderCredential(outcome=outcome, reason="pinned"), asked)

        def _must_not_build(*_a, **_k):
            raise AssertionError("the retriever must never be built without a usable credential")

        monkeypatch.setattr(activities, "_hybrid_retriever", _must_not_build)

        out = await activities.retrieve_context(_retrieve_input())

        assert out.degraded is True
        assert out.chunks == []
