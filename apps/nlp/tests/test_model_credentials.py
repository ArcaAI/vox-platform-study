"""nlp mirror of ``apps/stt/tests/unit/test_task799_model_credentials.py`` —
the model-registry credential client ( follow-on).

What these tests pin, in order of how much they matter:

1. **The funding tenant is the MODEL ROW'S OWNER, never the caller** — for nlp
   this is always `SYSTEM_TENANT_ID` (see `nlp/models/source_resolver.py`'s
   module docstring for why nlp cannot know the true owner).
2. **Fail CLOSED on a fault, OPEN on an absence.** `absent` means no tier has
   an opinion. `unavailable` means the gateway could not answer, and there is
   nothing to fall back to, so it must raise.
3. **The secret never leaks through repr, logs or a cache key.**
4. **`X-Tenant-Id` and `X-Internal-Service-Key` are both sent on every call**
   (00-project-context.md: mandatory on internal service-to-service calls
   carrying tenant-scoped work) — this is where nlp's client differs from
   stt's own, which sends the tenant only as a query parameter.
5. **The route is the GENERIC one**, `/internal/model-registry-credential`,
   not the STT-worker-reserved `/internal/stt/model-registry-credential`.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from nlp.core.model_credentials import (
    SYSTEM_TENANT_ID,
    CredentialOutcome,
    CredentialUnavailable,
    ModelRegistryCredential,
    ModelRegistryCredentialClient,
    owner_tenant_of,
)

TENANT = "11111111-1111-1111-1111-111111111111"


def make_client(handler, ttl_s: int = 60) -> ModelRegistryCredentialClient:
    return ModelRegistryCredentialClient(
        base_url="http://gateway.test",
        api_key="internal-key",
        ttl_s=ttl_s,
        transport=httpx.MockTransport(handler),
    )


def resolved(**extra) -> dict:
    return {"outcome": "resolved", "apiKey": "s3_secret", "funding": "platform", **extra}


# ---------------------------------------------------------------------------
# 1. Whose credential is spent
# ---------------------------------------------------------------------------


class TestOwnerTenant:
    def test_a_model_with_no_tenant_resolves_SYSTEM(self):
        assert owner_tenant_of(None) == SYSTEM_TENANT_ID
        assert owner_tenant_of("") == SYSTEM_TENANT_ID

    def test_a_tenant_owned_model_resolves_that_tenant(self):
        assert owner_tenant_of(TENANT) == TENANT

    async def test_the_request_carries_the_MODEL_owner_not_the_caller(self):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.params["tenantId"])
            return httpx.Response(200, json=resolved())

        client = make_client(handler)
        await client.resolve("s3", owner_tenant_of(None))
        assert seen == [SYSTEM_TENANT_ID]

    async def test_the_cache_is_keyed_by_tenant_AND_provider(self):
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            p = request.url.params
            calls.append((p["provider"], p["tenantId"]))
            return httpx.Response(200, json=resolved(apiKey=f"key-for-{p['tenantId']}"))

        client = make_client(handler)
        a = await client.resolve("s3", TENANT)
        b = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert a.secret != b.secret
        assert len(calls) == 2
        await client.resolve("s3", TENANT)
        assert len(calls) == 2


# ---------------------------------------------------------------------------
# 2. Fail closed on a fault, open on an absence
# ---------------------------------------------------------------------------


class TestFailurePosture:
    async def test_absent_is_usable_and_yields_no_token(self):
        client = make_client(lambda _r: httpx.Response(200, json={"outcome": "absent"}))
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.ABSENT
        assert cred.usable
        assert cred.secret is None

    async def test_a_transport_error_is_UNAVAILABLE_not_absent(self):
        def boom(_r: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("gateway unreachable")

        client = make_client(boom)
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE
        assert not cred.usable

    async def test_an_http_error_is_UNAVAILABLE(self):
        client = make_client(lambda _r: httpx.Response(500, text="boom"))
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE

    async def test_an_UNRECOGNISED_outcome_is_UNAVAILABLE_not_absent(self):
        client = make_client(lambda _r: httpx.Response(200, json={"outcome": "maybe"}))
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE

    async def test_denied_is_not_usable(self):
        client = make_client(
            lambda _r: httpx.Response(200, json={"outcome": "denied", "reason": "tenant veto"})
        )
        cred = await client.resolve("s3", TENANT)
        assert cred.outcome is CredentialOutcome.DENIED
        assert not cred.usable

    async def test_raise_if_unusable_raises_on_denied_and_unavailable(self):
        for outcome in (CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE):
            cred = ModelRegistryCredential(outcome=outcome, reason="because")
            with pytest.raises(CredentialUnavailable):
                cred.raise_if_unusable(provider="s3")

    async def test_raise_if_unusable_is_silent_on_resolved_and_absent(self):
        for outcome in (CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT):
            ModelRegistryCredential(outcome=outcome).raise_if_unusable(provider="s3")

    async def test_a_FAULT_is_never_cached(self):
        calls = {"n": 0}

        def flaky(_r: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectError("first call fails")
            return httpx.Response(200, json=resolved())

        client = make_client(flaky)
        assert (
            await client.resolve("s3", SYSTEM_TENANT_ID)
        ).outcome is CredentialOutcome.UNAVAILABLE
        assert (await client.resolve("s3", SYSTEM_TENANT_ID)).outcome is CredentialOutcome.RESOLVED


# ---------------------------------------------------------------------------
# 3. The secret does not leak
# ---------------------------------------------------------------------------


class TestSecretContainment:
    async def test_the_token_survives_neither_repr_nor_str(self):
        client = make_client(lambda _r: httpx.Response(200, json=resolved()))
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.secret == "s3_secret"
        assert "s3_secret" not in repr(cred)
        assert "s3_secret" not in str(cred)

    async def test_the_s3_pair_carries_the_nonsecret_id_beside_the_secret(self):
        client = make_client(
            lambda _r: httpx.Response(
                200,
                json={
                    "outcome": "resolved",
                    "apiKey": "the-secret-key",
                    "baseUrl": "minio:9000",
                    "extras": {"accessKeyId": "hope-models"},
                    "funding": "platform",
                },
            )
        )
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.secret == "the-secret-key"
        assert cred.base_url == "minio:9000"
        assert cred.access_key_id == "hope-models"

    async def test_an_empty_token_is_treated_as_absent_material(self):
        client = make_client(lambda _r: httpx.Response(200, json=resolved(apiKey="")))
        cred = await client.resolve("s3", SYSTEM_TENANT_ID)
        assert cred.secret is None


# ---------------------------------------------------------------------------
# 4. Single-flight
# ---------------------------------------------------------------------------


class TestSingleFlight:
    async def test_concurrent_resolves_of_the_same_key_collapse_onto_one_fetch(self):
        calls = {"n": 0}

        async def slow(_r: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            await asyncio.sleep(0.02)
            return httpx.Response(200, json=resolved())

        client = ModelRegistryCredentialClient(
            base_url="http://gateway.test",
            api_key="k",
            transport=httpx.MockTransport(slow),
        )
        await asyncio.gather(*(client.resolve("s3", SYSTEM_TENANT_ID) for _ in range(5)))
        assert calls["n"] == 1


# ---------------------------------------------------------------------------
# 5. Transport shape — the generic route, the auth header, X-Tenant-Id
# ---------------------------------------------------------------------------


class TestTransportShape:
    async def test_the_generic_route_is_used_not_the_stt_specific_one(self):
        seen_paths: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_paths.append(request.url.path)
            return httpx.Response(200, json=resolved())

        client = make_client(handler)
        await client.resolve("s3", SYSTEM_TENANT_ID)
        assert seen_paths == ["/internal/model-registry-credential"]

    async def test_x_internal_service_key_is_sent(self):
        seen_headers: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_headers.append(request.headers.get("x-internal-service-key"))
            return httpx.Response(200, json=resolved())

        client = make_client(handler)
        await client.resolve("s3", SYSTEM_TENANT_ID)
        assert seen_headers == ["internal-key"]

    async def test_x_tenant_id_is_always_sent_alongside_the_query_param(self):
        """00-project-context.md: mandatory on every internal call carrying
        tenant-scoped work. This resolution is never tenant-less, so the header
        is always a real value — never omitted, never dropped-in-transit-shaped."""
        seen: list[tuple[str | None, str | None]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((request.headers.get("x-tenant-id"), request.url.params.get("tenantId")))
            return httpx.Response(200, json=resolved())

        client = make_client(handler)
        await client.resolve("s3", TENANT)
        assert seen == [(TENANT, TENANT)]


# ---------------------------------------------------------------------------
# 6. resolve_s3_credentials — the seam `config_for_model` calls
# ---------------------------------------------------------------------------


class TestResolveS3Credentials:
    async def test_resolves_and_shapes_the_credential(self, monkeypatch):
        from nlp.core import model_credentials

        model_credentials.reset_model_credential_client()

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.params["provider"] == "s3"
            assert request.url.params["tenantId"] == SYSTEM_TENANT_ID
            return httpx.Response(
                200,
                json={
                    "outcome": "resolved",
                    "apiKey": "secret",
                    "baseUrl": "minio:9000",
                    "extras": {"accessKeyId": "hope-models"},
                },
            )

        monkeypatch.setattr(
            model_credentials,
            "get_model_credential_client",
            lambda: ModelRegistryCredentialClient(
                base_url="http://gateway.test",
                api_key="k",
                transport=httpx.MockTransport(handler),
            ),
        )

        cred = await model_credentials.resolve_s3_credentials(None)
        assert cred.secret == "secret"
        assert cred.base_url == "minio:9000"
        assert cred.access_key_id == "hope-models"

    async def test_raises_CredentialUnavailable_on_denied(self, monkeypatch):
        from nlp.core import model_credentials

        monkeypatch.setattr(
            model_credentials,
            "get_model_credential_client",
            lambda: ModelRegistryCredentialClient(
                base_url="http://gateway.test",
                api_key="k",
                transport=httpx.MockTransport(
                    lambda _r: httpx.Response(200, json={"outcome": "denied", "reason": "no"})
                ),
            ),
        )

        with pytest.raises(CredentialUnavailable):
            await model_credentials.resolve_s3_credentials(None)
