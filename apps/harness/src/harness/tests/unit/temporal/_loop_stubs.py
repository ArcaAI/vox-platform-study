"""Programmable stub activities for ``ConsultationLoopWorkflow`` tests.

Replaces every loop activity (same registered name) with a deterministic stub so
the workflow tests exercise pure orchestration — the pinned config, signal
de-duplication, the depth cap, budget degradation, ``continue_as_new`` and the
child-finalize ``ParentClosePolicy`` — with no network I/O at all. Not collected
by pytest (does not match ``test_*``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity

from harness.temporal.models import (
    CaptureFeedbackInput,
    CaptureFeedbackResponse,
    ConsultationLoopConfig,
    DeriveContextInput,
    DeriveContextResult,
    EmitLoopEventInput,
    EmitLoopEventResult,
    FetchLoopConfigInput,
    FinalizeDocumentsInput,
    FinalizeDocumentsResponse,
    LiveDocControlInput,
    LiveDocControlResult,
    LoopAgentSpec,
    LoopBudget,
    LoopSubscription,
    PlanDecision,
    PlanLoopInput,
    PlannedSpecialist,
    RecordAdjudicationInput,
    RecordSessionEndpointInput,
    RecordSessionEndpointResponse,
    SpecialistAnalysisInput,
    SpecialistFinding,
    SpecialistResult,
)


@dataclass
class LoopStubRecorder:
    """Records every stub invocation so a test can assert the dispatch sequence."""

    calls: list[tuple[str, Any]] = field(default_factory=list)

    def record(self, name: str, payload: Any) -> None:
        self.calls.append((name, payload))

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)

    def payloads(self, name: str) -> list[Any]:
        return [p for n, p in self.calls if n == name]


@dataclass
class LoopStubConfig:
    """Per-scenario behaviour for the loop stub activity set."""

    # The config the (single) ``fetch_loop_config`` call returns.
    config: ConsultationLoopConfig | None = None
    # Raise from ``fetch_loop_config`` instead of returning (unpinnable config).
    fetch_fails: bool = False
    # Seconds each dispatch activity sleeps — used to open a window in which a
    # signal lands WHILE an activity is in flight.
    dispatch_delay_s: float = 0.0

    # -- reasoning lane ------------------------------------------
    # Findings the stub specialist returns, per agent id. A default is used for
    # any agent not named here, so most tests need not configure anything.
    specialist_findings: dict[str, list[SpecialistFinding]] = field(default_factory=dict)
    # Agent ids whose specialist activity RAISES — the failure-isolation lever.
    failing_specialists: set[str] = field(default_factory=set)
    # Force a degraded planner answer (dispatches nothing).
    plan_degrades: bool = False

    # endpoint stage
    # Endpoint action names whose stub RAISES, so a test can prove the loop
    # reports a failed endpoint action as an OBSERVABLE skip and still runs the
    # rest of the sequence.
    failing_endpoint_actions: set[str] = field(default_factory=set)
    # Document keys the finalize stub reports it locked. Defaults to TWO keys on
    # purpose: DD-3 is that finalize locks EVERY document, and a single-document
    # default would let a SOAP-only implementation pass.
    finalize_document_keys: list[str] = field(
        default_factory=lambda: ["soap-note", "discharge-summary"]
    )


def default_loop_config(**overrides: Any) -> ConsultationLoopConfig:
    """A servable config subscribing TRANSCRIPT-ish kinds to ``client.emit``."""
    base: dict[str, Any] = {
        "enabled": True,
        "context_schema_version_id": "csv-1",
        "agent_config_version_id": "dav-1",
        "agent_id": "agent-1",
        "department_id": "dept-1",
        "subscriptions": [
            LoopSubscription(kind_key="transcript", actions=["client.emit"]),
            LoopSubscription(kind_key="worknote", actions=["client.emit"]),
        ],
        "budget": LoopBudget(max_depth=2, max_actions=50),
        "start_actions": [],
        "ending_actions": [],
    }
    base.update(overrides)
    return ConsultationLoopConfig(**base)


# The default reasoning roster: one primary plus two specialists with DISJOINT
# read scopes, which is what makes the scoped-read assertions meaningful.
REASONING_PRIMARY = LoopAgentSpec(
    agent_id="agent-primary",
    role="PRIMARY",
    slug="primary",
    goal="Produce one reconciled note",
    subscribed_kinds=["transcript", "worknote"],
    write_scope=["note", "gate"],
)
REASONING_CARDIO = LoopAgentSpec(
    agent_id="agent-cardio",
    role="SPECIALIST",
    slug="cardiology",
    subscribed_kinds=["transcript"],
    write_scope=["cardiology_finding"],
)
REASONING_PHARM = LoopAgentSpec(
    agent_id="agent-pharm",
    role="SPECIALIST",
    slug="pharmacy",
    subscribed_kinds=["worknote"],
    write_scope=["medication_finding"],
)


def reasoning_loop_config(**overrides: Any) -> ConsultationLoopConfig:
    """A servable config with the reasoning lane ON and a three-agent roster."""
    base: dict[str, Any] = {
        "reasoning_enabled": True,
        "agents": [REASONING_PRIMARY, REASONING_CARDIO, REASONING_PHARM],
        # Deliberately EMPTY by default: `harness.finalize` starts a child
        # `HarnessDocWorkflow`, which the loop awaits, so a test that does not
        # register and sign that child would hang. The two tests that care about
        # finalize opt in explicitly.
        "ending_actions": [],
    }
    base.update(overrides)
    return default_loop_config(**base)


def make_loop_stub_activities(
    config: LoopStubConfig,
    recorder: LoopStubRecorder,
) -> list[Callable[..., Any]]:
    """Build the stub activity set (registered under the real activity names)."""

    resolved = config.config if config.config is not None else default_loop_config()

    @activity.defn(name="fetch_loop_config")
    async def fetch_loop_config_stub(payload: FetchLoopConfigInput) -> ConsultationLoopConfig:
        recorder.record("fetch_loop_config", payload)
        if config.fetch_fails:
            raise RuntimeError("loop config endpoint unavailable")
        return resolved

    async def _delay() -> None:
        if config.dispatch_delay_s:
            await asyncio.sleep(config.dispatch_delay_s)

    @activity.defn(name="livedoc_start")
    async def livedoc_start_stub(payload: LiveDocControlInput) -> LiveDocControlResult:
        recorder.record("livedoc_start", payload)
        await _delay()
        return LiveDocControlResult(ok=True)

    @activity.defn(name="livedoc_stop")
    async def livedoc_stop_stub(payload: LiveDocControlInput) -> LiveDocControlResult:
        recorder.record("livedoc_stop", payload)
        await _delay()
        return LiveDocControlResult(ok=True)

    # endpoint stage

    @activity.defn(name="record_session_endpoint")
    async def record_session_endpoint_stub(
        payload: RecordSessionEndpointInput,
    ) -> RecordSessionEndpointResponse:
        recorder.record("record_session_endpoint", payload)
        await _delay()
        if "session.timeout" in config.failing_endpoint_actions:
            raise RuntimeError("endpoint disposition endpoint unavailable")
        return RecordSessionEndpointResponse(recorded=True, changed=True, reason=payload.reason)

    @activity.defn(name="finalize_documents")
    async def finalize_documents_stub(
        payload: FinalizeDocumentsInput,
    ) -> FinalizeDocumentsResponse:
        recorder.record("finalize_documents", payload)
        await _delay()
        if "summary.finalize" in config.failing_endpoint_actions:
            raise RuntimeError("finalize endpoint unavailable")
        return FinalizeDocumentsResponse(
            document_keys=list(config.finalize_document_keys),
            locked_sections=len(config.finalize_document_keys),
        )

    @activity.defn(name="capture_feedback")
    async def capture_feedback_stub(payload: CaptureFeedbackInput) -> CaptureFeedbackResponse:
        recorder.record("capture_feedback", payload)
        await _delay()
        if "feedback.capture" in config.failing_endpoint_actions:
            raise RuntimeError("feedback endpoint unavailable")
        return CaptureFeedbackResponse(captured=True)

    @activity.defn(name="emit_loop_event")
    async def emit_loop_event_stub(payload: EmitLoopEventInput) -> EmitLoopEventResult:
        recorder.record("emit_loop_event", payload)
        await _delay()
        return EmitLoopEventResult(emitted=True)

    # -- reasoning lane ------------------------------------------

    @activity.defn(name="plan_reasoning")
    async def plan_reasoning_stub(payload: PlanLoopInput) -> PlanDecision:
        """Dispatch every candidate whose read scope covers a triggering kind.

        Deterministic on purpose: the point of these tests is the ORCHESTRATION
        around the planner (cycle detection, budget, scoping, adjudication), not
        the model's judgement.
        """
        recorder.record("plan_reasoning", payload)
        await _delay()
        plan_id = f"{payload.consultation_id}:{payload.plan_seq}"
        if config.plan_degrades:
            return PlanDecision(plan_id=plan_id, dispatch=[], degraded=True)
        dispatch = [
            PlannedSpecialist(agent_id=agent.agent_id, kind_key=kind, reason="stub")
            for agent in payload.candidates
            for kind in payload.trigger_kinds
            if agent.reads(kind)
        ]
        return PlanDecision(plan_id=plan_id, dispatch=dispatch, rationale="stub plan")

    @activity.defn(name="run_specialist")
    async def run_specialist_stub(payload: SpecialistAnalysisInput) -> SpecialistResult:
        recorder.record("run_specialist", payload)
        await _delay()
        if payload.agent_id in config.failing_specialists:
            raise RuntimeError(f"specialist {payload.agent_id} is unavailable")
        findings = config.specialist_findings.get(payload.agent_id)
        if findings is None:
            findings = [
                SpecialistFinding(
                    output_kind=payload.write_scope[0] if payload.write_scope else "finding",
                    statement=f"{payload.agent_id} reviewed {payload.kind_key}",
                    confidence=0.7,
                )
            ]
        return SpecialistResult(
            agent_id=payload.agent_id,
            plan_id=payload.plan_id,
            kind_key=payload.kind_key,
            findings=list(findings),
        )

    @activity.defn(name="record_adjudication")
    async def record_adjudication_stub(payload: RecordAdjudicationInput) -> EmitLoopEventResult:
        recorder.record("record_adjudication", payload)
        await _delay()
        return EmitLoopEventResult(emitted=True)

    def _derive_stub(name: str, suffix: str):
        @activity.defn(name=name)
        async def _stub(payload: DeriveContextInput) -> DeriveContextResult:
            recorder.record(name, payload)
            await _delay()
            return DeriveContextResult(
                derived=True,
                context_item_id=f"{payload.context_item_id}:{suffix}",
                kind_key=f"{payload.kind_key or 'context'}_{suffix}",
                text=f"derived from {payload.context_item_id}",
            )

        return _stub

    return [
        fetch_loop_config_stub,
        livedoc_start_stub,
        livedoc_stop_stub,
        record_session_endpoint_stub,
        finalize_documents_stub,
        capture_feedback_stub,
        emit_loop_event_stub,
        plan_reasoning_stub,
        run_specialist_stub,
        record_adjudication_stub,
        _derive_stub("vision_extract_text", "text"),
        _derive_stub("document_extract_text", "text"),
        _derive_stub("nlp_extract_entities", "entities"),
    ]
