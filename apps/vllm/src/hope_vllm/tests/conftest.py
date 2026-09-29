"""Shared fixtures for vllm.

Nothing here needs a GPU or `vllm`: the app is always built with an injected
engine factory (``tests/fakes.py``), and the real vLLM adapter is exercised
against a stand-in ``vllm`` module (``test_vllm_backend.py``).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree
from httpx import ASGITransport, AsyncClient

assert_source_tree(["hope_vllm", "hope_env", "hope_obs"], __file__)

from hope_vllm.core.config import Settings  # noqa: E402
from hope_vllm.main import create_app  # noqa: E402
from hope_vllm.tests.fakes import FakeEngineFactory, FakeSpecResolver  # noqa: E402
from hope_vllm.tests.payloads import (  # noqa: E402
    DROP,
    RUNTIME_KEY,
    SAMPLE_RATE,
    SLUG,
    SYSTEM_TENANT_ID,
    TENANT_ID,
    serving_spec_payload,
    wav_bytes,
)

__all__ = [
    "DROP",
    "RUNTIME_KEY",
    "SAMPLE_RATE",
    "SLUG",
    "SYSTEM_TENANT_ID",
    "TENANT_ID",
    "serving_spec_payload",
    "wav_bytes",
    "HEADERS",
    "transcription_form",
]


#: The headers every `/v1/*` call carries (auth is bypassed by the `settings` fixture).
HEADERS = {"X-Tenant-Id": TENANT_ID}


def transcription_form(
    *, audio: bytes | None = None, **fields: object
) -> tuple[dict[str, str], dict[str, tuple[str, bytes, str]]]:
    """`(data, files)` for `POST /v1/audio/transcriptions` — 7 s of 16 kHz WAV, `ml`.

    A field set to ``None`` is left out of the form.
    """
    data: dict[str, object] = {"model": SLUG, "language": "ml", **fields}
    form = {key: str(value) for key, value in data.items() if value is not None}
    wav = wav_bytes(7.0) if audio is None else audio
    return form, {"file": ("window.wav", wav, "audio/wav")}


@pytest.fixture(autouse=True)
def _no_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """No unit test may reach a real gateway: a blank URL builds no control-plane client.

    Tests that exercise the control plane inject their own client over a mock transport.
    """
    monkeypatch.setenv("VLLM_API_GATEWAY_URL", "")
    for name in ("REDIS_URL", "VLLM_POOL", "HF_HUB_OFFLINE"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Explicit settings — local environment, no token configured (auth bypassed)."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.setenv("NODE_ENV", "test")
    return Settings()


@pytest.fixture
def factory() -> FakeEngineFactory:
    return FakeEngineFactory()


@pytest.fixture
def resolver() -> FakeSpecResolver:
    return FakeSpecResolver()


@pytest.fixture
def app(settings: Settings, factory: FakeEngineFactory, resolver: FakeSpecResolver):  # type: ignore[no-untyped-def]
    return create_app(settings, engine_factory=factory, serving_spec_client=resolver)


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:  # type: ignore[no-untyped-def]
    """ASGI client with the lifespan RUN (startup marker, pool shutdown)."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
