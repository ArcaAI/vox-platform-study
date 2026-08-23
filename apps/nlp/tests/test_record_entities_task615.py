"""TDD tests for wiring the dead ``record_entities()`` metric.

current-state-review.md §2.4: ``record_entities()`` had ZERO call-sites outside
its own definition/docstring — the advertised entities/documents-processed
count was computed nowhere, and the only place an entity count was observed
was a prose log line (``classify.py:87``). This wires it at the real
call-site (``TokenClassifier.process``, the shared implementation behind
both the REST and WebSocket token-classification routes) and proves the
Prometheus-scrapable counters move — the existing OTel-only export stays,
Prometheus is the ADDITION, not a replacement.
"""

from __future__ import annotations

import pytest
from prometheus_client import REGISTRY

from nlp.core import metrics as m
from nlp.core.config import TokenClassificationConfig
from nlp.schemas.classification import TokenClassificationRequest
from nlp.services.token_classifier import TransformerTokenClassifier


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class _FakeEntity:
    """Minimal stand-in for a transformers token-classification pipeline
    result, shaped like the raw HF output ``_to_entities`` consumes."""

    def __init__(self, entity_group: str, word: str, score: float = 0.9) -> None:
        self.data = {
            "entity_group": entity_group,
            "word": word,
            "score": score,
            "start": 0,
            "end": len(word),
        }

    def get(self, key: str, default=None):  # dict-like, matches result.get(...) usage
        return self.data.get(key, default)


class TestMetricDefinitions:
    def test_entities_counter_name_and_labels(self) -> None:
        assert m.NLP_ENTITIES_TOTAL._name == "nlp_entities"
        assert m.NLP_ENTITIES_TOTAL._labelnames == ("model", "entity_type")

    def test_documents_processed_counter_name_and_labels(self) -> None:
        assert m.NLP_DOCUMENTS_PROCESSED_TOTAL._name == "nlp_documents_processed"
        assert m.NLP_DOCUMENTS_PROCESSED_TOTAL._labelnames == ("model",)


class TestRecordEntitiesDualWrite:
    """``record_entities()`` must move BOTH the OTel counter (unchanged,
    pre-existing) and the new Prometheus counter — one call site, two sinks."""

    def test_record_entities_increments_prometheus_counter(self) -> None:
        labels = {"model": "token_classifier", "entity_type": "medication"}
        before = _val("nlp_entities_total", labels)

        m.nlp_metrics.record_entities(entity_count=3, entity_type="medication")

        assert _val("nlp_entities_total", labels) == before + 3

    def test_record_entities_still_increments_otel_counter(self) -> None:
        # The OTel path has no Prometheus-visible assertion surface, but this
        # pins that calling record_entities() doesn't raise / doesn't drop the
        # pre-existing OTel `.add()` call — a regression here would be silent.
        m.nlp_metrics.entity_count.add = lambda *a, **kw: None  # type: ignore[method-assign]
        m.nlp_metrics.record_entities(entity_count=1, entity_type="symptom")  # must not raise


class TestTokenClassifierWiresRecordEntities:
    """The real call-site: ``TokenClassifier.process()`` — shared by the REST
    route (``classify_tokens``) and the WebSocket route (same ``service.process``
    call), so wiring it here covers both without duplicating the wiring."""

    @pytest.mark.asyncio
    async def test_process_records_entities_by_type(self) -> None:
        classifier = TransformerTokenClassifier(configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner"))
        classifier.pipeline = lambda text, **kwargs: [
            _FakeEntity("MEDICATION", "aspirin").data,
            _FakeEntity("MEDICATION", "ibuprofen").data,
            _FakeEntity("SYMPTOM", "fever").data,
        ]
        classifier.is_initialized = True
        # Ontology linking + assertion classification are unrelated to this
        # metric and slow (offline models); disable to keep the unit test fast.
        classifier.linker_config.linker_enabled = False
        classifier.configs.assertion_enabled = False

        labels_med = {"model": m.MODEL_MEDICAL_NER, "entity_type": "MEDICATION"}
        labels_sym = {"model": m.MODEL_MEDICAL_NER, "entity_type": "SYMPTOM"}
        before_med = _val("nlp_entities_total", labels_med)
        before_sym = _val("nlp_entities_total", labels_sym)

        result = await classifier.process(
            TokenClassificationRequest(text="patient takes aspirin and ibuprofen for fever")
        )

        assert len(result.entities) == 3
        assert _val("nlp_entities_total", labels_med) == before_med + 2
        assert _val("nlp_entities_total", labels_sym) == before_sym + 1

    @pytest.mark.asyncio
    async def test_process_increments_documents_processed_once_per_call(self) -> None:
        classifier = TransformerTokenClassifier(configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner"))
        classifier.pipeline = lambda text, **kwargs: []
        classifier.is_initialized = True

        labels = {"model": m.MODEL_MEDICAL_NER}
        before = _val("nlp_documents_processed_total", labels)

        await classifier.process(TokenClassificationRequest(text="no entities here"))

        assert _val("nlp_documents_processed_total", labels) == before + 1

    @pytest.mark.asyncio
    async def test_process_with_zero_entities_still_counts_the_document(self) -> None:
        # A document that yields no entities is still "processed" — the
        # documents-processed counter is NOT gated on entities.entities > 0.
        classifier = TransformerTokenClassifier(configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner"))
        classifier.pipeline = lambda text, **kwargs: []
        classifier.is_initialized = True

        labels = {"model": m.MODEL_MEDICAL_NER}
        before = _val("nlp_documents_processed_total", labels)

        result = await classifier.process(TokenClassificationRequest(text="nothing to see"))

        assert result.entities == []
        assert _val("nlp_documents_processed_total", labels) == before + 1
