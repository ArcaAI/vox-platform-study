"""TASK-776 — `Gliner2GuardService` drives the runtime's BATCH verbs.

`gliner2==1.3.2` ships `batch_extract_entities(texts, entity_types, batch_size=…)`
and `batch_classify_text(texts, tasks, batch_size=…)`, which push N texts through
ONE encoder pass. TASK-735 wired only the single-text verbs, so 100 concurrent
sessions meant 100 sequential passes.

Also pinned here: the real runtime reports a span's confidence under the key
`confidence`, NOT `score` (verified against `fastino/gliner2-privacy-filter-PII-multi`
weights on 2026-08-19). The TASK-735 normaliser read `score` only, so every real
span came back with `score: 0.0` — below any caller threshold, which turns a
detected identifier into an invisible one. That is a PHI-leak-shaped bug, so it
gets an explicit test.
"""

from __future__ import annotations

import pytest

from nlp.services.gliner2_guard import Gliner2GuardService


class FakeRuntime:
    """Mimics the real `gliner2` return shapes (grouped by label, `confidence`)."""

    def __init__(self) -> None:
        self.batch_calls: list[tuple[list[str], int]] = []
        self.single_calls = 0

    def extract_entities(self, text, entity_types, **kw):  # noqa: ANN001, ANN003
        self.single_calls += 1
        return self._entities(text)

    def batch_extract_entities(
        self, texts, entity_types, batch_size=8, **kw
    ):  # noqa: ANN001, ANN003
        self.batch_calls.append((list(texts), batch_size))
        return [self._entities(t) for t in texts]

    def classify_text(self, text, tasks, **kw):  # noqa: ANN001, ANN003
        self.single_calls += 1
        return {"prompt_safety": "safe"}

    def batch_classify_text(self, texts, tasks, batch_size=8, **kw):  # noqa: ANN001, ANN003
        self.batch_calls.append((list(texts), batch_size))
        return [{"prompt_safety": "safe"} for _ in texts]

    @staticmethod
    def _entities(text: str) -> dict:
        idx = text.find("jane@roe.example")
        if idx < 0:
            return {"entities": {}}
        return {
            "entities": {
                "email": [
                    {
                        "text": "jane@roe.example",
                        "confidence": 0.9993,
                        "start": idx,
                        "end": idx + len("jane@roe.example"),
                    }
                ]
            }
        }


def _service() -> tuple[Gliner2GuardService, FakeRuntime]:
    service = Gliner2GuardService(weights_source="unused", model_id="unused")
    runtime = FakeRuntime()
    service.runtime = runtime
    return service, runtime


@pytest.mark.asyncio
async def test_confidence_is_read_from_the_runtimes_own_key() -> None:
    """`confidence`, not `score` — a zeroed score hides a detected identifier."""
    service, _ = _service()
    entities = await service.extract_entities("Mail jane@roe.example now", ["email"], 0.5)
    assert len(entities) == 1
    assert entities[0]["score"] == pytest.approx(0.9993)
    assert entities[0]["label"] == "email"


@pytest.mark.asyncio
async def test_batch_extraction_uses_one_forward_pass_for_many_texts() -> None:
    service, runtime = _service()
    texts = ["urgent: mail jane@roe.example", "nothing here"]
    results = await service.batch_extract_entities(texts, ["email"], 0.5)

    assert runtime.single_calls == 0, "the batch verb must not fall back to N single calls"
    assert len(runtime.batch_calls) == 1
    assert runtime.batch_calls[0][0] == texts
    assert len(results) == len(texts)
    assert len(results[0]) == 1 and results[1] == []


@pytest.mark.asyncio
async def test_batch_offsets_stay_bound_to_their_own_text() -> None:
    """Offsets index the text they came from — a cross-bound offset redacts the wrong span."""
    service, _ = _service()
    texts = ["jane@roe.example", "hello there, mail jane@roe.example"]
    results = await service.batch_extract_entities(texts, ["email"], 0.5)
    for text, entities in zip(texts, results, strict=True):
        for entity in entities:
            assert text[entity["start"] : entity["end"]] == entity["text"]


@pytest.mark.asyncio
async def test_batch_classification_uses_one_forward_pass() -> None:
    service, runtime = _service()
    tasks = {"prompt_safety": {"labels": ["safe", "unsafe"], "multi_label": False}}
    results = await service.batch_classify_text(["a", "b", "c"], tasks, 0.5)

    assert runtime.single_calls == 0
    assert len(runtime.batch_calls) == 1
    assert results == [{"prompt_safety": "safe"}] * 3


@pytest.mark.asyncio
async def test_an_empty_batch_never_touches_the_runtime() -> None:
    service, runtime = _service()
    assert await service.batch_extract_entities([], ["email"], 0.5) == []
    assert await service.batch_classify_text([], {}, 0.5) == []
    assert runtime.batch_calls == [] and runtime.single_calls == 0
