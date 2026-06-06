"""Unit tests for the document-loop activities (input → client mapping).

The orchestration is covered in ``test_doc_workflow`` with stubbed activities;
here we run each *real* activity body in a proper Temporal ``ActivityEnvironment``
with the module-level client factories monkeypatched to deterministic fakes, so
we assert the activity maps its typed input onto the right tool-client call and
returns the typed result. No network I/O.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.sensors.base import NEREntity
from harness.services.api_client import (
    AssembleResponse,
    DraftResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
)
from harness.services.smr_client import SmrGenerationResult
from harness.temporal import activities
from harness.temporal.models import (
    AssembleInput,
    EscalateInput,
    ExtractEntitiesInput,
    GenerateInput,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    RunSensorsInput,
)


class _FakeNlp:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def classify_tokens(self, text: str, *, language: str = "en") -> list[NEREntity]:
        self.calls.append((text, language))
        return [NEREntity(text="hypertension", type="DISEASE", start=0, end=12)]


class _FakeSmr:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        self.kwargs = kwargs
        return SmrGenerationResult(content="DRAFT", model="m", finish_reason="stop")


class _FakeApi:
    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}

    async def persist_entities(self, consultation_id: str, **kw: Any) -> PersistEntitiesResponse:
        self.calls["persist_entities"] = {"consultation_id": consultation_id, **kw}
        return PersistEntitiesResponse(saved_count=len(kw.get("entities", [])), entity_ids=["e0"])

    async def assemble(self, consultation_id: str, **kw: Any) -> AssembleResponse:
        self.calls["assemble"] = {"consultation_id": consultation_id, **kw}
        return AssembleResponse(user_prompt="U", system_prompt="S")

    async def persist_draft(self, consultation_id: str, **kw: Any) -> DraftResponse:
        self.calls["persist_draft"] = {"consultation_id": consultation_id, **kw}
        return DraftResponse(context_item_id="ctx-1")

    async def record_gate_decision(self, consultation_id: str, **kw: Any) -> RecordGateResponse:
        self.calls["record_gate_decision"] = {"consultation_id": consultation_id, **kw}
        return RecordGateResponse(recorded=True)


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestExtractEntities:
    @pytest.mark.asyncio
    async def test_delegates_to_nlp_client_and_maps_entities(self, env, monkeypatch):
        fake = _FakeNlp()
        monkeypatch.setattr(activities, "_nlp_client", lambda s: fake)
        result = await env.run(
            activities.extract_entities, ExtractEntitiesInput(text="hi", language="vi")
        )
        assert [e.text for e in result.entities] == ["hypertension"]
        assert fake.calls == [("hi", "vi")]


class TestGenerate:
    @pytest.mark.asyncio
    async def test_unpacks_hyperparameters_and_passes_response_format(self, env, monkeypatch):
        fake = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: fake)
        rf = {"type": "json_schema", "json_schema": {"type": "object"}}
        result = await env.run(
            activities.generate,
            GenerateInput(
                prompt="P",
                system_prompt="S",
                response_format=rf,
                hyperparameters={"temperature": 0.3, "max_tokens": 512, "top_p": 0.9},
                provider="azure-openai",
                model="gpt-4o",
            ),
        )
        assert result.content == "DRAFT"
        assert fake.kwargs["prompt"] == "P"
        assert fake.kwargs["system_prompt"] == "S"
        assert fake.kwargs["temperature"] == 0.3
        assert fake.kwargs["max_tokens"] == 512
        assert fake.kwargs["top_p"] == 0.9
        assert fake.kwargs["response_format"] == rf
        assert fake.kwargs["provider"] == "azure-openai"
        assert fake.kwargs["model"] == "gpt-4o"


class TestApiActivities:
    @pytest.mark.asyncio
    async def test_persist_entities_forwards_payload(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.persist_entities,
            PersistEntitiesInput(
                consultation_id="c-1",
                tenant_id="t-1",
                context_item_id="ctx-t1",
                entities=[NEREntity(text="x", type="DISEASE", start=0, end=1)],
                user_id="u-1",
            ),
        )
        assert result.saved_count == 1
        call = fake.calls["persist_entities"]
        assert call["consultation_id"] == "c-1"
        assert call["tenant_id"] == "t-1"
        assert call["context_item_id"] == "ctx-t1"

    @pytest.mark.asyncio
    async def test_assemble_prompt_forwards_consultation(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.assemble_prompt,
            AssembleInput(consultation_id="c-1", tenant_id="t-1", conversation_language="en"),
        )
        assert result.user_prompt == "U"
        assert fake.calls["assemble"]["consultation_id"] == "c-1"

    @pytest.mark.asyncio
    async def test_persist_draft_forwards_scores_and_citations(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.persist_draft,
            PersistDraftInput(
                consultation_id="c-1",
                tenant_id="t-1",
                content="DRAFT",
                sensor_scores={"entity_faithfulness": 1.0},
                citations_map={"claims": []},
                gate_decision="PASS",
                is_auto_generated=True,
            ),
        )
        assert result.context_item_id == "ctx-1"
        call = fake.calls["persist_draft"]
        assert call["content"] == "DRAFT"
        assert call["gate_decision"] == "PASS"
        assert call["sensor_scores"] == {"entity_faithfulness": 1.0}

    @pytest.mark.asyncio
    async def test_record_gate_decision_forwards_attestation(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.record_gate_decision,
            RecordGateInput(
                consultation_id="c-1",
                tenant_id="t-1",
                decision="SIGNED",
                gate_decision="PASS",
                clinician_id="doc-1",
                attestation_hash="h-1",
            ),
        )
        assert result.recorded is True
        call = fake.calls["record_gate_decision"]
        assert call["decision"] == "SIGNED"
        assert call["clinician_id"] == "doc-1"


_SOAP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "subjective": {"type": "string"},
        "objective": {"type": "string"},
        "assessment": {"type": "string"},
        "plan": {"type": "string"},
    },
    "required": ["subjective", "objective", "assessment", "plan"],
}


class TestRunSensors:
    @pytest.mark.asyncio
    async def test_runs_real_sensors_and_returns_scores(self, env):
        note = '{"subjective": "s", "objective": "o", "assessment": "a", "plan": "p"}'
        result = await env.run(
            activities.run_sensors,
            RunSensorsInput(
                note_text=note,
                transcript_text="patient",
                note_entities=[],
                transcript_entities=[],
                response_format={
                    "type": "json_schema",
                    "json_schema": _SOAP_SCHEMA,
                    "strict": True,
                },
            ),
        )
        assert result.results  # sensors ran
        assert set(result.scores)  # scores populated
        assert "claims" in result.citations_map


class TestEscalateGate:
    @pytest.mark.asyncio
    async def test_escalate_is_failsafe_no_op(self, env):
        result = await env.run(
            activities.escalate_gate,
            EscalateInput(consultation_id="c-1", tenant_id="t-1", reason="gate_sla_breached"),
        )
        assert result.escalated is True
