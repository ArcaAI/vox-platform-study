"""TASK-818 Lane A — the egress client layer stops rebuilding itself per request.

Bottleneck B-2: every adapter built a fresh SDK client (and therefore a fresh TLS
connection pool) on EVERY request — `openai.py`, `azure_openai.py`, `anthropic.py`,
`vertex.py`, `bedrock.py` and `openai_compat.py` alike. At the concurrency this
service is being built for that is a TLS handshake per stream and no connection
reuse anywhere.

The fix is a keyed cache, and the whole difficulty is that the property those
per-request comments were defending is REAL: two tenants with different
credentials must never share a client, because a shared client is a shared
credential. So the cache is keyed by `(provider, base_url, credential
fingerprint)` — a SALTED HASH, never the credential — and both halves of that
property are asserted here:

  * different credential  =>  different client   (isolation survives)
  * same credential       =>  SAME client        (which is the point)

Also covers B-8 (per-upstream pools, HTTP/2 posture) and V-6 (the
`_last_base_url` process memo can no longer reach a client construction site).

RED before implementation.
"""

from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock, patch

import httpx
import httpx2
import pytest

from text.models.requests import GenerateRequest


def _openai_request(key: str, *, base_url: str | None = None) -> GenerateRequest:
    override: dict[str, object] = {"api_key": key}
    if base_url is not None:
        override["base_url"] = base_url
    return GenerateRequest(
        prompt="hi",
        provider="openai",
        model="caller-model",
        provider_overrides={"openai": override},
    )


def _snapshot(profiles: list[dict]):
    from text.core.effective_config import EffectiveConfigSnapshot

    return EffectiveConfigSnapshot(raw={"runtimeProfiles": profiles}, ok=True)


def _code_of(func) -> str:
    """A function's source with its docstring removed.

    Lets a source-level fence assert on what the code REACHES FOR without
    tripping over the comment that explains why it must not.
    """
    import ast
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    node = tree.body[0]
    body = node.body  # type: ignore[attr-defined]
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    return "\n".join(ast.unparse(stmt) for stmt in body)


# -- A-1: the fingerprint is a salted hash, never the credential --------------


class TestCredentialFingerprint:
    def test_fingerprint_never_contains_the_credential(self):
        from text.providers.clients import credential_fingerprint

        secret = "sk-super-secret-value"
        fingerprint = credential_fingerprint(secret)
        assert secret not in fingerprint
        assert "super-secret" not in fingerprint

    def test_fingerprint_is_stable_for_the_same_credential(self):
        from text.providers.clients import credential_fingerprint

        assert credential_fingerprint("same") == credential_fingerprint("same")

    def test_fingerprint_differs_for_different_credentials(self):
        from text.providers.clients import credential_fingerprint

        assert credential_fingerprint("tenant-a") != credential_fingerprint("tenant-b")

    def test_fingerprint_is_salted_not_a_bare_digest(self):
        """A bare hash of a credential is a credential in a costume: an offline
        dictionary attack recovers a short key from it. The salt makes the digest
        meaningless outside this process, which is all a cache key ever needs."""
        import hashlib

        from text.providers.clients import _CACHE_KEY_SALT, credential_fingerprint

        secret = "sk-guessable"
        assert credential_fingerprint(secret) != hashlib.sha256(secret.encode()).hexdigest()
        assert credential_fingerprint(secret, salt=b"other-salt") != credential_fingerprint(secret)
        assert len(_CACHE_KEY_SALT) >= 16

    def test_empty_credential_has_its_own_marker(self):
        """A keyless self-hosted row is a distinct state, not a credential."""
        from text.providers.clients import KEYLESS, credential_fingerprint

        assert credential_fingerprint("") == KEYLESS


# -- A-1: isolation and reuse, the two halves that must both hold ------------


