"""TASK-1055 lane N — nlp places a model on the GPU the admin chose.

Contract: `tests/contracts/model-residency-task1055.fixture.json` → `python`
(`loadRequest.device`, `report.devices` lists EVERY GPU, the same model on two
devices is two entries) and `deviceIds.agent` (`cuda:<n>` / `cpu`).

* the planner takes `device`; `cuda:<i>` → a cache bound to that GPU, `None` →
  today's default, an unknown id → `DeviceUnavailable`;
* one cache per (slot, device), lazily built with the same retention;
* request traffic stays on the default-device cache unless the model is resident
  only on another device;
* the services load ON the requested card (`pipeline(device=N)`, `.to("cuda:N")`).

No GPU and no weights: two fake GPUs stand in for NVML, `torch.cuda` is mocked, and
transformers' loaders are replaced.
"""

from __future__ import annotations

import asyncio
import sys
import types
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

GUARD = "fastino/gliguard-LLMGuardrails-300M"


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _fake_gpu(index: int) -> Any:
    from hope_runtime_models import Device
    from hope_runtime_models.vram import DeviceMemory

    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=8 << 30, total_bytes=16 << 30),
        usage=lambda: 8 << 30,
    )


@pytest.fixture
def two_gpus(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Two visible GPUs; the default placement stays the configured `cpu`."""
    import nlp.core.device as device_module
    import nlp.dependencies as deps
    import nlp.residency as residency

    monkeypatch.setattr(residency, "gpu_devices", lambda *a, **k: [_fake_gpu(0), _fake_gpu(1)])
    monkeypatch.setattr(device_module.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(device_module.torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(deps, "release_accelerator_memory", lambda device_id=None: None)
    residency.nlp_device.cache_clear()
    deps.reset_model_caches()
    yield
    deps.reset_model_caches()
    residency.nlp_device.cache_clear()


@pytest.fixture
def factories(two_gpus: None, monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Every cache factory records `(key, device)` instead of loading weights."""
    import nlp.dependencies as deps

    calls: dict[str, list[Any]] = {}

    class _Loaded:
        def __init__(self, key: str, device: str | None) -> None:
            self.key, self.placement = key, device

        async def shutdown(self) -> None:
            pass

    def fake(name: str) -> Any:
        calls[name] = []

        async def factory(key: str, device: str | None = None) -> _Loaded:
            calls[name].append((key, device))
            deps._pending_entailment_calibration.pop(key, None)
            return _Loaded(key, device)

        return factory

    for name in (
        "_create_token_classifier",
        "_create_text_classifier",
        "_create_medical_suggester",
        "_create_gliner2_guard",
        "_create_entailment_scorer",
        "_create_seq_cls_guard",
        "_create_judge_guard",
    ):
        monkeypatch.setattr(deps, name, fake(name))
    return calls


# ── core/device.py: `cuda:N` ────────────────────────────────────────────────


def test_an_indexed_cuda_device_resolves_when_present(two_gpus: None) -> None:
    from nlp.core.device import resolve_inference_device

    assert resolve_inference_device("cuda:1") == "cuda:1"
    assert resolve_inference_device("CUDA:0") == "cuda:0"


def test_an_indexed_cuda_device_past_the_last_card_fails_closed(two_gpus: None) -> None:
    from nlp.core.device import DevicePlacementError, resolve_inference_device

    with pytest.raises(DevicePlacementError):
        resolve_inference_device("cuda:2")


def test_an_indexed_cuda_device_without_cuda_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    import nlp.core.device as device_module

    monkeypatch.setattr(device_module.torch.cuda, "is_available", lambda: False)
    with pytest.raises(device_module.DevicePlacementError):
        device_module.resolve_inference_device("cuda:0")


def test_device_helpers() -> None:
    from nlp.core.device import cuda_index, device_label, pipeline_device

    assert [device_label(d) for d in ("cuda:1", "cuda", "mps", "cpu")] == [
        "cuda",
        "cuda",
        "mps",
        "cpu",
    ]
    assert [cuda_index(d) for d in ("cuda:1", "cuda", "cpu")] == [1, 0, None]
    assert [pipeline_device(d) for d in ("cuda:1", "cuda", "cpu")] == [1, 0, -1]


# ── services load ON the requested card ─────────────────────────────────────


def _fake_transformers(monkeypatch: pytest.MonkeyPatch, module: Any) -> tuple[MagicMock, Any]:
    model = MagicMock(name="model")
    model.config.id2label = {0: "O"}
    pipeline = MagicMock(name="pipeline")
    for loader in ("AutoTokenizer", "AutoModelForTokenClassification"):
        if hasattr(module, loader):
            fake = MagicMock()
            fake.from_pretrained.return_value = model if "Model" in loader else MagicMock()
            monkeypatch.setattr(module, loader, fake)
    if hasattr(module, "AutoModelForSequenceClassification"):
        fake = MagicMock()
        fake.from_pretrained.return_value = model
        monkeypatch.setattr(module, "AutoModelForSequenceClassification", fake)
    monkeypatch.setattr(module, "pipeline", pipeline)
    return pipeline, model


def test_token_classifier_loads_on_the_requested_gpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from nlp.core.config import TokenClassificationConfig
    from nlp.services import token_classifier as module

    pipeline, model = _fake_transformers(monkeypatch, module)
    classifier = module.TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="ner", tokenizer_name="ner"), device="cuda:1"
    )

    _run(classifier.initialize())

    model.to.assert_called_with("cuda:1")
    assert pipeline.call_args.kwargs["device"] == 1
    assert classifier._device == "cuda"  # noqa: SLF001 — the metering label, not the id
    assert classifier.placement == "cuda:1"


