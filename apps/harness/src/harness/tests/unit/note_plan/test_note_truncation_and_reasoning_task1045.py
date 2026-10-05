"""The note plan never stores a truncated or empty note, and the agent's reasoning posture reaches
apps/text (TASK-1045 e2e findings E2E-26 / E2E-30).

Live run 2026-10-05 (consultation ``01a10d8d-…``): the governed finalizer's single plan call ran
on Gemma 4 E2B with reasoning ON although the agent says ``reasoning: {enabled: false}`` — the
harness never sent the posture. 1305 of the 1792 output tokens went to reasoning, the call ended
``stop_reason=length`` with a cut-off JSON answer, every section read as absent, the repair timed
out, and a note of four "Not discussed" headings was stored as AWAITING_REVIEW.

Hermetic: the plan is the pinned fixture, the gateway and Text are stubbed.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError

from harness.services.note_plan.executor import (
    NoteCallRequest,
    NoteCallResult,
    NoteOutputTruncated,
    NotePlanCallFailed,
    NotePlanEmptyNote,
    execute_plan,
)
from harness.services.text_client import TextClient, TextGenerationResult, reasoning_wire
from harness.temporal.models import TrajectoryContext
from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    SINGLE,
    _Api,
    _CapTraj,
    _env,
    _governed_agent,
    _input,
    _plan,
    _raw,
    _wire,
    activities,
)

_FULL = json.dumps(
    {
        "subjective": "Chest tightness for two days [S2].",
        "objective": "BP 150/95 [S8].",
        "assessment": "Exertional chest tightness.",
        "plan": "ECG and troponin ordered [S10].",
        "redactions": [],
        "sources": [{"sectionKey": "subjective", "refs": ["S2"]}],
    }
)
#: What the live call returned: the JSON cut off where the output budget ran out.
_CUT = '{"subjective": "Chest tightness for two days [S2].", "objective": "BP 150/'


def _result(content: str, stop: str = "stop") -> NoteCallResult:
    return NoteCallResult(content=content, stats={"stop_reason": stop}, stop_reason=stop)


class _Scripted:
    """An executor ``generate`` answering from a queue, recording each request."""

    def __init__(self, *answers: NoteCallResult) -> None:
        self.answers = list(answers)
        self.requests: list[NoteCallRequest] = []

    async def __call__(self, request: NoteCallRequest) -> NoteCallResult:
        self.requests.append(request)
        return self.answers.pop(0)


# ---------------------------------------------------------------------------------------------
# The executor: a length-truncated call is retried once with headroom, never stored
# ---------------------------------------------------------------------------------------------


async def test_a_truncated_call_is_retried_once_with_more_room_and_the_retry_is_used() -> None:
    plan = _plan(SINGLE)
    # The fixture's critical facts are not all in _FULL, so a repair follows (answered in full).
    generate = _Scripted(_result(_CUT, "length"), _result(_FULL), _result(_FULL))

    execution = await execute_plan(plan, system="sys", user_prefix="data", generate=generate)

    first, retry, repair = generate.requests
    assert repair.kind == "repair"
    assert first.max_tokens == plan.calls[0].max_tokens
    # Twice the cap, bounded by the room the window leaves after the prompt and the safety margin.
    assert retry.max_tokens == 2 * plan.calls[0].max_tokens
    assert retry.retry == 1 and retry.call_id == first.call_id and retry.user == first.user
    assert "Chest tightness" in execution.document["case_note"]
    record = execution.records[0]
    assert record.request.retry == 1
    assert [t.result.stop_reason for t in record.truncated] == ["length"]


async def test_the_retry_cap_never_exceeds_the_room_left_in_the_window() -> None:
    raw = _raw(SINGLE)
    raw["budget"]["contextWindow"] = raw["calls"][0]["promptTokens"] + 512 + 2000
    from harness.services.note_plan.models import NotePlanV1

    plan = NotePlanV1.model_validate(raw)
    generate = _Scripted(_result(_CUT, "length"), _result(_FULL), _result(_FULL))

    await execute_plan(plan, system=None, user_prefix="data", generate=generate)

    assert generate.requests[1].max_tokens == 2000


async def test_a_call_truncated_twice_fails_the_note_and_nothing_is_assembled() -> None:
    plan = _plan(SINGLE)
    generate = _Scripted(_result(_CUT, "length"), _result(_CUT, "length"))

    with pytest.raises(NotePlanCallFailed) as raised:
        await execute_plan(plan, system=None, user_prefix="data", generate=generate)

    [record] = raised.value.records
    assert isinstance(record.error, NoteOutputTruncated)
    assert record.result is None
    assert len(record.truncated) == 2


async def test_no_retry_when_the_activity_budget_has_no_room_for_one() -> None:
    plan = _plan(SINGLE)
    generate = _Scripted(_result(_CUT, "length"))

    with pytest.raises(NotePlanCallFailed):
        await execute_plan(
            plan, system=None, user_prefix="data", generate=generate, allow_repair=lambda: False
        )

    assert len(generate.requests) == 1


async def test_truncated_markdown_is_never_merged_either() -> None:
    plan = _plan(SINGLE)
    generate = _Scripted(
        _result("## Subjective\nChest tightness for", "length"),
        _result("## Subjective\nChest tightness for", "length"),
    )

    with pytest.raises(NotePlanCallFailed):
        await execute_plan(plan, system=None, user_prefix="data", generate=generate)


async def test_a_note_with_no_written_section_is_a_failure_not_a_note() -> None:
    plan = _plan(SINGLE)
    plan = plan.model_copy(
        update={"coverage": plan.coverage.model_copy(update={"critical_facts": None})}
    )
    # A complete answer that wrote nothing under any heading (or only the marker).
    empty = json.dumps(
        {"subjective": "", "objective": "Not discussed", "assessment": "", "plan": ""}
    )
    generate = _Scripted(_result(empty))

    with pytest.raises(NotePlanEmptyNote):
        await execute_plan(plan, system=None, user_prefix="data", generate=generate)


async def test_a_truncated_repair_keeps_the_gaps_and_its_text_is_dropped() -> None:
    plan = _plan(SINGLE)
    first = json.dumps(
        {"subjective": "Chest tightness [S2].", "objective": "", "assessment": "", "plan": ""}
    )
    generate = _Scripted(_result(first), _result('{"plan": "Amlodipine 5', "length"))

    execution = await execute_plan(plan, system=None, user_prefix="data", generate=generate)

    assert generate.requests[-1].kind == "repair"
    assert execution.coverage.repair_passes == 1
    assert execution.coverage.status == "gaps"
    assert "Amlodipine 5" not in execution.document["case_note"]
    assert isinstance(execution.records[-1].error, NoteOutputTruncated)


# ---------------------------------------------------------------------------------------------
# The reasoning posture on the wire
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("authored", "wire"),
    [
        ({"enabled": False}, {"enabled": False}),
        ({"enabled": False, "effort": "high"}, {"enabled": False}),
        ({"enabled": True}, {"enabled": True}),
        ({"enabled": True, "effort": "low"}, {"enabled": True, "effort": "low"}),
        ({"enabled": True, "effort": "max"}, {"enabled": True}),
        (None, None),
        ({"effort": "low"}, None),
        ("off", None),
    ],
)
def test_reasoning_wire_mirrors_the_gateway_rule(authored: Any, wire: Any) -> None:
    assert reasoning_wire(authored) == wire


async def test_the_text_client_sends_the_posture_and_omits_an_absent_one() -> None:
    client = TextClient("http://text")
    _url, body, _h = await client._prepare(**_prepare_args(reasoning={"enabled": False}))
    assert body["reasoning"] == {"enabled": False}
    _url, body, _h = await client._prepare(**_prepare_args(reasoning=None))
    assert "reasoning" not in body


def _prepare_args(**overrides: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "tenant_id": "t-1",
        "prompt": "p",
        "system_prompt": None,
        "provider": None,
        "model": "m",
        "temperature": 0,
        "max_tokens": 10,
        "top_p": None,
        "response_format": None,
        "context": None,
        "idempotency_key": None,
        "provider_override": None,
        "provider_locality": None,
        "known_phi": None,
        "stream": False,
    }
    args.update(overrides)
    return args


# ---------------------------------------------------------------------------------------------
# The governed finalizer (E2E-30 replayed)
# ---------------------------------------------------------------------------------------------


class _GovText:
    def __init__(self, *answers: tuple[str, str]) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        content, stop = self.answers.pop(0)
        return TextGenerationResult(
            content=content,
            model="gemma-4-e2b-it-qat",
            provider="lmstudio",
            usage={"prompt_tokens": 7955, "completion_tokens": 1792},
            finish_reason=stop,
            stats={"provider": "lmstudio", "stop_reason": stop},
        )


def _governed(reasoning: dict[str, Any] | None) -> dict[str, Any]:
    agent = _governed_agent()
    generation: dict[str, Any] = {"temperature": 0}
    if reasoning is not None:
        generation["reasoning"] = reasoning
    agent["compiledConfig"]["parameters"] = {"generation": generation}
    return agent


async def _run_governed(monkeypatch, text: _GovText, agent: dict[str, Any]):
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    raw = _raw(SINGLE)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION

    class _GovApi(_Api):
        progress: list[dict[str, Any]] = []

        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return agent

        async def report_progress(self, consultation_id: str, **kwargs: Any) -> Any:
            self.progress.append(kwargs)

    api, cap, persisted = _GovApi(raw), _CapTraj(), []
    _GovApi.progress = []

    async def _persist_draft(payload: Any) -> Any:
        persisted.append(payload)
        from harness.services.api_client import DraftResponse

        return DraftResponse(context_item_id="ctx-1", version_number=1)

    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)
    monkeypatch.setattr(activities, "persist_draft", _persist_draft)
    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    result = await _env().run(
        core.interpreter_core_agent,
        NodeActivityInput(
            node_id="n_finalize",
            node_type="core.agent",
            config={
                "agentRef": {"slug": "casenote-finalization"},
                "execution": {"lane": "durable", "cadence": "onEnd"},
            },
            tenant_id=_GOV_TENANT,
            bound_inputs={"in": [{"text": "", "note_plan_ref": ref}]},
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id="run-1",
            trajectory=TrajectoryContext(
                tenant_id=_GOV_TENANT, consultation_id=_GOV_CONSULTATION, seq=48
            ),
        ),
    )
    return result, api, cap, persisted


async def test_the_governed_finalizer_sends_the_agents_reasoning_posture(monkeypatch) -> None:
    text = _GovText((_FULL, "stop"), (_FULL, "stop"))

    result, _api, _cap, persisted = await _run_governed(
        monkeypatch, text, _governed({"enabled": False})
    )

    assert result.status == "SUCCEEDED", result.reason
    # The plan call and its repair both carry it.
    assert [c["reasoning"] for c in text.calls] == [{"enabled": False}] * 2
    assert len(persisted) == 1


async def test_an_agent_without_a_posture_sends_none(monkeypatch) -> None:
    text = _GovText((_FULL, "stop"), (_FULL, "stop"))

    await _run_governed(monkeypatch, text, _governed(None))

    assert text.calls[0]["reasoning"] is None


async def test_e2e30_a_note_cut_off_by_the_output_budget_is_never_stored(monkeypatch) -> None:
    text = _GovText((_CUT, "length"), (_CUT, "length"))

    result, api, cap, persisted = await _run_governed(
        monkeypatch, text, _governed({"enabled": False})
    )

    assert result.status == "DEGRADED"
    assert persisted == []
    assert [p["stage"] for p in api.progress] == ["failed"]
    assert "note_output_truncated" in api.progress[0]["label"]
    # The retry ran with more room; both truncated calls are on the run record.
    assert [c["max_tokens"] for c in text.calls] == [1792, 3584]
    failed = [s for s in cap.steps if s.step_type == "LLM_CALL"]
    assert len(failed) == 2
    assert {s.error_code for s in failed} == {"output_truncated"}
    node = next(s for s in cap.steps if s.step_type == "NODE")
    assert node.error_code == "note_output_truncated"


async def test_an_empty_governed_note_is_reported_failed_and_not_stored(monkeypatch) -> None:
    empty = json.dumps({"subjective": "", "objective": "", "assessment": "", "plan": ""})
    # The fixture's critical facts are missing from an empty note, so the repair runs (and
    # writes nothing either).
    text = _GovText((empty, "stop"), (empty, "stop"))

    result, api, _cap, persisted = await _run_governed(
        monkeypatch, text, _governed({"enabled": False})
    )

    assert result.status == "DEGRADED"
    assert persisted == []
    assert "note_empty" in api.progress[0]["label"]


# ---------------------------------------------------------------------------------------------
# The harness-doc activity
# ---------------------------------------------------------------------------------------------


class _DocText:
    def __init__(self, *answers: tuple[str, str]) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        content, stop = self.answers.pop(0)
        return TextGenerationResult(
            content=content,
            model="gemma-4-e2b-it-qat",
            provider="lmstudio",
            finish_reason=stop,
            stats={"provider": "lmstudio", "stop_reason": stop},
        )


async def test_harness_doc_retries_under_its_own_idempotency_key_then_fails_closed(
    monkeypatch,
) -> None:
    raw = _raw(SINGLE)
    text = _DocText((_CUT, "length"), (_CUT, "length"))
    _wire(monkeypatch, api=_Api(raw), text=text, cap=_CapTraj())

    with pytest.raises(ApplicationError) as raised:
        await _env().run(activities.execute_note_plan, _input(raw))

    assert raised.value.type == "NoteOutputTruncated"
    assert raised.value.non_retryable is True
    first, retry = text.calls
    assert first["idempotency_key"] != retry["idempotency_key"]
    assert retry["max_tokens"] == 2 * first["max_tokens"]


async def test_harness_doc_forwards_a_posture_carried_in_its_hyperparameters(monkeypatch) -> None:
    raw = _raw(SINGLE)
    text = _DocText((_FULL, "stop"))
    _wire(monkeypatch, api=_Api(raw), text=text, cap=_CapTraj())
    payload = _input(raw)
    payload.hyperparameters = {"temperature": 0, "reasoning": {"enabled": False}}

    await _env().run(activities.execute_note_plan, payload)

    assert text.calls[0]["reasoning"] == {"enabled": False}
