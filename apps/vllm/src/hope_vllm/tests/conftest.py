"""Shared fixtures for vllm.

Nothing here needs a GPU or `vllm`: the app is always built with an injected
engine factory (``tests/fakes.py``), and the real vLLM adapter is exercised
against a stand-in ``vllm`` module (``test_vllm_backend.py``).
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator

import numpy as np
import pytest
import pytest_asyncio

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree
from httpx import ASGITransport, AsyncClient

assert_source_tree(["hope_vllm", "hope_env", "hope_obs"], __file__)

from hope_vllm.core.config import Settings  # noqa: E402
from hope_vllm.main import create_app  # noqa: E402
from hope_vllm.tests.fakes import FakeEngineFactory  # noqa: E402

TENANT_ID = "50000000-0000-0000-0000-000000000000"
SAMPLE_RATE = 16_000


def pcm16_b64(seconds: float, *, amplitude: float = 0.3, freq_hz: float = 220.0) -> str:
    """A PCM16 LE mono 16 kHz tone, base64-encoded — the request's audio encoding."""
    n = int(round(seconds * SAMPLE_RATE))
    t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
    wave = (amplitude * np.sin(2 * np.pi * freq_hz * t) * 32767).astype("<i2")
    return base64.b64encode(wave.tobytes()).decode("ascii")


SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: Pass as an override value to REMOVE that key from the payload ("missing", not null).
DROP = object()

#: Overrides that land on `engine`; every other override lands on the spec itself.
_ENGINE_KEYS = frozenset({"vramGiB", "maxNumSeqs", "enforceEager"})

#: The default runtime key of :func:`serving_spec_payload`.
RUNTIME_KEY = "model-0001:v1"


def serving_spec_payload(**overrides: object) -> dict[str, object]:
    """A `ResolvedServingSpec` as the gateway emits it (camelCase, C-1) — every key present.

    ``vramGiB`` / ``maxNumSeqs`` / ``enforceEager`` overrides land on ``engine``; every other
    override lands on the spec; ``DROP`` removes a key.
    """
    engine: dict[str, object] = {"vramGiB": 3, "maxNumSeqs": 64, "enforceEager": None}
    payload: dict[str, object] = {
        "slug": "arcaai-whisper-large-ml-en-vllm",
        "kind": "asr",
        "runtimeKey": RUNTIME_KEY,
        "tenantId": SYSTEM_TENANT_ID,
        "localPath": "/mnt/models-bucket/hf/whisper-turbo-ml-en-fp16",
        "sourceUri": "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16",
        "sourceRevision": "main",
        "checksum": None,
        "format": "SAFETENSOR",
        "computeType": "float16",
        "quantization": None,
        "maxModelLen": None,
        "engine": engine,
    }
    for key, value in overrides.items():
        target = engine if key in _ENGINE_KEYS else payload
        if value is DROP:
            target.pop(key, None)
        else:
            target[key] = value
    return payload


def transcription_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "spec": serving_spec_payload(),
        "audio_b64": pcm16_b64(7.0),
        "language": "ml",
    }
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def _no_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """No unit test may reach a real gateway: a blank URL builds no control-plane client.

    Tests that exercise the control plane inject their own client over a mock transport.
    """
    monkeypatch.setenv("VLLM_API_GATEWAY_URL", "")
    monkeypatch.delenv("REDIS_URL", raising=False)


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
def app(settings: Settings, factory: FakeEngineFactory):  # type: ignore[no-untyped-def]
    return create_app(settings, engine_factory=factory)


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:  # type: ignore[no-untyped-def]
    """ASGI client with the lifespan RUN (startup marker, pool shutdown)."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
