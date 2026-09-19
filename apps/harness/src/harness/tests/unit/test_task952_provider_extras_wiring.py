"""TASK-952 D-1b / D-1c — the two inert connection planes behind the extras 400.

Two `AiProviderConnection` surfaces the console has offered all along and nothing
read. Both are now wired through the SAME per-activity gateway pull the Qdrant
credential already used (`GET /internal/harness/provider-credential`), and both
folds are shared by the retriever and the ingest endpoint so the two sites cannot
derive different values:

| D | Was | Is |
|---|---|---|
| D-1b | `vector:qdrant` -> `extraJson.collection` written, never read | the tenant's collection PREFIX reaches the Qdrant store |
| D-1c | the whole `embeddings` connection written, never read (`resolveTenantCloudOverrides` is called for `llm`/`stt`/`tts` only) | endpoint + key + model reach the embeddings client |

TASK-991 OD-3 / OD-4 later narrowed WHOSE embeddings row may be read: the
endpoint and the model are PLATFORM-FIXED, so the two-lane chain this file once
pinned is one lane (the SYSTEM `embeddings:tei-embed` row). That contract, and
the behaviour of a pre-existing tenant row under it, live in
`test_task991_embeddings_platform_lock.py`. What remains here is everything D-1b
/ D-1c wired that the narrowing did not touch: the `extras` wire shape, the
fold, the client, and fail-closed on both planes.

The properties under test are the ones that make it safe rather than merely wired:

* the platform floor is untouched when no tier has an opinion (`ABSENT`), and
  untouched again when a row carries no extras — an additive change must leave
  prior behaviour byte-identical;
* a resolve FAULT (`UNAVAILABLE`) or a tenant VETO (`DENIED`) fails CLOSED. It is
  never downgraded into "embed on the platform's endpoint instead", which would
  silently send one tenant's PHI somewhere it did not choose;
* ingest and retrieval derive the SAME collection and the SAME model, because a
  corpus embedded by one model into one collection and queried by another is a
  silent miss, not an error anyone sees.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from pydantic import SecretStr

import harness.api.endpoints.knowledge as knowledge
from harness.core.config import RetrievalConfig, Settings
from harness.core.provider_credentials import (
    EMBEDDINGS_PLATFORM_PROVIDER,
    VECTOR_COLLECTION_EXTRA,
    VECTOR_CONNECTION_PROVIDER,
    CredentialOutcome,
    CredentialUnavailable,
    DenialCause,
    ProviderCredential,
    apply_embeddings_credential,
    apply_vector_credential,
    prefixed_collection,
    require_embeddings_model,
)
from harness.services.api_client import ApiClient
from harness.services.embeddings_client import EmbeddingsClient
from harness.temporal import activities

TENANT = "11111111-1111-1111-1111-111111111111"


def _resolved(**kwargs: Any) -> ProviderCredential:
    return ProviderCredential(outcome=CredentialOutcome.RESOLVED, funding="tenant", **kwargs)


def _settings_with_embeddings_model(model: str = "test-embeddings") -> Settings:
    """Settings whose retrieval carries an embeddings model (TASK-952 D-1c).

    `embeddings_model` has no code default and no env path any more — a model id
    is a SELECTION, so it resolves from `AiProviderConnection.extraJson.model` and
    `_hybrid_retriever` fails closed without one. A test that is about SOMETHING
    ELSE (the collection prefix, the endpoint floor) injects one the same way the
    runtime fold does.
    """
    settings = Settings()
    settings.retrieval.embeddings_model = model
    return settings


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://gateway:8868", service_token="svc", transport=httpx.MockTransport(handler)
    )


# ───────────────────────── the wire: `extras` off the credential ─────────────────────────


class TestExtrasCrossTheWire:
    """`extraJson` minus the reserved keys is how the NON-SECRET half of a
    connection travels. Parsed defensively: a gateway that sends no block, or a
    malformed one, means "no extras" — never an error and never a guess."""

    @pytest.mark.asyncio
    async def test_extras_are_parsed_off_a_resolved_payload(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "outcome": "resolved",
                    "apiKey": "qdrant-tenant-key",
                    "baseUrl": "https://tenant.qdrant.cloud",
                    "extras": {"collection": "hope"},
                    "funding": "tenant",
                },
            )

        cred = await _client(handler).resolve_provider_credential(
            "vector", VECTOR_CONNECTION_PROVIDER, tenant_id=TENANT
        )

        assert cred.outcome is CredentialOutcome.RESOLVED
        assert cred.extras == {"collection": "hope"}
        assert cred.extra(VECTOR_COLLECTION_EXTRA) == "hope"

    @pytest.mark.asyncio
    async def test_a_payload_with_no_extras_block_yields_no_extras(self):
        """The pre-TASK-952 wire shape. Absent must stay byte-identical."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"outcome": "resolved", "apiKey": "k"})

        cred = await _client(handler).resolve_provider_credential(
            "vector", VECTOR_CONNECTION_PROVIDER, tenant_id=TENANT
        )

        assert cred.extras == {}
        assert cred.extra(VECTOR_COLLECTION_EXTRA) is None

    @pytest.mark.asyncio
    async def test_a_malformed_extras_block_is_no_extras_not_an_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"outcome": "resolved", "extras": "not-an-object"})

        cred = await _client(handler).resolve_provider_credential(
            "vector", VECTOR_CONNECTION_PROVIDER, tenant_id=TENANT
        )

        assert cred.outcome is CredentialOutcome.RESOLVED
        assert cred.extras == {}

    @pytest.mark.parametrize("value", ["", None, 7, True, ["a"], {"k": "v"}])
    def test_extra_returns_only_non_empty_strings(self, value):
        """`""` is a value to some backends, and a number/array/object is not a
        name — so neither may masquerade as a configured one. (`extraJson`
        legitimately admits all of those shapes; this accessor is for the ones
        that name something.)"""
        assert _resolved(extras={"collection": value}).extra(VECTOR_COLLECTION_EXTRA) is None

    def test_extras_do_not_make_the_credential_json_serialisable(self):
        """The Temporal-history guard must survive the new field: a dataclass
        carrying a SecretStr still cannot be dumped onto an activity input."""
        cred = _resolved(api_key=SecretStr("sk-secret"), extras={"collection": "hope"})
        with pytest.raises(TypeError):
            json.dumps(cred.__dict__)
        assert "sk-secret" not in repr(cred)