class TestClientCacheIsolationAndReuse:
    def test_different_credentials_never_share_a_client(self):
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            client_a = provider._client_for(_openai_request("tenant-a-key"))
            client_b = provider._client_for(_openai_request("tenant-b-key"))

        assert client_a is not client_b
        assert ctor.call_count == 2

    def test_same_credential_reuses_one_client_across_requests(self):
        """The entire point of the lane: two requests from the same tenant on the
        same connection pay ONE client build and ONE TLS pool, not two."""
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            first = provider._client_for(_openai_request("tenant-a-key"))
            second = provider._client_for(_openai_request("tenant-a-key"))

        assert first is second
        assert ctor.call_count == 1

    def test_same_credential_reuses_across_provider_instances(self):
        """The cache is process-level, not instance-level: `ProviderRegistry`
        memoizes one adapter today, but reuse must not depend on that."""
        from text.providers.openai import OpenAIProvider

        with patch("text.providers.openai.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            first = OpenAIProvider()._client_for(_openai_request("shared-key"))
            second = OpenAIProvider()._client_for(_openai_request("shared-key"))

        assert first is second
        assert ctor.call_count == 1

    def test_same_credential_on_a_different_base_url_is_a_different_client(self):
        """`base_url` is part of the key: one credential fronting two gateways
        must not be collapsed onto whichever endpoint got there first."""
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            first = provider._client_for(_openai_request("k", base_url="https://a.test/v1"))
            second = provider._client_for(_openai_request("k", base_url="https://b.test/v1"))

        assert first is not second
        assert ctor.call_count == 2

    def test_two_providers_never_collide_on_one_entry(self):
        from text.providers.clients import CLIENT_CACHE, client_key

        a = CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object)
        b = CLIENT_CACHE.get_or_create(client_key("anthropic", "", "k"), object)
        assert a is not b

    def test_a_failed_build_is_not_cached(self):
        """A malformed credential must fail every time, not once, and a later good
        build must not be skipped because an earlier one blew up."""
        from text.providers.clients import CLIENT_CACHE, client_key

        key = client_key("openai", "", "k")
        calls = {"n": 0}

        def _boom():
            calls["n"] += 1
            raise RuntimeError("bad key")

        for _ in range(2):
            with pytest.raises(RuntimeError):
                CLIENT_CACHE.get_or_create(key, _boom)
        assert calls["n"] == 2


