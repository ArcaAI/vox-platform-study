"""Shared test fixtures for the harness service."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree
from httpx import ASGITransport, AsyncClient

from harness.core.config import Settings
from harness.main import create_app

assert_source_tree(
    [
        "harness",
        "hope_env",
        "hope_runtime_models",
        "hope_workflow_contract",
        "hope_async_contract",
    ],
    __file__,
)


@pytest.fixture(autouse=True)
def _llm_governor_test_defaults(monkeypatch):
    """Neutralise the per-endpoint LLM governor for the unit suite.

    Production defaults add bounded rate-limit-aware retry + backoff to every LLM
    client; in unit tests a mocked 5xx is now "transient", so without this the
    existing client failure-path cases would retry+sleep for seconds. Force a single
    attempt with no backoff and a high concurrency cap so client tests behave exactly
    as before, and reset the (loop-bound) per-endpoint semaphores between tests. Tests
    that *specifically* exercise the governor pass an explicit ``config=`` (see
    ``tests/unit/core/test_llm_concurrency.py``) or set ``HARNESS_LLM_*`` themselves.
    """
    from harness.core.llm_concurrency import reset_endpoint_limiters

    monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_BASE_S", "0")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_JITTER_S", "0")
    monkeypatch.setenv("HARNESS_LLM_MAX_CONCURRENCY", "8")
    reset_endpoint_limiters()
    yield
    reset_endpoint_limiters()


@pytest.fixture(autouse=True)
def _byo_credentials_absent(monkeypatch):
    """TASK-799 lane B — the hermetic suite's BYO-credential posture is ABSENT.

    The judge and the retriever now resolve their credentials from the gateway's
    `AiProviderConnection` plane, INSIDE the activity that uses them. This suite
    is hermetic by contract (rule 06: "Temporal/LLM/reranker stubbed, Qdrant
    in-memory, no DB/Redis") — there is no gateway process and there are no
    connection rows, so without this every judge/retrieval test would fail closed
    on `UNAVAILABLE` while testing nothing about credentials.

    `ABSENT` is the TRUTHFUL hermetic answer, not a convenience: "no tier has an
    opinion" is exactly the state of a database that does not exist, and it is the
    same state a local unauthenticated LM Studio / dev Qdrant runs in. It is the
    same class of stub as the `_build_runtime_judge` / `_safety_screen_client`
    monkeypatches these tests already apply.

    It is deliberately NOT a blanket "credentials always succeed": `ABSENT` yields
    NO key, so a test that asserts a credential actually reaches a client has to
    say so explicitly. The FAIL-CLOSED paths (`DENIED` / `UNAVAILABLE`) are covered
    by tests that override this with their own `monkeypatch.setattr`, which runs
    after this fixture and therefore wins.
    """
    from harness.api.endpoints import knowledge
    from harness.core.provider_credentials import CredentialOutcome, ProviderCredential
    from harness.temporal import activities

    absent = ProviderCredential(outcome=CredentialOutcome.ABSENT)

    async def _absent(*_args, **_kwargs):
        return absent

    monkeypatch.setattr(activities, "_resolve_provider_credential", _absent)
    monkeypatch.setattr(knowledge, "_resolve_qdrant_credential", _absent)


@pytest.fixture
def settings() -> Settings:
    """Default test settings (process-local, no external dependencies)."""
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
    )


@pytest.fixture
def app(settings: Settings):
    """Create a test FastAPI app."""
    return create_app(settings_override=settings)


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client bound to the ASGI app for endpoint tests."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
