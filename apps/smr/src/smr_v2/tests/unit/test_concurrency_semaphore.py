"""TDD tests for per-provider concurrency semaphore (Task 4.4).

Tests use httpx.AsyncClient with ASGITransport to hit the FastAPI app.
RED: Written before implementation.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import AzureOpenAIConfig, BedrockConfig, OllamaConfig, Settings
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry

# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_provider(*, delay: float = 0.0, exc: Exception | None = None):
    """Create a mock provider with controllable latency and failure."""
    p = AsyncMock()

    async def _generate(*args, **kwargs):
        if delay:
            await asyncio.sleep(delay)
        if exc:
            raise exc
        return "ok", {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15}

    p.generate = AsyncMock(side_effect=_generate)
    p.health_check = AsyncMock(return_value=True)
    return p


def _make_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.PENDING, provider="test", model="m",
    ))
    tm.update_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.RUNNING, provider="test", model="m",
    ))
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _build_app(settings, registry, task_manager, *, semaphores=None):
    from smr_v2.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.settings = settings
    if semaphores is not None:
        app.state.provider_semaphores = semaphores
    return app


# ── Config field tests ───────────────────────────────────────────────────────


class TestMaxConcurrentConfigFields:
    """Verify AzureOpenAIConfig and BedrockConfig have max_concurrent."""

    def test_azure_has_max_concurrent(self):
        cfg = AzureOpenAIConfig()
        assert hasattr(cfg, "max_concurrent")
        assert cfg.max_concurrent == 10

    def test_bedrock_has_max_concurrent(self):
        cfg = BedrockConfig()
        assert hasattr(cfg, "max_concurrent")
        assert cfg.max_concurrent == 10

    def test_ollama_has_max_concurrent(self):
        cfg = OllamaConfig()
        assert hasattr(cfg, "max_concurrent")
        assert cfg.max_concurrent == 4


# ── Concurrency metric tests ────────────────────────────────────────────────


class TestConcurrencyMetric:
    """Verify CONCURRENT_REQUESTS gauge exists."""

    def test_concurrent_requests_gauge_exists(self):
        from smr_v2.core.metrics import CONCURRENT_REQUESTS

        assert CONCURRENT_REQUESTS is not None
        assert CONCURRENT_REQUESTS._name == "smr_v2_concurrent_requests"


# ── Dependency tests ─────────────────────────────────────────────────────────


class TestSemaphoreDependency:
    """Verify get_provider_semaphores dependency."""

    def test_get_provider_semaphores_returns_dict(self):
        from smr_v2.core.dependencies import get_provider_semaphores

        mock_request = AsyncMock()
        mock_request.app.state.provider_semaphores = {"ollama": asyncio.Semaphore(2)}
        result = get_provider_semaphores(mock_request)
        assert "ollama" in result

    def test_get_provider_semaphores_defaults_to_empty(self):
        from smr_v2.core.dependencies import get_provider_semaphores

        mock_request = AsyncMock()
        del mock_request.app.state.provider_semaphores
        result = get_provider_semaphores(mock_request)
        assert result == {}


# ── Generate with semaphore tests ────────────────────────────────────────────


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1", port=5099, debug=True, log_level="debug",
        metrics_enabled=False,
    )


class TestGenerateWithinConcurrencyLimit:
    """Normal generation works when under the semaphore limit."""

    @pytest_asyncio.fixture
    async def client(self, settings):
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())
        semaphores = {"ollama": asyncio.Semaphore(5)}
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_generate_succeeds_within_concurrency_limit(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": "ollama"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["content"] == "ok"


class TestConcurrentRequestsLimitedBySemaphore:
    """When max_concurrent=1, only 1 request runs at a time; the second waits."""

    @pytest.mark.asyncio
    async def test_concurrent_requests_limited_by_semaphore(self, settings):
        concurrency_log: list[int] = []
        current_count = 0

        async def _tracked_generate(*args, **kwargs):
            nonlocal current_count
            current_count += 1
            concurrency_log.append(current_count)
            await asyncio.sleep(0.3)
            current_count -= 1
            return "ok", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        provider = AsyncMock()
        provider.generate = AsyncMock(side_effect=_tracked_generate)
        provider.health_check = AsyncMock(return_value=True)

        registry = ProviderRegistry()
        registry.register("ollama", provider)

        semaphores = {"ollama": asyncio.Semaphore(1)}
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            tasks = [
                c.post("/api/v1/generate", json={"prompt": "a", "provider": "ollama"}),
                c.post("/api/v1/generate", json={"prompt": "b", "provider": "ollama"}),
            ]
            responses = await asyncio.gather(*tasks)

        for resp in responses:
            assert resp.status_code in (200, 503)

        assert max(concurrency_log) <= 1, (
            f"Expected max concurrency 1, but saw {max(concurrency_log)}"
        )


class TestSemaphoreReleasedOnSuccess:
    """After successful generation, semaphore is released so next request proceeds."""

    @pytest.mark.asyncio
    async def test_semaphore_released_on_success(self, settings):
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())

        sem = asyncio.Semaphore(1)
        semaphores = {"ollama": sem}
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp1 = await c.post("/api/v1/generate", json={"prompt": "a", "provider": "ollama"})
            assert resp1.status_code == 200

            resp2 = await c.post("/api/v1/generate", json={"prompt": "b", "provider": "ollama"})
            assert resp2.status_code == 200

        assert sem._value == 1, "Semaphore should be fully released after both requests"


class TestSemaphoreReleasedOnFailure:
    """After failed generation, semaphore is released."""

    @pytest.mark.asyncio
    async def test_semaphore_released_on_failure(self, settings):
        registry = ProviderRegistry()
        registry.register("broken", _make_provider(exc=RuntimeError("GPU OOM")))

        sem = asyncio.Semaphore(1)
        semaphores = {"broken": sem}
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/v1/generate", json={"prompt": "a", "provider": "broken"})
            assert resp.status_code == 502

        assert sem._value == 1, "Semaphore must be released even after provider failure"


class TestSemaphoreTimeoutReturns503:
    """When semaphore can't be acquired within timeout, returns 503."""

    @pytest.mark.asyncio
    async def test_semaphore_timeout_returns_503(self, settings):
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider(delay=5.0))

        sem = asyncio.Semaphore(1)
        await sem.acquire()  # exhaust the semaphore

        semaphores = {"ollama": sem}
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", timeout=10.0) as c:
            resp = await c.post("/api/v1/generate", json={"prompt": "a", "provider": "ollama"})

        assert resp.status_code == 503
        assert "concurrent" in resp.json()["detail"].lower()

        sem.release()  # cleanup