# ──────────────────────────── D-1b — the collection prefix ────────────────────────────


class TestCollectionPrefixDerivation:
    @pytest.mark.parametrize(
        ("prefix", "expected"),
        [
            ("hope", "hope_knowledge_chunks"),
            ("  hope  ", "hope_knowledge_chunks"),
            ("hope_", "hope_knowledge_chunks"),
            ("_hope_", "hope_knowledge_chunks"),
            ("", "knowledge_chunks"),
            ("   ", "knowledge_chunks"),
            ("_", "knowledge_chunks"),
            (None, "knowledge_chunks"),
        ],
    )
    def test_a_prefix_prefixes_and_a_blank_one_does_nothing(self, prefix, expected):
        """`""` must never derive `"_knowledge_chunks"` — an accidental second
        collection nobody can find is worse than no prefix at all."""
        assert prefixed_collection("knowledge_chunks", prefix) == expected


class TestCollectionPrefixReachesTheStore:
    """The half that was easy to leave unproven, and was: the console wrote the
    field for as long as the card has existed and NOTHING read it."""

    def _store_collection(self, credential: ProviderCredential | None) -> str:
        with patch("qdrant_client.QdrantClient"):
            return knowledge._qdrant_store(Settings(), credential)._collection

    def test_a_tenant_prefix_reaches_the_ingest_store(self):
        cred = _resolved(
            api_key=SecretStr("qdrant-tenant-key"), extras={VECTOR_COLLECTION_EXTRA: "hope"}
        )
        assert self._store_collection(cred) == "hope_knowledge_chunks"

    def test_the_retriever_derives_the_SAME_collection_as_ingest(self):
        """One derivation, two call sites. A tenant that writes into
        `hope_knowledge_chunks` and queries `knowledge_chunks` retrieves nothing,
        silently — so this asserts the two agree rather than each in isolation."""
        cred = _resolved(
            api_key=SecretStr("qdrant-tenant-key"), extras={VECTOR_COLLECTION_EXTRA: "hope"}
        )
        with patch("qdrant_client.QdrantClient"):
            retriever_collection = activities._hybrid_retriever(
                _settings_with_embeddings_model(), cred
            )._store._collection
        assert retriever_collection == self._store_collection(cred) == "hope_knowledge_chunks"

    def test_no_prefix_extra_leaves_the_platform_collection_untouched(self):
        """Today's behaviour, unchanged, for every row that carries no extras."""
        cred = _resolved(api_key=SecretStr("qdrant-tenant-key"))
        assert self._store_collection(cred) == "knowledge_chunks"

    def test_an_absent_credential_leaves_the_platform_collection_untouched(self):
        assert (
            self._store_collection(ProviderCredential(outcome=CredentialOutcome.ABSENT))
            == "knowledge_chunks"
        )
        assert self._store_collection(None) == "knowledge_chunks"

    @pytest.mark.parametrize(
        "credential",
        [
            None,
            ProviderCredential(outcome=CredentialOutcome.ABSENT),
            ProviderCredential(outcome=CredentialOutcome.DENIED, reason="tenant veto"),
            ProviderCredential(outcome=CredentialOutcome.UNAVAILABLE, reason="gateway down"),
        ],
    )
    def test_only_a_RESOLVED_credential_folds_at_all(self, credential):
        """A fold on any other outcome would be the silent downgrade the
        four-outcome contract exists to prevent — the two fail-closed outcomes
        are the caller's to reject, and they must not reach a fold even by
        accident."""
        floor = Settings().retrieval
        assert apply_vector_credential(floor, credential) is floor

    def test_the_prefix_does_not_disturb_the_key_or_the_url(self):
        cred = _resolved(
            api_key=SecretStr("qdrant-tenant-key"),
            base_url="https://tenant.qdrant.cloud",
            extras={VECTOR_COLLECTION_EXTRA: "hope"},
        )
        with patch("qdrant_client.QdrantClient") as mock_client:
            knowledge._qdrant_store(Settings(), cred)
        assert mock_client.call_args.kwargs.get("api_key") == "qdrant-tenant-key"
        assert mock_client.call_args.kwargs.get("url") == "https://tenant.qdrant.cloud"


