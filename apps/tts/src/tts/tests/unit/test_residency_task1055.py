"""TASK-1055 wave 3 (G3) — tts under console control: the shared residency router.

Contract: `tests/contracts/model-residency-task1055.fixture.json` → `wave3.ttsResidency`.

The resident set is the LOCAL engines' `ModelCache` entries (Kokoro, Indic Parler, Indic F5);
`model_ref` is the AiModel slug the engine was built from, `load_spec` is
``{"engine": "<registered name>"}``, the device is ``cpu``. Every engine here is a fake — the
spec-engine builder is stubbed with providers whose pipeline factories never touch real weights.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from prometheus_client import REGISTRY

from tts.core.config import IndicF5Config, IndicParlerConfig, KokoroConfig, Settings
from tts.main import create_app
from tts.providers.indic_f5 import IndicF5Provider
from tts.providers.indic_parler import IndicParlerProvider
from tts.providers.kokoro import KokoroProvider
from tts.tests.fakes import FakeEngine, candidate, spec_json, voice_binding

RESIDENCY = "/internal/residency"


class _Pipe:
    def __call__(self, text, voice=None):
        yield ("g", "p", np.zeros(2400, dtype=np.float32))


class _Factory:
    """Counts loads, so a test can tell a cache hit from a reload."""

    def __init__(self, product: Any) -> None:
        self.product = product
        self.calls = 0

    def __call__(self) -> Any:
        self.calls += 1
        return self.product


def _build_fakes(factories: dict[str, _Factory]):
    """A stand-in for `router._build_spec_engine`: the REAL providers, fake weights."""

    def build(_settings: Any, cand: Any, _override: dict[str, str]) -> Any:
        engine = cand.model.provider
        slug = cand.model.slug
        if engine == "kokoro":
            return KokoroProvider(
                KokoroConfig(),
                pipeline_factory=factories.setdefault(slug, _Factory(_Pipe())),
                slug=slug,
            )
        if engine == "indic_parler":
            gen = factories.setdefault(slug, _Factory(lambda _t, _d: np.zeros(10, np.float32)))
            return IndicParlerProvider(IndicParlerConfig(), generate_factory=gen, slug=slug)
        if engine == "indic_f5":
            gen = factories.setdefault(slug, _Factory(lambda _t: np.zeros(10, np.float32)))
            return IndicF5Provider(IndicF5Config(), generate_factory=gen, slug=slug)
        return None

    return build


@pytest.fixture
def factories() -> dict[str, _Factory]:
    return {}


@pytest_asyncio.fixture
async def app(monkeypatch, factories):
    import tts.routing.router as router_mod

    monkeypatch.setattr(router_mod, "_build_spec_engine", _build_fakes(factories))
    return create_app(settings_override=Settings(debug=True))


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _kokoro_spec(slug: str = "kokoro-82m") -> dict[str, Any]:
    return spec_json(
        candidate(
            "kokoro",
            slug=slug,
            voices=[voice_binding("en-female-1", locale="en-IN")],
            voice="en-female-1",
        )
    )


async def _synth(client: AsyncClient, resolved_spec: dict[str, Any]) -> None:
    resp = await client.post(
        "/api/v1/audio/speech",
        json={
            "input": "Hello.",
            "voice": "en-female-1",
            "stream_format": "audio",
            "resolved_spec": resolved_spec,
        },
    )
    assert resp.status_code == 200, resp.text


async def _load(client: AsyncClient, model_ref: str, load_spec: dict[str, Any], **extra: Any):
    return await client.post(
        f"{RESIDENCY}/load", json={"model_ref": model_ref, "load_spec": load_spec, **extra}
    )


# ── report ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_report_names_the_service_and_the_cpu_device_while_nothing_is_resident(client):
    resp = await client.get(RESIDENCY)

    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "tts"
    assert [d["id"] for d in body["devices"]] == ["cpu"]
    assert body["models"] == []


@pytest.mark.asyncio
async def test_a_served_local_model_is_reported_by_its_slug_cache_and_device(client):
    await _synth(client, _kokoro_spec())

    models = (await client.get(RESIDENCY)).json()["models"]

    assert len(models) == 1
    model = models[0]
    assert model["model_ref"] == "kokoro-82m"
    assert model["cache"] == "tts_kokoro"
    assert model["device"] == "cpu"
    assert model["state"] == "loaded"


@pytest.mark.asyncio
async def test_a_remote_engine_never_appears(app, client):
    app.state.provider_registry.register("azure", FakeEngine("azure"))
    await _synth(client, _kokoro_spec())

    refs = [m["model_ref"] for m in (await client.get(RESIDENCY)).json()["models"]]

    assert refs == ["kokoro-82m"]


# ── load ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_load_warms_the_engine_a_request_uses_so_the_next_request_is_a_hit(client, factories):
    await _synth(client, _kokoro_spec())
    assert (await client.post(f"{RESIDENCY}/unload", json={"model_ref": "kokoro-82m"})).json()[
        "outcome"
    ] == "unloaded"

    resp = await _load(client, "kokoro-82m", {"engine": "kokoro"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "loaded"
    assert resp.json()["model"]["cache"] == "tts_kokoro"
    assert factories["kokoro-82m"].calls == 2
    await _synth(client, _kokoro_spec())
    assert factories["kokoro-82m"].calls == 2  # served from the console-loaded copy


@pytest.mark.asyncio
async def test_load_of_a_resident_model_is_already_loaded(client, factories):
    await _synth(client, _kokoro_spec())

    resp = await _load(client, "kokoro-82m", {"engine": "kokoro"})

    assert resp.status_code == 200
    assert resp.json()["outcome"] == "already_loaded"
    assert factories["kokoro-82m"].calls == 1


@pytest.mark.asyncio
async def test_load_with_pin_sets_the_operator_pin(client):
    await _synth(client, _kokoro_spec())

    resp = await _load(client, "kokoro-82m", {"engine": "kokoro"}, pin=True)

    assert resp.json()["model"]["admin_pinned"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("engine", "slug", "cache"),
    [
        ("indic_parler", "indic-parler-tts", "tts_indic_parler"),
        ("indic_f5", "indic-f5", "tts_indic_f5"),
    ],
)
async def test_every_local_engine_is_loadable(client, engine, slug, cache):
    voice = voice_binding("ml-female-1", locale="ml-IN", ref_audio_path="/ref.wav", ref_text="x")
    await _synth_ml(client, engine, slug, voice)
    await client.post(f"{RESIDENCY}/unload", json={"model_ref": slug})

    resp = await _load(client, slug, {"engine": engine})

    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "loaded"
    assert resp.json()["model"]["cache"] == cache
    assert resp.json()["model"]["device"] == "cpu"


async def _synth_ml(client: AsyncClient, engine: str, slug: str, voice: Any) -> None:
    resp = await client.post(
        "/api/v1/audio/speech",
        json={
            "input": "നമസ്കാരം.",
            "voice": "ml-female-1",
            "stream_format": "audio",
            "resolved_spec": spec_json(
                candidate(
                    engine,
                    slug=slug,
                    voices=[voice],
                    voice="ml-female-1",
                    language="ml",
                )
            ),
        },
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_load_of_a_model_no_engine_was_built_for_is_model_unknown(client):
    resp = await _load(client, "kokoro-82m", {"engine": "kokoro"})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MODEL_UNKNOWN"


@pytest.mark.asyncio
async def test_load_naming_another_slug_of_the_engine_is_model_unknown(client):
    await _synth(client, _kokoro_spec("kokoro-82m"))

    resp = await _load(client, "kokoro-other", {"engine": "kokoro"})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MODEL_UNKNOWN"


@pytest.mark.asyncio
async def test_load_of_a_remote_engine_is_model_unknown(app, client):
    app.state.provider_registry.register("azure", FakeEngine("azure"))

    resp = await _load(client, "azure-neural", {"engine": "azure"})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "MODEL_UNKNOWN"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "load_spec", [{"engine": 3}, {"engine": "kokoro", "model_path": "/x"}, {"cache": "tts_kokoro"}]
)
async def test_an_unreadable_load_spec_is_refused(client, load_spec):
    resp = await _load(client, "kokoro-82m", load_spec)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "LOAD_FAILED"


@pytest.mark.asyncio
async def test_a_gpu_device_is_unavailable_and_cpu_is_accepted(client):
    await _synth(client, _kokoro_spec())

    gpu = await _load(client, "kokoro-82m", {"engine": "kokoro"}, device="cuda:0")
    cpu = await _load(client, "kokoro-82m", {"engine": "kokoro"}, device="cpu")

    assert gpu.status_code == 400
    assert gpu.json()["error"]["code"] == "DEVICE_UNAVAILABLE"
    assert cpu.status_code == 200
    assert cpu.json()["outcome"] == "already_loaded"


# ── unload ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unload_evicts_but_the_engine_stays_and_the_next_request_reloads(client, factories):
    await _synth(client, _kokoro_spec())

    resp = await client.post(f"{RESIDENCY}/unload", json={"model_ref": "kokoro-82m"})

    assert resp.json() == {"outcome": "unloaded", "model_ref": "kokoro-82m"}
    assert (await client.get(RESIDENCY)).json()["models"] == []
    await _synth(client, _kokoro_spec())
    assert factories["kokoro-82m"].calls == 2


# ── metrics ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_shared_residency_metrics_carry_the_slug(client):
    await _synth(client, _kokoro_spec("kokoro-metrics"))

    labels = {"service": "tts", "model": "kokoro-metrics", "device": "cpu", "state": "loaded"}
    assert REGISTRY.get_sample_value("model_resident", labels) == 1.0


# ── auth ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_router_is_behind_the_service_token(monkeypatch):
    app = create_app(settings_override=Settings(debug=True, internal_access_token="s3cret"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        denied = await c.get(RESIDENCY)
        allowed = await c.get(RESIDENCY, headers={"X-Service-Token": "s3cret"})

    assert denied.status_code == 401
    assert allowed.status_code == 200


# ── provider accessors ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("engine", "cls"),
    [
        ("kokoro", KokoroProvider),
        ("indic_parler", IndicParlerProvider),
        ("indic_f5", IndicF5Provider),
    ],
)
def test_from_spec_carries_the_row_slug(engine, cls):
    voice = voice_binding("v1", ref_audio_path="/ref.wav")
    cand = candidate(engine, slug=f"{engine}-row", voices=[voice], voice="v1")

    built = cls.from_spec(Settings(), cand, {})

    assert built.model_slug == f"{engine}-row"
    assert built.model_cache.name == f"tts_{engine}"
