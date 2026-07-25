"""End-to-end: POST /audio/speech → router → local providers (fakes) (Phase 4)."""

from __future__ import annotations

import numpy as np
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts.core.config import IndicParlerConfig, KokoroConfig, Settings
from tts.main import create_app
from tts.providers.indic_parler import IndicParlerProvider
from tts.providers.kokoro import KokoroProvider


class _FakePipe:
    def __call__(self, text, voice=None):
        yield ("g", "p", np.zeros(2400, dtype=np.float32))  # 0.1 s @ 24 kHz


def _fake_generate(text: str, description: str) -> np.ndarray:
    return np.zeros(4410, dtype=np.float32)  # 0.1 s @ 44.1 kHz


@pytest_asyncio.fixture
async def client():
    app = create_app(settings_override=Settings(debug=True))
    app.state.provider_registry.register(
        "kokoro", KokoroProvider(KokoroConfig(), pipeline=_FakePipe())
    )
    app.state.provider_registry.register(
        "indic_parler", IndicParlerProvider(IndicParlerConfig(), generate=_fake_generate)
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_english_voice_routes_to_kokoro(client):
    resp = await client.post(
        "/api/v1/audio/speech",
        json={"input": "Hello.", "voice": "en-female-1", "stream_format": "audio"},
    )
    assert resp.status_code == 200
    assert len(resp.content) == 4800  # 2400 samples × 2 bytes, 24k passthrough


@pytest.mark.asyncio
async def test_malayalam_voice_routes_to_parler_with_resample(client):
    resp = await client.post(
        "/api/v1/audio/speech",
        json={"input": "ഹലോ.", "voice": "ml-female-1", "stream_format": "audio"},
    )
    assert resp.status_code == 200
    assert abs(len(resp.content) // 2 - 2400) < 100  # 44.1k → 24k resample
