"""Token-classification aggregation contract.

The Medical-NER model (``blaze999/Medical-NER``) is BIO-prefixed and tokenizes
into subword ``##`` fragments. Unless the HF pipeline runs with an aggregation
strategy (``simple`` / ``first`` / ``max`` / ``average``) it emits raw subword
tokens keyed by ``entity`` with B-/I- prefixes. With aggregation it merges them
into whole-word spans keyed by ``entity_group`` (prefix stripped).

These tests pin that:
  * ``process`` forwards the (per-request, config-fallback) aggregation strategy
    to the pipeline call;
  * ``_to_entities`` reads the aggregated ``entity_group`` key (falling back to
    the raw ``entity`` key) so a merged medication becomes ONE un-prefixed entity
    with correct character offsets;
  * ``ignore_labels`` (default ``["O"]``) are dropped.
"""

from __future__ import annotations

import pytest

from nlp.schemas.classification import TokenClassificationRequest
from nlp.services.token_classifier import TransformerTokenClassifier


@pytest.mark.asyncio
async def test_process_forwards_aggregation_strategy_to_pipeline():
    classifier = TransformerTokenClassifier()
    seen: dict = {}

    def fake_pipeline(text, **kwargs):
        seen["text"] = text
        seen["kwargs"] = kwargs
        return []

    classifier.pipeline = fake_pipeline
    classifier.is_initialized = True

    # "max" != the configured default ("simple"), so this pins request-over-config
    # precedence — not merely that *some* strategy reached the pipeline.
    await classifier.process(
        TokenClassificationRequest(text="patient takes amlodipine", aggregation_strategy="max")
    )

    # Without a non-"none" strategy the pipeline emits ``##`` subword fragments
    # with raw BIO labels — the request's strategy MUST reach the pipeline call.
    assert seen["kwargs"].get("aggregation_strategy") == "max"


@pytest.mark.asyncio
async def test_process_falls_back_to_config_aggregation_strategy():
    classifier = TransformerTokenClassifier()
    seen: dict = {}

    def fake_pipeline(text, **kwargs):
        seen["kwargs"] = kwargs
        return []

    classifier.pipeline = fake_pipeline
    classifier.is_initialized = True

    # Empty per-request value → fall back to the configured default.
    await classifier.process(TokenClassificationRequest(text="fever", aggregation_strategy=""))

    assert seen["kwargs"].get("aggregation_strategy") == classifier.configs.aggregation_strategy


def test_to_entities_merges_multi_subword_medication_into_one_unprefixed_entity():
    classifier = TransformerTokenClassifier()

    text = "patient takes amlodipine"
    start = text.index("amlodipine")
    end = start + len("amlodipine")
    # HF with aggregation_strategy != "none" merges the ``am ##lo ##di ##pine``
    # subwords into ONE span keyed by ``entity_group`` (BIO prefix stripped).
    aggregated = [
        {
            "entity_group": "MEDICATION",
            "score": 0.97,
            "word": "amlodipine",
            "start": start,
            "end": end,
        },
    ]

    entities = classifier._to_entities(aggregated)

    assert len(entities) == 1
    ent = entities[0]
    assert ent.entity_type == "MEDICATION"  # un-prefixed (no B-/I-)
    assert ent.text == "amlodipine"
    assert "##" not in ent.text
    assert ent.position.start == start
    assert ent.position.end == end


def test_to_entities_filters_ignore_labels():
    classifier = TransformerTokenClassifier()
    assert "O" in classifier.configs.ignore_labels  # guards the assumption

    results = [
        {"entity_group": "O", "score": 0.40, "word": "patient", "start": 0, "end": 7},
        {"entity_group": "MEDICATION", "score": 0.95, "word": "aspirin", "start": 8, "end": 15},
    ]

    entities = classifier._to_entities(results)

    assert [e.entity_type for e in entities] == ["MEDICATION"]
