"""TASK-799 — the model-registry credential client.

`HUGGINGFACE_TOKEN` and the `STT_MODEL_S3_*` pair were the last two credentials
this service read from the environment. They now live on `AiProviderConnection`
under ``service = 'model-registry'`` and arrive over the gateway.

What these tests pin, in order of how much they matter:

1. **The funding tenant is the MODEL ROW'S OWNER, never the caller.** A
   SYSTEM-owned model fetches with the platform token even when a tenant asked
   for it. Without this, one tenant's transcription could spend another
   tenant's HuggingFace quota, and a shared in-process weight cache would hold
   bytes pulled with a credential the next caller is not entitled to.
2. **Fail CLOSED on a fault, OPEN on an absence.** `absent` means no tier has an
   opinion — a public repo, pulled anonymously. `unavailable` means the gateway
   could not answer, and after the env paths are closed there is nothing to fall
   back to, so it must raise rather than silently downgrade to an anonymous pull.
3. **The secret never leaks through repr, logs or a cache key.**
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from stt.core.model_credentials import (
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
    return {"outcome": "resolved", "apiKey": "hf_secret", "funding": "platform", **extra}


# ---------------------------------------------------------------------------
# 1. Whose credential is spent
# ---------------------------------------------------------------------------


class TestOwnerTenant:
    def test_a_model_with_no_tenant_resolves_SYSTEM(self):
        """A platform model is owned by SYSTEM. Passed EXPLICITLY — the gateway
        has no tenant-less form, because "no tenant" could only mean "read SYSTEM
        unconditionally", which is the widen-without-absence bug."""
        assert owner_tenant_of(None) == SYSTEM_TENANT_ID
        assert owner_tenant_of("") == SYSTEM_TENANT_ID

    def test_a_tenant_owned_model_resolves_that_tenant(self):
        assert owner_tenant_of(TENANT) == TENANT

    @pytest.mark.asyncio
    async def test_the_request_carries_the_MODEL_owner_not_the_caller(self):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.params["tenantId"])
            return httpx.Response(200, json=resolved())

        client = make_client(handler)
        # A SYSTEM-owned model, fetched during a TENANT's job.
        await client.resolve("huggingface", owner_tenant_of(None))
        assert seen == [SYSTEM_TENANT_ID]

    @pytest.mark.asyncio
    async def test_the_cache_is_keyed_by_tenant_AND_provider(self):
        """A cache keyed by provider alone would serve one tenant's token to
        another — rule 09's config-cache rule M4, and here it is key material."""
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            p = request.url.params
            calls.append((p["provider"], p["tenantId"]))
            return httpx.Response(200, json=resolved(apiKey=f"key-for-{p['tenantId']}"))

        client = make_client(handler)
        a = await client.resolve("huggingface", TENANT)
        b = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert a.secret != b.secret
        assert len(calls) == 2
        # ...and a repeat of the first is served from cache, not refetched.
        await client.resolve("huggingface", TENANT)
        assert len(calls) == 2


# ---------------------------------------------------------------------------
# 2. Fail closed on a fault, open on an absence
# ---------------------------------------------------------------------------


class TestFailurePosture:
    @pytest.mark.asyncio
    async def test_absent_is_usable_and_yields_no_token(self):
        client = make_client(lambda _r: httpx.Response(200, json={"outcome": "absent"}))
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.ABSENT
        assert cred.usable
        assert cred.secret is None

    @pytest.mark.asyncio
    async def test_a_transport_error_is_UNAVAILABLE_not_absent(self):
        def boom(_r: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("gateway unreachable")

        client = make_client(boom)
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE
        assert not cred.usable

    @pytest.mark.asyncio
    async def test_an_http_error_is_UNAVAILABLE(self):
        client = make_client(lambda _r: httpx.Response(500, text="boom"))
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE

    @pytest.mark.asyncio
    async def test_an_UNRECOGNISED_outcome_is_UNAVAILABLE_not_absent(self):
        """A contract the client does not understand is a fault. Reading it as
        "no opinion" would silently downgrade an entitled pull."""
        client = make_client(lambda _r: httpx.Response(200, json={"outcome": "maybe"}))
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.outcome is CredentialOutcome.UNAVAILABLE

    @pytest.mark.asyncio
    async def test_denied_is_not_usable(self):
        client = make_client(
            lambda _r: httpx.Response(200, json={"outcome": "denied", "reason": "tenant veto"})
        )
        cred = await client.resolve("huggingface", TENANT)
        assert cred.outcome is CredentialOutcome.DENIED
        assert not cred.usable

    @pytest.mark.asyncio
    async def test_raise_if_unusable_raises_on_denied_and_unavailable(self):
        for outcome in (CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE):
            cred = ModelRegistryCredential(outcome=outcome, reason="because")
            with pytest.raises(CredentialUnavailable):
                cred.raise_if_unusable(provider="huggingface")

    @pytest.mark.asyncio
    async def test_raise_if_unusable_is_silent_on_resolved_and_absent(self):
        for outcome in (CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT):
            ModelRegistryCredential(outcome=outcome).raise_if_unusable(provider="huggingface")

    @pytest.mark.asyncio
    async def test_a_FAULT_is_never_cached(self):
        """Caching `unavailable` would extend a momentary outage into a full TTL
        of failed loads. A negative result must be retried."""
        calls = {"n": 0}

        def flaky(_r: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectError("first call fails")
            return httpx.Response(200, json=resolved())

        client = make_client(flaky)
        assert (
            await client.resolve("huggingface", SYSTEM_TENANT_ID)
        ).outcome is CredentialOutcome.UNAVAILABLE
        assert (
            await client.resolve("huggingface", SYSTEM_TENANT_ID)
        ).outcome is CredentialOutcome.RESOLVED


# ---------------------------------------------------------------------------
# 3. The secret does not leak
# ---------------------------------------------------------------------------


class TestSecretContainment:
    @pytest.mark.asyncio
    async def test_the_token_survives_neither_repr_nor_str(self):
        client = make_client(lambda _r: httpx.Response(200, json=resolved()))
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.secret == "hf_secret"
        assert "hf_secret" not in repr(cred)
        assert "hf_secret" not in str(cred)

    @pytest.mark.asyncio
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

    @pytest.mark.asyncio
    async def test_an_empty_token_is_treated_as_absent_material(self):
        """`""` is not a credential. Forwarding it builds `Authorization: Bearer `
        with no value, which HuggingFace rejects outright."""
        client = make_client(lambda _r: httpx.Response(200, json=resolved(apiKey="")))
        cred = await client.resolve("huggingface", SYSTEM_TENANT_ID)
        assert cred.secret is None


# ---------------------------------------------------------------------------
# 4. Single-flight
# ---------------------------------------------------------------------------


class TestSingleFlight:
    @pytest.mark.asyncio
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
        await asyncio.gather(*(client.resolve("huggingface", SYSTEM_TENANT_ID) for _ in range(5)))
        assert calls["n"] == 1
