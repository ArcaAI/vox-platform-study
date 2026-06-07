"""Tests for the apps/api internal-harness tool client.

RED-first: written before ``harness.services.api_client`` exists. The client
targets the (configurable) ``{api_base_url}{api_internal_prefix}`` mount, always
sends ``X-Service-Token`` + ``tenantId`` in the body, maps Lane H ``NEREntity``s
to Lane G's camelCase ``HarnessEntityItem`` shape, and parses the camelCase
responses into snake_case typed models.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.sensors.base import NEREntity
from harness.services.api_client import ApiClient


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://api:8868",
        internal_prefix="/internal/harness",
        service_token="svc-token",
        transport=httpx.MockTransport(handler),
    )


class TestPersistEntities:
    @pytest.mark.asyncio
    async def test_persist_entities_posts_mapped_entities_with_token(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"savedCount": 2, "entityIds": ["a", "b"]})

        client = _client(handler)
        entities = [
            NEREntity(text="diabetes", type="DISEASE", start=12, end=20),
            NEREntity(text="chest pain", type="SYMPTOM", start=43, end=53),
        ]

        result = await client.persist_entities(
            "c-1", tenant_id="t-1", context_item_id="ctx-1", entities=entities, user_id="u-1"
        )

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/entities"
        assert req.headers["X-Service-Token"] == "svc-token"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["userId"] == "u-1"
        assert body["contextItemId"] == "ctx-1"
        assert body["entities"][0] == {
            "text": "diabetes",
            "type": "DISEASE",
            "normalizedText": "diabetes",
            "startOffset": 12,
            "endOffset": 20,
            "transcriptContextItemId": "ctx-1",
            "transcriptStartOffset": 12,
            "transcriptEndOffset": 20,
        }
        assert result.saved_count == 2
        assert result.entity_ids == ["a", "b"]


class TestAssemble:
    @pytest.mark.asyncio
    async def test_assemble_posts_body_and_maps_camel_response(self):
        seen: dict[str, httpx.Request] = {}
        response_format = {"type": "json_schema", "json_schema": {"type": "object"}, "strict": True}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(
                200,
                json={
                    "userPrompt": "USER",
                    "systemPrompt": "SYS",
                    "hyperparameters": {"temperature": 0.2, "max_tokens": 1024},
                    "responseFormat": response_format,
                    "promptTemplateId": "tmpl-1",
                    "promptVersion": "3",
                    "resolvedFrom": "department",
                },
            )

        client = _client(handler)
        result = await client.assemble("c-1", tenant_id="t-1", conversation_language="en")

        req = seen["request"]
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/assemble"
        assert req.headers["X-Service-Token"] == "svc-token"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["conversationLanguage"] == "en"
        assert result.user_prompt == "USER"
        assert result.system_prompt == "SYS"
        assert result.hyperparameters == {"temperature": 0.2, "max_tokens": 1024}
        assert result.response_format == response_format
        assert result.prompt_template_id == "tmpl-1"
        assert result.prompt_version == "3"
        assert result.resolved_from == "department"


class TestPersistDraft:
    @pytest.mark.asyncio
    async def test_persist_draft_posts_scores_and_citations_returns_context_item_id(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"contextItemId": "ctx-draft-1"})

        client = _client(handler)
        result = await client.persist_draft(
            "c-1",
            tenant_id="t-1",
            content='{"subjective": "ok"}',
            model_name="gpt-4o",
            sensor_scores={"entity_faithfulness": 1.0},
            citations_map={"claims": []},
            entity_faithfulness_score=1.0,
            coverage_score=0.9,
            rag_triad_score=0.92,
            guardrail_decisions={"safety": {"verdict": "pass"}, "groundedness": {"score": 0.88}},
            reduced_assurance=True,
            gate_decision="PASS",
            prompt_template_id="tmpl-1",
            prompt_version="3",
            job_id="job-1",
            is_auto_generated=True,
        )

        req = seen["request"]
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/draft"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["content"] == '{"subjective": "ok"}'
        assert body["sensorScores"] == {"entity_faithfulness": 1.0}
        assert body["citationsMap"] == {"claims": []}
        assert body["entityFaithfulnessScore"] == 1.0
        assert body["coverageScore"] == 0.9
        assert body["ragTriadScore"] == 0.92
        assert body["guardrailDecisions"] == {"safety": {"verdict": "pass"}, "groundedness": {"score": 0.88}}
        assert body["reducedAssurance"] is True
        assert body["gateDecision"] == "PASS"
        assert body["promptTemplateId"] == "tmpl-1"
        assert body["jobId"] == "job-1"
        assert body["isAutoGenerated"] is True
        assert result.context_item_id == "ctx-draft-1"

    @pytest.mark.asyncio
    async def test_persist_draft_prunes_guardrail_fields_when_not_provided(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"contextItemId": "ctx-draft-2"})

        client = _client(handler)
        await client.persist_draft("c-1", tenant_id="t-1", content="{}")

        body = json.loads(seen["request"].content)
        assert "guardrailDecisions" not in body
        assert "reducedAssurance" not in body


class TestRecordGateDecision:
    @pytest.mark.asyncio
    async def test_record_gate_decision_posts_attestation(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"recorded": True})

        client = _client(handler)
        result = await client.record_gate_decision(
            "c-1",
            tenant_id="t-1",
            decision="SIGNED",
            gate_decision="PASS",
            context_item_version_id="v-1",
            attestation_hash="h-1",
            clinician_id="doc-1",
        )

        req = seen["request"]
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/gate-decision"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["decision"] == "SIGNED"
        assert body["gateDecision"] == "PASS"
        assert body["contextItemVersionId"] == "v-1"
        assert body["attestationHash"] == "h-1"
        assert body["clinicianId"] == "doc-1"
        assert result.recorded is True


class TestConfigurablePrefix:
    @pytest.mark.asyncio
    async def test_prefix_is_configurable_for_lane_g_actual_mount(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"savedCount": 0, "entityIds": []})

        client = ApiClient(
            "http://api:8868",
            internal_prefix="/api/v1/internal/harness",
            service_token="svc-token",
            transport=httpx.MockTransport(handler),
        )
        await client.persist_entities("c-1", tenant_id="t-1", context_item_id="ctx-1", entities=[])

        assert (
            str(seen["request"].url)
            == "http://api:8868/api/v1/internal/harness/consultations/c-1/entities"
        )
