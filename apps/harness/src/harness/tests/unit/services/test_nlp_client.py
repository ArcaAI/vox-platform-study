"""Tests for the NLP tool client (POST /api/v1/classify/tokens).

The client
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

        await client.classify_tokens(
            "Patient has diabetes and chest pain", tenant_id="11111111-1111-1111-1111-111111111111"
        )

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

        entities = await client.classify_tokens(
            "Patient has diabetes and chest pain", tenant_id="11111111-1111-1111-1111-111111111111"
        )

        assert all(isinstance(e, NEREntity) for e in entities)
        assert entities[0] == NEREntity(text="diabetes", type="DISEASE", start=12, end=20)
        assert entities[1] == NEREntity(text="chest pain", type="SYMPTOM", start=43, end=53)

    @pytest.mark.asyncio
    async def test_classify_tokens_attaches_service_token_header(self):
        # NLP's ServiceAuthMiddleware requires X-Service-Token whenever
        # NLP_SERVICE_TOKEN is configured — the client must present it.
        seen, handler = _capture()
        client = NlpClient(
            "http://nlp:8864", service_token="tok-1", transport=httpx.MockTransport(handler)
        )

        await client.classify_tokens(
            "Patient has diabetes", tenant_id="11111111-1111-1111-1111-111111111111"
        )

        assert seen["request"].headers["X-Service-Token"] == "tok-1"

    @pytest.mark.asyncio
    async def test_classify_tokens_omits_service_token_header_when_unset(self):
        # No token configured (local dev-bypass case) → no header sent.
        seen, handler = _capture()
        client = NlpClient("http://nlp:8864", transport=httpx.MockTransport(handler))

        await client.classify_tokens(
            "Patient has diabetes", tenant_id="11111111-1111-1111-1111-111111111111"
        )

        assert "x-service-token" not in seen["request"].headers

    @pytest.mark.asyncio
    async def test_classify_tokens_maps_ontology_codes(self):
        """The NLP entity carries ontology codes; the client
        maps them onto ``NEREntity`` so harness NER round-trips coded entities."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "entities": [
                        {
                            "id": "e1",
                            "text": "metformin",
                            "normalized_text": "metformin",
                            "entity_type": "MEDICATION",
                            "confidence": 0.97,
                            "position": {"start": 14, "end": 23},
                            "rxnorm_code": "6809",
                            "umls_cui": "C0025598",
                            "snomed_code": None,
                            "icd_code": None,
                            "loinc_code": None,
                        }
                    ],
                    "model_version": "1.0.0",
                },
            )

        client = NlpClient("http://nlp:8864", transport=httpx.MockTransport(handler))
        entities = await client.classify_tokens(
            "patient takes metformin", tenant_id="11111111-1111-1111-1111-111111111111"
        )

        assert len(entities) == 1
        ent = entities[0]
        assert ent.rxnorm_code == "6809"
        assert ent.umls_cui == "C0025598"
        assert ent.snomed_code is None
        assert ent.icd_code is None
        assert ent.loinc_code is None
