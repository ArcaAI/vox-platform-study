"""Shared test fixtures for smr."""

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

from text.core.config import Settings

# Test-environment isolation (same defect class fixed in
# apps/tts/src/tts/tests/conftest.py).
#
# `smr/main.py` ends with a module-level `app = create_app()`, which the
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

_C = TypeVar("_C")


def keyed(config: _C, key: str = "test-key") -> _C:
    """Return a copy of a cloud provider config with an explicit ``api_key``.

    the cloud configs (Azure OpenAI / OpenAI / Anthropic) are BYOK-only
    — ``api_key`` is no longer name- or env-populatable, so tests can no longer
    pass ``api_key=`` to the constructor. This mirrors exactly how the gateway/
    router applies a credential in production: ``model_copy(update=...)`` sets the
    field without re-opening a validation/env path. Use for any test that needs a
    provider built with a live platform key.
    """
    return config.model_copy(update={"api_key": SecretStr(key)})


@pytest.fixture
def settings() -> Settings:
    """Default test settings with all providers disabled."""
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        cors_origins=["http://localhost:8868/api/v1"],
    )


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
