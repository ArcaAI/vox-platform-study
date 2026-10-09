"""TASK-1005 — nlp's residency agent: the shared routes over nlp's five model caches.

`hope_runtime_models` owns the agent (its own suite proves the verbs); this suite
proves the nlp WIRING: the routes are mounted, every cache is built residency-aware
on ONE shared CPU device (plan D-10), and nlp's `load_spec` — pinned in
`tests/contracts/model-residency-agent.fixture.json` → `loadSpecExamples.nlp` —
keys the slot exactly the way the request path does, so the next request is a hit.
No real model loads here: each cache's factory is replaced before it is built.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-agent.fixture.json"
        if candidate.is_file():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise AssertionError("model-residency-agent.fixture.json not found above this test")


EXAMPLES = {e["load_spec"]["cache"]: e for e in _fixture()["loadSpecExamples"]["nlp"]}

_FACTORIES = {
    "nlp_token_classifier": "_create_token_classifier",
    "nlp_text_classifier": "_create_text_classifier",
    "nlp_gliner2_guard": "_create_gliner2_guard",
    "nlp_medical_suggester": "_create_medical_suggester",
    "nlp_entailment_scorer": "_create_entailment_scorer",
    "nlp_seq_cls_guard": "_create_seq_cls_guard",
    "nlp_judge_guard": "_create_judge_guard",
}


class _Loaded:
    def __init__(self, key: str) -> None:
        self.key = key
        self.shut_down = False

    async def shutdown(self) -> None:
        self.shut_down = True


@pytest.fixture
def loaded_keys(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, list[str]]]:
    """Fresh caches whose factories record the slot key instead of loading weights."""
    import nlp.dependencies as deps

    calls: dict[str, list[str]] = {name: [] for name in _FACTORIES}

    def fake(cache_name: str) -> Any:
        async def factory(key: str) -> _Loaded:
            calls[cache_name].append(key)
            if cache_name == "nlp_entailment_scorer":
                # The real factory consumes the calibration it was handed.
                assert deps._pending_entailment_calibration.pop(key, None) is not None
            return _Loaded(key)

        return factory

    for cache_name, attribute in _FACTORIES.items():
        monkeypatch.setattr(deps, attribute, fake(cache_name))
    deps.reset_model_caches()
    yield calls
    deps.reset_model_caches()


@pytest.fixture
def api(loaded_keys: dict[str, list[str]]) -> Iterator[TestClient]:
    from nlp.residency import residency_router

    app = FastAPI()
    app.include_router(residency_router())
    with TestClient(app) as client:
        yield client


def test_the_routes_are_mounted_on_the_nlp_app(client: TestClient) -> None:
    response = client.get("/internal/residency")

    assert response.status_code == 200
    report = response.json()
    assert report["service"] == "nlp"
    assert [d["id"] for d in report["devices"]] == ["cpu"]  # reported before any cache exists


def test_every_cache_is_residency_aware_on_one_shared_cpu_device() -> None:
    import nlp.dependencies as deps

    deps.reset_model_caches()
    try:
        caches = [
            deps._token_classifier_cache(),
            deps._text_classifier_cache(),
            deps._medical_suggester_cache(),
            deps._gliner2_guard_cache(),
            deps._entailment_scorer_cache(),
        ]
        devices = {id(cache.residency.device) for cache in caches}
        (residency,) = {cache.residency.service for cache in caches}

        assert residency == "nlp"
        assert len(devices) == 1
        assert caches[0].residency.device.kind == "cpu"
        assert caches[0].residency.device.usage() is not None  # RSS readable on this host
        assert all(cache.residency.admission.enabled is False for cache in caches)
    finally:
        deps.reset_model_caches()


@pytest.mark.parametrize("cache_name", sorted(EXAMPLES))
def test_each_load_spec_example_keys_the_slot_like_the_request_path(
    cache_name: str, api: TestClient, loaded_keys: dict[str, list[str]]
) -> None:
    import nlp.dependencies as deps
    from nlp.services.entailment_scorer import EntailmentCalibration

    example = EXAMPLES[cache_name]
    spec = example["load_spec"]
    name = example["model_ref"]

    request = {"model_ref": name, "load_spec": spec}
    response = api.post("/internal/residency/load", json=request)

    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "loaded"
    model = response.json()["model"]
    assert model["model_ref"] == name
    assert model["cache"] == cache_name
    assert model["device"] == "cpu"
    assert model["ai_model_id"] is None
    expected_key = {
        "nlp_token_classifier": lambda: deps._model_cache_key(name, spec["model_path"]),
        "nlp_medical_suggester": lambda: deps._suggester_cache_key(
            name, spec["model_path"], spec["ner_model_name"], spec["ner_model_path"]
        ),
        "nlp_entailment_scorer": lambda: deps._entailment_cache_key(
            name, spec["model_path"], EntailmentCalibration.model_validate(spec["calibration"])
        ),
        "nlp_seq_cls_guard": lambda: deps._model_cache_key(name, spec["model_path"]),
        "nlp_judge_guard": lambda: deps._model_cache_key(name, spec["model_path"]),
    }[cache_name]()
    assert loaded_keys[cache_name] == [expected_key]

    again = api.post("/internal/residency/load", json=request)
    assert again.json()["outcome"] == "already_loaded"
    assert loaded_keys[cache_name] == [expected_key]


def test_a_loaded_slot_is_a_hit_for_the_request_path(
    api: TestClient, loaded_keys: dict[str, list[str]]
) -> None:
    import asyncio

    import nlp.dependencies as deps

    api.post(
        "/internal/residency/load",
        json={"model_ref": "blaze999/Medical-NER", "load_spec": {"cache": "nlp_token_classifier"}},
    )

    async def serve() -> None:
        async with deps.pinned_token_classifier("blaze999/Medical-NER"):
            pass

    asyncio.run(serve())
    assert loaded_keys["nlp_token_classifier"] == ["blaze999/Medical-NER"]


def test_unload_and_policy_address_a_hub_id_with_a_slash(api: TestClient) -> None:
    ref = "fastino/GLiNER2-Guardrails-PII-Multi"
    api.post(
        "/internal/residency/load",
        json={"model_ref": ref, "load_spec": {"cache": "nlp_gliner2_guard"}},
    )

    policy = api.put(
        "/internal/residency/models/fastino%2FGLiNER2-Guardrails-PII-Multi/policy",
        json={"admin_pinned": True, "ttl_seconds": 1800},
    )
    unloaded = api.post("/internal/residency/unload", json={"model_ref": ref})
    after = api.get("/internal/residency").json()

    assert policy.status_code == 200, policy.text
    assert policy.json()["model"]["admin_pinned"] is True
    assert policy.json()["model"]["ttl_seconds"] == 1800
    assert unloaded.json() == {"outcome": "unloaded", "model_ref": ref}
    assert after["models"] == []


@pytest.mark.parametrize(
    "load_spec",
    [
        {"cache": "nlp_nonexistent"},
        {"cache": "nlp_token_classifier", "surprise": 1},
        {"cache": "nlp_medical_suggester", "model_path": None},  # no ner_model_name
        {"cache": "nlp_entailment_scorer", "calibration": {"adapter": "half"}},
    ],
)
def test_an_unusable_load_spec_is_400_load_failed(
    load_spec: dict[str, Any], api: TestClient
) -> None:
    response = api.post(
        "/internal/residency/load", json={"model_ref": "any/model", "load_spec": load_spec}
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "LOAD_FAILED"


# ── TASK-1019 lane Y — a failed load is reported as state `failed`, not silence ──


def test_a_failed_load_is_reported_failed_then_cleared_by_unload(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nlp.dependencies as deps

    async def broken(_key: str) -> Any:
        raise RuntimeError("model directory is empty")

    monkeypatch.setattr(deps, "_create_token_classifier", broken)
    deps.reset_model_caches()
    ref = "blaze999/Medical-NER"

    refused = api.post(
        "/internal/residency/load",
        json={"model_ref": ref, "load_spec": {"cache": "nlp_token_classifier"}},
    )
    report = api.get("/internal/residency").json()
    cleared = api.post("/internal/residency/unload", json={"model_ref": ref})
    after = api.get("/internal/residency").json()

    assert refused.status_code == 500
    assert refused.json()["error"]["code"] == "LOAD_FAILED"
    (model,) = report["models"]
    assert model["model_ref"] == ref
    assert model["state"] == "failed"
    assert model["error"]["code"] == "RuntimeError"
    assert model["error"]["message"] == "model directory is empty"
    assert model["error"]["at"].endswith("Z")
    assert cleared.json() == {"outcome": "not_loaded", "model_ref": ref}
    assert after["models"] == []
