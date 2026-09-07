"""F13 — `core.classify` dispatches on the RESOLVED model's task, not on one hardcoded route.

The node always called nlp `POST /classify/text` (the sequence-classification route), while both
classification-capable rows the platform seeds — `gliner2-guardrails-pii-multi` and `medical-ner`
— are TOKEN_CLASSIFICATION extractors. nlp answered 503 "Text classification model not available"
for every one of them, so every PII/NER node DEGRADED, and every node bound to its `out` port
degraded after it with "no text arrived on the `in` port" (a classification object carries no
`text`).

Two halves are pinned here:

1. **Dispatch.** `ResolvedClassificationModel.task_type` chooses the route —
   TOKEN_CLASSIFICATION → `/classify/tokens`, anything else → `/classify/text` — with the SAME
   gateway-injected `model_name`/`model_path` either way. Nothing is resolved here.
2. **The `out` contract is one shape for both routes.** The classified TEXT rides through on
   `out` beside the classification, so a chain of classify nodes (and any agent bound to one)
   still sees the text it was handed. Spans are emitted for a token model when the node asks
   for them (`spans: true`).
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_TEXT = "Call Ada Lovelace on 555-0100 about her diabetes."

_TOKEN_ROW = {
    "slug": "gliner2-guardrails-pii-multi",
    "taskType": "TOKEN_CLASSIFICATION",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi",
    "localPath": "/mnt/models-bucket/nlp/gliner2-guardrails-pii-multi/",
    "servedBy": "nlp",
}
_TEXT_ROW = {
    "slug": "note-kind-classifier",
    "taskType": "TEXT_CLASSIFICATION",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "sourceUri": "acme/note-kind",
    "localPath": None,
    "servedBy": "nlp",
}

_ENTITIES = [
    {
        "id": "e1",
        "text": "Ada Lovelace",
        "normalized_text": "ada lovelace",
        "entity_type": "person",
        "confidence": 0.93,
        "position": {"start": 5, "end": 17},
    },
    {
        "id": "e2",
        "text": "555-0100",
        "normalized_text": "555-0100",
        "entity_type": "phone_number",
        "confidence": 0.61,
        "position": {"start": 21, "end": 29},
    },
    {
        "id": "e3",
        "text": "diabetes",
        "normalized_text": "diabetes",
        "entity_type": "DISEASE_DISORDER",
        "confidence": 0.22,
        "position": {"start": 40, "end": 48},
    },
]


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    async def resolve_model(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.answer


class _StubNlp:
    def __init__(self, entities: list[dict[str, Any]] | None = None) -> None:
        self.text_calls: list[dict[str, Any]] = []
        self.token_calls: list[dict[str, Any]] = []
        self._entities = _ENTITIES if entities is None else entities

    async def classify_text(self, text: str, **kwargs: Any) -> dict[str, Any]:
        self.text_calls.append({"text": text, **kwargs})
        return {
            "predicted_label": "discharge",
            "confidence": 0.88,
            "probabilities": {"discharge": 0.88, "referral": 0.12},
            "model_version": "1",
        }

    async def classify_tokens_raw(self, text: str, **kwargs: Any) -> dict[str, Any]:
        self.token_calls.append({"text": text, **kwargs})
        return {"entities": self._entities, "model_version": "1", "vitals": None}


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)

    def _install(row: dict[str, Any], entities: list[dict[str, Any]] | None = None):
        api = _StubApi(row)
        nlp = _StubNlp(entities)
        monkeypatch.setattr(core, "_api_client", lambda _settings: api)
        monkeypatch.setattr(core, "_nlp_client", lambda _settings: nlp)
        return api, nlp

    return _install


def _payload(**config: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="classify1",
        node_type="core.classify",
        config=config,
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": _TEXT},
        run_payload={},
        run_id=_RUN,
    )


_PII_CLASSES = [
    {"key": "pii_present", "label": "PII present"},
    {"key": "pii_absent", "label": "No PII detected"},
]


class TestDispatchFollowsTheResolvedTask:
    @pytest.mark.asyncio
    async def test_a_token_classification_row_goes_to_classify_tokens(self, stubs) -> None:
        _api, nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(modelSlug=_TOKEN_ROW["slug"], classes=_PII_CLASSES, threshold=0.5)
        )

        assert result.status == "SUCCEEDED"
        assert nlp.text_calls == []
        assert len(nlp.token_calls) == 1
        # The registry facts the gateway resolved reach the token route unaltered.
        assert nlp.token_calls[0]["model_name"] == _TOKEN_ROW["sourceUri"]
        assert nlp.token_calls[0]["model_path"] == _TOKEN_ROW["localPath"]
        assert nlp.token_calls[0]["tenant_id"] == _TENANT

    @pytest.mark.asyncio
    async def test_a_text_classification_row_still_goes_to_classify_text(self, stubs) -> None:
        _api, nlp = stubs(_TEXT_ROW)

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TEXT_ROW["slug"],
                classes=[{"key": "discharge", "label": "Discharge"}],
            )
        )

        assert result.status == "SUCCEEDED"
        assert nlp.token_calls == []
        assert nlp.text_calls[0]["model_name"] == _TEXT_ROW["sourceUri"]
        assert result.taken_handle == "discharge"


class TestTokenSpansMapOntoTheDeclaredClasses:
    @pytest.mark.asyncio
    async def test_a_class_naming_no_labels_is_taken_when_any_entity_clears_the_threshold(
        self, stubs
    ) -> None:
        """`mode: single`, `pii_present`/`pii_absent`: present iff >=1 entity above threshold."""
        _api, _nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TOKEN_ROW["slug"], mode="single", classes=_PII_CLASSES, threshold=0.5
            )
        )

        assert result.taken_handle == "pii_present"
        assert (result.output or {})["classification"]["category"] == "pii_present"

    @pytest.mark.asyncio
    async def test_nothing_above_the_threshold_takes_otherwise(self, stubs) -> None:
        _api, _nlp = stubs(_TOKEN_ROW, entities=[_ENTITIES[2]])  # 0.22, below 0.5

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TOKEN_ROW["slug"], mode="single", classes=_PII_CLASSES, threshold=0.5
            )
        )

        assert result.status == "SUCCEEDED"
        assert result.taken_handle == "otherwise"
        assert (result.output or {})["classification"]["category"] is None

    @pytest.mark.asyncio
    async def test_a_class_that_names_model_labels_scores_only_those(self, stubs) -> None:
        _api, _nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TOKEN_ROW["slug"],
                classes=[
                    {"key": "phone", "label": "Phone", "labels": ["phone_number"]},
                    {"key": "person", "label": "Person", "labels": ["person"]},
                ],
            )
        )

        scores = (result.output or {})["classification"]["scores"]
        assert scores == {"phone": 0.61, "person": 0.93}
        assert result.taken_handle == "person"

    @pytest.mark.asyncio
    async def test_spans_are_emitted_under_the_class_that_claims_them(self, stubs) -> None:
        """`mode: multi` + one catch-all class: the entity list rides as spans under it."""
        _api, _nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TOKEN_ROW["slug"],
                mode="multi",
                spans=True,
                classes=[{"key": "clinical_entity", "label": "Clinical entity"}],
            )
        )

        spans = (result.output or {})["classification"]["spans"]
        assert [s["text"] for s in spans] == ["Ada Lovelace", "555-0100", "diabetes"]
        assert spans[0] == {
            "text": "Ada Lovelace",
            "type": "person",
            "start": 5,
            "end": 17,
            "confidence": 0.93,
            "class": "clinical_entity",
        }

    @pytest.mark.asyncio
    async def test_spans_are_omitted_unless_the_node_asks_for_them(self, stubs) -> None:
        _api, _nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(modelSlug=_TOKEN_ROW["slug"], classes=_PII_CLASSES)
        )

        assert "spans" not in (result.output or {})["classification"]


class TestTheTextRidesThroughOnOut:
    @pytest.mark.asyncio
    async def test_the_token_branch_carries_the_classified_text(self, stubs) -> None:
        _api, _nlp = stubs(_TOKEN_ROW)

        result = await core.interpreter_core_classify(
            _payload(modelSlug=_TOKEN_ROW["slug"], classes=_PII_CLASSES)
        )

        assert (result.output or {})["classification"]["text"] == _TEXT

    @pytest.mark.asyncio
    async def test_the_text_branch_carries_it_too(self, stubs) -> None:
        _api, _nlp = stubs(_TEXT_ROW)

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_TEXT_ROW["slug"], classes=[{"key": "discharge", "label": "Discharge"}]
            )
        )

        assert (result.output or {})["classification"]["text"] == _TEXT

    def test_a_downstream_node_reads_that_text_off_the_bound_object(self) -> None:
        """The reason the passthrough matters: `_texts` is what every consumer uses."""
        classification = {"category": "pii_present", "scores": {}, "text": _TEXT}

        assert core._texts(classification) == [_TEXT]