def test_token_classifier_on_cpu_stays_on_cpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from nlp.core.config import TokenClassificationConfig
    from nlp.services import token_classifier as module

    pipeline, model = _fake_transformers(monkeypatch, module)
    classifier = module.TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="ner", tokenizer_name="ner"), device="cpu"
    )

    _run(classifier.initialize())

    assert pipeline.call_args.kwargs["device"] == -1
    assert classifier._device == "cpu"  # noqa: SLF001


def test_text_classifier_loads_on_the_requested_gpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from nlp.core.config import TextClassificationConfig
    from nlp.services import text_classifier as module

    pipeline, model = _fake_transformers(monkeypatch, module)
    classifier = module.TransformerTextClassifier(
        config=TextClassificationConfig(model_name="clinical/doc-type"), device="cuda:1"
    )

    _run(classifier.initialize())

    model.to.assert_called_with("cuda:1")
    assert pipeline.call_args.kwargs["device"] == 1


def test_medical_suggester_puts_both_models_on_the_requested_gpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from nlp.core.config import MedicalSuggesterConfig, TokenClassificationConfig
    from nlp.services import medical_suggester as module
    from nlp.services import token_classifier as ner_module

    pipeline, model = _fake_transformers(monkeypatch, module)
    ner_pipeline, ner_model = _fake_transformers(monkeypatch, ner_module)
    suggester = module.MedicalSuggester(
        config=MedicalSuggesterConfig(model_name="disease", tokenizer_name="disease"),
        token_classifier=ner_module.TransformerTokenClassifier(
            configs=TokenClassificationConfig(model_name="ner", tokenizer_name="ner"),
            device="cuda:1",
        ),
        device="cuda:1",
    )

    _run(suggester.initialize())

    model.to.assert_called_with("cuda:1")
    assert pipeline.call_args.kwargs["device"] == 1
    assert ner_pipeline.call_args.kwargs["device"] == 1


def test_guard_services_report_the_label_and_keep_the_id() -> None:
    from nlp.services.gliner2_guard import Gliner2GuardService
    from nlp.services.qwen3guard_judge import Qwen3GuardJudgeService
    from nlp.services.seq_cls_guard import SeqClsGuardService

    for cls in (Gliner2GuardService, SeqClsGuardService, Qwen3GuardJudgeService):
        service = cls(weights_source=GUARD, model_id=GUARD, device="cuda:1")
        assert (service.device, service.placement) == ("cuda", "cuda:1")


