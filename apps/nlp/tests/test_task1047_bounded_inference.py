"""TASK-1047 lane L6 — bounded inference (FC-8).

Input cap (413, no model load), gliner2 ``max_len``, per-inference threads,
one weight identity per process across the guard and token-classifier caches,
and worker recycling (RSS / request count).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import pytest

TENANT = "11111111-1111-1111-1111-111111111111"
MODEL = "some/gliner2-model"


@pytest.fixture(autouse=True)
def _reset_bounds():
    from nlp.core import bounds, recycle

    bounds.reset_bounds()
    recycle.reset_recycle_guard()
    yield
    bounds.reset_bounds()
    recycle.reset_recycle_guard()


def _boom_acquire(*_a: Any, **_k: Any):
    raise AssertionError("a model was acquired for an oversized input")


# ── C7: input cap ────────────────────────────────────────────────────────


def test_default_bounds_are_the_frozen_fc8_values():
    from nlp.core import bounds

    b = bounds.get_bounds()
    assert (b.max_input_chars, b.max_input_words) == (8192, 2048)
    assert (b.recycle_after_requests, b.recycle_rss_mib) == (2000, 12288)
    assert b.threads_per_inference == 0


def _assert_413(response, max_chars: int) -> None:
    assert response.status_code == 413
    assert response.json() == {"code": "INPUT_EXCEEDS_WINDOW", "maxChars": max_chars}


def test_guard_pii_over_bound_is_413_without_loading_a_model(client, monkeypatch):
    import nlp.api.v1.rest.guard as guard
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)
    monkeypatch.setattr(guard, "_acquire_guard", _boom_acquire)
    body = {
        "text": "x" * 51,
        "model_name": MODEL,
        "labels": ["email"],
        "tenant_id": TENANT,
    }
    _assert_413(client.post("/api/v1/guard/pii", json=body), 50)


def test_guard_classify_over_bound_is_413(client, monkeypatch):
    import nlp.api.v1.rest.guard as guard
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)
    monkeypatch.setattr(guard, "_acquire_guard", _boom_acquire)
    body = {
        "text": "x" * 51,
        "model_name": MODEL,
        "tasks": {"prompt_safety": {"labels": ["safe", "unsafe"]}},
        "tenant_id": TENANT,
    }
    _assert_413(client.post("/api/v1/guard/classify", json=body), 50)


@pytest.mark.parametrize("field", ["document", "claim"])
def test_guard_entailment_caps_each_text_field(client, monkeypatch, field):
    import nlp.api.v1.rest.guard as guard
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)
    monkeypatch.setattr(guard, "_acquire_scorer", _boom_acquire)
    pair = {"document": "d", "claim": "c"}
    pair[field] = "x" * 51
    body = {"pairs": [pair], "model_name": MODEL, "tenant_id": TENANT}
    _assert_413(client.post("/api/v1/guard/entailment", json=body), 50)


def test_classify_tokens_over_bound_is_413(client, monkeypatch):
    # FC-8a (OD-10): /classify/tokens windows text above maxInputChars server-side;
    # its 413 bound is nlp.ner.maxRequestChars (see test_task1047_ner_windowing.py).
    import nlp.api.v1.rest.classify as classify
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50, ner_max_request_chars=60)
    monkeypatch.setattr(classify, "pinned_token_classifier", _boom_acquire)
    body = {"text": "x" * 61, "model_name": MODEL}
    _assert_413(client.post("/api/v1/classify/tokens", json=body), 60)


def test_classify_text_over_bound_is_413(client, monkeypatch):
    import nlp.api.v1.rest.classify as classify
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)
    monkeypatch.setattr(classify, "pinned_text_classifier", _boom_acquire)
    body = {"text": "x" * 51, "model_name": MODEL}
    _assert_413(client.post("/api/v1/classify/text", json=body), 50)


def test_classify_text_multi_label_over_bound_is_413(client, monkeypatch):
    import nlp.api.v1.rest.classify as classify
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)
    monkeypatch.setattr(classify, "pinned_text_classifier", _boom_acquire)
    body = {"text": "x" * 51, "model_name": MODEL}
    _assert_413(client.post("/api/v1/classify/text/multi-label", json=body), 50)


def test_input_exactly_at_the_bound_is_served(client, monkeypatch):
    import nlp.api.v1.rest.guard as guard
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=50)

    class Fake:
        async def batch_extract_entities(self, texts, labels, threshold, batch_size=8):
            return [[] for _ in texts]

    @asynccontextmanager
    async def acquire(*_a, **_k):
        yield Fake()

    monkeypatch.setattr(guard, "_acquire_guard", acquire)
    body = {"text": "x" * 50, "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}
    assert client.post("/api/v1/guard/pii", json=body).status_code == 200


def test_413_is_counted():
    from nlp.core import bounds
    from nlp.core.metrics import NLP_INPUT_EXCEEDS_WINDOW_TOTAL

    bounds.set_bounds(max_input_chars=5)
    child = NLP_INPUT_EXCEEDS_WINDOW_TOTAL.labels(route="guard_pii")
    before = child._value.get()
    with pytest.raises(bounds.InputExceedsWindow):
        bounds.enforce_input_cap("guard_pii", "x" * 6)
    assert child._value.get() == before + 1


def test_bounds_follow_the_control_plane_snapshot():
    from nlp.core import bounds
    from nlp.core.effective_config import EffectiveConfigSnapshot

    def entry(v):
        return {"value": v}

    snap = EffectiveConfigSnapshot(
        raw={
            "settings": {
                "nlp.inference.maxInputChars": entry(4000),
                "nlp.inference.maxInputWords": entry(500),
                "nlp.worker.recycleAfterRequests": entry(10),
                "nlp.worker.recycleRssMib": entry(1000),
                "nlp.inference.threadsPerInference": entry(3),
            }
        },
        ok=True,
    )
    bounds.apply_snapshot(snap)
    b = bounds.get_bounds()
    assert (b.max_input_chars, b.max_input_words) == (4000, 500)
    assert (b.recycle_after_requests, b.recycle_rss_mib, b.threads_per_inference) == (10, 1000, 3)
    # "no opinion" keeps what is in force
    bounds.apply_snapshot(EffectiveConfigSnapshot())
    assert bounds.get_bounds().max_input_chars == 4000


# ── C1: max_len passed to every gliner2 call ─────────────────────────────


class RecordingRuntime:
    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}

    def extract_entities(self, text, labels, **kw):
        self.calls["extract_entities"] = kw
        return {"entities": []}

    def batch_extract_entities(self, texts, labels, **kw):
        self.calls["batch_extract_entities"] = kw
        return [{"entities": []} for _ in texts]

    def classify_text(self, text, tasks, **kw):
        self.calls["classify_text"] = kw
        return {}

    def batch_classify_text(self, texts, tasks, **kw):
        self.calls["batch_classify_text"] = kw
        return [{} for _ in texts]


def test_max_len_is_passed_to_all_four_gliner2_calls():
    from nlp.core import bounds
    from nlp.services.gliner2_guard import Gliner2GuardService

    bounds.set_bounds(max_input_words=123)
    svc = Gliner2GuardService("src", "m")
    svc.runtime = RecordingRuntime()
    svc._sync_extract("t", ["a"], 0.5)
    svc._sync_batch_extract(["t"], ["a"], 0.5, 8)
    svc._sync_classify("t", {"x": {}}, 0.5)
    svc._sync_batch_classify(["t"], {"x": {}}, 0.5, 8)
    assert {k: v["max_len"] for k, v in svc.runtime.calls.items()} == {
        "extract_entities": 123,
        "batch_extract_entities": 123,
        "classify_text": 123,
        "batch_classify_text": 123,
    }


# ── C5: threads per inference ────────────────────────────────────────────


def test_threads_derive_from_cpu_limit_over_concurrency():
    from nlp.core.bounds import resolve_threads_per_inference as resolve

    assert resolve(configured=0, cpu_allowance=16, max_concurrent=4) == 4
    assert resolve(configured=0, cpu_allowance=2, max_concurrent=4) == 1  # min 1
    assert resolve(configured=3, cpu_allowance=16, max_concurrent=4) == 3  # explicit wins


def test_refresh_applies_threads_and_follows_concurrency(monkeypatch):
    from nlp.core import bounds, concurrency
    from nlp.core.effective_config import EffectiveConfigSnapshot

    applied: list[int] = []
    monkeypatch.setattr(bounds, "_apply_torch_threads", applied.append)
    monkeypatch.setattr(bounds, "_cpu_allowance", lambda: 16)
    concurrency.reset_inference_semaphore()

    class Client:
        async def get(self):
            return EffectiveConfigSnapshot(raw={"concurrency": {"maxConcurrent": 4}}, ok=True)

    asyncio.run(concurrency.refresh_inference_limit(Client()))
    assert applied[-1] == 4
    concurrency.reset_inference_semaphore()


# ── C8: one weight identity per process ──────────────────────────────────


def test_registry_loads_one_identity_once():
    from nlp.core.weight_registry import WeightRegistry

    class Weights:
        pass

    loads = 0

    async def loader():
        nonlocal loads
        loads += 1
        return Weights()

    async def concurrent_same_identity(reg):
        results = await asyncio.gather(
            reg.get_or_load(("m", None), loader), reg.get_or_load(("m", None), loader)
        )
        return results[0] is results[1]

    async def scenario():
        reg = WeightRegistry()
        assert await concurrent_same_identity(reg)
        assert loads == 1
        other = await reg.get_or_load(("m", "/p"), loader)
        assert loads == 2 and other is not None

    asyncio.run(scenario())


def test_registry_does_not_keep_weights_alive_once_every_cache_drops_them():
    import gc
    import weakref

    from nlp.core.weight_registry import WeightRegistry

    class Weights:
        pass

    async def loader():
        return Weights()

    reg = WeightRegistry()
    obj = asyncio.run(reg.get_or_load(("m", None), loader))
    ref = weakref.ref(obj)
    del obj
    gc.collect()
    assert ref() is None


def test_guard_cache_and_token_classifier_cache_share_one_runtime(monkeypatch):
    import nlp.dependencies as deps
    from nlp.core import guard_model_reference
    from nlp.core.weight_registry import reset_weight_registry
    from nlp.services.gliner2_guard import Gliner2GuardService

    reset_weight_registry()
    loads: list[str] = []
    monkeypatch.setattr(Gliner2GuardService, "load", lambda self: loads.append(self.model_id))
    monkeypatch.setattr(guard_model_reference, "resolve_guard_weights_source", lambda n, p: n)

    async def weights_source(name, path):
        return name

    monkeypatch.setattr(deps, "_weights_source", weights_source)

    async def scenario():
        guard = await deps._create_gliner2_guard(MODEL)
        tokens = await deps._create_gliner_token_classifier(MODEL, MODEL, None)
        return guard, tokens

    guard, tokens = asyncio.run(scenario())
    assert loads == [MODEL]
    assert tokens._runtime is guard
    reset_weight_registry()


# ── worker recycling ─────────────────────────────────────────────────────


def _guard(rss_mib: float, **limits):
    from nlp.core import bounds, recycle

    bounds.set_bounds(**limits)
    fired: list[str] = []
    g = recycle.RecycleGuard(rss_reader=lambda: rss_mib, shutdown=fired.append)
    return g, fired


def test_recycle_fires_above_rss_threshold_and_only_once():
    g, fired = _guard(7000, recycle_rss_mib=6144)
    g.after_response()
    g.after_response()
    assert fired == ["rss"]


def test_recycle_does_not_fire_below_rss_threshold():
    g, fired = _guard(100, recycle_rss_mib=6144)
    g.after_response()
    assert fired == []


def test_recycle_fires_after_n_requests():
    g, fired = _guard(100, recycle_after_requests=3)
    g.after_response()
    g.after_response()
    assert fired == []
    g.after_response()
    assert fired == ["requests"]


def test_rss_gauge_is_published():
    from nlp.core.metrics import NLP_PROCESS_RSS_BYTES

    g, _ = _guard(100)
    g.after_response()
    assert NLP_PROCESS_RSS_BYTES._value.get() == 100 * 1024 * 1024


def test_middleware_recycles_after_the_response_is_delivered(client, monkeypatch):
    from nlp.core import bounds, recycle

    fired: list[str] = []
    bounds.set_bounds(max_input_chars=5, recycle_rss_mib=1)
    monkeypatch.setattr(recycle, "_current_rss_mib", lambda: 5000.0)
    monkeypatch.setattr(recycle, "_request_shutdown", fired.append)
    recycle.reset_recycle_guard()
    body = {"text": "x" * 6, "model_name": MODEL, "labels": ["e"], "tenant_id": TENANT}
    response = client.post("/api/v1/guard/pii", json=body)
    assert response.status_code == 413  # the in-flight response still completes
    assert fired == ["rss"]


def test_rss_reader_returns_a_positive_number():
    from nlp.core import recycle

    assert recycle._current_rss_mib() > 0