# ─────────────────────── D-1c — the embeddings plane, end to end ───────────────────────


class TestEmbeddingsEnvPathStaysClosed:
    """A credential enters by INJECTION or not at all — the same structural
    closure `qdrant_api_key` already has, not a convention."""

    def test_the_key_cannot_come_from_env(self, monkeypatch):
        monkeypatch.setenv("HARNESS_RETRIEVAL_EMBEDDINGS_API_KEY", "env-leaked-key")
        cfg = RetrievalConfig()
        assert (
            cfg.embeddings_api_key is None
            or cfg.embeddings_api_key.get_secret_value() != "env-leaked-key"
        )

    def test_an_empty_value_is_absent_not_the_empty_credential(self, monkeypatch):
        """`.env` spells an unset optional as `KEY=`; `""` is itself a bearer
        value, so it must resolve to ABSENT rather than an empty credential."""
        monkeypatch.setenv("HARNESS_RETRIEVAL_EMBEDDINGS_API_KEY__ENV_REMOVED", "")
        assert RetrievalConfig().embeddings_api_key is None

    def test_injection_by_model_copy_still_works(self):
        cfg = RetrievalConfig().model_copy(update={"embeddings_api_key": SecretStr("injected")})
        assert cfg.embeddings_api_key is not None
        assert cfg.embeddings_api_key.get_secret_value() == "injected"


class TestEmbeddingsConnectionFold:
    """The fold itself. Since TASK-991 OD-3/OD-4 the credential reaching it is
    always the SYSTEM `embeddings:tei-embed` row (`resolve_embeddings_credential`
    consults no other tier), so these are statements about the PLATFORM row."""

    def test_a_resolved_row_supplies_endpoint_model_and_key(self):
        folded = apply_embeddings_credential(
            Settings().retrieval,
            _resolved(
                api_key=SecretStr("sk-platform-embeddings"),
                base_url="https://embeddings.platform.example/v1",
                model="text-embedding-3-large",
            ),
        )
        assert folded.embeddings_base_url == "https://embeddings.platform.example/v1"
        assert folded.embeddings_model == "text-embedding-3-large"
        assert folded.embeddings_api_key is not None
        assert folded.embeddings_api_key.get_secret_value() == "sk-platform-embeddings"

    def test_a_partial_row_keeps_the_config_floor_for_what_it_omits(self):
        """A row that supplies only a key still embeds on the endpoint below it —
        the row expresses an opinion per FIELD, not all-or-nothing."""
        floor = Settings().retrieval
        folded = apply_embeddings_credential(floor, _resolved(api_key=SecretStr("sk-only")))
        assert folded.embeddings_base_url == floor.embeddings_base_url
        assert folded.embeddings_model == floor.embeddings_model
        assert folded.embeddings_api_key is not None

    @pytest.mark.parametrize(
        "credential",
        [None, ProviderCredential(outcome=CredentialOutcome.ABSENT)],
    )
    def test_absence_widens_to_the_documented_platform_floor(self, credential):
        """ABSENT is a RESOLVED STATE, not a failure: no tier has an opinion, so
        the platform's own self-hosted endpoint serves, unauthenticated. That is
        exactly what local dev and an un-configured tenant run on."""
        floor = Settings().retrieval
        folded = apply_embeddings_credential(floor, credential)
        assert folded.embeddings_base_url == floor.embeddings_base_url
        assert folded.embeddings_model == floor.embeddings_model
        assert folded.embeddings_api_key is None