def test_the_gliner2_factory_places_on_the_requested_gpu_with_its_own_weights(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nlp.dependencies as deps
    from nlp.core import guard_model_reference
    from nlp.core.weight_registry import reset_weight_registry
    from nlp.services.gliner2_guard import Gliner2GuardService

    reset_weight_registry()
    monkeypatch.setattr(Gliner2GuardService, "load", lambda self: None)
    monkeypatch.setattr(guard_model_reference, "resolve_guard_weights_source", lambda n, p: n)

    async def scenario() -> tuple[Any, Any]:
        return (
            await deps._create_gliner2_guard(GUARD),
            await deps._create_gliner2_guard(GUARD, device="cuda:1"),
        )

    default, placed = _run(scenario())
    reset_weight_registry()

    assert placed.placement == "cuda:1"
    assert default.placement == "cpu"
    assert placed is not default  # one copy PER DEVICE, never shared across cards


def test_the_entailment_factory_pins_llama_cpp_to_the_requested_gpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nlp.dependencies as deps
    from nlp.services import entailment_scorer

    specs: list[Any] = []
    monkeypatch.setattr(entailment_scorer, "load_minicheck_scorer", specs.append)

    _run(deps._create_entailment_scorer("minicheck\x00/models/m.gguf", device="cuda:1"))
    _run(deps._create_entailment_scorer("minicheck\x00/models/m.gguf"))

    assert [spec.main_gpu for spec in specs] == [1, None]


def test_an_unplaced_gpu_entailment_load_stays_on_the_first_gpu(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With CUDA_VISIBLE_DEVICES=0,1 llama.cpp would split an unplaced load over both
    # cards; a GPU-offloaded load nobody placed stays whole on cuda:0.
    import nlp.dependencies as deps
    from nlp.core.config import settings
    from nlp.services import entailment_scorer

    specs: list[Any] = []
    monkeypatch.setattr(entailment_scorer, "load_minicheck_scorer", specs.append)
    monkeypatch.setattr(settings.service, "entailment_n_gpu_layers", -1)

    _run(deps._create_entailment_scorer("minicheck\x00/models/m.gguf"))

    assert specs[0].main_gpu == 0


def test_load_minicheck_passes_main_gpu_and_no_split(monkeypatch: pytest.MonkeyPatch) -> None:
    from nlp.services import entailment_scorer as module

    seen: dict[str, Any] = {}

    class _Llama:
        def __init__(self, **kwargs: Any) -> None:
            seen.update(kwargs)
            raise RuntimeError("stop here")  # the load is all this test is about

    fake = types.ModuleType("llama_cpp")
    fake.Llama = _Llama  # type: ignore[attr-defined]
    fake.LLAMA_SPLIT_MODE_NONE = 0  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "llama_cpp", fake)
    calibration = module.EntailmentCalibration.model_construct(
        adapter=module.MINICHECK_ADAPTER,
        label_token_no=module.MINICHECK_LABEL_TOKEN_NO,
        label_token_yes=module.MINICHECK_LABEL_TOKEN_YES,
    )
    spec = module.MiniCheckLoadSpec(
        model_id="m", model_path="/m.gguf", calibration=calibration, n_gpu_layers=-1, main_gpu=1
    )

    with pytest.raises(module.NliModelUnavailableError):
        module.load_minicheck_scorer(spec)

    assert (seen["main_gpu"], seen["split_mode"]) == (1, 0)


# ── planner: (slot, device) caches ──────────────────────────────────────────


def test_a_load_on_cuda_1_is_bound_to_cuda_1(factories: dict[str, list[Any]]) -> None:
    import nlp.dependencies as deps
    from nlp.residency import _plan

    spec = {"cache": "nlp_gliner2_guard", "model_path": None}

    async def scenario() -> Any:
        plan = await _plan(GUARD, spec, device="cuda:1")
        await plan.load()
        return plan

    plan = _run(scenario())

    assert plan.cache.residency.device.id == "cuda:1"
    assert plan.cache is not deps._gliner2_guard_cache()
    assert plan.key == GUARD
    assert factories["_create_gliner2_guard"] == [(GUARD, "cuda:1")]


@pytest.mark.parametrize(
    "spec",
    [
        {"cache": "nlp_token_classifier", "model_path": None},
        {"cache": "nlp_text_classifier", "model_path": None},
        {"cache": "nlp_medical_suggester", "model_path": None, "ner_model_name": "ner"},
        {"cache": "nlp_entailment_scorer", "model_path": "/m.gguf", "calibration": None},
    ],
)
def test_every_planned_slot_honours_the_device(
    spec: dict[str, Any], factories: dict[str, list[Any]]
) -> None:
    from nlp.residency import _plan

    async def scenario() -> Any:
        plan = await _plan("some/model", spec, device="cuda:0")
        await plan.load()
        return plan

    plan = _run(scenario())

    assert plan.cache.residency.device.id == "cuda:0"
    assert [device for calls in factories.values() for _, device in calls] == ["cuda:0"]


def test_no_device_and_the_default_id_both_plan_onto_the_default_cache(
    factories: dict[str, list[Any]],
) -> None:
    import nlp.dependencies as deps
    from nlp.residency import _plan

    spec = {"cache": "nlp_gliner2_guard", "model_path": None}

    async def scenario() -> list[Any]:
        return [await _plan(GUARD, spec), await _plan(GUARD, spec, device="cpu")]

    plans = _run(scenario())

    assert all(plan.cache is deps._gliner2_guard_cache() for plan in plans)


def test_an_unknown_device_is_device_unavailable(factories: dict[str, list[Any]]) -> None:
    from hope_runtime_models.residency_agent import DeviceUnavailable

    from nlp.residency import _plan

    with pytest.raises(DeviceUnavailable):
        _run(_plan(GUARD, {"cache": "nlp_gliner2_guard"}, device="cuda:7"))
    with pytest.raises(DeviceUnavailable):
        _run(_plan(GUARD, {}, device="cuda:7"))


def test_one_cache_per_slot_and_device_with_the_same_retention(
    factories: dict[str, list[Any]],
) -> None:
    import nlp.dependencies as deps

    deps.apply_model_cache_retention({"ttl_seconds": 900, "max_models": 2})
    placed = deps._gliner2_guard_cache("cuda:1")

    assert deps._gliner2_guard_cache("cuda:1") is placed
    assert deps._gliner2_guard_cache("cuda:0") is not placed
    assert placed.stats().ttl_seconds == deps._gliner2_guard_cache().stats().ttl_seconds == 900
    assert placed.stats().max_size == 2

    deps.apply_model_cache_retention({"ttl_seconds": 1200})
    assert placed.stats().ttl_seconds == 1200  # live per-device caches follow the control plane
    assert placed in deps._live_caches()


# ── request traffic ─────────────────────────────────────────────────────────


def test_requests_route_to_the_only_device_holding_the_model(
    factories: dict[str, list[Any]],
) -> None:
    import nlp.dependencies as deps

    async def scenario() -> list[str | None]:
        await deps._gliner2_guard_cache("cuda:1").get(GUARD)
        async with deps.pinned_gliner2_guard(GUARD) as only_on_cuda_1:
            placements = [only_on_cuda_1.placement]
        await deps._gliner2_guard_cache().get(GUARD)
        async with deps.pinned_gliner2_guard(GUARD) as also_on_default:
            placements.append(also_on_default.placement)
        async with deps.pinned_gliner2_guard("not/resident") as cold:
            placements.append(cold.placement)
        return placements

    assert _run(scenario()) == ["cuda:1", None, None]


@pytest.mark.parametrize(
    ("pinned", "accessor", "args"),
    [
        ("pinned_token_classifier", "_token_classifier_cache", ("m",)),
        ("pinned_text_classifier", "_text_classifier_cache", ("m",)),
        ("pinned_seq_cls_guard", "_seq_cls_guard_cache", ("m",)),
        ("pinned_judge_guard", "_judge_guard_cache", ("m",)),
    ],
)
def test_every_pinned_resolver_routes(
    pinned: str, accessor: str, args: tuple[str, ...], factories: dict[str, list[Any]]
) -> None:
    import nlp.dependencies as deps

    async def scenario() -> Any:
        await getattr(deps, accessor)("cuda:0").get("m")
        async with getattr(deps, pinned)(*args) as service:
            return service.placement

    assert _run(scenario()) == "cuda:0"


# ── the agent report ────────────────────────────────────────────────────────


@pytest.fixture
def api(factories: dict[str, list[Any]]) -> Iterator[TestClient]:
    import nlp.residency as residency

    residency.nlp_residency_agent.cache_clear()
    app = FastAPI()
    app.include_router(residency.residency_router())
    with TestClient(app) as client:
        yield client
    residency.nlp_residency_agent.cache_clear()


def test_the_report_lists_every_gpu_before_anything_loads(api: TestClient) -> None:
    ids = [device["id"] for device in api.get("/internal/residency").json()["devices"]]

    assert ids[:2] == ["cuda:0", "cuda:1"]


def test_the_same_model_on_two_devices_is_two_entries(api: TestClient) -> None:
    spec = {"cache": "nlp_gliner2_guard", "model_path": None}
    on_gpu = api.post(
        "/internal/residency/load",
        json={"model_ref": GUARD, "load_spec": spec, "device": "cuda:1"},
    )
    on_default = api.post("/internal/residency/load", json={"model_ref": GUARD, "load_spec": spec})

    assert on_gpu.status_code == 200, on_gpu.text
    assert on_gpu.json()["model"]["device"] == "cuda:1"
    assert on_default.json()["model"]["device"] == "cpu"
    models = api.get("/internal/residency").json()["models"]
    assert sorted((m["cache"], m["device"]) for m in models) == [
        ("nlp_gliner2_guard", "cpu"),
        ("nlp_gliner2_guard", "cuda:1"),
    ]

    unloaded = api.post("/internal/residency/unload", json={"model_ref": GUARD, "device": "cuda:1"})
    assert unloaded.json()["outcome"] == "unloaded"
    remaining = api.get("/internal/residency").json()["models"]
    assert [m["device"] for m in remaining] == ["cpu"]


def test_an_unknown_device_on_the_wire_is_400(api: TestClient) -> None:
    response = api.post(
        "/internal/residency/load",
        json={"model_ref": GUARD, "load_spec": {"cache": "nlp_gliner2_guard"}, "device": "cuda:2"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "DEVICE_UNAVAILABLE"


def test_the_default_device_follows_an_indexed_inference_device(
    two_gpus: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nlp.residency as residency
    from nlp.core.config import settings

    monkeypatch.setattr(settings.service, "inference_device", "cuda:1")
    residency.nlp_device.cache_clear()

    assert residency.nlp_device().id == "cuda:1"
