"""Shared test fixtures for text."""

from __future__ import annotations

import importlib
import os
from collections.abc import AsyncGenerator
from typing import TypeVar
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import InternalAccessConfig, Settings
from text.models.requests import GenerateRequest, ProviderOverride

_R = TypeVar("_R", bound=GenerateRequest)

# Test-environment isolation (same defect class fixed in
# apps/tts/src/tts/tests/conftest.py).
#
# `text/main.py` ends with a module-level `app = create_app()`, which the
# uvicorn/Docker entrypoint (`uvicorn text.main:app`) legitimately relies on.
# That call runs the real `get_settings()`, which loads this machine's
# gitignored `.env.dev` into `os.environ` via `hope_env.load_env()` — a
# permanent mutation of the process environment, not scoped to a test.
#
# pytest imports every conftest.py during collection, BEFORE any test or
# fixture runs, so a plain `from text.main import create_app` here was enough to
# leak a live `TEXT_SERVICE_TOKEN` into the whole session. Every request the
# suite then made through the auth middleware got a real token expectation and
# returned `401 Invalid or missing service token` — 134 failures across the
# unit suite, all with the same root cause and none of them about the code
# under test.
#
# This was LATENT, not new: it only surfaced when the trace-helper
# refactor changed the import graph enough to alter collection order. Fixing
# the leak here removes the ordering dependency entirely.
#
# Every fixture below passes an explicit Settings override, so nothing here
# needs `.env.dev` loaded — the import is only for the `create_app` symbol.
_env_before_main_import = dict(os.environ)
create_app = importlib.import_module("text.main").create_app
os.environ.clear()
os.environ.update(_env_before_main_import)

# The same defect, one layer up. Restoring `os.environ` above un-does the import-time load, but
# every `Settings()` a fixture builds calls `hope_env.load_env()` again and re-reads `.env.test`
# — so a token in that file still reaches the middleware, and the suite 401s exactly as it did
# before. The env-file contract is "host env > file: the file never overwrites a variable already
# in the environment", so PINNING these empty here is what makes the whole session genuinely
# tokenless, whatever a given fixture forgets to override.
#
# Auth-specific suites (`test_auth_middleware.py`, `test_health_metrics.py`) pass an explicit
# token to their own `Settings`, which still wins — this only removes the ambient one.
for _token_var in ("INTERNAL_ACCESS_TOKEN", "SERVICE_TOKEN"):
    os.environ[_token_var] = ""

def connection(
    key: str = "test-key",
    *,
    base_url: str | None = None,
    region: str | None = None,
    project: str | None = None,
    location: str | None = None,
    model: str | None = None,
    api_version: str | None = None,
    deployment_name: str | None = None,
    funding: str = "tenant",
    **extra: object,
) -> ProviderOverride:
    """One resolved `AiProviderConnection` row, as the gateway injects it.

    The successor to the old ``keyed(config)`` helper. That helper set an
    ``api_key`` on a provider's pydantic config, which was the only way a test
    could give an adapter a working credential — and it worked because the
    adapter had a process-wide config to put one on. Since TASK-799 lane B it has
    none: endpoint, credential and routing all arrive per request, so a test
    supplies them the same way production does.
    """
    return ProviderOverride(
        api_key=SecretStr(key),
        base_url=base_url,
        region=region,
        project=project,
        location=location,
        model=model,
        api_version=api_version,
        deployment_name=deployment_name,
        funding=funding,  # type: ignore[arg-type]
        **extra,  # type: ignore[arg-type]
    )


def connected(request: _R, provider: str | None = None, **kwargs: object) -> _R:
    """Attach a resolved connection for ``request``'s provider.

    The request-level counterpart of `connection`: the single call a test makes
    to say "the gateway resolved a connection for this provider", which is the
    precondition for EVERY generation now that no adapter carries an endpoint of
    its own.
    """
    name = provider or getattr(request, "provider", "")
    return request.model_copy(  # type: ignore[return-value]
        update={"provider_overrides": {name: connection(**kwargs)}}  # type: ignore[arg-type]
    )



