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
from harness.services.api_client import ApiClient, ApiServiceError


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

    @pytest.mark.asyncio
    async def test_persist_entities_forwards_ontology_codes(self):
        """TASK-476 C1 — a coded NEREntity forwards its ontology codes into the
        HarnessEntityItem body so persistEntities writes the NamedEntity columns.
        Codes with no value are omitted (mirrors the existing offset pruning)."""
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"savedCount": 1, "entityIds": ["a"]})

        client = _client(handler)
        entities = [
            NEREntity(
                text="metformin",
                type="MEDICATION",
                start=14,
                end=23,
                rxnorm_code="6809",
                umls_cui="C0025598",
            ),
        ]

        await client.persist_entities(
            "c-1", tenant_id="t-1", context_item_id="ctx-1", entities=entities
        )

        item = json.loads(seen["request"].content)["entities"][0]
        assert item["rxnormCode"] == "6809"
        assert item["umlsCui"] == "C0025598"
        # Unset codes are omitted (not sent as null) — consistent with offsets.
        assert "snomedCode" not in item
        assert "icdCode" not in item
        assert "loincCode" not in item


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


class TestRetractDraft:
    """TASK-481 (E2) — the retraction write path (mirrors finalize_assurance)."""

    @pytest.mark.asyncio
    async def test_retract_draft_posts_flag_verdict_and_reason(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"retracted": True, "contextItemId": "ctx-1"})

        client = _client(handler)
        result = await client.retract_draft(
            "c-1",
            tenant_id="t-1",
            context_item_id="ctx-1",
            context_item_version_id="v-2",
            gate_decision="FLAG",
            reason="assurance_flag",
            claims_flagged=["Start warfarin"],
            user_id="u-1",
            job_id="job-1",
            idempotency_key="idem-1",
        )

        req = seen["request"]
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/retraction"
        assert req.headers["Idempotency-Key"] == "idem-1"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["contextItemId"] == "ctx-1"
        assert body["contextItemVersionId"] == "v-2"
        assert body["gateDecision"] == "FLAG"
        assert body["reason"] == "assurance_flag"
        assert body["claimsFlagged"] == ["Start warfarin"]
        assert result.retracted is True
        assert result.context_item_id == "ctx-1"

    @pytest.mark.asyncio
    async def test_retract_draft_raises_on_http_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.retract_draft("c-1", tenant_id="t-1", context_item_id="ctx-1")


_POLICY_JSON = {
    "id": "hp-1",
    "tenantId": "t-1",
    "source": "tenant",
    "entityFaithfulnessThreshold": 0.7,
    "coverageThreshold": 0.6,
    "citationPresenceThreshold": 0.9,
    "numericDoseThreshold": 1.0,
    "groundednessThreshold": 0.5,
    "safetyEnabled": False,
    "phiEnabled": False,
    "phiFailClosed": False,
    "safetyProvider": "ollama",
    "safetyModel": "granite-guardian-x",
    "smrProvider": "azure",
    "smrModel": "gpt-4o",
    "maxRegen": 4,
    "gateSlaSeconds": 3600,
    "gateEscalationSeconds": 1800,
    "toolAllowlist": ["nlp", "smr"],
    "updatedAt": "2026-06-07T00:00:00Z",
    "version": 7,
}


class TestGetPolicy:
    """The worker ``fetch_policy`` activity reads the effective harness policy from
    the apps/api worker-facing endpoint (TASK-330 Phase 6 — Phase C.3)."""

    @pytest.mark.asyncio
    async def test_get_policy_gets_with_tenant_query_and_token(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json=_POLICY_JSON)

        client = _client(handler)
        data = await client.get_policy("t-1")

        req = seen["request"]
        assert req.method == "GET"
        assert str(req.url) == "http://api:8868/internal/harness/policy?tenantId=t-1"
        assert req.headers["X-Service-Token"] == "svc-token"
        # The raw camelCase contract is returned verbatim (mapped by the activity).
        assert data["coverageThreshold"] == 0.6
        assert data["safetyEnabled"] is False
        assert data["version"] == 7

    @pytest.mark.asyncio
    async def test_get_policy_raises_on_upstream_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "policy unavailable"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.get_policy("t-1")


