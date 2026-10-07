"""A guard batcher runs each batch with ITS OWN group's schema, not the first caller's.

The batcher for one (weight slot, verb, lane) is built once and cached for the life of
the process. The batch callback used to close over the FIRST request's task schema and
threshold, so every later request on that slot was answered under them: GLiGuard's
outbound `response_*` tasks came back empty (the slot was first used by an inbound
`prompt_*` call) and an edited `cls_threshold` never took effect (TASK-1050 e2e S5/S6).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

TENANT = "11111111-1111-1111-1111-111111111111"
MODEL = "acme/guard"


@pytest.fixture(autouse=True)
def _fresh_dispatch():
    from nlp.services import guard_dispatch

    asyncio.run(guard_dispatch.reset_guard_batchers())
    yield
    asyncio.run(guard_dispatch.reset_guard_batchers())


class RecordingGuard:
    """Answers every requested task, and records the schema each pass ran under."""

    def __init__(self) -> None:
        self.classify_calls: list[tuple[list[str], float]] = []
        self.pii_calls: list[tuple[list[str], float]] = []

    async def batch_classify_text(self, texts, tasks, threshold, batch_size=8):  # noqa: ANN001
        self.classify_calls.append((sorted(tasks), threshold))
        return [{name: spec["labels"][0] for name, spec in tasks.items()} for _ in texts]

    async def batch_extract_entities(self, texts, labels, threshold, batch_size=8):  # noqa: ANN001
        self.pii_calls.append((list(labels), threshold))
        return [[] for _ in texts]


def _fake_acquire(service):
    @asynccontextmanager
    async def _acquire(model_name, model_path=None):
        yield service

    return _acquire


def _task(*labels: str) -> dict:
    return {"labels": list(labels), "multi_label": False}


def test_a_later_request_with_other_tasks_is_answered_under_its_own_schema(
    client, monkeypatch
) -> None:
    import nlp.api.v1.rest.guard as guard_module

    guard = RecordingGuard()
    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(guard))

    inbound = {
        "text": "a",
        "model_name": MODEL,
        "tenant_id": TENANT,
        "tasks": {"prompt_safety": _task("safe", "unsafe")},
    }
    outbound = {
        "text": "b",
        "model_name": MODEL,
        "tenant_id": TENANT,
        "tasks": {"response_safety": _task("safe", "unsafe")},
    }

    assert client.post("/api/v1/guard/classify", json=inbound).json()["results"] == {
        "prompt_safety": "safe"
    }
    second = client.post("/api/v1/guard/classify", json=outbound)

    assert second.status_code == 200
    assert second.json()["results"] == {"response_safety": "safe"}
    assert guard.classify_calls == [(["prompt_safety"], 0.5), (["response_safety"], 0.5)]


def test_a_changed_threshold_reaches_the_runtime(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module

    guard = RecordingGuard()
    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(guard))
    body = {
        "text": "a",
        "model_name": MODEL,
        "tenant_id": TENANT,
        "tasks": {"prompt_safety": _task("safe", "unsafe")},
    }

    client.post("/api/v1/guard/classify", json=body)
    client.post("/api/v1/guard/classify", json={**body, "threshold": 0.9})

    assert [threshold for _tasks, threshold in guard.classify_calls] == [0.5, 0.9]


def test_a_later_pii_request_runs_its_own_labels(client, monkeypatch) -> None:
    import nlp.api.v1.rest.guard as guard_module

    guard = RecordingGuard()
    monkeypatch.setattr(guard_module, "_acquire_guard", _fake_acquire(guard))

    client.post(
        "/api/v1/guard/pii",
        json={"text": "a", "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT},
    )
    client.post(
        "/api/v1/guard/pii",
        json={"text": "b", "model_name": MODEL, "labels": ["person"], "tenant_id": TENANT},
    )

    assert [labels for labels, _threshold in guard.pii_calls] == [["email"], ["person"]]
