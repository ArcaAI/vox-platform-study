"""F14 — `/classify/tokens` serves BOTH token-level runtimes this service hosts.

`apps/nlp` hosts two token-level runtimes: the transformers
`AutoModelForTokenClassification` pipeline (a CLOSED taxonomy — the checkpoint's
own BIO label set) and the `gliner2` extractor moved here by TASK-735 Phase 3 (an
OPEN taxonomy — the labels arrive per request). `/classify/tokens` only ever
built the first, so a GLiNER2 checkpoint answered

    checkpoint ... has model type `extractor` but Transformers does not
    recognize this architecture

and the route failed closed with 503 — which is what every workflow-lane
`core.classify` node bound to `gliner2-guardrails-pii-multi` hit after F13 routed
it here.

The loader now dispatches on the CHECKPOINT's own declared family, read from its
`config.json`. Never on a slug, a vendor prefix or a hub id: a tenant BYO row
names whatever checkpoint its admin configured, and a literal here could not see
it (`test_no_hardcoded_model_ids_task778.py` enforces the same rule).

The labels an extractor looks for are the CALLER's, exactly as on the guard
plane: absent ⇒ 503, never a label list invented in Python.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nlp.core.checkpoint_family import is_gliner_checkpoint, read_checkpoint_config
from nlp.schemas.classification import TokenClassificationRequest

# Transcribed from the real checkpoints staged on the dev host — the two shapes
# the dispatcher has to tell apart.
_GLINER2_CONFIG = {
    "counting_layer": "count_lstm",
    "max_width": 8,
    "model_name": "microsoft/mdeberta-v3-base",
    "model_type": "extractor",
    "token_pooling": "first",
}
_TRANSFORMERS_CONFIG = {
    "architectures": ["DebertaV2ForTokenClassification"],
    "model_type": "deberta-v2",
    "id2label": {"0": "O", "1": "B-DISEASE_DISORDER"},
}


class TestTheCheckpointDeclaresItsOwnFamily:
    def test_a_gliner2_extractor_config_is_recognized(self) -> None:
        assert is_gliner_checkpoint(_GLINER2_CONFIG) is True

    def test_a_transformers_token_classifier_config_is_not(self) -> None:
        assert is_gliner_checkpoint(_TRANSFORMERS_CONFIG) is False

    def test_an_unreadable_config_is_not_a_gliner_checkpoint(self) -> None:
        """Absence is never taken as evidence: an unreadable config falls through
        to the transformers path, which fails exactly as it does today."""
        assert is_gliner_checkpoint(None) is False
        assert is_gliner_checkpoint({}) is False

    def test_a_local_checkpoint_directory_is_read_from_disk(self, tmp_path: Path) -> None:
        (tmp_path / "config.json").write_text(json.dumps(_GLINER2_CONFIG), encoding="utf-8")
        assert read_checkpoint_config(str(tmp_path)) == _GLINER2_CONFIG

    def test_an_unreadable_source_reads_as_an_empty_config(self, tmp_path: Path) -> None:
        assert read_checkpoint_config(str(tmp_path / "nope")) == {}


class _StubRuntime:
    """Stands in for the loaded `Gliner2GuardService`."""

    def __init__(self, spans: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._spans = (
            spans
            if spans is not None
            else [
                {"label": "person", "start": 5, "end": 17, "score": 0.93, "text": "Ada Lovelace"},
                {
                    "label": "phone_number",
                    "start": 21,
                    "end": 29,
                    "score": 0.61,
                    "text": "555-0100",
                },
            ]
        )

    async def extract_entities(
        self, text: str, labels: list[str], threshold: float
    ) -> list[dict[str, Any]]:
        self.calls.append({"text": text, "labels": labels, "threshold": threshold})
        return self._spans


def _classifier(runtime: _StubRuntime):
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

    service = Gliner2TokenClassifier(model_name="tenant/whatever-they-configured", runtime=runtime)
    service.is_initialized = True
    return service


class TestTheExtractorAnswersTheTokenClassificationContract:
    @pytest.mark.asyncio
    async def test_spans_become_token_classification_entities(self) -> None:
        runtime = _StubRuntime()
        service = _classifier(runtime)

        response = await service.process(
            TokenClassificationRequest(
                text="Call Ada Lovelace on 555-0100 about her diabetes.",
                labels=["person", "phone_number"],
                threshold=0.5,
            )
        )

        # The SAME shape `classify_tokens_raw` (apps/harness) already consumes.
        assert [
            (e.text, e.entity_type, e.position.start, e.position.end) for e in response.entities
        ] == [
            ("Ada Lovelace", "person", 5, 17),
            ("555-0100", "phone_number", 21, 29),
        ]
        assert response.entities[0].confidence == pytest.approx(0.93)
        assert runtime.calls == [
            {
                "text": "Call Ada Lovelace on 555-0100 about her diabetes.",
                "labels": ["person", "phone_number"],
                "threshold": 0.5,
            }
        ]

    @pytest.mark.asyncio
    async def test_no_labels_is_a_refusal_not_an_invented_taxonomy(self) -> None:
        from nlp.services.gliner_token_classifier import ExtractorLabelsUnavailable

        service = _classifier(_StubRuntime())

        with pytest.raises(ExtractorLabelsUnavailable):
            await service.process(TokenClassificationRequest(text="hi", labels=[]))

    @pytest.mark.asyncio
    async def test_an_absent_threshold_filters_nothing(self) -> None:
        """The caller's threshold is policy; absent, the model's own answer rides
        through untouched rather than being clipped at a floor invented here."""
        runtime = _StubRuntime()
        service = _classifier(runtime)

        await service.process(TokenClassificationRequest(text="hi", labels=["person"]))

        assert runtime.calls[0]["threshold"] == 0.0


class TestTheRouteRefusesAnExtractorWithNoTaxonomy:
    def test_missing_labels_answers_503(self, client, monkeypatch: pytest.MonkeyPatch) -> None:
        """Mirrors `/guard/pii`: an OPEN-taxonomy model with no taxonomy is
        unserviceable, not a 500."""
        import contextlib

        from nlp.services.gliner_token_classifier import ExtractorLabelsUnavailable

        class _Raising:
            is_initialized = True

            async def process(self, _request: Any) -> Any:
                raise ExtractorLabelsUnavailable("no labels")

        @contextlib.asynccontextmanager
        async def _pinned(*_args: Any, **_kwargs: Any):
            yield _Raising()

        monkeypatch.setattr("nlp.api.v1.rest.classify.pinned_token_classifier", _pinned)

        response = client.post(
            "/api/v1/classify/tokens",
            json={"text": "Email a@b.com", "model_name": "tenant/whatever"},
        )

        assert response.status_code == 503


class TestTheFactoryBuildsTheRuntimeTheCheckpointNeeds:
    @pytest.mark.asyncio
    async def test_a_gliner2_checkpoint_gets_the_extractor_runtime(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import nlp.dependencies as deps
        from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

        (tmp_path / "config.json").write_text(json.dumps(_GLINER2_CONFIG), encoding="utf-8")
        loaded: list[str] = []

        class _FakeGuardService:
            def __init__(self, *, weights_source: str, model_id: str, **_kw: Any) -> None:
                self.weights_source = weights_source
                self.model_id = model_id

            def load(self) -> None:
                loaded.append(self.weights_source)

        monkeypatch.setattr(
            "nlp.services.gliner2_guard.Gliner2GuardService", _FakeGuardService, raising=True
        )

        service = await deps._create_token_classifier(str(tmp_path))

        assert isinstance(service, Gliner2TokenClassifier)
        assert loaded == [str(tmp_path)]

    @pytest.mark.asyncio
    async def test_a_transformers_checkpoint_still_gets_the_pipeline(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import nlp.dependencies as deps
        from nlp.services.token_classifier import TransformerTokenClassifier

        (tmp_path / "config.json").write_text(json.dumps(_TRANSFORMERS_CONFIG), encoding="utf-8")

        async def _initialized(self: Any) -> None:
            self.is_initialized = True

        monkeypatch.setattr(TransformerTokenClassifier, "initialize", _initialized)

        service = await deps._create_token_classifier(str(tmp_path))

        assert isinstance(service, TransformerTokenClassifier)