class TestLoadEntityPriors:
    """TASK-480 Half-B — the read counterpart of persist_entities: the ``extract_entities``
    activity reads persisted coded NamedEntity rows as NER priors from apps/api."""

    @pytest.mark.asyncio
    async def test_gets_with_tenant_query_and_maps_camel_rows_to_ner_entities(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(
                200,
                json={
                    "entities": [
                        {
                            "text": "hypertension",
                            "type": "DISEASE",
                            "normalizedText": "hypertension",
                            "startOffset": 12,
                            "endOffset": 24,
                            "snomedCode": "38341003",
                            "umlsCui": "C0020538",
                        },
                        {"text": "metformin", "type": "MEDICATION", "rxnormCode": "6809"},
                    ]
                },
            )

        client = _client(handler)
        priors = await client.load_entity_priors("c-1", tenant_id="t-1")

        req = seen["request"]
        assert req.method == "GET"
        assert (
            str(req.url) == "http://api:8868/internal/harness/consultations/c-1/entities?tenantId=t-1"
        )
        assert req.headers["X-Service-Token"] == "svc-token"
        assert [(e.text, e.type, e.start, e.end) for e in priors] == [
            ("hypertension", "DISEASE", 12, 24),
            ("metformin", "MEDICATION", -1, -1),  # missing offsets default to -1
        ]
        # Ontology codes carry through so the activity can gate reuse on them.
        assert priors[0].snomed_code == "38341003"
        assert priors[0].umls_cui == "C0020538"
        assert priors[1].rxnorm_code == "6809"
        assert priors[1].snomed_code is None

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_rows(self):
        client = _client(lambda request: httpx.Response(200, json={"entities": []}))
        assert await client.load_entity_priors("c-1", tenant_id="t-1") == []

    @pytest.mark.asyncio
    async def test_raises_on_upstream_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "not found"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.load_entity_priors("c-1", tenant_id="t-1")


class TestReportProgress:
    """TASK-345 — live progress feed: the workflow's ``report_progress`` activity
    posts one stage event per phase to the internal progress endpoint."""

    @pytest.mark.asyncio
    async def test_report_progress_posts_camelcase_stage_event_with_token(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        client = _client(handler)
        result = await client.report_progress(
            "c-1",
            tenant_id="t-1",
            stage="drafting_note",
            label="Drafting the note",
            ordinal=3,
            total=5,
            job_id="harness-doc-1",
        )

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/progress"
        assert req.headers["X-Service-Token"] == "svc-token"
        body = json.loads(req.content)
        assert body == {
            "tenantId": "t-1",
            "jobId": "harness-doc-1",
            "stage": "drafting_note",
            "label": "Drafting the note",
            "ordinal": 3,
            "total": 5,
        }
        assert result.ok is True

    @pytest.mark.asyncio
    async def test_report_progress_prunes_optional_fields(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        client = _client(handler)
        await client.report_progress("c-1", tenant_id="t-1", stage="completed")

        body = json.loads(seen["request"].content)
        assert body == {"tenantId": "t-1", "stage": "completed"}

    @pytest.mark.asyncio
    async def test_report_progress_raises_on_upstream_error(self):
        # The client raises like every other method; the ACTIVITY is the layer
        # that swallows (progress must never fail the workflow).
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "redis down"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.report_progress("c-1", tenant_id="t-1", stage="drafting_note")


class TestReportAssuranceEvent:
    """TASK-355 Phase D Slice 5d (Q5 true mid-pass live feed): the
    ``run_inferential_sensors`` activity posts ONE resolved claim verdict per
    claim to the internal assurance-event endpoint as each claim settles."""

    @pytest.mark.asyncio
    async def test_report_assurance_event_posts_camelcase_claim_with_token(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        client = _client(handler)
        result = await client.report_assurance_event(
            "c-1",
            tenant_id="t-1",
            claim_id="claim-7",
            sensor="groundedness",
            verdict="grounded",
            label="Assessment",
            ordinal=3,
            total=12,
            job_id="harness-doc-1",
        )

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/assurance-event"
        assert req.headers["X-Service-Token"] == "svc-token"
        body = json.loads(req.content)
        assert body == {
            "tenantId": "t-1",
            "jobId": "harness-doc-1",
            "claimId": "claim-7",
            "sensor": "groundedness",
            "verdict": "grounded",
            "label": "Assessment",
            "ordinal": 3,
            "total": 12,
        }
        assert result.ok is True

    @pytest.mark.asyncio
    async def test_report_assurance_event_prunes_optional_fields(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        client = _client(handler)
        await client.report_assurance_event(
            "c-1", tenant_id="t-1", claim_id="claim-1", sensor="groundedness", verdict="ungrounded"
        )

        body = json.loads(seen["request"].content)
        assert body == {
            "tenantId": "t-1",
            "claimId": "claim-1",
            "sensor": "groundedness",
            "verdict": "ungrounded",
        }

    @pytest.mark.asyncio
    async def test_report_assurance_event_raises_on_upstream_error(self):
        # The client raises like every other method; the ACTIVITY is the layer
        # that swallows (the live feed must never fail the assurance pass).
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "redis down"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.report_assurance_event(
                "c-1", tenant_id="t-1", claim_id="claim-1", sensor="safety", verdict="flag"
            )


class TestRecordEscalation:
    """C1-05 (TASK-458): an SLA breach is recorded to apps/api (was a local no-op).
    The apps/api endpoint that consumes this is a coordinated follow-up (out of the
    harness manifest); the harness-side POST is fail-safe at the activity layer."""

    @pytest.mark.asyncio
    async def test_record_escalation_posts_reason_with_token(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"recorded": True})

        client = _client(handler)
        result = await client.record_escalation(
            "c-1",
            tenant_id="t-1",
            reason="gate_sla_breached",
            escalation_count=2,
            job_id="job-1",
        )

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://api:8868/internal/harness/consultations/c-1/escalation"
        assert req.headers["X-Service-Token"] == "svc-token"
        body = json.loads(req.content)
        assert body["tenantId"] == "t-1"
        assert body["reason"] == "gate_sla_breached"
        assert body["escalationCount"] == 2
        assert body["jobId"] == "job-1"
        assert result.recorded is True

    @pytest.mark.asyncio
    async def test_record_escalation_prunes_optional_fields(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"recorded": True})

        client = _client(handler)
        await client.record_escalation("c-1", tenant_id="t-1", reason="gate_sla_breached")
        body = json.loads(seen["request"].content)
        assert body == {"tenantId": "t-1", "reason": "gate_sla_breached"}

    @pytest.mark.asyncio
    async def test_record_escalation_raises_on_upstream_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "down"})

        client = _client(handler)
        with pytest.raises(ApiServiceError):
            await client.record_escalation("c-1", tenant_id="t-1", reason="gate_sla_breached")

    @pytest.mark.asyncio
    async def test_record_escalation_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"recorded": True})

        client = _client(handler)
        await client.record_escalation(
            "c-1", tenant_id="t-1", reason="gate_sla_breached", idempotency_key="run-9:act-4"
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-4"


class TestIdempotencyKey:
    """C1-03 (TASK-458): every WORM/draft callback carries a deterministic
    ``Idempotency-Key`` header so a retried POST (Temporal ``_API_RETRY``) dedups
    on apps/api instead of double-writing the WORM audit / draft."""

    @staticmethod
    def _seen_handler(seen: dict[str, httpx.Request], json_body: dict):
        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json=json_body)

        return handler

    @pytest.mark.asyncio
    async def test_persist_draft_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"contextItemId": "ctx-1"}))
        await client.persist_draft(
            "c-1", tenant_id="t-1", content="{}", idempotency_key="run-9:act-3"
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-3"

    @pytest.mark.asyncio
    async def test_persist_draft_omits_header_when_no_key(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"contextItemId": "ctx-1"}))
        await client.persist_draft("c-1", tenant_id="t-1", content="{}")
        assert "Idempotency-Key" not in seen["request"].headers

    @pytest.mark.asyncio
    async def test_record_gate_decision_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"recorded": True}))
        await client.record_gate_decision(
            "c-1", tenant_id="t-1", decision="SIGNED", idempotency_key="run-9:act-7"
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-7"

    @pytest.mark.asyncio
    async def test_finalize_assurance_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"recorded": True, "contextItemId": "ctx-1"}))
        await client.finalize_assurance(
            "c-1", tenant_id="t-1", context_item_id="ctx-1", idempotency_key="run-9:act-8"
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-8"

    @pytest.mark.asyncio
    async def test_persist_entities_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"savedCount": 0, "entityIds": []}))
        await client.persist_entities(
            "c-1",
            tenant_id="t-1",
            context_item_id="ctx-1",
            entities=[],
            idempotency_key="run-9:act-1",
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-1"

    @pytest.mark.asyncio
    async def test_report_progress_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"ok": True}))
        await client.report_progress(
            "c-1", tenant_id="t-1", stage="drafting_note", idempotency_key="run-9:act-2"
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-2"

    @pytest.mark.asyncio
    async def test_report_assurance_event_attaches_idempotency_key_header(self):
        seen: dict[str, httpx.Request] = {}
        client = _client(self._seen_handler(seen, {"ok": True}))
        await client.report_assurance_event(
            "c-1",
            tenant_id="t-1",
            claim_id="claim-1",
            sensor="groundedness",
            verdict="grounded",
            idempotency_key="run-9:act-5:claim-1",
        )
        assert seen["request"].headers["Idempotency-Key"] == "run-9:act-5:claim-1"


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
