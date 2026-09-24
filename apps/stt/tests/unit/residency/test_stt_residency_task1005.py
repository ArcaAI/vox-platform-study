"""TASK-1005 — stt's residency agent: the shared routes over stt's model cache.

`hope_runtime_models` owns the agent (its own suite proves the verbs); this suite
proves the stt WIRING: the routes are mounted on the app, the model cache is built
residency-aware (so the Dramatiq worker, which builds the same cache, emits the
residency metrics too), and stt's `load_spec` — `{"resolved_spec": <ResolvedAsrSpec>}`,
the example pinned in `tests/contracts/model-residency-agent.fixture.json` — loads
the spec's primary ASR model exactly the way a session create would.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from prometheus_client import REGISTRY

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat


def _contracts_dir() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts"
        if (candidate / "model-residency-agent.fixture.json").is_file():
            return candidate
    raise AssertionError("tests/contracts not found above this test")


CONTRACTS = _contracts_dir()
RESIDENCY = json.loads((CONTRACTS / "model-residency-agent.fixture.json").read_text())


def _resolve_refs(value: Any) -> Any:
    """Resolve `{"$ref": "<file>#/a/b"}` against tests/contracts (examples only)."""
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            file_name, _, pointer = value["$ref"].partition("#")
            target: Any = json.loads((CONTRACTS / file_name).read_text())
            for part in filter(None, pointer.split("/")):
                target = target[part]
            return target
        return {k: _resolve_refs(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_refs(v) for v in value]
    return value


(STT_EXAMPLE,) = RESIDENCY["loadSpecExamples"]["stt"]
PRIMARY_SLUG = STT_EXAMPLE["model_ref"]
LOAD_SPEC = _resolve_refs(STT_EXAMPLE["load_spec"])


@pytest.fixture
def cache(monkeypatch: pytest.MonkeyPatch) -> Any:
    """A fresh stt ModelCache as the process singleton, with a fake loader."""
    import stt.models.cache as cache_module
    from stt.models.cache import ModelCache

    fresh = ModelCache()
    loader = MagicMock()
    loader.load = AsyncMock(
        side_effect=lambda config: LoadedModel(
            model_id=config.id,
            model_slug=config.slug,
            model=object(),
            format=config.format,
            memory_mb=1500,
            device="cuda",
        )
    )
    loader.unload = AsyncMock()
    monkeypatch.setattr(fresh, "loader_for", lambda _config: loader)
    monkeypatch.setattr(fresh, "_get_loader", lambda _format: loader)
    monkeypatch.setattr(cache_module, "_cache", fresh)
    fresh.fake_loader = loader
    return fresh


@pytest.fixture
def client(cache: Any) -> AsyncClient:
    from stt.residency.agent import residency_router

    app = FastAPI()
    app.include_router(residency_router())
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://stt")


def test_the_routes_are_mounted_on_the_stt_app(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    from stt.core.config.settings import Settings
    from stt.main import create_app

    app = create_app(settings_override=Settings(metrics_enabled=False, otel_enabled=False))
    paths = set(app.openapi()["paths"])

    assert {
        "/internal/residency",
        "/internal/residency/load",
        "/internal/residency/unload",
        "/internal/residency/models/{model_ref}/policy",
    } <= paths


def test_the_model_cache_is_built_residency_aware() -> None:
    from stt.models.cache import ModelCache

    residency = ModelCache().residency

    assert residency is not None
    assert residency.service == "stt"
    assert residency.device.kind in {"gpu", "cpu"}
    assert residency.metrics is not None
    assert residency.admission.enabled is False  # nothing changes live until enabled


def test_the_stt_load_spec_example_is_pinned_in_the_fixture() -> None:
    assert set(STT_EXAMPLE) >= {"model_ref", "load_spec"}
    assert set(STT_EXAMPLE["load_spec"]) == {"resolved_spec"}
    assert LOAD_SPEC["resolved_spec"]["models"]["asr"]["slug"] == PRIMARY_SLUG


async def test_load_spec_loads_the_primary_asr_model_like_a_session(
    cache: Any, client: AsyncClient
) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "pin": True},
        )
        again = await client.post(
            "/internal/residency/load", json={"model_ref": PRIMARY_SLUG, "load_spec": {}}
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "loaded"
    model = body["model"]
    assert model["model_ref"] == PRIMARY_SLUG
    assert model["cache"] == "stt_model_cache"
    assert model["admin_pinned"] is True
    # The spec carries no AiModel id — a synthetic `agent-model:<slug>` is not one.
    assert model["ai_model_id"] is None
    (config,) = cache.fake_loader.load.await_args.args
    assert config.slug == PRIMARY_SLUG
    assert config.format == AiModelFormat.WHISPER_CPP
    assert config.library_name == "whisper.cpp"
    assert again.json()["outcome"] == "already_loaded"
    assert cache.fake_loader.load.await_count == 1


async def test_a_load_spec_for_another_model_is_refused_as_invalid(client: AsyncClient) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load",
            json={"model_ref": "some-other-model", "load_spec": LOAD_SPEC},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "LOAD_FAILED"


async def test_a_malformed_resolved_spec_is_refused_as_invalid(client: AsyncClient) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": {"resolved_spec": {"nope": 1}}},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "LOAD_FAILED"


async def test_an_unknown_model_with_no_spec_is_404(client: AsyncClient) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load", json={"model_ref": PRIMARY_SLUG, "load_spec": {}}
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MODEL_UNKNOWN"


async def test_report_and_unload_follow_a_session_pin(cache: Any, client: AsyncClient) -> None:
    from stt.pipeline.spec import bundle_from_resolved

    bundle = bundle_from_resolved(LOAD_SPEC["resolved_spec"])
    await cache.get_or_load(bundle.model_configs[PRIMARY_SLUG])
    await cache.pin(PRIMARY_SLUG)  # a live session holds it

    async with client:
        report = (await client.get("/internal/residency")).json()
        refused = await client.post("/internal/residency/unload", json={"model_ref": PRIMARY_SLUG})
        forced = await client.post(
            "/internal/residency/unload", json={"model_ref": PRIMARY_SLUG, "force": True}
        )

    (model,) = report["models"]
    assert report["service"] == "stt"
    assert model["in_flight"] == 1 and model["pinned"] is True
    assert refused.status_code == 409 and refused.json()["error"]["in_flight"] == 1
    assert forced.json() == {"outcome": "unloaded", "model_ref": PRIMARY_SLUG}
    cache.fake_loader.unload.assert_awaited_once()


async def test_any_process_building_the_cache_emits_residency_metrics(cache: Any) -> None:
    """The Dramatiq worker serves no routes but builds this same cache."""
    from stt.pipeline.spec import bundle_from_resolved

    bundle = bundle_from_resolved(LOAD_SPEC["resolved_spec"])
    await cache.get_or_load(bundle.model_configs[PRIMARY_SLUG])

    labels = {
        "service": "stt",
        "model": PRIMARY_SLUG,
        "device": cache.residency.device.id,
        "state": "loaded",
    }
    assert REGISTRY.get_sample_value("model_resident", labels) == 1
    assert REGISTRY.get_sample_value(
        "model_load_seconds_count", {"service": "stt", "model": PRIMARY_SLUG}
    )
