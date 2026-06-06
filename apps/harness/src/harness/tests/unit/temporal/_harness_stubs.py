"""Programmable stub activities for HarnessDocWorkflow tests.

Replace every real activity (same registered name) with a deterministic stub so
the workflow tests exercise pure orchestration — bounded regen, the gate
wait-condition + SLA escalation, and the degradation paths — without any
network/NLP/SMR I/O. Not collected by pytest (does not match ``test_*``).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from temporalio import activity
from temporalio.exceptions import ApplicationError

from harness.sensors.base import NEREntity, SensorResult
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.api_client import (
    AssembleResponse,
    DraftResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
)
from harness.services.sensor_runner import SensorRunOutput
from harness.services.smr_client import SmrGenerationResult
from harness.temporal.models import (
    AssembleInput,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    GenerateInput,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    RunSensorsInput,
)

_OK_NOTE = '{"subjective": "s", "objective": "o", "assessment": "a", "plan": "p"}'


@dataclass
class StubConfig:
    """Per-scenario behaviour for the stub activity set."""

    verdicts: list[str] = field(default_factory=lambda: ["PASS"])
    nlp_fails: bool = False
    generate_fails: bool = False
    note_content: str = _OK_NOTE


@dataclass
class StubRecorder:
    """Captures what the workflow drove (call counts + payloads)."""

    calls: Counter = field(default_factory=Counter)
    persist_entities_inputs: list[PersistEntitiesInput] = field(default_factory=list)
    persist_draft_inputs: list[PersistDraftInput] = field(default_factory=list)
    record_inputs: list[RecordGateInput] = field(default_factory=list)
    escalate_inputs: list[EscalateInput] = field(default_factory=list)


def _ok(name: str) -> SensorResult:
    return SensorResult(name=name, score=1.0, passed=True)


def _results_for(kind: str) -> list[SensorResult]:
    """Build a 5-sensor result list that aggregates to ``kind``."""
    if kind == "PASS":
        return [_ok(n) for n in COMPUTATIONAL_SENSOR_NAMES]
    if kind == "REGEN":
        # coverage_omission (regen-fixable) fails, names a target section.
        return [
            _ok("entity_faithfulness"),
            SensorResult(
                name="coverage_omission",
                score=0.5,
                passed=False,
                claims_flagged=["omitted-dx"],
                details={"sections": ["O"]},
            ),
            _ok("schema_validity"),
            _ok("citation_presence"),
            _ok("numeric_dose"),
        ]
    if kind == "FLAG":
        # entity_faithfulness (highest-harm) fails -> escalate to clinician.
        return [
            SensorResult(
                name="entity_faithfulness", score=0.0, passed=False, claims_flagged=["warfarin"]
            ),
            _ok("coverage_omission"),
            _ok("schema_validity"),
            _ok("citation_presence"),
            _ok("numeric_dose"),
        ]
    raise ValueError(f"unknown verdict kind: {kind}")


def make_stub_activities(config: StubConfig, recorder: StubRecorder) -> list:
    """Build the full set of name-matched stub activities."""

    @activity.defn(name="extract_entities")
    async def extract_entities(payload: ExtractEntitiesInput) -> EntitiesResult:
        recorder.calls["extract_entities"] += 1
        if config.nlp_fails:
            raise ApplicationError("nlp unavailable", non_retryable=True)
        return EntitiesResult(
            entities=[NEREntity(text="hypertension", type="DISEASE", start=0, end=12)]
        )

    @activity.defn(name="persist_entities")
    async def persist_entities(payload: PersistEntitiesInput) -> PersistEntitiesResponse:
        recorder.calls["persist_entities"] += 1
        recorder.persist_entities_inputs.append(payload)
        n = len(payload.entities)
        return PersistEntitiesResponse(saved_count=n, entity_ids=[f"e{i}" for i in range(n)])

    @activity.defn(name="assemble_prompt")
    async def assemble_prompt(payload: AssembleInput) -> AssembleResponse:
        recorder.calls["assemble_prompt"] += 1
        return AssembleResponse(
            user_prompt="U",
            system_prompt="S",
            hyperparameters={"temperature": 0.2, "max_tokens": 1024},
            response_format={
                "type": "json_schema",
                "json_schema": {"type": "object"},
                "strict": True,
            },
            prompt_template_id="tmpl-1",
            prompt_version="3",
            resolved_from="department",
        )

    @activity.defn(name="generate")
    async def generate(payload: GenerateInput) -> SmrGenerationResult:
        recorder.calls["generate"] += 1
        if config.generate_fails:
            raise ApplicationError("smr unavailable", non_retryable=True)
        return SmrGenerationResult(
            content=config.note_content,
            model="gpt-4o",
            provider="azure-openai",
            usage={"total_tokens": 40},
            latency_ms=10,
            finish_reason="stop",
        )

    @activity.defn(name="run_sensors")
    async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
        i = recorder.calls["run_sensors"]
        recorder.calls["run_sensors"] += 1
        kind = config.verdicts[min(i, len(config.verdicts) - 1)]
        results = _results_for(kind)
        return SensorRunOutput(
            results=results,
            citations_map={"claims": [{"id": "c1", "evidence": [{"quote": "x"}]}]},
            scores={r.name: r.score for r in results},
            soap_sections={},
        )

    @activity.defn(name="persist_draft")
    async def persist_draft(payload: PersistDraftInput) -> DraftResponse:
        recorder.calls["persist_draft"] += 1
        recorder.persist_draft_inputs.append(payload)
        return DraftResponse(context_item_id="ctx-draft-1")

    @activity.defn(name="record_gate_decision")
    async def record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
        recorder.calls["record_gate_decision"] += 1
        recorder.record_inputs.append(payload)
        return RecordGateResponse(recorded=True)

    @activity.defn(name="escalate_gate")
    async def escalate_gate(payload: EscalateInput) -> EscalateResult:
        recorder.calls["escalate_gate"] += 1
        recorder.escalate_inputs.append(payload)
        return EscalateResult(escalated=True)

    return [
        extract_entities,
        persist_entities,
        assemble_prompt,
        generate,
        run_sensors,
        persist_draft,
        record_gate_decision,
        escalate_gate,
    ]
