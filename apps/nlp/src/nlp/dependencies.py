from typing import cast

from nlp.core.config import (
    UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL,
    MedicalSuggesterConfig,
    TextClassificationConfig,
    TokenClassificationConfig,
)
from nlp.core.websocket_manager import WebSocketManager
from nlp.services.document_extractor import DocumentExtractor
from nlp.services.medical_suggester import MedicalSuggester
from nlp.services.model_cache import ModelCache
from nlp.services.text_classifier import TextClassifier, TransformerTextClassifier
from nlp.services.text_corrector import SymSpellCorrector, TextCorrector
from nlp.services.token_classifier import TokenClassifier, TransformerTokenClassifier


def get_text_classifier() -> TextClassifier:
    if globals().get("_text_classifier_instance") is None:
        globals()["_text_classifier_instance"] = TransformerTextClassifier()
    return cast(TextClassifier, globals()["_text_classifier_instance"])


def get_token_classifier() -> TokenClassifier:
    if globals().get("_token_classifier_instance") is None:
        globals()["_token_classifier_instance"] = TransformerTokenClassifier()
    return cast(TokenClassifier, globals()["_token_classifier_instance"])


def get_text_corrector() -> TextCorrector:
    if globals().get("_text_corrector_instance") is None:
        globals()["_text_corrector_instance"] = SymSpellCorrector()
    return cast(TextCorrector, globals()["_text_corrector_instance"])


def get_medical_suggester() -> MedicalSuggester:
    if globals().get("_medical_suggester_instance") is None:
        globals()["_medical_suggester_instance"] = MedicalSuggester(token_classifier=get_token_classifier())
    return cast(MedicalSuggester, globals()["_medical_suggester_instance"])


def get_websocket_manager() -> WebSocketManager:
    if globals().get("_websocket_manager_instance") is None:
        globals()["_websocket_manager_instance"] = WebSocketManager()
    return cast(WebSocketManager, globals()["_websocket_manager_instance"])


def get_document_extractor() -> DocumentExtractor:
    if globals().get("_document_extractor_instance") is None:
        globals()["_document_extractor_instance"] = DocumentExtractor()
    return cast(DocumentExtractor, globals()["_document_extractor_instance"])


# ---------------------------------------------------------------------------
# Per-request model selection (TASK-506).
#
# Requests may carry an optional `model_name` override (gateway-injected from
# the AiTaskDefault registry). The env-configured default instances above stay
# the startup-preloaded singletons; overrides resolve to per-model instances in
# a bounded per-slot LRU cache (lazily created, initialized on first use).
# ---------------------------------------------------------------------------


async def _create_token_classifier(model_name: str) -> TokenClassifier:
    configs = TokenClassificationConfig(model_name=model_name, tokenizer_name=model_name)
    instance = TransformerTokenClassifier(configs=configs)
    await instance.initialize()
    return instance


async def _create_text_classifier(model_name: str) -> TextClassifier:
    config = TextClassificationConfig(model_name=model_name, tokenizer_name=model_name)
    instance = TransformerTextClassifier(config=config)
    await instance.initialize()
    if not instance.is_initialized:
        # Only the placeholder sentinel initializes "successfully" without
        # loading — refuse to cache a non-functional classifier.
        raise RuntimeError(f"text classification model failed to load: {model_name}")
    return instance


async def _create_medical_suggester(model_name: str) -> MedicalSuggester:
    # Overrides ONLY the disease-classification model — the internal NER stays
    # the default token classifier (already initialized; initialize() is
    # idempotent so the shared instance is never reloaded).
    config = MedicalSuggesterConfig(model_name=model_name, tokenizer_name=model_name)
    instance = MedicalSuggester(config=config, token_classifier=get_token_classifier())
    await instance.initialize()
    return instance


def _token_classifier_cache() -> ModelCache[TokenClassifier]:
    if globals().get("_token_classifier_cache_instance") is None:
        globals()["_token_classifier_cache_instance"] = ModelCache(factory=_create_token_classifier)
    return cast("ModelCache[TokenClassifier]", globals()["_token_classifier_cache_instance"])


def _text_classifier_cache() -> ModelCache[TextClassifier]:
    if globals().get("_text_classifier_cache_instance") is None:
        globals()["_text_classifier_cache_instance"] = ModelCache(factory=_create_text_classifier)
    return cast("ModelCache[TextClassifier]", globals()["_text_classifier_cache_instance"])


def _medical_suggester_cache() -> ModelCache[MedicalSuggester]:
    if globals().get("_medical_suggester_cache_instance") is None:
        globals()["_medical_suggester_cache_instance"] = ModelCache(factory=_create_medical_suggester)
    return cast("ModelCache[MedicalSuggester]", globals()["_medical_suggester_cache_instance"])


async def get_token_classifier_for(model_name: str | None) -> TokenClassifier:
    """Resolve the token classifier for an optional per-request model override."""
    default = get_token_classifier()
    if not model_name or model_name == getattr(default, "model_name", None):
        return default
    return await _token_classifier_cache().get(model_name)


async def get_text_classifier_for(model_name: str | None) -> TextClassifier:
    """Resolve the text classifier for an optional per-request model override."""
    default = get_text_classifier()
    if not model_name:
        return default
    if model_name == UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL:
        # The placeholder sentinel is never loadable — even when it happens to
        # be the default's (unconfigured) model name.
        raise RuntimeError("the doc-type classifier placeholder sentinel is not a loadable model")
    if model_name == getattr(default, "model_name", None):
        return default
    return await _text_classifier_cache().get(model_name)


async def get_medical_suggester_for(model_name: str | None) -> MedicalSuggester:
    """Resolve the medical suggester for an optional classification-model override."""
    default = get_medical_suggester()
    default_model = getattr(getattr(default, "config", None), "model_name", None)
    if not model_name or model_name == default_model:
        return default
    return await _medical_suggester_cache().get(model_name)
