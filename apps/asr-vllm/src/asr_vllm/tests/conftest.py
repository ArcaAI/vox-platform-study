"""Shared fixtures for asr-vllm.

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

assert_source_tree(["asr_vllm", "hope_env", "hope_obs"], __file__)

from asr_vllm.core.config import Settings  # noqa: E402
from asr_vllm.main import create_app  # noqa: E402
from asr_vllm.tests.fakes import FakeEngineFactory  # noqa: E402

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

#: Overrides that land on the spec itself; every other override lands on `models.asr`.
_TOP_LEVEL_KEYS = frozenset({"runtimeKey", "schemaVersion"})


def asr_model_payload(**overrides: object) -> dict[str, object]:
    """One `AsrSpecModel` (the `models.asr` row) as the gateway emits it."""
    model: dict[str, object] = {
        "role": "asr",
        "slug": "arcaai-whisper-large-ml-en-vllm",
        "taskType": "AUTOMATIC_SPEECH_RECOGNITION",
        "format": "SAFETENSOR",
        "libraryName": "transformers",
        "sourceUri": "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16",
        "sourceRevision": "main",
        "localPath": "/mnt/models-bucket/hf/whisper-turbo-ml-en-fp16",
        "checksum": None,
        "computeType": "float16",
        "provider": None,
        "tenantId": SYSTEM_TENANT_ID,
        "metadata": {"maxDecodeWindowSec": 7},
    }
    for key, value in overrides.items():
        if value is DROP:
            model.pop(key, None)
        else:
            model[key] = value
    return model


def spec_payload(**overrides: object) -> dict[str, object]:
    """A `ResolvedAsrSpec` as the gateway emits it (camelCase), trimmed but real-shaped.

    ``runtimeKey`` / ``schemaVersion`` overrides land on the spec; every other override
    lands on ``models.asr``; ``DROP`` removes a key. The blocks this service ignores
    (`agent`, `audioFrontEnd`, `fallback`, …) are present so every test also proves they
    are tolerated.
    """
    model_overrides = {k: v for k, v in overrides.items() if k not in _TOP_LEVEL_KEYS}
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "runtimeKey": "agent-version-0001",
        "agent": {
            "slug": "ml-en-transcription",
            "versionId": "agent-version-0001",
            "versionNumber": 1,
            "tenantId": "50000000-0000-0000-0000-000000000000",
            "source": "tenant",
        },
        "models": {"asr": asr_model_payload(**model_overrides)},
        "audioFrontEnd": {
            "vad": {"enabled": False, "threshold": None, "minSpeechMs": None, "minSilenceMs": None},
            "denoise": {"enabled": False, "level": "off"},
            "diarization": {"enabled": False, "backend": "embedding", "maxSpeakers": None},
            "resample": True,
            "normalize": True,
        },
        "fallback": {"kind": "none", "autoSwitch": False, "chain": [], "spec": None},
    }
    for key in _TOP_LEVEL_KEYS & overrides.keys():
        if overrides[key] is DROP:
            payload.pop(key, None)
        else:
            payload[key] = overrides[key]
    return payload


def transcription_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "spec": spec_payload(),
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
    monkeypatch.setenv("ASR_VLLM_API_GATEWAY_URL", "")
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