class TestTheEmbeddingsCredentialActuallyReachesTheClient:
    def test_a_resolved_row_reaches_the_retriever_embeddings_client(self):
        cred = _resolved(
            api_key=SecretStr("sk-tenant-embeddings"),
            base_url="https://api.tenant.example/v1",
            model="text-embedding-3-large",
        )
        with patch("qdrant_client.QdrantClient"):
            embeddings = activities._hybrid_retriever(Settings(), None, cred)._embeddings

        assert embeddings.model == "text-embedding-3-large"
        assert embeddings._base_url == "https://api.tenant.example/v1"
        assert embeddings._api_key == "sk-tenant-embeddings"

    def test_a_resolved_row_reaches_the_ingest_embeddings_client(self):
        cred = _resolved(api_key=SecretStr("sk-tenant-embeddings"), model="text-embedding-3-large")
        embeddings = knowledge._embeddings_client(Settings(), cred)
        assert embeddings.model == "text-embedding-3-large"
        assert embeddings._api_key == "sk-tenant-embeddings"

    def test_an_absent_credential_leaves_the_client_unauthenticated_on_the_floor(self):
        # The ENDPOINT floor survives an absent credential (it is an env-tier
        # transport address); the MODEL has no floor left to fall to (TASK-952
        # D-1c), so it is injected here exactly as a resolved row injects it.
        settings = _settings_with_embeddings_model()
        floor = settings.retrieval
        with patch("qdrant_client.QdrantClient"):
            embeddings = activities._hybrid_retriever(
                settings, None, ProviderCredential(outcome=CredentialOutcome.ABSENT)
            )._embeddings

        assert embeddings.model == floor.embeddings_model
        assert embeddings._base_url == floor.embeddings_base_url.rstrip("/")
        assert embeddings._api_key is None

    @pytest.mark.asyncio
    async def test_a_key_becomes_a_bearer_header_and_absence_sends_none(self):
        seen: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("Authorization"))
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]})

        transport = httpx.MockTransport(handler)
        await EmbeddingsClient(
            "http://platform:1234/v1", model="m", api_key="sk-tenant", transport=transport
        ).embed(["hello"])
        await EmbeddingsClient("http://platform:1234/v1", model="m", transport=transport).embed(
            ["hello"]
        )

        assert seen == ["Bearer sk-tenant", None]


# ────────────────────────────── fail-closed, both planes ──────────────────────────────