def stub_client(provider, client):
    """Bind ``client`` as the SDK client this provider builds for every request.

    Adapter tests that exercise the WIRE (message shape, streaming, structured
    output) are not about connection resolution, and since TASK-799 lane B there
    is no process-wide client to assign — the client is built per request from
    the injected connection. This says "assume a connection resolved, and it
    produced this client".

    Deliberately the only such shortcut. The connection contract itself —
    fail-closed on absence, request-scoped so two tenants cannot share one,
    funding derived from the row — is covered against the REAL resolution path by
    `test_task602_byok_credentials.py` and `test_provider_overrides.py`.
    """
    provider._client_for = lambda _request: client
    provider._client = client
    return client


def stub_endpoint(provider, url: str = "http://engine.local"):
    """Bind ``url`` as the engine endpoint this self-host provider resolves.

    The self-host counterpart of `stub_client`: an adapter's `base_url` now comes
    from the injected connection, so a test about the WIRE (request body, stream
    parsing, retention hints) says "assume a connection resolved, and it pointed
    here". Also seeds the probe memo so `health_check`/`get_info` have something
    to reach.
    """
    provider._endpoint = lambda _request: url
    provider._last_base_url = url
    return url

@pytest.fixture
def settings() -> Settings:
    """Default test settings with service auth off.

    The token is pinned empty on purpose. `Settings` reads it from the environment, so whatever
    the loaded `.env.test` carries would turn every suite-issued request into a 401 before its
    handler ran. These suites exercise handler behaviour and send no `X-Service-Token`, so
    "auth disabled" is the state they have always assumed; it just used to be true by accident
    (an unset token) rather than by declaration.

    There is no longer a "providers disabled" dimension to configure: a provider's availability
    is not an env setting, and every adapter fails closed until a connection is injected with the
    request (see `connection` / `connected` above).

    Tests that are ABOUT auth (`test_auth_middleware.py`, `test_health_metrics.py`) build their
    own `Settings` with an explicit token and are unaffected.
    """
    return Settings(port=5099, log_level="debug", # `internal_access_token` is a read-only property over this nested config, so the shared
        # token is cleared HERE — passing it as a kwarg is an `extra_forbidden` error.
        internal_access=InternalAccessConfig(token=SecretStr("")))


@pytest.fixture
def mock_redis():
    """Mock Redis client that responds to ping()."""
    redis = AsyncMock()
    redis.ping = AsyncMock(return_value=True)
    return redis


@pytest.fixture
def app(settings: Settings, mock_redis):
    """Create a test FastAPI app with mock Redis."""
    application = create_app()
    application.state.settings = settings
    application.state.redis = mock_redis
    return application


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client for testing endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


# ── TASK-737 — default `X-Tenant-Id` on suite-issued requests ────────────────
#
# `X-Tenant-Id` is MANDATORY on every internal request carrying tenant-scoped
# work (owner directive 2026-08-16), and `POST /api/v1/generate` now ENFORCES it
# with 428. Every real caller sends it.
#
# The suite's ~110 pre-existing `/generate` calls, however, are about retries,
# queueing, circuit breakers, metrics and provider selection — none of them are
# about the tenant contract, and none set the header. Without a default they all
# fail 428 for a reason unrelated to what they assert, which is exactly the
# false-signal failure mode the leaked-`TEXT_SERVICE_TOKEN` note at the top of
# this file describes: 134 failures, one root cause, none about the code under
# test. So the harness supplies a tenant the way a real gateway would.
#
# It is a DEFAULT, never an override: a test that sets the header (or sets it to
# a `tenantless:` marker) keeps its own value, so the contract stays assertable.
# A test that must send NO header — i.e. the one asserting the 428 itself —
# opts out with `@pytest.mark.no_default_tenant_header`.
_TEST_TENANT_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _default_tenant_header(request, monkeypatch):
    """Attach a default `X-Tenant-Id` to every httpx request the suite makes."""
    if request.node.get_closest_marker("no_default_tenant_header"):
        return

    original = AsyncClient.request

    async def with_tenant(self, method, url, **kwargs):
        headers = kwargs.get("headers") or {}
        # Case-insensitive check: an explicit header from the test always wins.
        if not any(k.lower() == "x-tenant-id" for k in headers):
            headers = {**headers, "X-Tenant-Id": _TEST_TENANT_ID}
            kwargs["headers"] = headers
        return await original(self, method, url, **kwargs)

    monkeypatch.setattr(AsyncClient, "request", with_tenant)
