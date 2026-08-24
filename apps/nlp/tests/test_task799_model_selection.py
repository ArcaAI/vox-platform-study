"""TASK-799 lane C.2 (F-04) — no hardcoded model ids, anywhere.

`core/config.py` defaulted `TokenClassificationConfig` to a real NER checkpoint
and `MedicalSuggesterConfig` to a real disease-classification checkpoint. Both
were LIVE, because `dependencies.py` built those classifiers with NO config at
all — the env-source filter only stopped env from *changing* the selection,
which is what made the violation look closed.

Owner directive: services MUST work from the tenant's or the platform's
configuration. So a resolved selection is a REQUIRED argument, and an
unresolved one is a REFUSAL (503) — never a substituted literal.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from nlp.core.config import MedicalSuggesterConfig, TokenClassificationConfig

SRC = Path(__file__).resolve().parents[1] / "src"


class TestConfigsRefuseToInventAModel:
    def test_token_classification_config_requires_a_model(self) -> None:
        with pytest.raises(ValidationError):
            TokenClassificationConfig()

    def test_medical_suggester_config_requires_a_model(self) -> None:
        with pytest.raises(ValidationError):
            MedicalSuggesterConfig()

    def test_an_injected_selection_is_accepted(self) -> None:
        config = TokenClassificationConfig(model_name="db/ner", tokenizer_name="db/ner")
        assert config.model_name == "db/ner"


class TestNoZeroArgumentClassifierConstructors:
    """The getters that supplied the hardcoded defaults are gone entirely.

    Every classifier is now resolved per request through the model cache from a
    caller-supplied selection, so a process-wide singleton built from settings
    has no remaining job — and while it exists it is a way back to a literal.
    """

    @pytest.mark.parametrize(
        "name", ["get_token_classifier", "get_text_classifier", "get_medical_suggester"]
    )
    def test_singleton_getter_is_removed(self, name: str) -> None:
        import nlp.dependencies as deps

        assert not hasattr(deps, name)

    def test_token_classifier_requires_a_config(self) -> None:
        from nlp.services.token_classifier import TransformerTokenClassifier

        with pytest.raises(TypeError):
            TransformerTokenClassifier()  # type: ignore[call-arg]

    def test_medical_suggester_requires_a_config_and_a_ner(self) -> None:
        from nlp.services.medical_suggester import MedicalSuggester

        with pytest.raises(TypeError):
            MedicalSuggester()  # type: ignore[call-arg]


class TestNoModelIdLiteralInShippedPython:
    """The two ids TASK-778's guard deliberately excluded are now in scope.

    That guard covered the safety-plane vendors only, and said so; the NER and
    diagnosis planes were recorded as a pre-existing finding. This closes them,
    so the exclusion note in `test_no_hardcoded_model_ids_task778.py` no longer
    describes live code.
    """

    FORBIDDEN = re.compile(r"(?<![\w/-])(?:blaze999|shanover)/[A-Za-z0-9._-]+")

    @pytest.mark.parametrize("path", sorted(SRC.rglob("*.py")), ids=lambda p: str(p))
    def test_ner_and_diagnosis_ids_are_gone(self, path: Path) -> None:
        hits = self.FORBIDDEN.findall(path.read_text(encoding="utf-8"))
        assert not hits, f"{path} names model id(s) {sorted(set(hits))} in shipped Python."


class TestRestRoutesFailClosed:
    def test_diagnosis_requires_the_ner_selection_too(self, client) -> None:
        """The suggester runs TWO models: a disease classifier AND an internal
        NER. Only the first was ever injected; the second silently used the
        hardcoded default, so half the route stayed un-configurable."""
        response = client.post(
            "/api/v1/diagnosis/suggestions",
            json={"text": "headache and fever", "model_name": "db/dx", "tenant_id": "t-1"},
        )
        assert response.status_code == 503
        assert response.json()["error"] == "Diagnosis NER model selection is unresolved"

    def test_diagnosis_still_refuses_a_missing_disease_model(self, client) -> None:
        response = client.post(
            "/api/v1/diagnosis/suggestions",
            json={
                "text": "headache and fever",
                "ner_model_name": "db/ner",
                "tenant_id": "t-1",
            },
        )
        assert response.status_code == 503
        assert response.json()["error"] == "Diagnosis classification model selection is unresolved"


@pytest.fixture()
def ws_client(client):
    """`client` stubs the websocket manager out; these cases need the real one.

    The shared fixture's stub has no `handle_connection`, so the handshake would
    fail before a message is ever read. The override is keyed on the callable the
    ROUTE MODULE holds, because that is what its `Depends` default captured.
    """
    import nlp.api.v1.ws.classify as ws_routes
    from nlp.core.websocket_manager import WebSocketManager

    client.app.dependency_overrides[ws_routes.get_websocket_manager] = WebSocketManager
    yield client
    client.app.dependency_overrides.clear()


class TestWebSocketRoutesCarrySelectionAndTenant:
    """The WS classify routes took neither a model nor a tenant.

    They resolved the process singleton — i.e. the hardcoded default — for
    every message, on a surface with no attribution at all.
    """

    def test_token_socket_refuses_a_message_with_no_model(self, ws_client) -> None:
        client = ws_client
        with client.websocket_connect("/ws/classify/token/s1") as socket:
            socket.send_text(json.dumps({"text": "aspirin 100mg", "tenant_id": "t-1"}))
            message = socket.receive_json()
        assert message["type"] == "error"
        assert "503" in json.dumps(message["data"])

    def test_token_socket_refuses_a_message_with_no_tenant(self, ws_client) -> None:
        client = ws_client
        with client.websocket_connect("/ws/classify/token/s2") as socket:
            socket.send_text(json.dumps({"text": "aspirin 100mg", "model_name": "db/ner"}))
            message = socket.receive_json()
        assert message["type"] == "error"
        assert "428" in json.dumps(message["data"])

    def test_text_socket_refuses_a_message_with_no_model(self, ws_client) -> None:
        client = ws_client
        with client.websocket_connect("/ws/classify/text/s3") as socket:
            socket.send_text(json.dumps({"text": "discharge summary", "tenant_id": "t-1"}))
            message = socket.receive_json()
        assert message["type"] == "error"
        assert "503" in json.dumps(message["data"])
