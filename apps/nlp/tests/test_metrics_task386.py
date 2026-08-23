"""NLP per-model metrics (Prometheus-scrapable).

NLP's domain metrics use OpenTelemetry (OTLP gRPC export). The platform-metrics
backend reads Prometheus, so these tests cover the prometheus_client-based
standardized ``model_running_instances`` / ``model_inference_latency_seconds``
metrics and prove the token-classification path (Medical-NER) increments them.
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


def test_canonical_model_ids_match_platform_inventory():
    # Must match apps/admin/src/features/platform-dashboard/models.ts
    assert m.MODEL_MEDICAL_NER == "Medical-NER"
    assert m.MODEL_SYMPTOMS_DISEASE == "symps-disease-bert"


def test_track_model_inference_bumps_then_restores_and_observes():
    labels = {"service": "nlp", "model": "Medical-NER"}
    before_gauge = _val("model_running_instances", labels)
    before_count = _val("model_inference_latency_seconds_count", labels)

    with m.track_model_inference("Medical-NER"):
        assert _val("model_running_instances", labels) == before_gauge + 1

    assert _val("model_running_instances", labels) == before_gauge
    assert _val("model_inference_latency_seconds_count", labels) == before_count + 1


@pytest.mark.asyncio
async def test_token_classifier_process_observes_medical_ner_latency():
    classifier = TransformerTokenClassifier(configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner"))
    # Stub out the HF pipeline so no model download/inference is needed.
    # Accept **kwargs so process()'s aggregation_strategy= call hits the SUCCESS
    # path (not the except branch).
    classifier.pipeline = lambda text, **kwargs: []
    classifier.is_initialized = True

    labels = {"service": "nlp", "model": "Medical-NER"}
    before_count = _val("model_inference_latency_seconds_count", labels)
    before_gauge = _val("model_running_instances", labels)

    await classifier.process(TokenClassificationRequest(text="patient has a fever"))

    assert _val("model_inference_latency_seconds_count", labels) == before_count + 1
    assert _val("model_running_instances", labels) == before_gauge