class TestAnthropicAzureAndCompatAreCachedToo:
    def test_anthropic_reuses_and_isolates(self):
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider()

        def _req(key: str) -> GenerateRequest:
            return GenerateRequest(
                prompt="hi",
                provider="anthropic",
                model="m",
                provider_overrides={"anthropic": {"api_key": key}},
            )

        with patch("text.providers.anthropic.AsyncAnthropic") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            same_a = provider._client_for(_req("a"))
            same_b = provider._client_for(_req("a"))
            other = provider._client_for(_req("b"))

        assert same_a is same_b
        assert same_a is not other
        assert ctor.call_count == 2

    def test_azure_reuses_and_isolates(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        provider = AzureOpenAIProvider()

        def _req(key: str) -> GenerateRequest:
            return GenerateRequest(
                prompt="hi",
                provider="azure",
                model="m",
                provider_overrides={
                    "azure": {"api_key": key, "base_url": "https://r.openai.azure.com"}
                },
            )

        with patch("text.providers.azure_openai.AsyncAzureOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            same_a = provider._client_for(_req("a"))
            same_b = provider._client_for(_req("a"))
            other = provider._client_for(_req("b"))

        assert same_a is same_b
        assert same_a is not other
        assert ctor.call_count == 2

    def test_keyless_self_host_is_keyed_on_base_url_alone(self):
        """`openai_compat` is `SELF_HOST`: a keyless LM Studio row has no BYOK
        reason to pay for a per-credential entry, so two keyless requests to one
        endpoint share a client."""
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="lm-studio", display_name="LM Studio")
        req = GenerateRequest(
            prompt="hi",
            provider="lm-studio",
            model="m",
            provider_overrides={"lm-studio": {"api_key": "", "base_url": "http://e.test/v1"}},
        )
        with patch("text.providers.openai_compat.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            first = provider._client_for(req)
            second = provider._client_for(req)

        assert first is second
        assert ctor.call_count == 1

    def test_a_self_host_row_that_does_carry_a_key_still_isolates(self):
        """The narrowing that keeps `SELF_HOST` honest: the adapter documents that
        it honours a tenant override, so when a real key IS present it is part of
        the key. Two tenants fronting the SAME endpoint with DIFFERENT credentials
        must not be collapsed - that would be a cross-tenant credential
        substitution on the cheapest possible path."""
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="lm-studio", display_name="LM Studio")

        def _req(key: str) -> GenerateRequest:
            return GenerateRequest(
                prompt="hi",
                provider="lm-studio",
                model="m",
                provider_overrides={
                    "lm-studio": {"api_key": key, "base_url": "http://shared.test/v1"}
                },
            )

        with patch("text.providers.openai_compat.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            a = provider._client_for(_req("tenant-a"))
            b = provider._client_for(_req("tenant-b"))

        assert a is not b
        assert ctor.call_count == 2


# -- A-1: bounded, expiring, and evictable -----------------------------------


class TestClientCacheIsBounded:
    def test_lru_evicts_the_least_recently_used_entry(self):
        from text.providers.clients import ClientCache, client_key

        cache = ClientCache(max_entries=2)
        first = cache.get_or_create(client_key("p", "", "1"), object)
        cache.get_or_create(client_key("p", "", "2"), object)
        cache.get_or_create(client_key("p", "", "3"), object)

        assert len(cache) == 2
        assert cache.get_or_create(client_key("p", "", "1"), object) is not first

    def test_a_hit_refreshes_recency(self):
        from text.providers.clients import ClientCache, client_key

        cache = ClientCache(max_entries=2)
        first = cache.get_or_create(client_key("p", "", "1"), object)
        cache.get_or_create(client_key("p", "", "2"), object)
        assert cache.get_or_create(client_key("p", "", "1"), object) is first
        cache.get_or_create(client_key("p", "", "3"), object)
        assert cache.get_or_create(client_key("p", "", "1"), object) is first

    def test_entries_expire(self):
        from text.providers.clients import ClientCache, client_key

        now = {"t": 0.0}
        cache = ClientCache(max_entries=8, ttl_s=100.0, time_func=lambda: now["t"])
        key = client_key("p", "", "1")
        first = cache.get_or_create(key, object)
        now["t"] = 99.0
        assert cache.get_or_create(key, object) is first
        now["t"] = 101.0
        assert cache.get_or_create(key, object) is not first


class TestEviction:
    def test_evict_provider_drops_only_that_provider(self):
        from text.providers.clients import CLIENT_CACHE, client_key

        keep = CLIENT_CACHE.get_or_create(client_key("anthropic", "", "k"), object)
        openai_first = CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object)
        CLIENT_CACHE.evict_provider("openai")

        assert CLIENT_CACHE.get_or_create(client_key("anthropic", "", "k"), object) is keep
        assert CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object) is not openai_first

    def test_evict_all_empties_the_cache(self):
        from text.providers.clients import CLIENT_CACHE, client_key, evict_all_clients

        CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object)
        assert len(CLIENT_CACHE) > 0
        evict_all_clients("test")
        assert len(CLIENT_CACHE) == 0

    def test_a_config_invalidation_message_drops_every_cached_client(self):
        """Rule 09 "Config caches": invalidation is the propagation path, the TTL
        is only a bounded-staleness net. A rotated credential must not leave a
        client authenticated with the revoked one holding warm sockets."""
        import text.providers.openai  # noqa: F401  (registers the eviction hook)
        from text.core.effective_config import EffectiveConfigClient
        from text.providers.clients import CLIENT_CACHE, client_key

        CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object)
        assert len(CLIENT_CACHE) > 0

        client = EffectiveConfigClient(base_url="http://gw.test", token="t")
        client.handle_invalidation_message(b'{"key":"ai.provider.connection"}')

        assert len(CLIENT_CACHE) == 0


# -- A-2 / A-3: per-upstream pools, tuned from the config plane --------------


