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

from text.core.config import Settings
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry

# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_provider(*, delay: float = 0.0, exc: Exception | None = None):
    """Create a mock provider with controllable latency and failure."""
    p = AsyncMock()

    async def _generate(*args, **kwargs):
        if delay:
            await asyncio.sleep(delay)
        if exc:
            raise exc
        return "ok", "", {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15}

    p.generate = AsyncMock(side_effect=_generate)
    p.health_check = AsyncMock(return_value=True)
    return p


def _make_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="t-1",
            status=TaskStatus.PENDING,
            provider="test",
            model="m",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="t-1",
            status=TaskStatus.RUNNING,
            provider="test",
            model="m",
        )
    )
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _build_app(settings, registry, task_manager, *, semaphores=None):
    from text.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.settings = settings
    if semaphores is not None:
        app.state.provider_semaphores = semaphores
    return app


# ── Config field tests ───────────────────────────────────────────────────────


class TestMaxConcurrentIsAControlPlaneValue:
    """Per-provider capacity is an `AiRuntimeProfile` row, not an env field.

    Ten providers carried ten `*_MAX_CONCURRENT` defaults and none of the
    variation was a decision anyone made. What remains in code is one
    resource-safety FLOOR, and the control plane moves the LIVE semaphore — so a
    saturating provider can be given more headroom without a restart.
    """

    def test_no_provider_declares_max_concurrent_in_settings(self):
        from pydantic import BaseModel

        from text.core.config import Settings

        def walk(model: type[BaseModel], prefix: str = "") -> list[str]:
            out: list[str] = []
            for name, field in model.model_fields.items():
                annotation = field.annotation
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    out.extend(walk(annotation, f"{prefix}{name}."))
                else:
                    out.append(f"{prefix}{name}")
            return out

        assert [f for f in walk(Settings) if f.endswith("max_concurrent")] == []

    def test_the_floor_seeds_every_registered_provider(self):
        from unittest.mock import MagicMock as _MagicMock

        from text.core.runtime_defaults import USER_LANE_FLOOR
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry
        from text.services.resizable_semaphore import ResizableSemaphore

        registry = ProviderRegistry()
        _register_provider_factories(registry, _MagicMock())
        semaphores = {
            name: ResizableSemaphore(USER_LANE_FLOOR.max_concurrent)
            for name in registry.list_providers()
        }
        assert semaphores
        assert all(s.limit == USER_LANE_FLOOR.max_concurrent for s in semaphores.values())

    def test_a_served_limit_moves_the_live_semaphore(self):
        from text.core.effective_config import EffectiveConfigSnapshot
        from text.services.resizable_semaphore import ResizableSemaphore
        from text.services.runtime_limits import apply_provider_limits

        semaphores = {"azure-openai": ResizableSemaphore(4)}
        snapshot = EffectiveConfigSnapshot(
            raw={
                "runtimeProfiles": [
                    {"provider": "azure-openai", "modelSlug": "", "maxConcurrent": 10}
                ]
            },
            ok=True,
        )
        apply_provider_limits(snapshot, semaphores, {})
        assert semaphores["azure-openai"].limit == 10


# ── Concurrency metric tests ────────────────────────────────────────────────


class TestConcurrencyMetric:
    """Verify CONCURRENT_REQUESTS gauge exists."""

    def test_concurrent_requests_gauge_exists(self):
        from text.core.metrics import CONCURRENT_REQUESTS

        assert CONCURRENT_REQUESTS is not None
        assert CONCURRENT_REQUESTS._name == "text_concurrent_requests"


# ── Dependency tests ─────────────────────────────────────────────────────────


class TestSemaphoreDependency:
    """Verify get_provider_semaphores dependency."""

    def test_get_provider_semaphores_returns_dict(self):
        from text.core.dependencies import get_provider_semaphores

        mock_request = AsyncMock()
        mock_request.app.state.provider_semaphores = {"ollama": asyncio.Semaphore(2)}
        result = get_provider_semaphores(mock_request)
        assert "ollama" in result

    def test_get_provider_semaphores_defaults_to_empty(self):
        from text.core.dependencies import get_provider_semaphores

        mock_request = AsyncMock()
        del mock_request.app.state.provider_semaphores
        result = get_provider_semaphores(mock_request)
        assert result == {}


# ── Generate with semaphore tests ────────────────────────────────────────────


@pytest.fixture
def settings():
    return Settings(port=5099, log_level="debug")


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
            json={"prompt": "hello", "provider": "ollama", "model": "test-model"},
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
            return "ok", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

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
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "a", "provider": "ollama", "model": "test-model"},
                ),
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "b", "provider": "ollama", "model": "test-model"},
                ),
            ]
            responses = await asyncio.gather(*tasks)

        for resp in responses:
            assert resp.status_code in (200, 503)

        assert (
            max(concurrency_log) <= 1
        ), f"Expected max concurrency 1, but saw {max(concurrency_log)}"


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
            resp1 = await c.post(
                "/api/v1/generate",
                json={"prompt": "a", "provider": "ollama", "model": "test-model"},
            )
            assert resp1.status_code == 200

            resp2 = await c.post(
                "/api/v1/generate",
                json={"prompt": "b", "provider": "ollama", "model": "test-model"},
            )
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
            resp = await c.post(
                "/api/v1/generate",
                json={"prompt": "a", "provider": "broken", "model": "test-model"},
            )
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
            resp = await c.post(
                "/api/v1/generate",
                json={"prompt": "a", "provider": "ollama", "model": "test-model"},
            )

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
                c.post(
                    "/api/v1/generate",
                    json={"prompt": f"q{i}", "provider": "ollama", "model": "test-model"},
                )
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
            return "a", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        async def _gen_b(*args, **kwargs):
            nonlocal count_b
            count_b += 1
            concurrency_b.append(count_b)
            await asyncio.sleep(0.2)
            count_b -= 1
            return "b", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

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
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "a1", "provider": "ollama", "model": "test-model"},
                ),
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "a2", "provider": "ollama", "model": "test-model"},
                ),
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "b1", "provider": "azure", "model": "test-model"},
                ),
                c.post(
                    "/api/v1/generate",
                    json={"prompt": "b2", "provider": "azure", "model": "test-model"},
                ),
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
        from text.main import create_app

        app = create_app(settings_override=settings)
        assert hasattr(app.state, "provider_semaphores")
        assert app.state.provider_semaphores == {}
