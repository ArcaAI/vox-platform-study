"""harness trajectory emitters + Prometheus metrics.

Two layers, both hermetic:

* Per-activity emission (``ActivityEnvironment`` + a capturing trajectory client
  monkeypatched onto ``activities._trajectory_api_client``): each real activity
  body emits the right ``(step_type, name, status)`` step and increments the
  right Prometheus metric — and a trajectory-route OUTAGE never fails the
  activity (fire-and-forget, like ``report_progress``).
* Full workflow ordered spine (time-skipping ``WorkflowEnvironment`` + real
  activities with the tool clients stubbed): the exact ORDERED step sequence a
  happy-path run emits, and that a trajectory OUTAGE never fails the workflow.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from prometheus_client import REGISTRY
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker

from harness.core.config import Settings
from harness.sensors.base import NEREntity
from harness.services.api_client import (
    ApiServiceError,
    AssembleResponse,
    DraftResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
    ReportProgressResponse,
    TrajectoryReportResponse,
)
from harness.services.sensor_runner import SensorRunOutput
from harness.services.smr_client import SmrGenerationResult
from harness.temporal import activities
from harness.temporal.models import (
    FetchPolicyInput,
    GenerateInput,
    PersistDraftInput,
    RecordGateInput,
    TrajectoryContext,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import _OK_NOTE, _results_for
from harness.tests.unit.temporal.test_activities import (
    _FakeGranite,
    _StubJudge,
)

# ---------------------------------------------------------------------------
# Capturing / failing trajectory clients
# ---------------------------------------------------------------------------


class _CapTraj:
    """Capturing ``report_trajectory`` client: records every batch + flat steps."""

    def __init__(self) -> None:
        self.steps: list[Any] = []
        self.batches: list[tuple[list[Any], str | None]] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        self.batches.append((list(steps), idempotency_key))
        return TrajectoryReportResponse(accepted=len(steps))


class _RaiseTraj:
    """Trajectory client that always fails — proves the fire-and-forget swallow."""

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        raise ApiServiceError("trajectory route unavailable")


def _traj_ctx(**kw: Any) -> TrajectoryContext:
    base: dict[str, Any] = {"tenant_id": "t-1", "consultation_id": "c-1", "seq": 0}
    base.update(kw)
    return TrajectoryContext(**base)


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _pairs(steps) -> list[tuple[str, str]]:
    return [(s.step_type, s.name) for s in steps]


# ---------------------------------------------------------------------------
# Per-activity emission
# ---------------------------------------------------------------------------


class TestActivityEmission:
    @pytest.mark.asyncio
    async def test_fetch_policy_emits_phase_step(self, env, monkeypatch):
        class _PolicyApi:
            async def get_policy(self, tenant_id: str) -> dict[str, Any]:
                return {"version": 5}

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_api_client", lambda s: _PolicyApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(
            activities.fetch_policy,
            FetchPolicyInput(tenant_id="t-1", trajectory=_traj_ctx(seq=0)),
        )

        assert _pairs(cap.steps) == [("PHASE", "fetch_policy")]
        step = cap.steps[0]
        assert step.status == "OK"
        assert step.seq == 0
        assert step.tenant_id == "t-1"
        assert step.consultation_id == "c-1"
        assert step.session_id and step.run_id  # from activity.info()
        assert step.started_at and step.ended_at
        # B1: durationMs must be an int on the wire — the apps/api ingest DTO
        # validates it as an integer under a strict pipe, and a fractional value
        # 400s the whole batch (silently dropped by fire-and-forget).
        assert step.duration_ms is not None and step.duration_ms >= 0
        assert isinstance(step.duration_ms, int)

    @pytest.mark.asyncio
    async def test_no_trajectory_context_emits_nothing(self, env, monkeypatch):
        class _PolicyApi:
            async def get_policy(self, tenant_id: str) -> dict[str, Any]:
                return {"version": 1}

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_api_client", lambda s: _PolicyApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        # No ``trajectory`` on the input (legacy / pre-510 call) ⇒ no report call.
        await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))
        assert cap.batches == []

    @pytest.mark.asyncio
    async def test_trajectory_outage_never_fails_activity(self, env, monkeypatch):
        class _PolicyApi:
            async def get_policy(self, tenant_id: str) -> dict[str, Any]:
                return {"version": 7}

        monkeypatch.setattr(activities, "_api_client", lambda s: _PolicyApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: _RaiseTraj())

        # The trajectory POST raises, but the activity still returns its policy.
        policy = await env.run(
            activities.fetch_policy,
            FetchPolicyInput(tenant_id="t-1", trajectory=_traj_ctx()),
        )
        assert policy.version == 7

    @pytest.mark.asyncio
    async def test_generate_emits_llm_call_with_stats(self, env, monkeypatch):
        stats = {
            "stop_reason": "stop",
            "total_ms": 950,
            "ttft_ms": 60,
            "tokens_per_second": 33.0,
            "prompt_tokens": 25,
            "predicted_tokens": 12,
            "total_tokens": 37,
            "provider": "openai_compat",
            "model": "m",
            "engine_native": None,
        }

        class _StatsSmr:
            async def generate(self, **kwargs: Any) -> SmrGenerationResult:
                return SmrGenerationResult(
                    content="DRAFT", model="m", finish_reason="stop", stats=stats
                )

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_smr_client", lambda s: _StatsSmr())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(activities.generate, GenerateInput(prompt="P", trajectory=_traj_ctx(seq=32)))

        assert _pairs(cap.steps) == [("LLM_CALL", "generate")]
        step = cap.steps[0]
        assert step.status == "OK"
        assert step.seq == 32
        # AD-1 stats embedded verbatim on the LLM_CALL step.
        assert step.stats == stats

    @pytest.mark.asyncio
    async def test_generate_emits_thinking_step_when_reasoning_present(self, env, monkeypatch):
        stats = {
            "stop_reason": "stop",
            "total_ms": 900,
            "provider": "openai_compat",
            "model": "m",
            "engine_native": {"reasoning_tokens": 42},
        }

        class _ReasoningSmr:
            async def generate(self, **kwargs: Any) -> SmrGenerationResult:
                return SmrGenerationResult(content="DRAFT", model="m", stats=stats)

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_smr_client", lambda s: _ReasoningSmr())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(activities.generate, GenerateInput(prompt="P", trajectory=_traj_ctx(seq=64)))

        assert _pairs(cap.steps) == [("LLM_CALL", "generate"), ("THINKING", "reasoning")]
        llm, thinking = cap.steps
        assert llm.seq == 64
        # THINKING is stats-only (payloadRef stays null — capture flag is OFF).
        assert thinking.seq == 65
        assert thinking.payload_ref is None
        assert thinking.stats == {"reasoning_tokens": 42}

    @pytest.mark.asyncio
    async def test_generate_regen_increments_regen_metric(self, env, monkeypatch):
        class _Smr:
            async def generate(self, **kwargs: Any) -> SmrGenerationResult:
                return SmrGenerationResult(content="DRAFT", model="m")

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_smr_client", lambda s: _Smr())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        before = REGISTRY.get_sample_value("harness_regen_total") or 0.0
        # is_regen=True ⇒ this generation is a bounded-regen iteration.
        await env.run(
            activities.generate, GenerateInput(prompt="P", trajectory=_traj_ctx(is_regen=True))
        )
        after = REGISTRY.get_sample_value("harness_regen_total") or 0.0
        assert after - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_step_emit_observes_duration_metric(self, env, monkeypatch):
        class _PolicyApi:
            async def get_policy(self, tenant_id: str) -> dict[str, Any]:
                return {"version": 1}

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_api_client", lambda s: _PolicyApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        labels = {"step_type": "PHASE", "name": "fetch_policy"}
        before = REGISTRY.get_sample_value("harness_step_duration_seconds_count", labels) or 0.0
        await env.run(
            activities.fetch_policy,
            FetchPolicyInput(tenant_id="t-1", trajectory=_traj_ctx()),
        )
        after = REGISTRY.get_sample_value("harness_step_duration_seconds_count", labels) or 0.0
        assert after - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_persist_draft_increments_gate_decision_metric(self, env, monkeypatch):
        class _DraftApi:
            async def persist_draft(self, consultation_id: str, **kw: Any) -> DraftResponse:
                return DraftResponse(context_item_id="ctx-1")

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_api_client", lambda s: _DraftApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        labels = {"decision": "PASS"}
        before = REGISTRY.get_sample_value("harness_gate_decision_total", labels) or 0.0
        await env.run(
            activities.persist_draft,
            PersistDraftInput(
                consultation_id="c-1",
                tenant_id="t-1",
                content=_OK_NOTE,
                gate_decision="PASS",
                trajectory=_traj_ctx(),
            ),
        )
        after = REGISTRY.get_sample_value("harness_gate_decision_total", labels) or 0.0
        assert after - before == pytest.approx(1.0)
        # The persist step itself is a PHASE marker (the GATE metric is decoupled).
        assert _pairs(cap.steps) == [("PHASE", "persist_draft")]

    @pytest.mark.asyncio
    async def test_record_gate_decision_emits_gate_step(self, env, monkeypatch):
        class _GateApi:
            async def record_gate_decision(
                self, consultation_id: str, **kw: Any
            ) -> RecordGateResponse:
                return RecordGateResponse(recorded=True)

        cap = _CapTraj()
        monkeypatch.setattr(activities, "_api_client", lambda s: _GateApi())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)

        await env.run(
            activities.record_gate_decision,
            RecordGateInput(
                consultation_id="c-1",
                tenant_id="t-1",
                decision="SIGNED",
                gate_decision="PASS",
                trajectory=_traj_ctx(),
            ),
        )
        assert _pairs(cap.steps) == [("GATE", "record_gate_decision")]


# ---------------------------------------------------------------------------
# Full workflow ordered spine (real activities, stubbed tool clients)
# ---------------------------------------------------------------------------


class _FakeNlp:
    async def classify_tokens(self, text: str, *, language: str = "en") -> list[NEREntity]:
        return [NEREntity(text="hypertension", type="DISEASE", start=0, end=12)]


class _FakeSmr:
    def __init__(self, stats: dict[str, Any] | None) -> None:
        self._stats = stats

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        return SmrGenerationResult(
            content=_OK_NOTE, model="gpt-4o", provider="azure-openai", stats=self._stats
        )


class _FakeApi:
    async def get_policy(self, tenant_id: str) -> dict[str, Any]:
        # code-default policy (safety on, phi on, no custom SMR model) but
        # WITH the SYSTEM harness.judge selection, so the real inferential pass builds
        # the (stubbed) judge instead of failing closed on a missing selection.
        return {"judgeProvider": "openai_compat", "judgeModel": "stub-judge"}

    async def persist_entities(self, consultation_id: str, **kw: Any) -> PersistEntitiesResponse:
        return PersistEntitiesResponse(saved_count=len(kw.get("entities", [])), entity_ids=["e0"])

    async def assemble(self, consultation_id: str, **kw: Any) -> AssembleResponse:
        return AssembleResponse(
            user_prompt="U",
            system_prompt="S",
            hyperparameters={"temperature": 0.2, "max_tokens": 1024},
            response_format={"type": "json_schema", "json_schema": {"type": "object"}, "strict": True},
            prompt_template_id="tmpl-1",
            prompt_version="3",
            resolved_from="department",
        )

    async def persist_draft(self, consultation_id: str, **kw: Any) -> DraftResponse:
        return DraftResponse(context_item_id="ctx-draft-1")

    async def record_gate_decision(self, consultation_id: str, **kw: Any) -> RecordGateResponse:
        return RecordGateResponse(recorded=True)


class _FakeProgressApi:
    async def report_progress(self, consultation_id: str, **kw: Any) -> ReportProgressResponse:
        return ReportProgressResponse(ok=True)


def _pass_sensor_output(**kwargs: Any) -> SensorRunOutput:
    results = _results_for("PASS")
    return SensorRunOutput(
        results=results,
        citations_map={"claims": [{"id": "c1", "evidence": [{"quote": "x"}]}]},
        scores={r.name: r.score for r in results},
        soap_sections={},
    )


def _patch_real_activity_clients(monkeypatch, cap, *, smr_stats=None, traj=None) -> None:
    """Stub every tool client the real activities reach, hermetically."""
    monkeypatch.setattr(
        activities,
        "get_settings",
        lambda: Settings(retrieval={"enabled": False}, ner_priors_enabled=False),
    )
    monkeypatch.setattr(activities, "_api_client", lambda s: _FakeApi())
    monkeypatch.setattr(activities, "_nlp_client", lambda s: _FakeNlp())
    monkeypatch.setattr(activities, "_smr_client", lambda s: _FakeSmr(smr_stats))
    monkeypatch.setattr(activities, "_progress_api_client", lambda s: _FakeProgressApi())
    monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
    monkeypatch.setattr(
        activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
    )
    # Force a deterministic PASS computational verdict (no regen) while keeping the
    # real ``run_sensors`` activity body (and its SENSOR-step emission).
    monkeypatch.setattr(activities, "run_computational_sensors", _pass_sensor_output)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: traj if traj else cap)


def _wf_input():
    from harness.temporal.models import HarnessDocWorkflowInput

    return HarnessDocWorkflowInput(
        consultation_id="c-1",
        tenant_id="t-1",
        user_id="u-1",
        job_id="job-1",
        correlation_id="corr-1",
        context_item_id="ctx-t1",
        transcript_text="Patient has hypertension.",
    )


class TestWorkflowOrderedSpine:
    @pytest.mark.asyncio
    async def test_happy_path_emits_exact_ordered_step_sequence(self, monkeypatch):
        cap = _CapTraj()
        smr_stats = {"stop_reason": "stop", "total_ms": 900, "provider": "azure-openai", "model": "gpt-4o"}
        _patch_real_activity_clients(monkeypatch, cap, smr_stats=smr_stats)

        env = await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        )
        async with env:
            tq = f"harness-traj-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=activities.DOCUMENT_ACTIVITIES,
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _wf_input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                from harness.temporal.models import ApprovalSignal

                await handle.signal(
                    HarnessDocWorkflow.approval,
                    ApprovalSignal(decision="SIGNED", clinician_id="doc-1"),
                )
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.approved is True

        # The exact ordered spine a legacy happy-path run emits. The apps/api
        # receiving wave must accept exactly this ordered (stepType, name) stream.
        assert _pairs(cap.steps) == [
            ("PHASE", "fetch_policy"),
            ("TOOL_CALL", "nlp.extract_entities"),
            ("TOOL_CALL", "persist_entities"),
            ("RETRIEVAL", "retrieve_context"),
            ("TOOL_CALL", "assemble_prompt"),
            ("LLM_CALL", "generate"),
            ("TOOL_CALL", "nlp.extract_entities"),
            ("SENSOR", "run_sensors"),
            ("GUARDRAIL", "run_inferential_sensors"),
            ("PHASE", "persist_draft"),
            ("GATE", "record_gate_decision"),
        ]
        # Workflow-owned seq is globally monotonic (deterministic stride allocation).
        seqs = [s.seq for s in cap.steps]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)
        # session/run come from the Temporal ids; correlation threads through.
        assert all(s.session_id and s.run_id for s in cap.steps)
        assert all(s.correlation_id == "corr-1" for s in cap.steps)
        # The LLM_CALL step carries the AD-1 stats.
        llm = next(s for s in cap.steps if s.step_type == "LLM_CALL")
        assert llm.stats == smr_stats

    @pytest.mark.asyncio
    async def test_trajectory_outage_never_fails_workflow(self, monkeypatch):
        cap = _CapTraj()
        _patch_real_activity_clients(monkeypatch, cap, traj=_RaiseTraj())

        env = await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        )
        async with env:
            tq = f"harness-traj-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=activities.DOCUMENT_ACTIVITIES,
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _wf_input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                from harness.temporal.models import ApprovalSignal

                await handle.signal(
                    HarnessDocWorkflow.approval,
                    ApprovalSignal(decision="SIGNED", clinician_id="doc-1"),
                )
                # Every report_trajectory raises, yet the clinical loop completes.
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.approved is True