class TestPoolPolicy:
    def test_floor_applies_when_the_control_plane_has_no_opinion(self):
        from text.providers.pool import (
            POOL_HTTP2_FLOOR,
            POOL_KEEPALIVE_EXPIRY_FLOOR_S,
            POOL_MAX_CONNECTIONS_FLOOR,
            POOL_MAX_KEEPALIVE_FLOOR,
            pool_policy_for,
        )

        policy = pool_policy_for("a-provider-nobody-configured")
        assert policy.max_connections == POOL_MAX_CONNECTIONS_FLOOR
        assert policy.max_keepalive_connections == POOL_MAX_KEEPALIVE_FLOOR
        assert policy.keepalive_expiry_s == POOL_KEEPALIVE_EXPIRY_FLOOR_S
        assert policy.http2 is POOL_HTTP2_FLOOR is False

    def test_keepalive_expiry_floor_sits_below_any_plausible_idle_timeout(self):
        """4.2: an expiry ABOVE the upstream idle timeout hands you sockets the
        peer already reaped. The floor must therefore be conservative, never
        ambitious - a deployment raises it deliberately, per upstream."""
        from text.providers.pool import POOL_KEEPALIVE_EXPIRY_FLOOR_S

        assert 0 < POOL_KEEPALIVE_EXPIRY_FLOOR_S <= 5.0

    def test_control_plane_values_are_adopted_per_upstream(self):
        from text.providers.pool import apply_pool_policy, pool_policy_for

        apply_pool_policy(
            _snapshot(
                [
                    {
                        "provider": "vllm",
                        "modelSlug": "",
                        "poolMaxConnections": 512,
                        "poolMaxKeepaliveConnections": 256,
                        "poolKeepaliveExpiryS": 55.0,
                        "http2": True,
                    },
                    {"provider": "openai", "modelSlug": "", "poolMaxConnections": 64},
                ]
            )
        )

        vllm = pool_policy_for("vllm")
        assert vllm.max_connections == 512
        assert vllm.max_keepalive_connections == 256
        assert vllm.keepalive_expiry_s == 55.0
        assert vllm.http2 is True

        openai = pool_policy_for("openai")
        assert openai.max_connections == 64
        # untouched keys keep the floor rather than becoming zero
        assert openai.http2 is False

    def test_a_negative_cached_snapshot_changes_nothing(self):
        from text.core.effective_config import EffectiveConfigSnapshot
        from text.providers.pool import apply_pool_policy, pool_policy_for

        apply_pool_policy(_snapshot([{"provider": "vllm", "modelSlug": "", "http2": True}]))
        apply_pool_policy(EffectiveConfigSnapshot(raw={}, ok=False))
        assert pool_policy_for("vllm").http2 is True

    def test_a_removed_profile_reverts_to_the_floor(self):
        from text.providers.pool import apply_pool_policy, pool_policy_for

        apply_pool_policy(_snapshot([{"provider": "vllm", "modelSlug": "", "http2": True}]))
        apply_pool_policy(_snapshot([]))
        assert pool_policy_for("vllm").http2 is False

    def test_model_scoped_rows_are_ignored(self):
        """Pool shape is a property of the UPSTREAM, not of a model served on it."""
        from text.providers.pool import apply_pool_policy, pool_policy_for

        apply_pool_policy(
            _snapshot([{"provider": "vllm", "modelSlug": "qwen3", "poolMaxConnections": 999}])
        )
        assert pool_policy_for("vllm").max_connections != 999

    def test_nonsense_values_are_refused_not_adopted(self):
        from text.providers.pool import (
            POOL_MAX_CONNECTIONS_FLOOR,
            apply_pool_policy,
            pool_policy_for,
        )

        apply_pool_policy(
            _snapshot(
                [
                    {
                        "provider": "vllm",
                        "modelSlug": "",
                        "poolMaxConnections": 0,
                        "poolKeepaliveExpiryS": -1,
                        "http2": "yes-please",
                    }
                ]
            )
        )
        policy = pool_policy_for("vllm")
        assert policy.max_connections == POOL_MAX_CONNECTIONS_FLOOR
        assert policy.keepalive_expiry_s > 0
        assert policy.http2 is False

    def test_limits_mirror_the_policy(self):
        from text.providers.pool import PoolPolicy

        limits = PoolPolicy(
            max_connections=7, max_keepalive_connections=3, keepalive_expiry_s=9.0
        ).limits()
        assert isinstance(limits, httpx.Limits)
        assert limits.max_connections == 7
        assert limits.max_keepalive_connections == 3
        assert limits.keepalive_expiry == 9.0