class TestAnUnresolvedSelectionFailsClosed:
    """DENIED (tenant veto) and UNAVAILABLE (gateway fault) must degrade the
    consumer. Substituting the platform's endpoint would send a tenant's PHI to a
    backend it did not choose, and would turn a Vault outage into a silent
    downgrade — which is the whole reason the four outcomes are not two."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    async def test_retrieval_degrades_when_only_the_EMBEDDINGS_row_is_unusable(
        self, monkeypatch, outcome
    ):
        from harness.temporal.models import RetrieveContextInput

        async def _by_service(_settings, service, _provider, _tenant_id):
            if service == "embeddings":
                return ProviderCredential(outcome=outcome, reason="pinned")
            return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        monkeypatch.setattr(activities, "_resolve_provider_credential", _by_service)

        def _must_not_build(*_a, **_k):
            raise AssertionError("the retriever must never be built without a usable credential")

        monkeypatch.setattr(activities, "_hybrid_retriever", _must_not_build)

        out = await activities.retrieve_context(
            RetrieveContextInput(tenant_id=TENANT, entities=[], retrieval_enabled=True)
        )

        assert out.degraded is True
        assert out.chunks == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    async def test_ingest_503s_without_embedding_anything(self, monkeypatch, outcome):
        """Lane B fails and retries the job. It never embeds on the platform's
        endpoint on the assumption the tenant would have agreed."""
        from httpx import ASGITransport, AsyncClient
        from pydantic import SecretStr as _SecretStr

        from harness.main import create_app

        async def _unusable(*_a, **_k):
            return ProviderCredential(outcome=outcome, reason="pinned")

        monkeypatch.setattr(knowledge, "_resolve_embeddings_credential", _unusable)

        def _must_not_embed(*_a, **_k):
            raise AssertionError("nothing may be embedded without a usable credential")

        monkeypatch.setattr(knowledge, "_embeddings_client", _must_not_embed)

        settings = Settings(
            internal_service_token=_SecretStr("ingest-secret"),
            service_token=_SecretStr(""),
            log_level="debug",
        )
        app = create_app(settings_override=settings)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            resp = await http.post(
                "/api/v1/internal/knowledge/ingest",
                headers={"X-Service-Token": "ingest-secret"},
                json={
                    "tenantId": TENANT,
                    "knowledgeDocumentId": "kd-1",
                    "text": "Hypertension management. " * 40 + "Diabetes follow-up. " * 40,
                },
            )

        assert resp.status_code == 503
        assert resp.json()["detail"]["error"] == "embeddings_credential_unavailable"


class TestTheEmbeddingsProviderIsTheWireProtocol:
    def test_the_connection_providers_are_the_expected_slots(self):
        """`EmbeddingsClient` speaks ONE wire shape — the OpenAI `{model, input}`
        POST — and since TASK-991 OD-3/OD-4 exactly ONE row may serve it: the
        platform's own self-hosted server, reached on that row by its `baseUrl`
        exactly as `llm:lm-studio` is."""
        assert EMBEDDINGS_PLATFORM_PROVIDER == "tei-embed"
        assert VECTOR_CONNECTION_PROVIDER == "qdrant"


# ─────────────── D-1c: the PLATFORM lane of the embeddings connection ───────────────


class _FakeRetriever:
    """Stand-in :class:`HybridRetriever` that records nothing and degrades never."""

    async def retrieve(self, *, query: str, tenant_id: str):  # noqa: ARG002
        from harness.guides.retrieval.retriever import RetrievalResult

        return RetrievalResult(chunks=[], degraded=False)


class _AllowConsentClient:
    """Stub `ConsentClient`, always allowed.

    `retrieve_context` gates on consent BEFORE it resolves any credential, and an
    input without `external_patient_id` is reported `unavailable` — which degrades
    for a reason that has nothing to do with this ticket. Stubbing it (and passing
    an id) is what makes "did not degrade" mean "the credential chain worked".
    """

    async def check(self, **_kwargs):  # noqa: ANN201
        from harness.core.consent_client import ConsentDecision

        return ConsentDecision(allowed=True)


#: A consent-complete retrieval input, so the assertions below are about
#: credentials rather than about the consent gate in front of them.
def _retrieve_input():
    from harness.temporal.models import RetrieveContextInput

    return RetrieveContextInput(
        tenant_id=TENANT,
        entities=[],
        retrieval_enabled=True,
        external_patient_id="PAT-1",
        consultation_id="c-1",
    )


def _platform_row() -> ProviderCredential:
    """What the SYSTEM `embeddings:tei-embed` row resolves to."""
    return _resolved(
        api_key=SecretStr("not-needed"),
        base_url="http://localhost:8871/v1",
        model="BAAI/bge-m3",
    )


class TestTheDenialCauseWireContract:
    """`denial` is the gateway's MACHINE-READABLE cause beside the prose
    `reason`, and parsing it fail-closed is still this file's business.

    The five lane tests that used to live here pinned the TWO-LANE embeddings
    chain (tenant `embeddings:openai`, then the platform's own server). TASK-991
    OD-3 / OD-4 collapsed that to one platform lane by owner decision, so the
    lane contract — including what a pre-existing tenant row now does — is pinned
    in `test_task991_embeddings_platform_lock.py` instead. What survives is the
    parsing, which every service's resolve shares.
    """

    def test_an_unrecognised_denial_cause_parses_to_none_rather_than_a_guess(self):
        parsed = ProviderCredential.from_payload(
            {"outcome": "denied", "reason": "x", "denial": "something-new"}
        )
        assert parsed.outcome is CredentialOutcome.DENIED
        assert parsed.denial is None

    def test_the_two_causes_are_parsed_off_the_wire(self):
        for wire, expected in (
            ("tenant-veto", DenialCause.TENANT_VETO),
            ("platform-entitlement", DenialCause.PLATFORM_ENTITLEMENT),
        ):
            parsed = ProviderCredential.from_payload({"outcome": "denied", "denial": wire})
            assert parsed.denial is expected


class TestRetrievalNoLongerDegradesForATenantWithNoRow:
    """The activity-level statement of the D-1c regression, and of its guard.

    The regression: retrieval returned EMPTY CONTEXT for every tenant, because
    the platform default was carried on the cloud `embeddings:openai` pair and
    the R6 entitlement gate denied it to everyone. TASK-991 OD-3/OD-4 made the
    property structural rather than merely fixed — the lane now resolves a
    self-host provider the gate never touches, and consults nothing else — so
    `_answers` ASSERTS that no other provider is ever asked for.
    """

    @staticmethod
    def _answers(monkeypatch, platform: ProviderCredential):
        async def _by_provider(_settings, service, provider, _tenant_id):
            if service != "embeddings":
                return ProviderCredential(outcome=CredentialOutcome.ABSENT)
            assert provider == EMBEDDINGS_PLATFORM_PROVIDER, (
                f"the embeddings lane asked for {provider!r}; "
                "TASK-991 OD-3/OD-4 permits the platform row and nothing else"
            )
            return platform

        monkeypatch.setattr(activities, "_resolve_provider_credential", _by_provider)
        monkeypatch.setattr(activities, "_consent_client", lambda _s: _AllowConsentClient())

    @pytest.mark.asyncio
    async def test_a_tenant_with_no_row_retrieves_on_the_platform_server(self, monkeypatch):
        self._answers(monkeypatch, _platform_row())
        seen: dict[str, Any] = {}

        def _capture(settings, vector_credential=None, embeddings_credential=None):
            seen["embeddings"] = embeddings_credential
            return _FakeRetriever()

        monkeypatch.setattr(activities, "_hybrid_retriever", _capture)

        out = await activities.retrieve_context(_retrieve_input())

        assert out.degraded is False
        assert seen["embeddings"].outcome is CredentialOutcome.RESOLVED
        assert seen["embeddings"].base_url == "http://localhost:8871/v1"
        assert seen["embeddings"].model == "BAAI/bge-m3"

    @pytest.mark.asyncio
    async def test_the_platform_credential_builds_a_real_client_on_its_own_endpoint(
        self, monkeypatch
    ):
        """No stubbed retriever: the platform row alone must satisfy
        `require_embeddings_model`, which is the whole point of seeding it."""
        self._answers(monkeypatch, _platform_row())

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
        assert built == {"model": "BAAI/bge-m3", "base_url": "http://localhost:8871/v1"}


class TestTheEmbeddingsModelFailsClosed:
    """D-1c retired `text-embedding-bge-m3`. A model id is a SELECTION, so
    an unresolved one RAISES; nothing is substituted."""

    def test_the_config_default_is_gone(self):
        assert Settings().retrieval.embeddings_model is None

    def test_require_raises_when_no_tier_supplied_one(self):
        with pytest.raises(CredentialUnavailable) as exc:
            require_embeddings_model(Settings().retrieval)
        assert "extraJson.model" in str(exc.value)

    def test_require_returns_the_resolved_model(self):
        folded = apply_embeddings_credential(Settings().retrieval, _platform_row())
        assert require_embeddings_model(folded) == "BAAI/bge-m3"

    @pytest.mark.asyncio
    async def test_retrieval_degrades_rather_than_embedding_with_an_invented_model(
        self, monkeypatch
    ):
        """An `ABSENT` credential on BOTH lanes leaves no model anywhere. That is
        a visible degrade, not an activity failure and not a guess."""

        async def _absent(*_a, **_k):
            return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        monkeypatch.setattr(activities, "_resolve_provider_credential", _absent)
        monkeypatch.setattr(activities, "_consent_client", lambda _s: _AllowConsentClient())

        with patch("qdrant_client.QdrantClient"):
            out = await activities.retrieve_context(_retrieve_input())

        assert out.degraded is True
        assert out.chunks == []
