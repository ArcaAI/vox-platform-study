"""TASK-1055 follow-up (D2, the reverse duplicate) — clinical NER sends ``model_path``.

``apps/nlp`` caches a token classifier by ``(model_name, model_path)``. The admin
residency load and the agent-invocation path send both (``model_path`` is the
gateway's ``derivedLocalPath(row)``, surfaced to the worker as ``localPath``), so a
name-only clinical NER call that loaded first created a copy a later admin load could
not recognise. The worker now forwards the resolved ``localPath`` exactly as
``core.classify`` does, and stays name-only when the row has no published path.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.services.nlp_client import NlpClient
from harness.temporal import activities

_PUBLISHED = {
    "slug": "medical-ner",
    "taskType": "TOKEN_CLASSIFICATION",
    "sourceUri": "blaze999/Medical-NER",
    "localPath": "/mnt/models-bucket/nlp/medical-ner/",
}


class _Api:
    def __init__(self, model: dict[str, Any]) -> None:
        self._model = model

    async def resolve_task_model(self, task_key: str, *, tenant_id: str) -> dict[str, Any]:
        return dict(self._model)


def _capture(monkeypatch: pytest.MonkeyPatch, model: dict[str, Any]) -> list[dict[str, Any]]:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"entities": [], "model_version": "m"})

    client = NlpClient("http://nlp", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(activities, "_api_client", lambda settings: _Api(model))
    monkeypatch.setattr(activities, "_nlp_client", lambda settings: client)
    return bodies


async def test_sends_the_resolved_local_path_as_model_path(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies = _capture(monkeypatch, _PUBLISHED)

    await activities._extract_clinical_entities(object(), "note", tenant_id="t1")  # type: ignore[arg-type]

    assert len(bodies) == 1
    assert bodies[0]["model_name"] == "blaze999/Medical-NER"
    assert bodies[0]["model_path"] == "/mnt/models-bucket/nlp/medical-ner/"


@pytest.mark.parametrize("local_path", [None, ""])
async def test_stays_name_only_without_a_published_path(
    monkeypatch: pytest.MonkeyPatch, local_path: str | None
) -> None:
    bodies = _capture(monkeypatch, {**_PUBLISHED, "localPath": local_path})

    await activities._extract_clinical_entities(object(), "note", tenant_id="t1")  # type: ignore[arg-type]

    assert bodies[0]["model_name"] == "blaze999/Medical-NER"
    assert "model_path" not in bodies[0]


async def test_ignores_a_non_string_local_path(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies = _capture(monkeypatch, {**_PUBLISHED, "localPath": 42})

    await activities._extract_clinical_entities(object(), "note", tenant_id="t1")  # type: ignore[arg-type]

    assert "model_path" not in bodies[0]
