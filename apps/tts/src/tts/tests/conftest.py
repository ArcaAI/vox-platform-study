"""Shared test fixtures for tts."""

from __future__ import annotations

import importlib
import os
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree
from httpx import ASGITransport, AsyncClient

from tts.core.config import Settings

assert_source_tree(["tts", "hope_env", "hope_runtime_models"], __file__)

# `tts.main` builds a module-level `app = create_app()` for the uvicorn
# entrypoint (`uvicorn tts.main:app` — see apps/tts/Dockerfile and
# scripts/dev-service.sh's tts case). That call runs the real
# `get_settings()`, which loads this machine's gitignored `.env.dev` into
# `os.environ` via `hope_env.load_env()` — a real, permanent mutation of the
# process environment, not scoped to a test or a fixture. Because pytest
# imports every conftest.py during collection (before any test or fixture
# runs), simply having `from tts.main import create_app` at module level here
# was enough to leak the developer's real secrets (e.g. a live
# `TTS_SERVICE_TOKEN`) into the rest of the pytest session — breaking tests
# like `test_config.py::TestDefaults::test_service_token_empty_by_default`
# whenever collection order put them after this import.
#
# Every fixture below passes an explicit `settings_override`, so nothing here
# actually needs `.env.dev` loaded — the import is only for the `create_app`
# symbol. Snapshotting and restoring `os.environ` around the import undoes
# that one-time side effect without touching `tts/main.py` itself, so the
# uvicorn/Docker entrypoint (which legitimately wants `get_settings()` to
# read the real environment) is untouched.
_env_before_main_import = dict(os.environ)
create_app = importlib.import_module("tts.main").create_app
os.environ.clear()
os.environ.update(_env_before_main_import)


@pytest.fixture
def settings() -> Settings:
    """Default test settings (auth disabled)."""
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def app(settings: Settings):
    """Create a test FastAPI app."""
    return create_app(settings_override=settings)


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client bound to the test app via ASGI transport."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