class TestPooledTransport:
    def test_one_pooled_client_per_upstream_not_one_global(self):
        """4.2: use one client per upstream, not one global."""
        from text.providers.pool import pooled_http_client

        a = pooled_http_client("openai", timeout_s=30)
        b = pooled_http_client("openai", timeout_s=30)
        c = pooled_http_client("anthropic", timeout_s=30)
        assert a is b
        assert a is not c

    def test_the_two_transport_families_are_pooled_separately(self):
        """`openai>=3` is on `httpx2`; `anthropic` is on `httpx`. The two client
        libraries are structurally identical and NOT interchangeable — handing an
        `httpx.AsyncClient` to `AsyncOpenAI` is accepted at construction and only
        misbehaves later in the transport. Keying the pool on the family is what
        makes that unrepresentable."""
        from text.providers.pool import TransportFamily, pooled_http_client

        one = pooled_http_client("openai", timeout_s=30, family=TransportFamily.HTTPX)
        two = pooled_http_client("openai", timeout_s=30, family=TransportFamily.HTTPX2)

        assert one is not two
        assert isinstance(one, httpx.AsyncClient)
        assert isinstance(two, httpx2.AsyncClient)

    def test_every_openai_sdk_adapter_asks_for_the_httpx2_family(self):
        """The regression fence for the mismatch above. A new OpenAI-wire adapter
        that forgets `family=` silently gets an `httpx` client from the default."""
        from pathlib import Path

        import text.providers as providers_pkg

        root = Path(providers_pkg.__file__).parent
        offenders: list[str] = []
        for name in ("openai.py", "azure_openai.py", "openai_compat.py"):
            source = (root / name).read_text(encoding="utf-8")
            if "pooled_http_client(" in source and "TransportFamily.HTTPX2" not in source:
                offenders.append(name)
        assert not offenders, (
            f"OpenAI-SDK adapters not declaring the httpx2 family: {offenders}. "
            "`openai._base_client` annotates `http_client: httpx2.AsyncClient`."
        )

    @pytest.mark.parametrize("family_name", ["HTTPX", "HTTPX2"])
    def test_the_pooled_client_carries_the_policy_limits(self, family_name):
        from text.providers.pool import TransportFamily, apply_pool_policy, pooled_http_client

        apply_pool_policy(
            _snapshot(
                [
                    {
                        "provider": "openai",
                        "modelSlug": "",
                        "poolMaxConnections": 33,
                        "poolMaxKeepaliveConnections": 11,
                        "poolKeepaliveExpiryS": 4.0,
                    }
                ]
            )
        )
        client = pooled_http_client("openai", timeout_s=30, family=TransportFamily[family_name])
        pool = client._transport._pool
        assert pool._max_connections == 33
        assert pool._max_keepalive_connections == 11
        assert pool._keepalive_expiry == 4.0

    def test_http2_is_requested_when_the_policy_asks_for_it(self):
        # Asserted on the TRANSPORT, which is the object that actually
        # negotiates it — an `AsyncClient` handed an explicit transport ignores
        # its own `http2=`, so spying on the client's kwargs would pass on a
        # value with no effect. Same seam the limits test above inspects.
        from text.providers import pool as pool_mod

        pool_mod.apply_pool_policy(
            _snapshot([{"provider": "vllm", "modelSlug": "", "http2": True}])
        )
        client = pool_mod.pooled_http_client("vllm", timeout_s=30)

        assert client._transport._pool._http2 is pool_mod.http2_supported()

    def test_a_missing_h2_package_degrades_to_http1_instead_of_raising(self):
        """`http2=True` raises `ImportError` when `h2` is absent. An egress proxy
        must not 500 a tenant's generation because an optional transport extra was
        not installed - it negotiates down and says so."""
        from text.providers import pool as pool_mod

        with patch.object(pool_mod, "http2_supported", return_value=False):
            pool_mod.apply_pool_policy(
                _snapshot([{"provider": "vllm", "modelSlug": "", "http2": True}])
            )
            client = pool_mod.pooled_http_client("vllm", timeout_s=30)
        assert isinstance(client, httpx.AsyncClient)

    def test_a_policy_change_rebuilds_the_pool_and_drops_stale_clients(self):
        """A new pool shape is worthless if every cached SDK client still holds the
        old transport."""
        from text.providers.clients import CLIENT_CACHE, client_key
        from text.providers.pool import apply_pool_policy, pooled_http_client

        apply_pool_policy(
            _snapshot([{"provider": "openai", "modelSlug": "", "poolMaxConnections": 10}])
        )
        before = pooled_http_client("openai", timeout_s=30)
        sentinel = CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object)

        apply_pool_policy(
            _snapshot([{"provider": "openai", "modelSlug": "", "poolMaxConnections": 20}])
        )
        after = pooled_http_client("openai", timeout_s=30)

        assert after is not before
        assert CLIENT_CACHE.get_or_create(client_key("openai", "", "k"), object) is not sentinel

    def test_an_unchanged_policy_keeps_the_pool_warm(self):
        """The refresh runs on every request. Rebuilding an unchanged pool would
        undo the connection reuse this lane exists to create."""
        from text.providers.pool import apply_pool_policy, pooled_http_client

        profiles = [{"provider": "openai", "modelSlug": "", "poolMaxConnections": 10}]
        apply_pool_policy(_snapshot(profiles))
        before = pooled_http_client("openai", timeout_s=30)
        apply_pool_policy(_snapshot(profiles))
        assert pooled_http_client("openai", timeout_s=30) is before


