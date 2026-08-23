"""Route-level tests for required per-request model selection.

Hermetic: transformers loading is mocked and the FastAPI app is a minimal
shell mounting only the REST v1 routers (no lifespan → no eager model loads).

`model_name` (the gateway-injected `AiModel.sourceUri`) is REQUIRED on
the classify/diagnosis paths; there is no env-configured default selection. Every
selected model is loaded lazily on first use through the idle-TTL cache and pinned
for the request. A missing/unloadable model fails closed with HTTP 503.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import nlp.dependencies as deps

# Imported at COLLECTION time on purpose: the shared conftest `client` fixture
# imports `nlp.app` lazily while `nlp.dependencies.get_*` are patched, which
# would bake MagicMocks into the routers' Depends defaults for the rest of the
# session. Importing the API package here binds the real dependencies first.
from nlp.api.v1 import rest_api_router_v1
from nlp.core.config import UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL

_SLOTS = (
    "_text_corrector_instance",
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


# ---------------------------------------------------------------------------
# Missing model_name → fail-closed 503
# ---------------------------------------------------------------------------


def test_classify_tokens_without_model_name_returns_503(client, clean_deps) -> None:
    r = client.post("/api/v1/classify/tokens", json={"text": "fever"})

    assert r.status_code == 503
    # nothing was loaded/cached
    assert clean_deps._token_classifier_cache_instance is None


def test_classify_text_without_model_name_returns_503(client, clean_deps) -> None:
    r = client.post("/api/v1/classify/text", json={"text": "note text"})

    assert r.status_code == 503
    assert clean_deps._text_classifier_cache_instance is None


def test_diagnosis_without_model_name_returns_503(client, clean_deps) -> None:
    r = client.post("/api/v1/diagnosis/suggestions", json={"text": "fever and chills"})

    assert r.status_code == 503
    assert clean_deps._medical_suggester_cache_instance is None


# ---------------------------------------------------------------------------
# model_name path — lazily created, cached, and loaded exactly once
# ---------------------------------------------------------------------------


def test_model_name_creates_and_caches_distinct_instance(client, clean_deps) -> None:
    fake_pipe = MagicMock(return_value=[])
    with (
        patch("nlp.services.token_classifier.AutoTokenizer") as tok,
        patch("nlp.services.token_classifier.AutoModelForTokenClassification") as mdl,
        patch("nlp.services.token_classifier.pipeline", return_value=fake_pipe),
    ):
        r1 = client.post(
            "/api/v1/classify/tokens",
            json={"text": "fever", "model_name": "org/custom-ner"},
        )
        r2 = client.post(
            "/api/v1/classify/tokens",
            json={"text": "chills", "model_name": "org/custom-ner"},
        )

    assert r1.status_code == 200 and r2.status_code == 200
    # first request loaded the model exactly once; the second was a cache hit …
    tok.from_pretrained.assert_called_once_with("org/custom-ner")
    mdl.from_pretrained.assert_called_once_with("org/custom-ner")
    # … and the model stays cached (unpinned) after the request completes.
    cache = clean_deps._token_classifier_cache_instance
    assert cache is not None
    assert cache.cached_models() == ["org/custom-ner"]


def test_model_load_failure_returns_503(client, clean_deps) -> None:
    with (
        patch("nlp.services.token_classifier.AutoTokenizer") as tok,
        patch("nlp.services.token_classifier.AutoModelForTokenClassification"),
        patch("nlp.services.token_classifier.pipeline"),
    ):
        tok.from_pretrained.side_effect = OSError("no such model on the hub")
        r = client.post("/api/v1/classify/tokens", json={"text": "x", "model_name": "org/missing"})

    assert r.status_code == 503
    # a failed load is not cached — a later request retries
    cache = clean_deps._token_classifier_cache_instance
    assert cache is not None
    assert cache.cached_models() == []


def test_classify_text_model_name_loads_custom_model(client, clean_deps) -> None:
    fake_pipe = MagicMock(return_value=[{"label": "clinical_note", "score": 0.8}])
    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as tok,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mdl,
        patch("nlp.services.text_classifier.pipeline", return_value=fake_pipe),
    ):
        r = client.post(
            "/api/v1/classify/text",
            json={"text": "note text", "model_name": "org/doc-type"},
        )

    assert r.status_code == 200
    assert r.json()["predicted_label"] == "clinical_note"
    tok.from_pretrained.assert_called_once_with("org/doc-type")
    mdl.from_pretrained.assert_called_once_with("org/doc-type")


def test_classify_text_sentinel_model_name_rejected_503(client, clean_deps) -> None:
    # Passing the placeholder sentinel as an override must not "load" it.
    r = client.post(
        "/api/v1/classify/text",
        json={"text": "x", "model_name": UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL},
    )

    assert r.status_code == 503


# ---------------------------------------------------------------------------
# Diagnosis — BOTH selections are injected and BOTH drive their own load
# ---------------------------------------------------------------------------


def test_diagnosis_injects_both_the_classifier_and_the_ner(client, clean_deps) -> None:
    """The suggester runs two models, so it takes two selections.

    Its internal NER used to be the process singleton built from settings — the
    hardcoded default. Now the caller names it, and the cache slot is keyed on
    BOTH identities so a change to either is a miss.
    """
    cls_pipe = MagicMock(return_value=[{"label": "LABEL_10", "score": 0.9}])
    ner_pipe = MagicMock(return_value=[])
    with (
        patch("nlp.services.medical_suggester.AutoTokenizer") as cls_tok,
        patch("nlp.services.medical_suggester.AutoModelForSequenceClassification") as cls_mdl,
        patch("nlp.services.medical_suggester.pipeline", return_value=cls_pipe),
        patch("nlp.services.token_classifier.AutoTokenizer") as ner_tok,
        patch("nlp.services.token_classifier.AutoModelForTokenClassification") as ner_mdl,
        patch("nlp.services.token_classifier.pipeline", return_value=ner_pipe),
    ):
        ner_mdl.from_pretrained.return_value.config.id2label = {}
        r = client.post(
            "/api/v1/diagnosis/suggestions",
            json={
                "text": "patient reports fever and chills",
                "model_name": "org/custom-classifier",
                "ner_model_name": "org/custom-ner",
                "tenant_id": "tenant-a",
            },
        )

    assert r.status_code == 200
    cls_tok.from_pretrained.assert_called_once_with("org/custom-classifier")
    cls_mdl.from_pretrained.assert_called_once_with("org/custom-classifier")
    ner_tok.from_pretrained.assert_called_once_with("org/custom-ner")
    ner_mdl.from_pretrained.assert_called_once_with("org/custom-ner")

    cache = clean_deps._medical_suggester_cache_instance
    assert cache is not None
    assert cache.cached_models() == [
        deps._suggester_cache_key("org/custom-classifier", None, "org/custom-ner", None)
    ]


def test_diagnosis_fails_closed_without_the_ner_selection(client) -> None:
    r = client.post(
        "/api/v1/diagnosis/suggestions",
        json={
            "text": "patient reports fever and chills",
            "model_name": "org/custom-classifier",
            "tenant_id": "tenant-a",
        },
    )
    assert r.status_code == 503
