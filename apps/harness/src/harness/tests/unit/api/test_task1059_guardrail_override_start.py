"""TASK-1059 O2 — the run start accepts ``guardrailOverrideNoticeIds`` onto ``InterpreterInput``."""

from __future__ import annotations

import pytest

from harness.tests.unit.api.test_task1038_interpreter_start import _start


@pytest.mark.asyncio
async def test_the_ids_reach_the_workflow_input():
    wf_input, _, _ = await _start(guardrailOverrideNoticeIds=["n-1", "n-2"])

    assert wf_input.guardrail_override_notice_ids == ["n-1", "n-2"]


@pytest.mark.asyncio
async def test_absent_they_stay_absent():
    wf_input, _, _ = await _start()

    assert wf_input.guardrail_override_notice_ids is None
