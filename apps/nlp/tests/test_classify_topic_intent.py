"""Route-level tests for `/classify/topic` and `/classify/intent` (TASK-729).

Hermetic: the FastAPI app is a minimal shell mounting only the REST v1
routers (no lifespan → no real ExternalTextClient); `get_external_text_client`
is overridden with a fake. Mirrors `test_model_override_routes.py`'s style —
fail-closed 503 on missing gateway-injected instructions, and the peer-call
delegation on the happy path.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nlp.api.v1 import rest_api_router_v1
from nlp.dependencies import get_external_text_client
from nlp.services.external_text_client import ExternalTextUnavailableError


class _FakeExternalTextClient:
    def __init__(self, label: str = "billing") -> None:
        self.label = label
        self.calls: list[dict] = []
        self.raise_error = False

    async def generate_label(self, prompt: str, system_prompt: str | None = None, tenant_id: str | None = None) -> str:
        self.calls.append({"prompt": prompt, "system_prompt": system_prompt, "tenant_id": tenant_id})
        if self.raise_error:
            raise ExternalTextUnavailableError("text unreachable")
        return self.label


@pytest.fixture()
def app_and_client():
    app = FastAPI()
    app.include_router(rest_api_router_v1)
    fake = _FakeExternalTextClient()
    app.dependency_overrides[get_external_text_client] = lambda: fake
    return app, TestClient(app), fake


class TestClassifyTopic:
    def test_missing_instructions_fails_closed_503(self, app_and_client):
        _, client, fake = app_and_client
        resp = client.post("/api/v1/classify/topic", json={"text": "I have a billing question"})
        assert resp.status_code == 503
        assert fake.calls == []

    def test_empty_instructions_fails_closed_503(self, app_and_client):
        _, client, fake = app_and_client
        resp = client.post("/api/v1/classify/topic", json={"text": "I have a billing question", "instructions": []})
        assert resp.status_code == 503
        assert fake.calls == []

    def test_delegates_to_external_text_client_and_returns_label(self, app_and_client):
        _, client, fake = app_and_client
        fake.label = "billing"
        resp = client.post(
            "/api/v1/classify/topic",
            json={"text": "I have a billing question", "instructions": ["billing", "appointments"], "tenant_id": "t1"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["predicted_topic"] == "billing"
        assert body["available_topics"] == ["billing", "appointments"]
        assert len(fake.calls) == 1
        assert "billing" in fake.calls[0]["prompt"]
        assert "appointments" in fake.calls[0]["prompt"]
        assert fake.calls[0]["tenant_id"] == "t1"

    def test_upstream_unavailable_maps_to_503(self, app_and_client):
        _, client, fake = app_and_client
        fake.raise_error = True
        resp = client.post(
            "/api/v1/classify/topic",
            json={"text": "hello", "instructions": ["billing"]},
        )
        assert resp.status_code == 503


class TestClassifyIntent:
    def test_missing_instructions_fails_closed_503(self, app_and_client):
        _, client, fake = app_and_client
        resp = client.post("/api/v1/classify/intent", json={"text": "book me an appointment"})
        assert resp.status_code == 503
        assert fake.calls == []

    def test_delegates_to_external_text_client_and_returns_label(self, app_and_client):
        _, client, fake = app_and_client
        fake.label = "schedule_appointment"
        resp = client.post(
            "/api/v1/classify/intent",
            json={"text": "book me an appointment", "instructions": ["schedule_appointment", "cancel_appointment"]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["predicted_intent"] == "schedule_appointment"
        assert body["available_intents"] == ["schedule_appointment", "cancel_appointment"]
