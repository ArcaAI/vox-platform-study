"""Proves `/classify/text` already serves sentiment/toxicity (TASK-729 Task 2).

Per the ticket (§1/§2.2): sentiment and toxicity are FIXED-taxonomy
classification tasks that the existing generic `/classify/text` endpoint
already serves — it is model-agnostic (`model_name`/`model_path` select the
model; the handler carries zero task-specific logic). This ticket adds NO new
`apps/nlp` endpoint for these two task types, only new `AiTaskDefault` rows
(`nlp.sentiment`, `nlp.toxicity`) pointing at a sentiment/toxicity-labeled
model. This test proves that claim rather than assuming it: it drives
`/classify/text` with a fixture sentiment model and a fixture toxicity model
(via `model_name`, exactly as the gateway would inject after Task 2's
`AiTaskDefault` rows are configured) and asserts the SAME generic
`TextClassificationResponse` shape serves both.

Mirrors `test_model_override_routes.py`'s fixture-model pattern — imitate,
don't invent a new fixture style.

TOXICITY LABEL SHAPE — RESOLVED (owner decision, 2026-08-20, TASK-729 §6):
toxicity is MULTI-LABEL (toxic + threat + insult may all apply to the same
utterance simultaneously). The single-label tests above still exercise
`/classify/text` directly (proving the generic single-label path is
unaffected — `nlp.sentiment` and `nlp.classification` keep it verbatim);
the multi-label tests further down drive the NEW, dedicated
`/classify/text/multi-label` endpoint (`MultiLabelClassificationResponse`:
`predicted_labels` + a per-label `scores` map), which is what `nlp.toxicity`
now resolves to.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import nlp.dependencies as deps
from nlp.api.v1 import rest_api_router_v1

_SLOTS = (
    "_text_classifier_instance",
    "_token_classifier_instance",
    "_text_corrector_instance",
    "_medical_suggester_instance",
    "_websocket_manager_instance",
    "_document_extractor_instance",
    "_token_classifier_cache_instance",
    "_text_classifier_cache_instance",
    "_medical_suggester_cache_instance",
)


@pytest.fixture()
def clean_deps():
    saved = {name: deps.__dict__.get(name) for name in _SLOTS}
    for name in _SLOTS:
        deps.__dict__[name] = None
    yield deps
    for name, value in saved.items():
        deps.__dict__[name] = value


@pytest.fixture()
def client(clean_deps):
    app = FastAPI()
    app.include_router(rest_api_router_v1)
    return TestClient(app)


def test_classify_text_serves_sentiment_via_model_name(client, clean_deps) -> None:
    """A sentiment-labeled model, selected purely by `model_name`, produces a
    correctly-shaped `TextClassificationResponse` — no sentiment-specific
    code path exists or is needed."""
    fake_pipe = MagicMock(
        return_value=[
            {"label": "positive", "score": 0.82},
            {"label": "negative", "score": 0.1},
            {"label": "neutral", "score": 0.08},
        ]
    )
    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as tok,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mdl,
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r = client.post(
            "/api/v1/classify/text",
            json={
                "text": "The patient reports feeling much better today.",
                "model_name": "org/sentiment-model",
            },
        )

    assert r.status_code == 200
    body = r.json()
    assert body["predicted_label"] == "positive"
    assert set(body["probabilities"].keys()) == {"positive", "negative", "neutral"}
    tok.from_pretrained.assert_called_once_with("org/sentiment-model")
    mdl.from_pretrained.assert_called_once_with("org/sentiment-model")


def test_classify_text_serves_toxicity_via_model_name(client, clean_deps) -> None:
    """A toxicity-labeled model, selected purely by `model_name`, produces the
    SAME generic single-label response shape — no new endpoint or schema
    field. (Multi-label toxicity is the OPEN, HUMAN-GATED follow-up — not
    exercised here.)"""
    fake_pipe = MagicMock(
        return_value=[
            {"label": "toxic", "score": 0.91},
            {"label": "non_toxic", "score": 0.09},
        ]
    )
    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as tok,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mdl,
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r = client.post(
            "/api/v1/classify/text",
            json={"text": "some user-submitted comment", "model_name": "org/toxicity-model"},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["predicted_label"] == "toxic"
    assert set(body["probabilities"].keys()) == {"toxic", "non_toxic"}
    tok.from_pretrained.assert_called_once_with("org/toxicity-model")
    mdl.from_pretrained.assert_called_once_with("org/toxicity-model")


def test_toxicity_multi_label_returns_per_label_scores_and_simultaneous_positives(
    client, clean_deps
) -> None:
    """Owner decision (2026-08-20, TASK-729 §6): toxicity is MULTI-LABEL — an
    utterance may be toxic AND a threat AND an insult at once. `/classify/text/
    multi-label` returns a per-label score for every label the model exposes,
    plus every label that clears `cls_threshold` (not just one winner)."""
    fake_pipe = MagicMock(
        return_value=[
            {"label": "toxic", "score": 0.91},
            {"label": "threat", "score": 0.77},
            {"label": "insult", "score": 0.62},
            {"label": "obscene", "score": 0.12},
        ]
    )
    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as tok,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mdl,
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r = client.post(
            "/api/v1/classify/text/multi-label",
            json={
                "text": "some user-submitted comment",
                "model_name": "org/toxicity-model",
                "cls_threshold": 0.5,
            },
        )

    assert r.status_code == 200
    body = r.json()
    # Three labels simultaneously clear the threshold — not one winning label.
    assert set(body["predicted_labels"]) == {"toxic", "threat", "insult"}
    assert body["scores"] == {"toxic": 0.91, "threat": 0.77, "insult": 0.62, "obscene": 0.12}
    assert body["threshold"] == 0.5
    tok.from_pretrained.assert_called_once_with("org/toxicity-model")
    mdl.from_pretrained.assert_called_once_with("org/toxicity-model")


def test_toxicity_multi_label_can_return_zero_or_all_labels(client, clean_deps) -> None:
    """Independent thresholding, not a forced top-1 pick: nothing clearing the
    bar yields an empty list (never a fabricated `predicted_label`)."""
    fake_pipe = MagicMock(
        return_value=[
            {"label": "toxic", "score": 0.1},
            {"label": "non_toxic", "score": 0.05},
        ]
    )
    with (
        patch("nlp.services.text_classifier.AutoTokenizer"),
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification"),
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r = client.post(
            "/api/v1/classify/text/multi-label",
            json={"text": "a perfectly polite comment", "model_name": "org/toxicity-model"},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["predicted_labels"] == []
    assert body["threshold"] == 0.5  # the request-schema default


def test_toxicity_multi_label_requires_model_name_fails_closed_503(client, clean_deps) -> None:
    resp = client.post("/api/v1/classify/text/multi-label", json={"text": "hello"})
    assert resp.status_code == 503


def test_sentiment_and_toxicity_are_the_same_generic_path_no_task_specific_branching(
    client, clean_deps
) -> None:
    """Both task types load through the identical `pinned_text_classifier`
    code path — i.e. confirming there is no per-task branching to maintain."""
    fake_pipe = MagicMock(return_value=[{"label": "x", "score": 1.0}])
    with (
        patch("nlp.services.text_classifier.AutoTokenizer"),
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification"),
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r1 = client.post(
            "/api/v1/classify/text", json={"text": "a", "model_name": "org/sentiment-model"}
        )
        r2 = client.post(
            "/api/v1/classify/text", json={"text": "b", "model_name": "org/toxicity-model"}
        )

    assert r1.status_code == 200 and r2.status_code == 200
    cache = clean_deps._text_classifier_cache_instance
    assert cache is not None
    assert set(cache.cached_models()) == {"org/sentiment-model", "org/toxicity-model"}
