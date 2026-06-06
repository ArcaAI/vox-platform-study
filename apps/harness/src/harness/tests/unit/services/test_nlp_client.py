"""Tests for the NLP tool client (POST /api/v1/classify/tokens).

RED-first: written before ``harness.services.nlp_client`` exists. The client
sends the documented body and maps the NLP NER response shape
(``{text, normalized_text, entity_type, confidence, position:{start,end}}``)
to Lane H's ``NEREntity{text, type, start, end}``.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.sensors.base import NEREntity
from harness.services.nlp_client import NlpClient


def _capture():
    seen: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(
            200,
            json={
                "entities": [
                    {
                        "id": "e1",
                        "text": "diabetes",
                        "normalized_text": "diabetes",
                        "entity_type": "DISEASE",
                        "confidence": 0.95,
                        "position": {"start": 12, "end": 20},
                        "model_version": "1.0.0",
                    },
                    {
                        "id": "e2",
                        "text": "chest pain",
                        "normalized_text": "chest pain",
                        "entity_type": "SYMPTOM",
                        "confidence": 0.89,
                        "position": {"start": 43, "end": 53},
                        "model_version": "1.0.0",
                    },
                ],
                "model_version": "1.0.0",
            },
        )

    return seen, handler


class TestNlpClient:
    @pytest.mark.asyncio
    async def test_classify_tokens_posts_documented_body(self):
        seen, handler = _capture()
        client = NlpClient("http://nlp:8864", transport=httpx.MockTransport(handler))

        await client.classify_tokens("Patient has diabetes and chest pain")

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://nlp:8864/api/v1/classify/tokens"
        body = json.loads(req.content)
        assert body == {
            "text": "Patient has diabetes and chest pain",
            "aggregation_strategy": "simple",
            "language": "en",
        }

    @pytest.mark.asyncio
    async def test_classify_tokens_maps_response_to_ner_entities(self):
        _seen, handler = _capture()
        client = NlpClient("http://nlp:8864", transport=httpx.MockTransport(handler))

        entities = await client.classify_tokens("Patient has diabetes and chest pain")

        assert all(isinstance(e, NEREntity) for e in entities)
        assert entities[0] == NEREntity(text="diabetes", type="DISEASE", start=12, end=20)
        assert entities[1] == NEREntity(text="chest pain", type="SYMPTOM", start=43, end=53)
