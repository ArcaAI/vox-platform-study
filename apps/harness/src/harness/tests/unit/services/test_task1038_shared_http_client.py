"""TASK-1038 R-6 — one shared ``httpx.AsyncClient`` per worker process.

Before: ``ApiClient`` and ``TextClient`` opened (and tore down) a NEW ``httpx.AsyncClient`` — a new
connection pool, a new TCP + TLS handshake — for every single request. A worker making hundreds of
gateway and text calls per run paid that cost on every one.

After: both clients borrow ONE process-wide client per event loop (``harness.temporal.http_pool``),
and the worker closes it on shutdown. A client built with an explicit ``transport`` (every unit
suite in this package) keeps its private per-request client, so test isolation is unchanged.
"""

from __future__ import annotations

import httpx
import pytest

from harness.services.api_client import ApiClient
from harness.services.text_client import TextClient
from harness.temporal import http_pool


@pytest.fixture
def counted_pool(monkeypatch: pytest.MonkeyPatch):
    built: list[httpx.AsyncClient] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/generate"):
            return httpx.Response(200, json={"content": "ok", "provider": "p", "model": "m"})
        return httpx.Response(200, json={"ok": True})

    def build() -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        built.append(client)
        return client

    monkeypatch.setattr(http_pool, "_build_client", build)
    http_pool.reset_for_tests()
    yield built
    http_pool.reset_for_tests()


@pytest.mark.asyncio
async def test_api_client_reuses_one_pooled_client_across_requests(counted_pool):
    api = ApiClient("http://api", service_token="t")
    await api.get_policy("t-1")
    await api.get_policy("t-1")
    await api.resolve_agent(slug="a", tenant_id="t-1")

    assert len(counted_pool) == 1
    assert not counted_pool[0].is_closed


@pytest.mark.asyncio
async def test_api_and_text_clients_share_the_same_pool(counted_pool):
    await ApiClient("http://api", service_token="t").get_policy("t-1")
    await TextClient("http://text", service_token="t").generate(
        tenant_id="t-1", prompt="hi", provider="p", model="m"
    )

    assert len(counted_pool) == 1


@pytest.mark.asyncio
async def test_aclose_closes_the_pooled_client_and_a_later_call_builds_a_fresh_one(counted_pool):
    api = ApiClient("http://api", service_token="t")
    await api.get_policy("t-1")
    await http_pool.aclose_shared_clients()

    assert counted_pool[0].is_closed
    await api.get_policy("t-1")
    assert len(counted_pool) == 2


@pytest.mark.asyncio
async def test_an_injected_transport_never_touches_the_pool(counted_pool):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={})

    api = ApiClient("http://api", service_token="t", transport=httpx.MockTransport(handler))
    await api.get_policy("t-1")

    assert calls == ["/internal/harness/policy"]
    assert counted_pool == []


def test_the_worker_closes_the_shared_pool_on_shutdown():
    """`run_worker` cannot run hermetically (it needs a live Temporal); its shutdown path is
    pinned at source level instead: the pool must be closed inside the `finally` that drains
    the worker, after Temporal has finished its in-flight activities."""
    import inspect

    from harness.temporal import worker

    source = inspect.getsource(worker.run_worker)
    finally_block = source[source.index("finally:") :]
    assert "aclose_shared_clients()" in finally_block
