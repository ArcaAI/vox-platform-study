"""C-2 client: `model=<slug>` → `ResolvedServingSpec` through the gateway, per tenant.

`GET {gateway}/internal/models/{slug}/serving-spec?service=vllm` with `X-Service-Token` and
`X-Tenant-Id`. Cache key `(tenant_id, slug)` — the tenant is ALWAYS in the key, because the
same slug can name a tenant's BYO row for one caller and the SYSTEM row for another (review
focus 2). Positive TTL 60 s, negative TTL 10 s (a settled 404 / 409), single-flight per key;
a fault (5xx, transport, malformed body) raises and caches nothing.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from hope_vllm.core.serving_spec_client import (
    ModelNotFound,
    ModelNotServable,
    ServingSpecClient,
    ServingSpecUnavailable,
)
from hope_vllm.engine.pool import EnginePool
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.conftest import serving_spec_payload
from hope_vllm.tests.fakes import FakeEngineFactory

FIXTURE = Path(__file__).resolve().parents[6] / "tests/contracts/resolved-serving-spec.fixture.json"
GATEWAY = "http://gateway.test/api/v1"
TENANT_A = "a0000000-0000-0000-0000-00000000000a"
TENANT_B = "b0000000-0000-0000-0000-00000000000b"
SLUG = "arcaai-whisper-large-ml-en-vllm"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Gateway:
    """A stand-in serving-spec route. `responses[(tenant, slug)]` = (status, body)."""

    def __init__(self) -> None:
        self.responses: dict[tuple[str, str], tuple[int, Any]] = {}
        self.default: tuple[int, Any] = (200, json.loads(FIXTURE.read_text()))
        self.requests: list[httpx.Request] = []
        self.delay_s = 0.0

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        slug = request.url.path.split("/models/", 1)[1].split("/serving-spec", 1)[0]
        tenant = request.headers.get("X-Tenant-Id", "")
        status, body = self.responses.get((tenant, slug), self.default)
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)


def make_client(gateway: Gateway, clock: Clock | None = None) -> ServingSpecClient:
    return ServingSpecClient(
        base_url=GATEWAY,
        token="tok-123",
        transport=httpx.MockTransport(gateway.handler),
        time_func=clock or Clock(),
    )


async def test_resolves_the_committed_fixture_with_the_house_headers() -> None:
    gateway = Gateway()
    spec = await make_client(gateway).resolve(SLUG, TENANT_A)

    assert spec == ResolvedServingSpec.model_validate(json.loads(FIXTURE.read_text()))
    (request,) = gateway.requests
    assert request.method == "GET"
    assert request.url.path == f"/api/v1/internal/models/{SLUG}/serving-spec"
    # The gateway's InternalServiceTokenGuard picks its secret by `?service=`.
    assert request.url.params["service"] == "vllm"
    assert request.headers["X-Service-Token"] == "tok-123"
    assert request.headers["X-Tenant-Id"] == TENANT_A


async def test_a_slug_is_path_escaped() -> None:
    gateway = Gateway()
    gateway.default = (404, {"code": "MODEL_NOT_FOUND"})
    with pytest.raises(ModelNotFound):
        await make_client(gateway).resolve("a/b?c", TENANT_A)
    (request,) = gateway.requests
    assert request.url.raw_path.startswith(b"/api/v1/internal/models/a%2Fb%3Fc/serving-spec")


async def test_a_second_call_within_the_ttl_makes_no_second_request() -> None:
    gateway, clock = Gateway(), Clock()
    client = make_client(gateway, clock)
    first = await client.resolve(SLUG, TENANT_A)
    clock.now += 59
    second = await client.resolve(SLUG, TENANT_A)
    assert first == second
    assert len(gateway.requests) == 1

    clock.now += 2  # 61 s: expired
    await client.resolve(SLUG, TENANT_A)
    assert len(gateway.requests) == 2


async def test_two_tenants_asking_for_the_same_slug_make_two_requests() -> None:
    gateway = Gateway()
    client = make_client(gateway)
    await client.resolve(SLUG, TENANT_A)
    await client.resolve(SLUG, TENANT_B)
    assert [r.headers["X-Tenant-Id"] for r in gateway.requests] == [TENANT_A, TENANT_B]


async def test_a_404_is_model_not_found_and_negatively_cached_for_10_s() -> None:
    gateway, clock = Gateway(), Clock()
    gateway.default = (404, {"code": "MODEL_NOT_FOUND"})
    client = make_client(gateway, clock)

    with pytest.raises(ModelNotFound):
        await client.resolve(SLUG, TENANT_A)
    clock.now += 9
    with pytest.raises(ModelNotFound):
        await client.resolve(SLUG, TENANT_A)
    assert len(gateway.requests) == 1

    clock.now += 2  # 11 s: the negative entry expired
    gateway.default = (200, json.loads(FIXTURE.read_text()))
    assert (await client.resolve(SLUG, TENANT_A)).slug == SLUG
    assert len(gateway.requests) == 2


@pytest.mark.parametrize("reason", ["FORMAT_UNSUPPORTED", "SERVING_FACTS_MISSING", "DISABLED"])
async def test_a_409_is_model_not_servable_with_its_reason(reason: str) -> None:
    gateway, clock = Gateway(), Clock()
    gateway.default = (409, {"code": "MODEL_NOT_SERVABLE", "reason": reason})
    client = make_client(gateway, clock)
    with pytest.raises(ModelNotServable) as info:
        await client.resolve(SLUG, TENANT_A)
    assert info.value.reason == reason
    # A settled answer — negatively cached like a 404.
    with pytest.raises(ModelNotServable):
        await client.resolve(SLUG, TENANT_A)
    assert len(gateway.requests) == 1


async def test_a_409_without_a_reason_still_names_one() -> None:
    gateway = Gateway()
    gateway.default = (409, {"code": "MODEL_NOT_SERVABLE"})
    with pytest.raises(ModelNotServable) as info:
        await make_client(gateway).resolve(SLUG, TENANT_A)
    assert info.value.reason == "UNKNOWN"


@pytest.mark.parametrize(
    "response",
    [
        (500, {"message": "boom"}),
        (503, {"message": "down"}),
        (401, {"message": "bad token"}),
        (200, "not json"),
        (200, {"slug": SLUG}),  # 200 but not the contract shape
    ],
)
async def test_a_fault_raises_and_is_not_cached(response: tuple[int, Any]) -> None:
    gateway = Gateway()
    gateway.default = response
    client = make_client(gateway)
    with pytest.raises(ServingSpecUnavailable):
        await client.resolve(SLUG, TENANT_A)
    with pytest.raises(ServingSpecUnavailable):
        await client.resolve(SLUG, TENANT_A)
    assert len(gateway.requests) == 2  # nothing cached

    gateway.default = (200, json.loads(FIXTURE.read_text()))
    assert (await client.resolve(SLUG, TENANT_A)).slug == SLUG


async def test_a_transport_failure_raises_and_is_not_cached() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("refused", request=request)

    client = ServingSpecClient(
        base_url=GATEWAY, token="t", transport=httpx.MockTransport(handler), time_func=Clock()
    )
    for _ in range(2):
        with pytest.raises(ServingSpecUnavailable):
            await client.resolve(SLUG, TENANT_A)
    assert calls == 2


async def test_no_gateway_configured_is_unavailable_without_a_request() -> None:
    client = ServingSpecClient(base_url="", token="t", time_func=Clock())
    with pytest.raises(ServingSpecUnavailable):
        await client.resolve(SLUG, TENANT_A)


async def test_concurrent_first_calls_make_one_request() -> None:
    gateway = Gateway()
    gateway.delay_s = 0.05
    client = make_client(gateway)
    specs = await asyncio.gather(*(client.resolve(SLUG, TENANT_A) for _ in range(10)))
    assert len({s.runtime_key for s in specs}) == 1
    assert len(gateway.requests) == 1


async def test_concurrent_first_calls_share_one_failure_too() -> None:
    gateway = Gateway()
    gateway.delay_s = 0.05
    gateway.default = (500, {"message": "boom"})
    client = make_client(gateway)
    results = await asyncio.gather(
        *(client.resolve(SLUG, TENANT_A) for _ in range(5)), return_exceptions=True
    )
    assert all(isinstance(r, ServingSpecUnavailable) for r in results)
    assert len(gateway.requests) == 1


async def test_same_slug_for_two_tenants_yields_two_runtime_keys_and_two_engines() -> None:
    """Review focus 2: tenant A's BYO row must never be served to tenant B under the slug."""
    gateway = Gateway()
    gateway.responses[(TENANT_A, SLUG)] = (
        200,
        serving_spec_payload(tenantId=TENANT_A, runtimeKey="byo-a-row:v1", vramGiB=2),
    )
    gateway.responses[(TENANT_B, SLUG)] = (
        200,
        serving_spec_payload(runtimeKey="system-row:v1", vramGiB=2),
    )
    client = make_client(gateway)
    spec_a = await client.resolve(SLUG, TENANT_A)
    spec_b = await client.resolve(SLUG, TENANT_B)
    assert spec_a.runtime_key != spec_b.runtime_key

    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=2)
    async with pool.lease(spec_a) as engine_a, pool.lease(spec_b) as engine_b:
        assert engine_a is not engine_b
    assert factory.builds == ["byo-a-row:v1", "system-row:v1"]
    assert engine_a.spec.tenant_id == TENANT_A  # type: ignore[attr-defined]
    await pool.close()