class TestAdaptersUseThePooledTransport:
    def test_openai_hands_the_pooled_client_to_the_sdk(self):
        from text.providers.openai import OpenAIProvider
        from text.providers.pool import TransportFamily, pooled_http_client

        provider = OpenAIProvider()
        with patch("text.providers.openai.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            provider._client_for(_openai_request("k"))
        assert ctor.call_args.kwargs["http_client"] is pooled_http_client(
            "openai", timeout_s=provider._timeout_s, family=TransportFamily.HTTPX2
        )

    def test_anthropic_hands_the_pooled_client_to_the_sdk(self):
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider()
        req = GenerateRequest(
            prompt="hi",
            provider="anthropic",
            model="m",
            provider_overrides={"anthropic": {"api_key": "k"}},
        )
        with patch("text.providers.anthropic.AsyncAnthropic") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            provider._client_for(req)
        assert "http_client" in ctor.call_args.kwargs

    def test_openai_compat_hands_the_pooled_client_to_the_sdk(self):
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="lm-studio", display_name="LM Studio")
        req = GenerateRequest(
            prompt="hi",
            provider="lm-studio",
            model="m",
            provider_overrides={"lm-studio": {"api_key": "", "base_url": "http://e.test/v1"}},
        )
        with patch("text.providers.openai_compat.AsyncOpenAI") as ctor:
            ctor.side_effect = lambda **_: AsyncMock()
            provider._client_for(req)
        assert "http_client" in ctor.call_args.kwargs


# -- A-5: the process-wide endpoint memo cannot reach a client build ---------


class TestNoProcessWideEndpointMemoInAClientBuild:
    def test_the_client_construction_seam_takes_an_explicit_url(self):
        from text.providers.openai_compat import OpenAICompatProvider

        # CODE, not prose: the docstring explains what the memo is and why it is
        # excluded, and a naive text scan would flag that explanation. Same
        # distinction `test_no_serving_invariant.py` draws when it parses imports
        # rather than grepping for them - a comment about a hazard is
        # documentation, a reference to it is a capability.
        source = _code_of(OpenAICompatProvider._client_at)
        assert "_last_base_url" not in source, (
            "the single client-construction seam reads the process memo. V-6 is "
            "about exactly this: an endpoint that survives across tenants is one "
            "edit away from routing a generation to another tenant's engine."
        )
        assert "base_url" in inspect.signature(OpenAICompatProvider._client_at).parameters

    def test_every_openai_compat_client_is_built_at_that_one_seam(self):
        """If a second construction site grows back, the explicit-URL argument
        stops being a guarantee and becomes a convention."""
        import text.providers.openai_compat as mod

        source = inspect.getsource(mod)
        # one call inside `_client_at`, plus the `import` and the module docstring
        assert source.count("AsyncOpenAI(") == 1

    def test_the_probe_returns_nothing_when_no_engine_has_been_observed(self):
        from text.providers.openai_compat import OpenAICompatProvider

        assert OpenAICompatProvider()._probe_client() is None

    def test_discover_models_never_repoints_the_generation_memo(self):
        from text.models.probe import ProbeConnection
        from text.providers import openai_compat as mod
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="lm-studio", display_name="LM Studio")
        provider._last_base_url = "http://platform.test/v1"

        class _List:
            data: list[object] = []

        class _Client:
            def __init__(self) -> None:
                self.models = AsyncMock()
                self.models.list = AsyncMock(return_value=_List())

        with patch.object(mod, "AsyncOpenAI", lambda **_: _Client()):
            asyncio.run(provider.discover_models(ProbeConnection(base_url="http://tenant.test/v1")))

        assert provider._last_base_url == "http://platform.test/v1"


# -- The isolation property, end to end through the real resolution path ----


class TestIsolationSurvivesTheCacheEndToEnd:
    def test_two_tenants_generations_use_two_distinct_credentials(self):
        from text.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        built: list[str] = []

        def _ctor(**kwargs):
            built.append(kwargs["api_key"])
            return AsyncMock()

        with patch("text.providers.openai.AsyncOpenAI", side_effect=_ctor):
            provider._client_for(_openai_request("tenant-a-key"))
            provider._client_for(_openai_request("tenant-b-key"))
            provider._client_for(_openai_request("tenant-a-key"))

        # The third call is tenant A again: served from cache, never rebuilt, and
        # never served tenant B's client.
        assert built == ["tenant-a-key", "tenant-b-key"]