class TestNoSemaphoreAllowsUnlimited:
    """When no semaphore for provider, all requests proceed without limit."""

    @pytest.mark.asyncio
    async def test_no_semaphore_allows_unlimited(self, settings):
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())

        semaphores = {}  # no semaphore for ollama
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            tasks = [
                c.post("/api/v1/generate", json={"prompt": f"q{i}", "provider": "ollama"})
                for i in range(5)
            ]
            responses = await asyncio.gather(*tasks)

        for resp in responses:
            assert resp.status_code == 200


class TestSemaphoresPerProvider:
    """Each provider has independent semaphore limits."""

    @pytest.mark.asyncio
    async def test_semaphores_per_provider(self, settings):
        concurrency_a: list[int] = []
        concurrency_b: list[int] = []
        count_a = 0
        count_b = 0

        async def _gen_a(*args, **kwargs):
            nonlocal count_a
            count_a += 1
            concurrency_a.append(count_a)
            await asyncio.sleep(0.2)
            count_a -= 1
            return "a", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        async def _gen_b(*args, **kwargs):
            nonlocal count_b
            count_b += 1
            concurrency_b.append(count_b)
            await asyncio.sleep(0.2)
            count_b -= 1
            return "b", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        provider_a = AsyncMock()
        provider_a.generate = AsyncMock(side_effect=_gen_a)
        provider_a.health_check = AsyncMock(return_value=True)

        provider_b = AsyncMock()
        provider_b.generate = AsyncMock(side_effect=_gen_b)
        provider_b.health_check = AsyncMock(return_value=True)

        registry = ProviderRegistry()
        registry.register("ollama", provider_a)
        registry.register("azure", provider_b)

        semaphores = {
            "ollama": asyncio.Semaphore(1),
            "azure": asyncio.Semaphore(2),
        }
        app = _build_app(settings, registry, _make_task_manager(), semaphores=semaphores)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            tasks = [
                c.post("/api/v1/generate", json={"prompt": "a1", "provider": "ollama"}),
                c.post("/api/v1/generate", json={"prompt": "a2", "provider": "ollama"}),
                c.post("/api/v1/generate", json={"prompt": "b1", "provider": "azure"}),
                c.post("/api/v1/generate", json={"prompt": "b2", "provider": "azure"}),
            ]
            responses = await asyncio.gather(*tasks)

        for resp in responses:
            assert resp.status_code in (200, 503)

        if concurrency_a:
            assert max(concurrency_a) <= 1
        if concurrency_b:
            assert max(concurrency_b) <= 2


class TestCreateAppInitializesSemaphores:
    """create_app() must initialize provider_semaphores to {} for backward compat."""

    def test_create_app_sets_provider_semaphores(self, settings):
        from smr_v2.main import create_app

        app = create_app(settings_override=settings)
        assert hasattr(app.state, "provider_semaphores")
        assert app.state.provider_semaphores == {}
