"""Route-level tests for per-request model selection (TASK-506).

Hermetic: transformers loading is mocked and the FastAPI app is a minimal
shell mounting only the REST v1 routers (no lifespan → no eager model loads).
The default (env-configured) instances are injected into the
``nlp.dependencies`` singleton slots so the no-``model_name`` path can be
asserted byte-for-byte unchanged.
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
from nlp.schemas.classification import TokenClassificationResponse
from nlp.schemas.diagnosis import DiagnosisSuggestionResponse

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


class _FakeTokenClassifier:
    def __init__(self, model_name: str = "blaze999/Medical-NER") -> None:
        self.model_name = model_name
        self.is_initialized = True
        self.processed: list = []

    async def initialize(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass

    async def process(self, request) -> TokenClassificationResponse:
        self.processed.append(request)
        return TokenClassificationResponse(entities=[], model_version=f"fake:{self.model_name}")


class _FakeTextClassifier:
    """Stands in for the (unconfigured-by-default) doc-type classifier."""

    def __init__(self, model_name: str = UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL) -> None:
        self.model_name = model_name
        self.is_initialized = False


class _FakeSuggester:
    def __init__(self) -> None:
        self.is_initialized = True
        self.requests: list = []

    async def suggest(self, request) -> DiagnosisSuggestionResponse:
        self.requests.append(request)
        return DiagnosisSuggestionResponse(
            suggestions=[], symptoms_analyzed=[], model_version="fake"
        )


# ---------------------------------------------------------------------------
# Default path — no model_name → the startup singleton, cache never touched
# ---------------------------------------------------------------------------


def test_classify_tokens_without_model_name_uses_default_singleton(client, clean_deps) -> None:
    fake = _FakeTokenClassifier()
    clean_deps._token_classifier_instance = fake

    r = client.post("/api/v1/classify/tokens", json={"text": "fever"})

    assert r.status_code == 200
    assert r.json()["model_version"] == "fake:blaze999/Medical-NER"
    assert len(fake.processed) == 1
    assert clean_deps._token_classifier_cache_instance is None  # cache never consulted


def test_diagnosis_without_model_name_uses_default_singleton(client, clean_deps) -> None:
    fake = _FakeSuggester()
    clean_deps._medical_suggester_instance = fake

    r = client.post("/api/v1/diagnosis/suggestions", json={"text": "fever and chills"})

    assert r.status_code == 200
    assert len(fake.requests) == 1
    assert clean_deps._medical_suggester_cache_instance is None


async def test_resolver_none_returns_default_singleton(clean_deps) -> None:
    fake = _FakeTokenClassifier()
    clean_deps._token_classifier_instance = fake

    assert await deps.get_token_classifier_for(None) is fake
    assert clean_deps._token_classifier_cache_instance is None


def test_model_name_matching_default_reuses_singleton(client, clean_deps) -> None:
    fake = _FakeTokenClassifier("blaze999/Medical-NER")
    clean_deps._token_classifier_instance = fake

    r = client.post(
        "/api/v1/classify/tokens",
        json={"text": "fever", "model_name": "blaze999/Medical-NER"},
    )

    assert r.status_code == 200
    assert len(fake.processed) == 1
    assert clean_deps._token_classifier_cache_instance is None


# ---------------------------------------------------------------------------
# model_name path — cached-or-lazily-created per-model instance
# ---------------------------------------------------------------------------


def test_model_name_creates_and_caches_distinct_instance(client, clean_deps) -> None:
    default = _FakeTokenClassifier()
    clean_deps._token_classifier_instance = default

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
    # loaded exactly once (second request served from the cache) …
    tok.from_pretrained.assert_called_once_with("org/custom-ner")
    mdl.from_pretrained.assert_called_once_with("org/custom-ner")
    # … and the default singleton was never involved
    assert default.processed == []
    cache = clean_deps._token_classifier_cache_instance
    assert cache is not None
    assert cache.cached_models() == ["org/custom-ner"]


def test_model_load_failure_returns_503(client, clean_deps) -> None:
    clean_deps._token_classifier_instance = _FakeTokenClassifier()

    with (
        patch("nlp.services.token_classifier.AutoTokenizer") as tok,
        patch("nlp.services.token_classifier.AutoModelForTokenClassification"),
        patch("nlp.services.token_classifier.pipeline"),
    ):
        tok.from_pretrained.side_effect = OSError("no such model on the hub")
        r = client.post(
            "/api/v1/classify/tokens", json={"text": "x", "model_name": "org/missing"}
        )

    assert r.status_code == 503


def test_classify_text_model_name_loads_custom_model(client, clean_deps) -> None:
    clean_deps._text_classifier_instance = _FakeTextClassifier()  # sentinel default

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
    clean_deps._text_classifier_instance = _FakeTextClassifier()

    r = client.post(
        "/api/v1/classify/text",
        json={"text": "x", "model_name": UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL},
    )

    assert r.status_code == 503


# ---------------------------------------------------------------------------
# Diagnosis — model_name overrides ONLY the suggester's classification model
# ---------------------------------------------------------------------------


def test_diagnosis_model_name_overrides_classifier_only(client, clean_deps) -> None:
    default_token = _FakeTokenClassifier()
    clean_deps._token_classifier_instance = default_token

    cls_pipe = MagicMock(return_value=[{"label": "LABEL_10", "score": 0.9}])
    with (
        patch("nlp.services.medical_suggester.AutoTokenizer") as cls_tok,
        patch("nlp.services.medical_suggester.AutoModelForSequenceClassification") as cls_mdl,
        patch("nlp.services.medical_suggester.pipeline", return_value=cls_pipe),
        patch("nlp.services.token_classifier.AutoTokenizer") as ner_tok,
        patch("nlp.services.token_classifier.AutoModelForTokenClassification") as ner_mdl,
    ):
        r = client.post(
            "/api/v1/diagnosis/suggestions",
            json={
                "text": "patient reports fever and chills",
                "model_name": "org/custom-classifier",
            },
        )

    assert r.status_code == 200
    # the override drove the classification model …
    cls_tok.from_pretrained.assert_called_once_with("org/custom-classifier")
    cls_mdl.from_pretrained.assert_called_once_with("org/custom-classifier")
    # … while the internal NER stayed the default token classifier
    ner_tok.from_pretrained.assert_not_called()
    ner_mdl.from_pretrained.assert_not_called()
    assert len(default_token.processed) == 1
    cache = clean_deps._medical_suggester_cache_instance
    assert cache is not None
    assert cache.cached_models() == ["org/custom-classifier"]
