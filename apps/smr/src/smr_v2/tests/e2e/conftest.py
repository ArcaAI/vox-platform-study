"""E2E test fixtures — real LLM providers, fakeredis for task storage.

Creates a fully wired FastAPI app that talks to real Ollama and/or
Azure OpenAI endpoints while using fakeredis for Redis-backed task
management (we're testing LLM integration, not Redis).
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator

import fakeredis.aioredis
import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.main import create_app
from smr_v2.providers.base import ProviderRegistry
from smr_v2.services.task_manager import TaskManager


def _load_env_file() -> dict[str, str]:
    """Read the monorepo root .env and return key-value pairs."""
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "..", ".env")
    env_path = os.path.normpath(env_path)
    values: dict[str, str] = {}
    if not os.path.exists(env_path):
        return values
    with open(env_path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line and ":" not in line:
                continue
            sep = "=" if "=" in line else ":"
            key, _, val = line.partition(sep)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            values[key] = val
    return values


def _apply_env_overrides() -> None:
    """Map monorepo .env vars to SMR_V2_* prefixed env vars."""
    dotenv = _load_env_file()

    os.environ["SMR_V2_SERVICE_TOKEN"] = ""
    os.environ["SMR_V2_METRICS_ENABLED"] = "false"
    os.environ["SMR_V2_OTEL_ENABLED"] = "false"

    ollama_url = dotenv.get("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model = dotenv.get("OLLAMA_MODEL", "gemma3:latest")
    os.environ["SMR_V2_OLLAMA_BASE_URL"] = ollama_url
    os.environ["SMR_V2_OLLAMA_DEFAULT_MODEL"] = ollama_model
    os.environ["SMR_V2_OLLAMA_TIMEOUT_S"] = "120"

    azure_key = dotenv.get("AZURE_OPENAI_API_KEY", "")
    azure_endpoint = dotenv.get("AZURE_OPENAI_ENDPOINT", "")
    azure_model = dotenv.get("AZURE_OPENAI_MODEL", "gpt-4o-mini")
    azure_deployment = dotenv.get("AZURE_OPENAI_DEPLOYMENT_NAME", "")
    azure_api_version = dotenv.get("AZURE_OPENAI_API_VERSION", "2024-02-01")

    if azure_key and azure_endpoint:
        os.environ["SMR_V2_AZURE_API_KEY"] = azure_key
        os.environ["SMR_V2_AZURE_ENDPOINT"] = azure_endpoint
        os.environ["SMR_V2_AZURE_DEFAULT_MODEL"] = azure_model
        os.environ["SMR_V2_AZURE_DEPLOYMENT_NAME"] = azure_deployment
        os.environ["SMR_V2_AZURE_API_VERSION"] = azure_api_version
        os.environ["SMR_V2_AZURE_TIMEOUT_S"] = "120"

    lm_studio_url = dotenv.get("LM_STUDIO_BASE_URL", "http://localhost:1234/v1")
    lm_studio_model = dotenv.get("LM_STUDIO_MODEL", "qwen3.5-4b")
    os.environ["SMR_V2_OPENAI_COMPAT_BASE_URL"] = lm_studio_url
    os.environ["SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL"] = lm_studio_model
    os.environ["SMR_V2_OPENAI_COMPAT_TIMEOUT_S"] = "120"


_apply_env_overrides()


@pytest.fixture(scope="session")
def ollama_base_url() -> str:
    return os.environ.get("SMR_V2_OLLAMA_BASE_URL", "http://localhost:11434")


@pytest.fixture(scope="session")
def azure_api_key() -> str:
    return os.environ.get("SMR_V2_AZURE_API_KEY", "")


@pytest.fixture(scope="session")
def ollama_reachable(ollama_base_url: str) -> bool:
    """Check if Ollama is reachable; skip the test if not."""
    try:
        resp = httpx.get(f"{ollama_base_url}/api/tags", timeout=5.0)
        return resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException, OSError):
        return False


@pytest.fixture(scope="session")
def azure_credentials_valid(azure_api_key: str) -> bool:
    """Check if Azure OpenAI credentials are present."""
    return bool(azure_api_key)


@pytest.fixture(autouse=False)
def require_ollama(ollama_reachable: bool) -> None:
    """Skip the test when Ollama is not reachable."""
    if not ollama_reachable:
        pytest.skip("Ollama is not reachable — skipping E2E test")


@pytest.fixture(autouse=False)
def require_azure(azure_credentials_valid: bool) -> None:
    """Skip the test when Azure OpenAI credentials are missing."""
    if not azure_credentials_valid:
        pytest.skip("Azure OpenAI credentials not configured — skipping E2E test")


@pytest.fixture(scope="session")
def lm_studio_base_url() -> str:
    return os.environ.get("SMR_V2_OPENAI_COMPAT_BASE_URL", "http://localhost:1234/v1")


@pytest.fixture(scope="session")
def lm_studio_reachable(lm_studio_base_url: str) -> bool:
    """Check if LM Studio is reachable."""
    try:
        resp = httpx.get(f"{lm_studio_base_url}/models", timeout=5.0)
        return resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException, OSError):
        return False


@pytest.fixture(autouse=False)
def require_lm_studio(lm_studio_reachable: bool) -> None:
    """Skip the test when LM Studio is not reachable."""
    if not lm_studio_reachable:
        pytest.skip("LM Studio is not reachable — skipping E2E test")


@pytest_asyncio.fixture
async def e2e_redis() -> AsyncGenerator:
    """Fakeredis client for E2E tests (we only need real LLM calls, not Redis)."""
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield client
    await client.aclose()


def _create_e2e_app(redis) -> tuple:
    """Wire up a real app with real providers, backed by fakeredis.

    ASGITransport does not trigger the FastAPI lifespan, so we manually
    initialise the provider registry, rate limiters, circuit breakers,
    semaphores, and other state that the lifespan would normally set up.
    """
    import asyncio

    from smr_v2.services.circuit_breaker import CircuitBreaker
    from smr_v2.services.provider_queue import ProviderQueue
    from smr_v2.services.rate_limiter import RateLimitTracker
    from smr_v2.services.shutdown_manager import ShutdownManager

    settings = Settings()
    app = create_app(settings_override=settings)

    app.state.redis = redis
    app.state.task_manager = TaskManager(
        redis=redis,
        task_ttl=3600,
        stream_max_len=10_000,
    )

    http_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    app.state.http_client = http_client

    registry = ProviderRegistry()

    # providers are gated by CONNECTION config, not an ENABLE flag.
    if settings.ollama.base_url:
        from smr_v2.providers.ollama import OllamaProvider
        registry.register("ollama", OllamaProvider(settings.ollama, http_client))

    if settings.azure.endpoint and settings.azure.api_key.get_secret_value():
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider_instance = AzureOpenAIProvider(settings.azure)
        registry.register("azure-openai", provider_instance)
        registry.register("azure", provider_instance)

    if settings.openai_compat.base_url:
        from smr_v2.providers.openai_compat import OpenAICompatProvider
        provider_instance = OpenAICompatProvider(settings.openai_compat)
        registry.register("lm-studio", provider_instance)
        registry.register("openai_compat", provider_instance)

    app.state.provider_registry = registry

    provider_configs = {
        "ollama": settings.ollama,
        "azure-openai": settings.azure,
        "azure": settings.azure,
        "bedrock": settings.bedrock,
        "lm-studio": settings.openai_compat,
        "openai_compat": settings.openai_compat,
    }

    rate_limiters: dict[str, RateLimitTracker] = {}
    queues: dict[str, ProviderQueue] = {}
    cbs: dict[str, CircuitBreaker] = {}
    sems: dict[str, asyncio.Semaphore] = {}
    cb_cfg = settings.circuit_breaker

    for name in registry.list_providers():
        cfg = provider_configs.get(name)
        rpm = getattr(cfg, "rpm_limit", 0) if cfg else 0
        tpm = getattr(cfg, "tpm_limit", 0) if cfg else 0
        rate_limiters[name] = RateLimitTracker(rpm_limit=rpm, tpm_limit=tpm)
        queues[name] = ProviderQueue(max_size=settings.queue.max_size)
        cbs[name] = CircuitBreaker(
            failure_threshold=cb_cfg.failure_threshold,
            recovery_timeout=cb_cfg.recovery_timeout_s,
        )
        max_conc = getattr(cfg, "max_concurrent", 10) if cfg else 10
        sems[name] = asyncio.Semaphore(max_conc)

    app.state.rate_limiters = rate_limiters
    app.state.provider_queues = queues
    app.state.circuit_breakers = cbs
    app.state.provider_semaphores = sems
    app.state.shutdown_manager = ShutdownManager()

    return app, settings


@pytest_asyncio.fixture
async def e2e_client(e2e_redis) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client wired to the real app with real providers."""
    app, _ = _create_e2e_app(e2e_redis)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await app.state.http_client.aclose()


@pytest_asyncio.fixture
async def e2e_client_and_app(e2e_redis) -> AsyncGenerator[tuple[AsyncClient, object], None]:
    """Async HTTP client + app reference for tests that need app.state."""
    app, _ = _create_e2e_app(e2e_redis)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, app
    await app.state.http_client.aclose()
