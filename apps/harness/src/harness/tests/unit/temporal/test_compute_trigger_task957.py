"""TASK-957 — every worker-CPU sample says what the CPU was burned FOR.

Found by the e2e lane on a REAL workflow run: every `WORKFLOW`/`CPU_SECOND` row landed with no
`trigger` at all, while the §10.2 wire contract says a run's rows carry `WORKFLOW_RUN`. The
cause was not a mapping bug — it was that there was nothing to map. `_build_sample` read
`trigger` off the activity's own input, and NO activity input model on either lane declares
one, so the field was unconditionally absent and the gateway's
`pickSampleTrigger` correctly dropped it.

The fix reads the fact that IS present: Temporal's `workflow_id`. Its prefix is a deterministic
addressing contract (`temporal/workflow_ids.py`) — the same one the gateway's `WorkflowRun`
join relies on — so it answers "what is this run" without inventing a field on 94 activity
inputs.

What is pinned here:

* each of the three prefixes maps to its trigger, INCLUDING `core-loop-`: a loop child's CPU
  belongs to the same `WorkflowRun` as the interpreter run that started it;
* an explicit `trigger` on the input still WINS. The derivation is a fallback for inputs that
  cannot say, never an override of one that can;
* an UNRECOGNISED prefix omits the label rather than guessing. `trigger` is a closed
  vocabulary and a wrong value is worse than an absent one — it moves spend onto a lane that
  did not incur it, where nobody is looking for it;
* `run_id` is untouched. It is Temporal's EXECUTION id on purpose (see the note at
  `compute_metering.py`'s `_build_sample`).
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment
from temporalio.worker import ExecuteActivityInput

from harness.temporal.compute_metering import ComputeMeteringInterceptor, ComputeSample
from harness.temporal.workflow_ids import (
    CORE_LOOP_WORKFLOW_ID_PREFIX,
    DOC_WORKFLOW_ID_PREFIX,
    INTERPRETER_WORKFLOW_ID_PREFIX,
)


class _Terminal:
    def __init__(self, body) -> None:
        self._body = body

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        return await self._body(input)


class _Collector:
    def __init__(self) -> None:
        self.samples: list[ComputeSample] = []

    def offer(self, sample: ComputeSample) -> None:
        self.samples.append(sample)


@dataclasses.dataclass
class _Payload:
    tenant_id: str | None = "t-1"


@dataclasses.dataclass
class _PayloadWithTrigger:
    tenant_id: str | None = "t-1"
    trigger: str | None = None


def _env(**info: Any) -> ActivityEnvironment:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, **info)
    return env


async def _sample_for(workflow_id: str, payload: Any = None) -> ComputeSample:
    collector = _Collector()

    async def _body(_input: ExecuteActivityInput) -> str:
        return "ok"

    inbound = ComputeMeteringInterceptor(collector).intercept_activity(_Terminal(_body))
    activity_input = ExecuteActivityInput(
        fn=_body, args=[_Payload() if payload is None else payload], executor=None, headers={}
    )

    async def _run() -> Any:
        return await inbound.execute_activity(activity_input)

    await _env(workflow_id=workflow_id).run(_run)
    [sample] = collector.samples
    return sample


class TestDerivedFromTheWorkflowIdPrefix:
    @pytest.mark.asyncio
    async def test_an_interpreter_run_is_a_workflow_run(self):
        sample = await _sample_for(f"{INTERPRETER_WORKFLOW_ID_PREFIX}run-7")
        assert sample.trigger == "WORKFLOW_RUN"

    @pytest.mark.asyncio
    async def test_a_core_loop_child_bills_to_the_same_workflow_run(self):
        sample = await _sample_for(f"{CORE_LOOP_WORKFLOW_ID_PREFIX}run-7-node-2")
        assert sample.trigger == "WORKFLOW_RUN"

    @pytest.mark.asyncio
    async def test_a_document_workflow_is_a_consultation(self):
        sample = await _sample_for(f"{DOC_WORKFLOW_ID_PREFIX}consultation-3")
        assert sample.trigger == "CONSULTATION"


class TestPrecedenceAndRefusal:
    @pytest.mark.asyncio
    async def test_an_explicit_trigger_on_the_input_wins(self):
        sample = await _sample_for(
            f"{INTERPRETER_WORKFLOW_ID_PREFIX}run-7",
            _PayloadWithTrigger(trigger="AGENT_INVOCATION"),
        )
        assert sample.trigger == "AGENT_INVOCATION"

    @pytest.mark.asyncio
    async def test_an_unknown_prefix_omits_the_label_rather_than_guessing(self):
        sample = await _sample_for("some-other-workflow-42")
        assert sample.trigger is None

    @pytest.mark.asyncio
    async def test_the_run_id_stays_temporals_execution_id(self):
        sample = await _sample_for(f"{INTERPRETER_WORKFLOW_ID_PREFIX}run-7")
        assert sample.session_id == f"{INTERPRETER_WORKFLOW_ID_PREFIX}run-7"
        # NOT the business run id parsed out of the workflow id — see the note in
        # `_build_sample`. The trajectory dedupe tuple is keyed on this.
        assert sample.run_id != "run-7"
        assert sample.run_id


class TestThePrefixesAreNotRestated:
    """The leaf module is the source of truth; the workflow modules re-export it."""

    def test_the_interpreter_modules_export_the_leaf_values(self):
        from harness.temporal.interpreter.core_loop_workflow import (
            CORE_LOOP_WORKFLOW_ID_PREFIX as loop,
        )
        from harness.temporal.interpreter.workflow import INTERPRETER_WORKFLOW_ID_PREFIX as interp

        assert interp is INTERPRETER_WORKFLOW_ID_PREFIX
        assert loop is CORE_LOOP_WORKFLOW_ID_PREFIX

    def test_the_admin_endpoint_reads_the_same_doc_prefix(self):
        from harness.api.endpoints.admin import _WORKFLOW_ID_PREFIX

        assert _WORKFLOW_ID_PREFIX is DOC_WORKFLOW_ID_PREFIX
