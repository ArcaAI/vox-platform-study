"""F14 — an OPEN-taxonomy extractor is told WHAT to look for.

F13 routed a TOKEN_CLASSIFICATION row to nlp `/classify/tokens`. Half the rows
that arrive there are `gliner2` EXTRACTORS, which carry no label set of their own:
the labels are configuration, and `apps/nlp` fails closed (503) rather than
inventing one. So the node has to send them, and the two places they can honestly
come from are:

1. the node's OWN `classes[].labels` — the author naming the model labels each
   declared class claims (the same field `_pick_class` already scores by);
2. failing that, the registry row's `_metadata.labelTaxonomy.labels`, which the
   gateway resolves on the SAME tenant → SYSTEM cascade that chose the model
   (`HarnessInternalService.resolveRegistryModel`).

A class KEY is never used as a label here: `pii_present` / `pii_absent` are the
author's semantic buckets, not entity types the model was trained on — sending
them would ask the extractor to find spans of a type that does not exist. That is
also why `_catch_all_class` exists on the reading side.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_TEXT = "Call Ada Lovelace on 555-0100 about her diabetes."

_TAXONOMY = {"threshold": 0.5, "labels": ["person", "phone_number", "email"]}
_EXTRACTOR_ROW = {
    "slug": "gliner2-guardrails-pii-multi",
    "taskType": "TOKEN_CLASSIFICATION",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi",
    "localPath": "/mnt/models-bucket/nlp/gliner2-guardrails-pii-multi/",
    "servedBy": "nlp",
    "labelTaxonomy": _TAXONOMY,
}
#: The seeded closed-taxonomy checkpoint: its labels ARE its own, so the registry
#: row carries none and the node must not fabricate any.
_CLOSED_ROW = {
    "slug": "medical-ner",
    "taskType": "TOKEN_CLASSIFICATION",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "sourceUri": "blaze999/Medical-NER",
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
    }
]

#: The J6 shape: semantic buckets, no model labels named.
_PII_CLASSES = [
    {"key": "pii_present", "label": "PII present"},
    {"key": "pii_absent", "label": "No PII detected"},
]


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_model(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer


class _StubNlp:
    def __init__(self) -> None:
        self.token_calls: list[dict[str, Any]] = []

    async def classify_tokens_raw(self, text: str, **kwargs: Any) -> dict[str, Any]:
        self.token_calls.append({"text": text, **kwargs})
        return {"entities": _ENTITIES, "model_version": "1", "vitals": None}

    async def classify_text(self, text: str, **kwargs: Any) -> dict[str, Any]:  # pragma: no cover
        raise AssertionError("a TOKEN_CLASSIFICATION row must not reach /classify/text")


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)

    def _install(row: dict[str, Any]):
        nlp = _StubNlp()
        monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi(row))
        monkeypatch.setattr(core, "_nlp_client", lambda _settings: nlp)
        return nlp

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


class TestTheLabelsSentToAnExtractor:
    @pytest.mark.asyncio
    async def test_the_rows_label_taxonomy_is_sent_when_the_node_names_none(self, stubs) -> None:
        nlp = stubs(_EXTRACTOR_ROW)

        result = await core.interpreter_core_classify(
            _payload(modelSlug=_EXTRACTOR_ROW["slug"], classes=_PII_CLASSES, threshold=0.5)
        )

        assert result.status == "SUCCEEDED"
        assert nlp.token_calls[0]["labels"] == _TAXONOMY["labels"]
        # The node's own floor rides along — the model's answer is filtered once,
        # at the threshold the author declared, not at one nlp chose.
        assert nlp.token_calls[0]["threshold"] == 0.5

    @pytest.mark.asyncio
    async def test_the_nodes_own_labels_win_over_the_rows_taxonomy(self, stubs) -> None:
        nlp = stubs(_EXTRACTOR_ROW)

        await core.interpreter_core_classify(
            _payload(
                modelSlug=_EXTRACTOR_ROW["slug"],
                classes=[
                    {"key": "identity", "labels": ["person", "date_of_birth"]},
                    {"key": "contact", "labels": ["email"]},
                ],
            )
        )

        assert nlp.token_calls[0]["labels"] == ["person", "date_of_birth", "email"]

    @pytest.mark.asyncio
    async def test_class_keys_are_never_sent_as_model_labels(self, stubs) -> None:
        """A row with NO taxonomy and a node naming no labels sends none — nlp
        then fails closed if the checkpoint needed them. `pii_present` is not an
        entity type and must never be presented as one."""
        nlp = stubs(_CLOSED_ROW)

        await core.interpreter_core_classify(
            _payload(modelSlug=_CLOSED_ROW["slug"], classes=_PII_CLASSES)
        )

        assert nlp.token_calls[0].get("labels") is None
