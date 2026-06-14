"""End-to-end tests for HarnessDocWorkflow via Temporal's time-skipping env.

RED-first: written before the workflow/activities exist. Activities are replaced
with name-matched deterministic stubs (see ``_harness_stubs``) so these tests
exercise pure orchestration: happy path + gate, bounded regen, regen-budget
exhaustion, the gate wait-condition + SLA escalation, and degradation paths.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.models import (
    HARNESS_DRAFT_PHASE_EARLY,
    ApprovalSignal,
    EditSignal,
    HarnessDocWorkflowInput,
    HarnessGateConfig,
    HarnessPolicy,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    _OK_NOTE,
    StubConfig,
    StubRecorder,
    make_stub_activities,
)


def _input(**kw) -> HarnessDocWorkflowInput:
    base: dict[str, Any] = {
        "consultation_id": "c-1",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "job_id": "job-1",
        "context_item_id": "ctx-t1",
        "transcript_text": "Patient has hypertension.",
    }
    base.update(kw)
    return HarnessDocWorkflowInput(**base)


def _approval() -> ApprovalSignal:
    return ApprovalSignal(
        decision="SIGNED",
        clinician_id="doc-1",
        context_item_version_id="v-1",
        attestation_hash="h-1",
    )


# TASK-355 Phase D — the optimistic gate (4a flag ON); 4b assurance signals are
# patch-gated, not flag-gated, so they are intrinsic to the optimistic path.
def _opt_gate(**kw) -> HarnessGateConfig:
    kw.setdefault("optimistic_delivery_enabled", True)
    kw.setdefault("max_regen", 2)
    return HarnessGateConfig(**kw)


# A distinct edited note so tests can prove assurance re-bound to the clinician's
# edited version (run_inferential_sensors.note_text changes on the re-run).
_EDITED_NOTE = '{"subjective": "s-edited", "objective": "o", "assessment": "a", "plan": "p-edited"}'


async def _env() -> WorkflowEnvironment:
    return await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter)


async def _wait_phase(handle, target: str, max_polls: int = 300) -> None:
    for _ in range(max_polls):
        if await handle.query(HarnessDocWorkflow.phase) == target:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"workflow never reached phase {target!r}")


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_pass_first_try_persists_draft_and_closes_on_approval(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                # Buffered signal resolves the gate as soon as it is reached.
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 0
        assert result.approved is True
        assert result.clinician_id == "doc-1"
        assert result.context_item_id == "ctx-draft-1"
        assert recorder.calls["persist_entities"] == 1
        assert recorder.calls["persist_draft"] == 1
        assert recorder.calls["record_gate_decision"] == 1
        assert recorder.calls["escalate_gate"] == 0
        draft = recorder.persist_draft_inputs[0]
        assert draft.gate_decision == "PASS"
        assert draft.is_auto_generated is True
        assert recorder.record_inputs[0].gate_decision == "PASS"
        assert recorder.record_inputs[0].clinician_id == "doc-1"


class TestBoundedRegen:
    @pytest.mark.asyncio
    async def test_regen_then_pass_uses_budget(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "REGEN", "PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 2
        assert recorder.calls["run_sensors"] == 3  # initial + 2 regens
        assert recorder.calls["generate"] == 3
        assert recorder.calls["persist_draft"] == 1

    @pytest.mark.asyncio
    async def test_regen_budget_exhausted_flags(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "REGEN", "REGEN"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 2
        assert recorder.calls["run_sensors"] == 3
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].gate_decision == "FLAG"

    @pytest.mark.asyncio
    async def test_highest_harm_flag_first_try_skips_regen(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["FLAG"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 0
        assert recorder.calls["run_sensors"] == 1
        assert recorder.calls["persist_draft"] == 1


class TestGate:
    @pytest.mark.asyncio
    async def test_gate_blocks_until_approval_signal(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2, gate_sla_seconds=1_000_000.0)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await _wait_phase(handle, "GATE")
                # Still blocked after advancing well short of the SLA.
                await env.sleep(1)
                assert await handle.query(HarnessDocWorkflow.phase) == "GATE"
                assert recorder.calls["record_gate_decision"] == 0

                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["record_gate_decision"] == 1
        assert recorder.calls["escalate_gate"] == 0

    @pytest.mark.asyncio
    async def test_sla_breach_escalates_then_resolves_on_later_approval(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(
                        gate=HarnessGateConfig(
                            max_regen=2,
                            gate_sla_seconds=30.0,
                            gate_escalation_seconds=1_000_000.0,
                        )
                    ),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await _wait_phase(handle, "GATE")
                # Advance past the SLA -> escalation fires, gate keeps waiting.
                await env.sleep(60)
                assert recorder.calls["escalate_gate"] >= 1
                assert await handle.query(HarnessDocWorkflow.phase) == "GATE"

                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.escalations >= 1
        assert recorder.escalate_inputs[0].reason == "gate_sla_breached"
        assert recorder.calls["record_gate_decision"] == 1


class TestInferentialPass:
    """Phase 2: the inferential pass runs after the computational loop settles —
    safety -> FLAG, groundedness -> one optional regen, degraded -> reduced assurance."""

    @pytest.mark.asyncio
    async def test_safe_pass_persists_guardrail_decisions_and_rag_triad(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["run_inferential_sensors"] == 1
        draft = recorder.persist_draft_inputs[0]
        assert draft.guardrail_decisions is not None
        assert set(draft.guardrail_decisions) == {"groundedness", "safety"}
        assert draft.guardrail_decisions["safety"]["decision"] == "PASS"
        assert draft.rag_triad_score == 1.0
        assert not draft.reduced_assurance
        # The inferential activity gets the generated note + provenance to screen.
        assert recorder.inferential_inputs[0].note_text == _OK_NOTE
        assert "claims" in recorder.inferential_inputs[0].citations_map

    @pytest.mark.asyncio
    async def test_unsafe_safety_forces_flag_without_regen(self):
        recorder = StubRecorder()
        # Computational PASSes, but the safety screen flags unsafe content -> FLAG,
        # never auto-regenerated (regen budget is untouched).
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["UNSAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 0
        assert recorder.calls["run_sensors"] == 1
        assert recorder.calls["run_inferential_sensors"] == 1
        draft = recorder.persist_draft_inputs[0]
        assert draft.gate_decision == "FLAG"
        assert draft.guardrail_decisions["safety"]["decision"] == "FLAG"
        assert not draft.reduced_assurance

    @pytest.mark.asyncio
    async def test_groundedness_regen_consumes_one_budget_then_passes(self):
        recorder = StubRecorder()
        # Computational PASSes every time; the first inferential pass says REGEN
        # (ungrounded claim) -> consume ONE regen -> second pass is clean -> PASS.
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["REGEN", "SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 1
        assert recorder.calls["run_sensors"] == 2  # initial + 1 inferential-driven regen
        assert recorder.calls["run_inferential_sensors"] == 2
        assert recorder.calls["persist_draft"] == 1

    @pytest.mark.asyncio
    async def test_inferential_degraded_sets_reduced_assurance_and_proceeds(self):
        recorder = StubRecorder()
        # Judge + Granite down -> degraded inferential pass -> proceed on the
        # computational verdict (PASS), but record reduced assurance.
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["DEGRADED"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["run_inferential_sensors"] == 1
        draft = recorder.persist_draft_inputs[0]
        # reduced_assurance=True is exactly what triggers the REDUCED_ASSURANCE WORM.
        assert draft.reduced_assurance is True
        assert draft.gate_decision == "PASS"

    @pytest.mark.asyncio
    async def test_inferential_activity_failure_degrades_to_reduced_assurance(self):
        recorder = StubRecorder()
        # An infra failure of the inferential activity must not crash the loop:
        # degrade gracefully to reduced assurance on the computational verdict.
        config = StubConfig(verdicts=["PASS"], inferential_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].reduced_assurance is True


class TestInstitutionalRetrieval:
    """Phase 3: JIT retrieval augments the prompt + threads chunks into the sensors;
    a degraded retrieval flags reduced assurance (generation still proceeds)."""

    @pytest.mark.asyncio
    async def test_retrieved_chunks_augment_prompt_and_thread_into_sensors(self):
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS"],
            retrieved_chunks=[("kc-1", "First-line HTN therapy is a thiazide.")],
        )
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["retrieve_context"] == 1
        # Retrieval is entity-triggered, scoped to the tenant.
        assert recorder.retrieve_inputs[0].tenant_id == "t-1"
        # The generation prompt was augmented with the StrictCitations block.
        gen_prompt = recorder.generate_inputs[0].prompt
        assert "kc-1" in gen_prompt and "[[kb:" in gen_prompt
        # Chunk ids are threaded into the computational pass (knowledgeChunkIds mapping)
        assert recorder.run_sensors_inputs[0].retrieved_chunk_ids == ["kc-1"]
        # ...and the chunk text is threaded into the inferential pass (citation-verify).
        assert recorder.inferential_inputs[0].knowledge_chunks == {
            "kc-1": "First-line HTN therapy is a thiazide."
        }
        assert recorder.persist_draft_inputs[0].reduced_assurance is False

    @pytest.mark.asyncio
    async def test_retrieval_degrade_flags_reduced_assurance_but_proceeds(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], retrieval_degraded=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        # Generation proceeds (empty context), but the draft is flagged reduced assurance.
        assert result.decision == "PASS"
        assert recorder.calls["generate"] == 1
        assert recorder.persist_draft_inputs[0].reduced_assurance is True


class TestPolicyInjection:
    """Phase 6: the policy is read ONCE at workflow start (``fetch_policy``) and
    threaded into the deterministic body — thresholds, guard toggles, gate budget,
    and model defaults. A failed fetch degrades to the code defaults (never crashes)."""

    @pytest.mark.asyncio
    async def test_policy_threads_thresholds_toggles_and_model_defaults(self):
        recorder = StubRecorder()
        policy = HarnessPolicy(
            coverage_threshold=0.55,
            groundedness_threshold=0.42,
            safety_enabled=False,
            smr_provider="azure",
            smr_model="gpt-4o",
        )
        config = StubConfig(verdicts=["PASS"], policy=policy)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),  # no smr provider/model -> policy supplies the defaults
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        # Policy is fetched first, scoped to the consultation's tenant.
        assert recorder.calls["fetch_policy"] == 1
        assert recorder.fetch_policy_inputs[0].tenant_id == "t-1"
        # Computational thresholds are threaded into run_sensors.
        threaded = recorder.run_sensors_inputs[0].thresholds
        assert threaded is not None
        assert threaded.coverage_threshold == 0.55
        # Inferential groundedness threshold + safety toggle are threaded in.
        assert recorder.inferential_inputs[0].groundedness_threshold == 0.42
        assert recorder.inferential_inputs[0].safety_enabled is False
        # Policy smr provider/model are used as defaults when the input omits them.
        assert recorder.generate_inputs[0].provider == "azure"
        assert recorder.generate_inputs[0].model == "gpt-4o"

    @pytest.mark.asyncio
    async def test_input_smr_overrides_policy_default(self):
        recorder = StubRecorder()
        policy = HarnessPolicy(smr_provider="azure", smr_model="gpt-4o")
        config = StubConfig(verdicts=["PASS"], policy=policy)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(smr_provider="lm-studio", smr_model="local-llm"),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        # An explicit workflow-input model wins over the policy default.
        assert recorder.generate_inputs[0].provider == "lm-studio"
        assert recorder.generate_inputs[0].model == "local-llm"

    @pytest.mark.asyncio
    async def test_policy_max_regen_overrides_gate_budget(self):
        recorder = StubRecorder()
        # 3 REGENs then PASS. With the policy budget of 3 the loop survives to PASS;
        # the input gate's default budget of 2 would FLAG — so PASS proves the
        # policy budget overrode the gate config.
        policy = HarnessPolicy(max_regen=3)
        config = StubConfig(verdicts=["REGEN", "REGEN", "REGEN", "PASS"], policy=policy)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 3
        assert recorder.calls["run_sensors"] == 4

    @pytest.mark.asyncio
    async def test_policy_fetch_failure_degrades_to_code_defaults(self):
        recorder = StubRecorder()
        # policy=None -> the fetch_policy stub raises -> the workflow falls back to
        # the code defaults: default thresholds (None passed through), safety ON,
        # and the input gate budget governs the loop. Never crashes.
        config = StubConfig(verdicts=["PASS"], policy=None)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["fetch_policy"] == 1
        # Fallback: no policy thresholds, safety guard stays ON, draft is not flagged
        # reduced-assurance just because the policy fetch failed.
        assert recorder.run_sensors_inputs[0].thresholds is None
        assert recorder.inferential_inputs[0].safety_enabled is True
        assert recorder.persist_draft_inputs[0].reduced_assurance is False


class TestOptimisticDelivery:
    """TASK-355 Phase D (Slice 4a) — optimistic two-phase delivery.

    Flag ON (+ patch marker): the computational loop settles, the readable draft is
    DELIVERED early (``persist_draft`` with ``phase=DRAFT_PENDING_SENSORS``, verdict
    withheld) and the terminal ``completed`` progress fires BEFORE the costly
    inferential pass runs as ASSURANCE; ``finalize_assurance`` then backfills the
    verdict. Flag OFF (default): the legacy single-phase path is unchanged.
    """

    @staticmethod
    def _opt_gate(**kw) -> HarnessGateConfig:
        kw.setdefault("optimistic_delivery_enabled", True)
        kw.setdefault("max_regen", 2)
        return HarnessGateConfig(**kw)

    @pytest.mark.asyncio
    async def test_flag_on_delivers_early_then_finalizes_assurance(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.approved is True
        assert recorder.calls["persist_draft"] == 1
        assert recorder.calls["run_inferential_sensors"] == 1
        assert recorder.calls["finalize_assurance"] == 1
        assert recorder.calls["record_gate_decision"] == 1

        # Early persist: readable draft, verdict + RAG-triad WITHHELD until assurance.
        draft = recorder.persist_draft_inputs[0]
        assert draft.phase == HARNESS_DRAFT_PHASE_EARLY
        assert draft.gate_decision is None
        assert draft.guardrail_decisions is None
        assert draft.rag_triad_score is None

        # Finalize carries the folded verdict against the early-persisted draft.
        fin = recorder.finalize_inputs[0]
        assert fin.context_item_id == "ctx-draft-1"
        assert fin.gate_decision == "PASS"
        assert set(fin.guardrail_decisions) == {"groundedness", "safety"}
        assert fin.guardrail_decisions["safety"]["decision"] == "PASS"
        assert fin.rag_triad_score == 1.0
        assert not fin.reduced_assurance

        # The REORDER: deliver -> assure -> finalize (never assure-then-deliver).
        order = [
            c
            for c in recorder.call_order
            if c in {"persist_draft", "run_inferential_sensors", "finalize_assurance"}
        ]
        assert order == ["persist_draft", "run_inferential_sensors", "finalize_assurance"]

    @pytest.mark.asyncio
    async def test_flag_survives_policy_rebuild_and_activates_optimistic(self):
        """Production path: with a policy present the gate is REBUILT from the policy
        knobs at the top of ``_run``. The optimistic flag is NOT a policy knob, so the
        snapshotted ``inp.gate`` value (env -> document:start) must be carried over the
        policy merge — otherwise the env kill-switch would silently never activate the
        optimistic path in prod. Read from the deterministic workflow input (never env),
        so it stays replay-safe."""
        recorder = StubRecorder()
        # Policy present (the common production case) drives the line-274 rebuild branch.
        policy = HarnessPolicy(max_regen=2)
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"], policy=policy)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        # The rebuild branch ran (a policy was fetched)...
        assert recorder.calls["fetch_policy"] == 1
        # ...and the optimistic path STILL activated despite the policy merge.
        assert recorder.calls["finalize_assurance"] == 1
        assert recorder.persist_draft_inputs[0].phase == HARNESS_DRAFT_PHASE_EARLY
        order = [
            c
            for c in recorder.call_order
            if c in {"persist_draft", "run_inferential_sensors", "finalize_assurance"}
        ]
        assert order == ["persist_draft", "run_inferential_sensors", "finalize_assurance"]

    @pytest.mark.asyncio
    async def test_flag_on_completes_feed_before_running_assurance(self):
        """Perceived-latency invariant: the feed folds to ``completed`` BEFORE the
        slow inferential pass — that is the whole point of optimistic delivery."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                await handle.result()

        # The drafting feed is unchanged (same 6 stages); inferential now runs after.
        stages = [p.stage for p in recorder.progress_inputs]
        assert stages == [
            "extracting_information",
            "assembling_context",
            "drafting_note",
            "running_safety_sensors",
            "finalizing_draft",
            "completed",
        ]
        assert recorder.call_order.index("progress:completed") < recorder.call_order.index(
            "run_inferential_sensors"
        )

    @pytest.mark.asyncio
    async def test_flag_off_keeps_legacy_single_phase(self):
        """Default (flag off) ⇒ legacy: assure-then-persist, no finalize, no phase."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),  # optimistic OFF (default)
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["finalize_assurance"] == 0
        assert recorder.calls["persist_draft"] == 1
        draft = recorder.persist_draft_inputs[0]
        assert draft.phase is None
        assert draft.gate_decision == "PASS"
        assert draft.guardrail_decisions is not None  # legacy folds inferential into persist
        order = [
            c for c in recorder.call_order if c in {"persist_draft", "run_inferential_sensors"}
        ]
        assert order == ["run_inferential_sensors", "persist_draft"]

    @pytest.mark.asyncio
    async def test_flag_on_unsafe_safety_delivers_then_finalizes_flag(self):
        """A delivered draft is still delivered early even when assurance will FLAG;
        the FLAG lands in finalize (it gates sign-off, not delivery)."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["UNSAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 0
        # Delivered early despite the eventual FLAG.
        assert recorder.persist_draft_inputs[0].phase == HARNESS_DRAFT_PHASE_EARLY
        fin = recorder.finalize_inputs[0]
        assert fin.gate_decision == "FLAG"
        assert fin.guardrail_decisions["safety"]["decision"] == "FLAG"

    @pytest.mark.asyncio
    async def test_flag_on_inferential_degraded_finalizes_reduced_assurance(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["DEGRADED"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["finalize_assurance"] == 1
        assert recorder.finalize_inputs[0].reduced_assurance is True
        assert recorder.finalize_inputs[0].gate_decision == "PASS"

    @pytest.mark.asyncio
    async def test_flag_on_inferential_failure_still_finalizes_no_stuck_state(self):
        """Finalise-on-degrade (I6): an inferential infra failure must NOT leave the
        consultation stuck in DRAFT_PENDING_SENSORS — finalize still runs (reduced
        assurance) so apps/api flips to PENDING_REVIEW."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], inferential_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=self._opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["persist_draft"] == 1  # draft was delivered
        assert recorder.calls["finalize_assurance"] == 1  # still finalised
        assert recorder.finalize_inputs[0].reduced_assurance is True


class TestAssuranceSignals:
    """TASK-355 Phase D (Slice 4b) — signal-driven assurance dynamics.

    Built ON the optimistic path (4a) and gated by a SECOND patch marker
    (``task-355-assurance-signals``). Two LOCKED governance behaviours:

    * **Q1 regen-if-untouched** — after early delivery, a REGEN-fixable assurance
      verdict silently regenerates + re-delivers the draft ONCE (budget
      permitting) *only while the clinician has not touched it*; once edited, a
      REGEN-fixable verdict surfaces as a FLAG instead (never swap an edited note).
    * **Q3 edit-re-runs** — a clinician ``edit`` signal during the assurance pass
      re-binds assurance to the edited version and re-runs it (assurance only — the
      clinician owns the edited content, so it is never re-generated/re-delivered);
      the verdict binds to the edited version.
    """

    @pytest.mark.asyncio
    async def test_regen_if_untouched_regenerates_redelivers_then_finalizes(self):
        """Q1 — untouched REGEN verdict ⇒ one silent regen + re-deliver, then re-assure."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["REGEN", "SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=_opt_gate()),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 1
        # regen-if-untouched: a SECOND generation + a SECOND (re-)delivery happened.
        assert recorder.calls["generate"] == 2
        assert recorder.calls["run_inferential_sensors"] == 2
        assert recorder.calls["persist_draft"] == 2  # early deliver + regen re-deliver
        assert recorder.calls["finalize_assurance"] == 1
        # both deliveries are EARLY (verdict withheld until finalize).
        assert all(p.phase == HARNESS_DRAFT_PHASE_EARLY for p in recorder.persist_draft_inputs)
        # final verdict is the re-assured PASS; bound to the original draft (no edit).
        fin = recorder.finalize_inputs[0]
        assert fin.gate_decision == "PASS"
        assert fin.context_item_version_id is None
        # ORDER: deliver -> assure(REGEN) -> re-deliver -> assure(SAFE) -> finalize
        order = [
            c
            for c in recorder.call_order
            if c in {"persist_draft", "run_inferential_sensors", "finalize_assurance"}
        ]
        assert order == [
            "persist_draft",
            "run_inferential_sensors",
            "persist_draft",
            "run_inferential_sensors",
            "finalize_assurance",
        ]

    @pytest.mark.asyncio
    async def test_regen_budget_exhausted_untouched_finalizes_flag(self):
        """Q1 — REGEN that never settles is bounded by max_regen, then FLAGs (no infinite swap)."""
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS", "PASS", "PASS"],
            inferential_verdicts=["REGEN", "REGEN", "REGEN"],
        )
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=_opt_gate(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        # 2 regens consumed, then the unresolved REGEN escalates to FLAG.
        assert result.decision == "FLAG"
        assert result.regens_used == 2
        assert recorder.calls["generate"] == 3  # initial + 2 regens
        assert recorder.calls["run_inferential_sensors"] == 3
        assert recorder.calls["persist_draft"] == 3  # early + 2 re-deliveries
        assert recorder.finalize_inputs[0].gate_decision == "FLAG"

    @pytest.mark.asyncio
    async def test_edit_disables_silent_regen_surfaces_flag(self):
        """Q1 — once edited, a REGEN verdict does NOT regenerate; it converts to a FLAG."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["REGEN", "REGEN"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            wf_id = f"harness-doc-{uuid.uuid4()}"
            recorder.edit_signal_handle = env.client.get_workflow_handle(wf_id)
            recorder.edit_on_inferential_index = 0
            recorder.edit_payload = EditSignal(
                content=_EDITED_NOTE, context_item_version_id="ver-edit-1", edited_by="doc-9"
            )
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=_opt_gate()),
                    id=wf_id,
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        # REGEN converted to FLAG — no silent swap of an edited note.
        assert result.decision == "FLAG"
        assert result.regens_used == 0
        assert recorder.calls["generate"] == 1  # NO re-generation
        assert recorder.calls["persist_draft"] == 1  # NO re-delivery
        assert recorder.calls["run_inferential_sensors"] == 2  # original + re-run on edit
        # assurance re-bound to the edited content + version.
        assert recorder.inferential_inputs[1].note_text == _EDITED_NOTE
        fin = recorder.finalize_inputs[0]
        assert fin.gate_decision == "FLAG"
        assert fin.context_item_version_id == "ver-edit-1"

    @pytest.mark.asyncio
    async def test_edit_during_assurance_rebinds_and_reruns(self):
        """Q3 — an edit during assurance re-binds + re-runs (assurance only), binds to edit."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["SAFE", "SAFE"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            wf_id = f"harness-doc-{uuid.uuid4()}"
            recorder.edit_signal_handle = env.client.get_workflow_handle(wf_id)
            recorder.edit_on_inferential_index = 0
            recorder.edit_payload = EditSignal(
                content=_EDITED_NOTE, context_item_version_id="ver-edit-1"
            )
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=_opt_gate()),
                    id=wf_id,
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        # An edit re-runs ASSURANCE only — never re-generates or re-delivers.
        assert recorder.calls["generate"] == 1
        assert recorder.calls["persist_draft"] == 1
        assert recorder.calls["run_inferential_sensors"] == 2  # original + edited re-run
        assert recorder.inferential_inputs[0].note_text != _EDITED_NOTE  # first ran on generated
        assert recorder.inferential_inputs[1].note_text == _EDITED_NOTE  # re-run on edited
        fin = recorder.finalize_inputs[0]
        assert fin.gate_decision == "PASS"
        assert fin.context_item_version_id == "ver-edit-1"


