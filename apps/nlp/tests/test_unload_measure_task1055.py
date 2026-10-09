"""TASK-1055 lane N — nlp unload returns the memory, and sizes are measured honestly.

Live finding E6/E7 (2026-10-09): unloading GLiGuard / Medical NER evicted them from
the cache but GPU memory did not drop, and their re-measured sizes collapsed. The
causes: no-op / partial ``shutdown()``s, no accelerator release after an unload,
and footprints read off a device-wide free-memory delta.

Contract (`tests/contracts/model-residency-task1055.fixture.json` →
`python.unloadSemantics`): an unload drops every reference (cache entry,
``shutdown()``, weight registry), gc's, then calls
``release_accelerator_memory(<the cache's device>)``.

No GPU, no weights: services are given tiny CPU torch modules or plain fakes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
import torch.nn as nn

MODEL = "vendor/some-model"


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


@pytest.fixture
def releases(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str | None]]:
    """Fresh caches; `release_accelerator_memory` records the device it was asked to free."""
    import nlp.dependencies as deps
    from nlp.core.weight_registry import reset_weight_registry

    calls: list[str | None] = []
    monkeypatch.setattr(deps, "release_accelerator_memory", calls.append)
    deps.reset_model_caches()
    reset_weight_registry()
    yield calls
    deps.reset_model_caches()
    reset_weight_registry()


def _pipeline() -> SimpleNamespace:
    return SimpleNamespace(model=nn.Linear(4, 4), tokenizer=object())


# ── real shutdown()s ────────────────────────────────────────────────────────


def test_token_classifier_shutdown_drops_model_tokenizer_and_pipeline_refs() -> None:
    from nlp.core.config import TokenClassificationConfig
    from nlp.services.token_classifier import TransformerTokenClassifier

    classifier = TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name=MODEL, tokenizer_name=MODEL)
    )
    pipe = _pipeline()
    classifier.pipeline, classifier.model, classifier.tokenizer = pipe, pipe.model, pipe.tokenizer
    classifier.is_initialized = True

    _run(classifier.shutdown())

    assert classifier.pipeline is None and classifier.model is None
    assert classifier.tokenizer is None and classifier.is_initialized is False
    # The pipeline object itself may outlive us (a caller's local): it must not keep weights.
    assert pipe.model is None and pipe.tokenizer is None


def test_text_classifier_shutdown_drops_the_pipeline_model_too() -> None:
    from nlp.core.config import TextClassificationConfig
    from nlp.services.text_classifier import TransformerTextClassifier

    classifier = TransformerTextClassifier(config=TextClassificationConfig(model_name=MODEL))
    pipe = _pipeline()
    classifier.pipeline, classifier.model, classifier.tokenizer = pipe, pipe.model, pipe.tokenizer

    _run(classifier.shutdown())

    assert pipe.model is None and pipe.tokenizer is None and classifier.pipeline is None


def test_medical_suggester_shutdown_drops_its_classifier_and_its_ner() -> None:
    from nlp.core.config import MedicalSuggesterConfig, TokenClassificationConfig
    from nlp.services.medical_suggester import MedicalSuggester
    from nlp.services.token_classifier import TransformerTokenClassifier

    ner = TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="ner", tokenizer_name="ner")
    )
    ner_pipe = _pipeline()
    ner.pipeline, ner.model = ner_pipe, ner_pipe.model
    suggester = MedicalSuggester(
        config=MedicalSuggesterConfig(model_name=MODEL, tokenizer_name=MODEL),
        token_classifier=ner,
    )
    pipe = _pipeline()
    suggester.text_classifier_pipeline = pipe
    # NOT initialized: a half-built suggester (failed NER init) must still free what it holds.
    suggester.is_initialized = False

    _run(suggester.shutdown())

    assert suggester.text_classifier_pipeline is None and pipe.model is None
    assert ner.model is None and ner_pipe.model is None


def test_gliner2_guard_service_has_a_real_shutdown() -> None:
    from nlp.services.gliner2_guard import Gliner2GuardService

    service = Gliner2GuardService(weights_source=MODEL, model_id=MODEL)
    service.runtime = nn.Linear(2, 2)

    service.shutdown()

    assert service.runtime is None


def test_entailment_scorer_shutdown_drops_the_llama_handle_and_closes_it() -> None:
    from nlp.services.entailment_scorer import EntailmentCalibration, LlamaCppMiniCheckScorer

    closed: list[bool] = []
    calibration = EntailmentCalibration.model_construct()
    scorer = LlamaCppMiniCheckScorer(
        lambda prompt: (0.0, 1.0), calibration, close=lambda: closed.append(True)
    )

    scorer.shutdown()
    scorer.shutdown()  # idempotent

    assert closed == [True]
    assert scorer._logit_fn is None


# ── the unload hook on every cache ──────────────────────────────────────────


class _Async:
    def __init__(self) -> None:
        self.shut_down = 0

    async def shutdown(self) -> None:
        self.shut_down += 1


class _Sync:
    def __init__(self) -> None:
        self.shut_down = 0

    def shutdown(self) -> None:
        self.shut_down += 1


_SLOTS = {
    "nlp_token_classifier": ("_token_classifier_cache", "_create_token_classifier", _Async),
    "nlp_text_classifier": ("_text_classifier_cache", "_create_text_classifier", _Async),
    "nlp_medical_suggester": ("_medical_suggester_cache", "_create_medical_suggester", _Async),
    "nlp_gliner2_guard": ("_gliner2_guard_cache", "_create_gliner2_guard", _Sync),
    "nlp_seq_cls_guard": ("_seq_cls_guard_cache", "_create_seq_cls_guard", _Sync),
    "nlp_judge_guard": ("_judge_guard_cache", "_create_judge_guard", _Sync),
    "nlp_entailment_scorer": ("_entailment_scorer_cache", "_create_entailment_scorer", _Sync),
}


@pytest.mark.parametrize("slot", sorted(_SLOTS))
def test_unload_calls_the_real_shutdown_then_releases_the_cache_device(
    slot: str, monkeypatch: pytest.MonkeyPatch, releases: list[str | None]
) -> None:
    import nlp.dependencies as deps

    accessor, factory_name, kind = _SLOTS[slot]
    instance = kind()

    async def factory(key: str, **_: Any) -> Any:
        return instance

    monkeypatch.setattr(deps, factory_name, factory)

    async def scenario() -> tuple[bool, str]:
        cache = getattr(deps, accessor)()
        await cache.get(MODEL)
        return await cache.unload(MODEL), cache.residency.device.id

    unloaded, device_id = _run(scenario())

    assert unloaded is True
    assert instance.shut_down == 1
    assert releases == [device_id]


def test_a_ttl_or_lru_eviction_also_releases(
    monkeypatch: pytest.MonkeyPatch, releases: list[str | None]
) -> None:
    import nlp.dependencies as deps

    made: list[_Async] = []

    async def factory(key: str, **_: Any) -> _Async:
        made.append(_Async())
        return made[-1]

    monkeypatch.setattr(deps, "_create_text_classifier", factory)

    async def scenario() -> None:
        cache = deps._text_classifier_cache()
        cache.configure(max_size=1)
        await cache.get("a")
        await cache.get("b")  # LRU-evicts "a"

    _run(scenario())

    assert made[0].shut_down == 1 and made[1].shut_down == 0
    assert releases == ["cpu"]


def test_a_failing_shutdown_still_releases_the_device(
    monkeypatch: pytest.MonkeyPatch, releases: list[str | None]
) -> None:
    import nlp.dependencies as deps

    class _Broken:
        async def shutdown(self) -> None:
            raise RuntimeError("boom")

    async def factory(key: str, **_: Any) -> _Broken:
        return _Broken()

    monkeypatch.setattr(deps, "_create_text_classifier", factory)

    async def scenario() -> None:
        cache = deps._text_classifier_cache()
        await cache.get(MODEL)
        await cache.unload(MODEL)

    _run(scenario())

    assert releases == ["cpu"]


# ── the shared GLiNER2 runtime (weight registry) ────────────────────────────


def _shared_runtime(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    import nlp.dependencies as deps
    from nlp.core import guard_model_reference
    from nlp.services.gliner2_guard import Gliner2GuardService

    loaded: list[Any] = []

    def load(self: Gliner2GuardService) -> None:
        self.runtime = nn.Linear(4, 4)
        loaded.append(self)

    monkeypatch.setattr(Gliner2GuardService, "load", load)
    monkeypatch.setattr(guard_model_reference, "resolve_guard_weights_source", lambda n, p: n)

    async def weights_source(name: str, path: str | None) -> str:
        return name

    monkeypatch.setattr(deps, "_weights_source", weights_source)
    monkeypatch.setattr(deps, "read_checkpoint_config", lambda source: {})
    monkeypatch.setattr(deps, "is_gliner_checkpoint", lambda config: True)
    return loaded


def test_the_shared_runtime_survives_one_cache_unloading_and_dies_with_the_last(
    monkeypatch: pytest.MonkeyPatch, releases: list[str | None]
) -> None:
    import nlp.dependencies as deps
    from nlp.core.weight_registry import get_weight_registry

    loaded = _shared_runtime(monkeypatch)

    async def scenario() -> tuple[Any, Any]:
        guard_cache, token_cache = deps._gliner2_guard_cache(), deps._token_classifier_cache()
        guard = await guard_cache.get(MODEL)
        tokens = await token_cache.get(MODEL)
        assert tokens.runtime is guard  # one resident copy (TASK-1047 C8)

        await guard_cache.unload(MODEL)
        alive_after_first = guard.runtime
        await token_cache.unload(MODEL)
        return alive_after_first, guard

    alive_after_first, guard = _run(scenario())

    assert len(loaded) == 1
    assert alive_after_first is not None  # the token cache was still serving it
    assert guard.runtime is None  # the last holder shut it down
    assert get_weight_registry().holders((MODEL, None)) == 0
    assert releases == ["cpu", "cpu"]


def test_the_registry_counts_holders_and_releases_on_the_last() -> None:
    from nlp.core.weight_registry import WeightRegistry

    class Weights:
        pass

    async def loader() -> Weights:
        return Weights()

    async def scenario() -> list[bool]:
        reg = WeightRegistry()
        first = await reg.get_or_load(("m", None), loader)
        second = await reg.get_or_load(("m", None), loader)
        assert first is second
        return [reg.release(("m", None), first), reg.release(("m", None), first)]

    assert _run(scenario()) == [False, True]


def test_an_unregistered_value_is_its_own_last_holder() -> None:
    from nlp.core.weight_registry import WeightRegistry

    assert WeightRegistry().release(("m", None), object()) is True


# ── honest size: parameter + buffer bytes, stable across unload/reload ──────


def _param_bytes(module: nn.Module) -> int:
    return sum(p.numel() * p.element_size() for p in module.parameters()) + sum(
        b.numel() * b.element_size() for b in module.buffers()
    )


def test_every_torch_cache_measures_parameter_bytes_and_llama_keeps_the_delta(
    releases: list[str | None],
) -> None:
    import nlp.dependencies as deps
    from nlp.residency import measure_instance

    measured = {name: deps._cache_for(name)._measure for name in _SLOTS}  # noqa: SLF001

    assert measured.pop("nlp_entailment_scorer") is None
    assert set(measured.values()) == {measure_instance}


def test_measure_reads_each_service_shape() -> None:
    from nlp.core.config import (
        MedicalSuggesterConfig,
        TokenClassificationConfig,
    )
    from nlp.residency import measure_instance
    from nlp.services.gliner2_guard import Gliner2GuardService
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier
    from nlp.services.medical_suggester import MedicalSuggester
    from nlp.services.qwen3guard_judge import Qwen3GuardJudgeService
    from nlp.services.seq_cls_guard import SeqClsGuardService
    from nlp.services.token_classifier import TransformerTokenClassifier

    ner = TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="ner", tokenizer_name="ner")
    )
    ner.model = nn.Linear(8, 8)
    assert measure_instance(ner) == _param_bytes(ner.model)

    suggester = MedicalSuggester(
        config=MedicalSuggesterConfig(model_name=MODEL, tokenizer_name=MODEL), token_classifier=ner
    )
    suggester.text_classifier_pipeline = SimpleNamespace(model=nn.Linear(16, 4), tokenizer=None)
    assert measure_instance(suggester) == _param_bytes(ner.model) + _param_bytes(
        suggester.text_classifier_pipeline.model
    )

    guard = Gliner2GuardService(weights_source=MODEL, model_id=MODEL)
    guard.runtime = nn.Linear(3, 3)
    assert measure_instance(guard) == _param_bytes(guard.runtime)
    assert measure_instance(Gliner2TokenClassifier(MODEL, runtime=guard)) == _param_bytes(
        guard.runtime
    )

    for cls in (SeqClsGuardService, Qwen3GuardJudgeService):
        service = cls(weights_source=MODEL, model_id=MODEL)
        service._model = nn.Linear(5, 5)  # noqa: SLF001
        assert measure_instance(service) == _param_bytes(service._model)  # noqa: SLF001

    assert measure_instance(object()) is None


def test_a_measured_size_is_stable_across_unload_and_reload(
    monkeypatch: pytest.MonkeyPatch, releases: list[str | None]
) -> None:
    import nlp.dependencies as deps
    from nlp.core.config import TokenClassificationConfig
    from nlp.residency import measure_instance
    from nlp.services.token_classifier import TransformerTokenClassifier

    async def factory(key: str, **_: Any) -> TransformerTokenClassifier:
        classifier = TransformerTokenClassifier(
            configs=TokenClassificationConfig(model_name=key, tokenizer_name=key)
        )
        classifier.model = nn.Linear(32, 32)
        classifier.pipeline = SimpleNamespace(model=classifier.model, tokenizer=None)
        return classifier

    monkeypatch.setattr(deps, "_create_token_classifier", factory)

    async def scenario() -> list[int | None]:
        cache = deps._token_classifier_cache()
        sizes = []
        for _ in range(2):
            sizes.append(measure_instance(await cache.get(MODEL)))
            await cache.unload(MODEL)
        return sizes

    first, second = _run(scenario())

    assert first == second == _param_bytes(nn.Linear(32, 32))
