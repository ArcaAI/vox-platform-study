"""Tests for the document-type text-classifier default model.

The `/classify/text` endpoint is meant for *clinical document-type* classification,
but historically defaulted to an *emotion* model (`michellejieli/emotion_text_classifier`)
as a placeholder. The intended clinical taxonomy/model is an open product decision, so the
default must NOT be the emotion model: it must be an explicit, non-functional placeholder
that makes the service loudly signal it is unconfigured rather than silently emit emotion
labels for clinical text.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest

from nlp.core.config import UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL, TextClassificationConfig
from nlp.services.text_classifier import TransformerTextClassifier

EMOTION_MODEL = "michellejieli/emotion_text_classifier"


@pytest.fixture()
def clean_text_classifier_env(monkeypatch):
    """Ensure config defaults are exercised, independent of any ambient env."""
    monkeypatch.delenv("TEXT_CLASSIFIER_MODEL_NAME", raising=False)
    monkeypatch.delenv("TEXT_CLASSIFIER_TOKENIZER_NAME", raising=False)


def test_default_model_is_not_the_emotion_classifier(clean_text_classifier_env):
    config = TextClassificationConfig()
    assert config.model_name != EMOTION_MODEL
    assert config.tokenizer_name != EMOTION_MODEL


def test_default_model_is_the_unconfigured_placeholder(clean_text_classifier_env):
    config = TextClassificationConfig()
    assert config.model_name == UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL
    assert config.is_configured is False


def test_explicit_model_name_marks_config_as_configured(clean_text_classifier_env):
    config = TextClassificationConfig(model_name="some-org/clinical-doctype-model")
    assert config.is_configured is True


async def test_initialize_when_unconfigured_warns_and_stays_uninitialized(
    clean_text_classifier_env, caplog
):
    classifier = TransformerTextClassifier()

    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as mock_tokenizer,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mock_model,
        patch("nlp.services.text_classifier.pipeline") as mock_pipeline,
        caplog.at_level(logging.WARNING, logger="nlp.services.text_classifier"),
    ):
        await classifier.initialize()

    # Must NOT attempt to load the placeholder as a real model.
    mock_tokenizer.from_pretrained.assert_not_called()
    mock_model.from_pretrained.assert_not_called()
    mock_pipeline.assert_not_called()

    # Endpoint must report itself unavailable (REST returns 503 on this).
    assert classifier.is_initialized is False
    assert classifier.pipeline is None

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings, "expected a loud warning that doc-type classification is unconfigured"
    joined = " ".join(r.getMessage() for r in warnings).lower()
    assert "unconfigured" in joined
    # the doc-type classifier is now driven by a required, DB-backed
    # model_name rather than the TEXT_CLASSIFIER_MODEL_NAME env var.
    assert "model_name" in joined


async def test_initialize_when_configured_loads_model_without_warning(
    clean_text_classifier_env, caplog
):
    config = TextClassificationConfig(model_name="some-org/clinical-doctype-model")
    classifier = TransformerTextClassifier(config=config)

    with (
        patch("nlp.services.text_classifier.AutoTokenizer") as mock_tokenizer,
        patch("nlp.services.text_classifier.AutoModelForSequenceClassification") as mock_model,
        patch("nlp.services.text_classifier.pipeline", return_value=MagicMock()),
        caplog.at_level(logging.WARNING, logger="nlp.services.text_classifier"),
    ):
        await classifier.initialize()

    mock_tokenizer.from_pretrained.assert_called_once_with("some-org/clinical-doctype-model")
    mock_model.from_pretrained.assert_called_once_with("some-org/clinical-doctype-model")
    assert classifier.is_initialized is True

    unconfigured_warnings = [
        r for r in caplog.records if "unconfigured" in r.getMessage().lower()
    ]
    assert not unconfigured_warnings
