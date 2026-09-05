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
from tts.tests.fakes import candidate, spec_json, voice_binding


class _FakePipe:
    def __call__(self, text, voice=None):
        yield ("g", "p", np.zeros(2400, dtype=np.float32))  # 0.1 s @ 24 kHz


def _fake_generate(text: str, description: str) -> np.ndarray:
    return np.zeros(4410, dtype=np.float32)  # 0.1 s @ 44.1 kHz


@pytest_asyncio.fixture
async def client(monkeypatch):
    # Boot registration now covers every engine in the image, so the fakes REPLACE the real
    # instances rather than filling an empty registry — and `_build_spec_engine` is stubbed out so
    # the router serves the fake instead of building a real engine from the spec.
    import tts.routing.router as router_mod

    monkeypatch.setattr(router_mod, "_build_spec_engine", lambda *_a, **_k: None)
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
    # The SYSTEM TEXT_TO_SPEECH agent binds the local Kokoro engine, so a tenant with no opinion
    # gets a spec naming it — synthesis goes to the built-in engine, never a cloud vendor.
    resp = await client.post(
        "/api/v1/audio/speech",
        json={
            "input": "Hello.",
            "voice": "en-female-1",
            "stream_format": "audio",
            "resolved_spec": spec_json(
                candidate(
                    "kokoro",
                    voices=[voice_binding("en-female-1", locale="en-IN")],
                    voice="en-female-1",
                )
            ),
        },
    )
    assert resp.status_code == 200
    assert len(resp.content) == 4800  # 2400 samples × 2 bytes, 24k passthrough


@pytest.mark.asyncio
async def test_malayalam_voice_routes_to_parler_with_resample(client):
    # A Malayalam agent binds the local Indic Parler engine; the engine-native speaker name rides
    # on the model's own voice binding, so nothing here needs a provider-voice table.
    resp = await client.post(
        "/api/v1/audio/speech",
        json={
            "input": "ഹലോ.",
            "voice": "ml-female-1",
            "stream_format": "audio",
            "resolved_spec": spec_json(
                candidate(
                    "indic_parler",
                    slug="indic-parler-tts",
                    source_uri="ai4bharat/indic-parler-tts",
                    voices=[
                        voice_binding("ml-female-1", locale="ml-IN", provider_voice="Anjali")
                    ],
                    voice="ml-female-1",
                    language="ml",
                )
            ),
        },
    )
    assert resp.status_code == 200
    assert abs(len(resp.content) // 2 - 2400) < 100  # 44.1k → 24k resample