class TestDegradation:
    @pytest.mark.asyncio
    async def test_nlp_failure_forces_flag_no_auto_pass(self):
        recorder = StubRecorder()
        # Sensors would PASS, but NLP is down -> degraded -> never auto-PASS.
        config = StubConfig(verdicts=["PASS"], nlp_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        # No entities extracted -> nothing to persist.
        assert recorder.calls["persist_entities"] == 0
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].gate_decision == "FLAG"

    @pytest.mark.asyncio
    async def test_smr_failure_fails_workflow_without_persisting_draft(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], generate_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                with pytest.raises(WorkflowFailureError):
                    await handle.result()

        # Never silently downgrade: no draft on SMR failure.
        assert recorder.calls["persist_draft"] == 0


class TestProgressFeed:
    """TASK-345 — the workflow emits one ``report_progress`` event per stage.

    Progress is fire-and-forget: stage events thread consultation/tenant/job ids,
    regen iterations re-emit the drafting/sensor stages, and a dead progress
    pipeline must never fail (or even degrade) the document loop.
    """

    @pytest.mark.asyncio
    async def test_happy_path_emits_ordered_stage_sequence(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        stages = [p.stage for p in recorder.progress_inputs]
        assert stages == [
            "extracting_information",
            "assembling_context",
            "drafting_note",
            "running_safety_sensors",
            "finalizing_draft",
            "completed",
        ]
        first = recorder.progress_inputs[0]
        assert first.consultation_id == "c-1"
        assert first.tenant_id == "t-1"
        assert first.job_id == "job-1"
        assert first.label == "Extracting key information"
        assert first.ordinal == 1
        assert first.total == 5
        ordinals = [p.ordinal for p in recorder.progress_inputs[:-1]]
        assert ordinals == [1, 2, 3, 4, 5]
        assert all(p.total == 5 for p in recorder.progress_inputs)

    @pytest.mark.asyncio
    async def test_regen_re_emits_drafting_and_sensor_stages(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.regens_used == 1
        stages = [p.stage for p in recorder.progress_inputs]
        assert stages == [
            "extracting_information",
            "assembling_context",
            "drafting_note",
            "running_safety_sensors",
            "drafting_note",  # regen iteration re-enters the loop
            "running_safety_sensors",
            "finalizing_draft",
            "completed",
        ]

    @pytest.mark.asyncio
    async def test_progress_pipeline_failure_never_fails_the_workflow(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], progress_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        # Every emission raised, yet the loop completed and the draft persisted
        # WITHOUT degradation (progress is non-clinical).
        assert result.decision == "PASS"
        assert result.approved is True
        # TASK-348 / TG-2: the stub raises a RETRYABLE error, so the EXACT
        # per-stage count pins _PROGRESS_RETRY's maximum_attempts=1 — any
        # retry budget creep would multiply this count (5 stages + terminal).
        assert recorder.calls["report_progress"] == 6
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].reduced_assurance is False

    @pytest.mark.asyncio
    async def test_progress_emissions_bound_total_queue_plus_exec_time(self):
        """TASK-348 / MAJ-9: every emission carries schedule_to_close_timeout.

        start_to_close alone leaves the queue wait unbounded — a saturated
        activity slot could stall each stage transition. The schedule-to-close
        bound caps queue + execution at 10s per emission.
        """
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                await handle.result()

        assert len(recorder.progress_schedule_to_close) == 6
        assert all(t == timedelta(seconds=10) for t in recorder.progress_schedule_to_close)

    @pytest.mark.asyncio
    async def test_workflow_failure_emits_terminal_failed_event_then_propagates(self):
        """TASK-348 / MAJ-1: on workflow failure the feed must not freeze.

        SMR exhausts its retries -> the workflow MUST still fail (no draft is
        ever persisted on SMR failure), but a best-effort terminal `failed`
        event is emitted first so the API closes the SSE feed instead of
        leaving an `active` stage lying for the snapshot TTL.
        """
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], generate_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                # The original failure still propagates — never swallowed.
                with pytest.raises(WorkflowFailureError):
                    await handle.result()

        # No draft on SMR failure (unchanged degradation contract).
        assert recorder.calls["persist_draft"] == 0
        # The feed got a terminal `failed` event after the stages that ran.
        stages = [p.stage for p in recorder.progress_inputs]
        assert stages == [
            "extracting_information",
            "assembling_context",
            "drafting_note",
            "failed",
        ]
        # Pinned wire contract (the API fold + UI build against exactly this).
        failed = recorder.progress_inputs[-1]
        assert failed.label == "Documentation generation failed"
        assert failed.ordinal == 5
        assert failed.total == 5
        assert failed.consultation_id == "c-1"
        assert failed.tenant_id == "t-1"
        assert failed.job_id == "job-1"
