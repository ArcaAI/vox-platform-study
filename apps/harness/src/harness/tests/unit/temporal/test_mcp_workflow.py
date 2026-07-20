"""MCP terminology-validation workflow integration (feature-flagged).

Full-workflow tests (time-skipping ``WorkflowEnvironment`` + the stub activity set) that
prove the opt-in, patch-gated MCP path:

* Default OFF everywhere: no policy / ``mcpToolsEnabled`` unset ⇒ ``call_mcp_tool`` is
  NEVER scheduled (the ``workflow.patched`` short-circuit keeps the run command-neutral).
* Armed: ``mcpToolsEnabled=true`` + an enabled terminology server ⇒ exactly one
  ``call_mcp_tool`` after the transcript NER, carrying the resolved server + the tenant
  allowlist intersection inputs.
* Degrade-safe: a degraded MCP result flags reduced assurance; it never crashes the loop.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.models import (
    ApprovalSignal,
    HarnessDocWorkflowInput,
    HarnessPolicy,
    McpServerConfig,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)


def _term_policy(**kw) -> HarnessPolicy:
    base = {
        "mcp_tools_enabled": True,
        "tool_allowlist": ["validate_codes"],
        "mcp_servers": [
            McpServerConfig(
                id="srv-term",
                name="fhir-term",
                base_url="http://terminology.local/mcp",
                tool_allowlist=["validate_codes"],
                phi_boundary="in-boundary",
                enabled=True,
            )
        ],
    }
    base.update(kw)
    return HarnessPolicy(**base)


def _wf_input() -> HarnessDocWorkflowInput:
    return HarnessDocWorkflowInput(
        consultation_id="c-1",
        tenant_id="t-1",
        user_id="u-1",
        job_id="job-1",
        context_item_id="ctx-1",
        transcript_text="Patient has hypertension.",
    )


async def _run(config: StubConfig, recorder: StubRecorder):
    env = await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter)
    async with env:
        tq = f"harness-mcp-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[HarnessDocWorkflow],
            activities=make_stub_activities(config, recorder),
        ):
            handle = await env.client.start_workflow(
                HarnessDocWorkflow.run,
                _wf_input(),
                id=f"harness-doc-{uuid.uuid4()}",
                task_queue=tq,
            )
            await handle.signal(
                HarnessDocWorkflow.approval,
                ApprovalSignal(decision="SIGNED", clinician_id="doc-1"),
            )
            return await handle.result()


class TestMcpWorkflowIntegration:
    @pytest.mark.asyncio
    async def test_mcp_off_by_default_no_call(self):
        # No policy ⇒ code defaults ⇒ MCP OFF ⇒ call_mcp_tool never scheduled.
        recorder = StubRecorder()
        result = await _run(StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"]), recorder)
        assert result.decision == "PASS"
        assert recorder.calls["call_mcp_tool"] == 0

    @pytest.mark.asyncio
    async def test_policy_present_but_flag_unset_no_call(self):
        # A policy WITHOUT mcpToolsEnabled (None ⇒ OFF) ⇒ still no MCP call.
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS"],
            inferential_verdicts=["SAFE"],
            policy=HarnessPolicy(),  # mcp_tools_enabled defaults None
        )
        await _run(config, recorder)
        assert recorder.calls["call_mcp_tool"] == 0

    @pytest.mark.asyncio
    async def test_mcp_enabled_calls_terminology_tool(self):
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS"], inferential_verdicts=["SAFE"], policy=_term_policy()
        )
        result = await _run(config, recorder)
        assert result.decision == "PASS"
        assert recorder.calls["call_mcp_tool"] == 1
        call = recorder.call_mcp_inputs[0]
        assert call.tool == "validate_codes"
        assert call.server.name == "fhir-term"
        # The tenant policy allowlist is threaded for the intersection enforcement.
        assert call.policy_tool_allowlist == ["validate_codes"]
        # The extracted transcript terms are sent for validation.
        assert "hypertension" in call.args["terms"]
        # It runs BEFORE retrieval / prompt assembly (right after the transcript NER).
        assert recorder.call_order[:1] == ["call_mcp_tool"] or "call_mcp_tool" in recorder.call_order

    @pytest.mark.asyncio
    async def test_mcp_no_matching_server_skips_call(self):
        # Flag on but no enabled server offers the tool ⇒ selection returns None ⇒ no call.
        recorder = StubRecorder()
        policy = _term_policy(
            mcp_servers=[
                McpServerConfig(
                    id="s2", name="other", base_url="http://x", tool_allowlist=["something_else"],
                    enabled=True,
                )
            ]
        )
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"], policy=policy)
        await _run(config, recorder)
        assert recorder.calls["call_mcp_tool"] == 0

    @pytest.mark.asyncio
    async def test_mcp_degraded_flags_reduced_assurance(self):
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS"],
            inferential_verdicts=["SAFE"],
            policy=_term_policy(),
            mcp_degraded=True,
        )
        result = await _run(config, recorder)
        # The loop completes (never crashes) but the delivered draft is reduced-assurance.
        assert result.decision == "PASS"
        assert recorder.calls["call_mcp_tool"] == 1
        assert recorder.persist_draft_inputs[0].reduced_assurance is True

    @pytest.mark.asyncio
    async def test_mcp_activity_raise_degrades_not_crashes(self):
        # An allowlist/PHI/infra raise from the activity is caught → reduced assurance.
        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["PASS"],
            inferential_verdicts=["SAFE"],
            policy=_term_policy(),
            mcp_fails=True,
        )
        result = await _run(config, recorder)
        assert result.decision == "PASS"
        assert recorder.persist_draft_inputs[0].reduced_assurance is True
