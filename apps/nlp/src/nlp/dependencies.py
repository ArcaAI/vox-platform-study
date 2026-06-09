from typing import cast

from nlp.core.websocket_manager import WebSocketManager
from nlp.services.document_extractor import DocumentExtractor
from nlp.services.medical_suggester import MedicalSuggester
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
