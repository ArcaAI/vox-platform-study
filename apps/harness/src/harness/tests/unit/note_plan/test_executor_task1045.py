"""The NotePlan executor: parallel section groups, merge order, section_regen, run-record steps.

Hermetic — the plan comes from the pinned fixture, the gateway and Text are stubbed, and the
activity runs under ``ActivityEnvironment`` (no Temporal server, DB or Redis).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.services.note_plan import executor as executor_module
from harness.services.note_plan.executor import (
    CALL_STEP_OFFSET_BASE,
    FAILED_STEP_OFFSET_BASE,
    MAX_FAILED_STEPS,
    MAX_PARALLEL_CALLS,
    NODE_STEP_OFFSET,
    REPAIR_STEP_OFFSET,
    NoteCallRequest,
    NoteCallResult,
    NotePlanCallFailed,
    execute_plan,
    render_user_prefix,
)
from harness.services.note_plan.merge import NOT_DISCUSSED_MARKER, merge_sections, split_sections
from harness.services.note_plan.models import MAX_NOTE_PLAN_CALLS, NotePlanRef, NotePlanV1
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.models import ExecuteNotePlanInput, TrajectoryContext

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)


def _raw(name: str) -> dict[str, Any]:
    raw = next(case["plan"] for case in FIXTURE["notePlans"] if case["name"] == name)
    return json.loads(json.dumps(raw))


def _plan(name: str) -> NotePlanV1:
    return NotePlanV1.model_validate(_raw(name))


SINGLE = "single_pass_two_encounters"
GROUPS = "ledger_prior_section_groups_with_audio_and_draft"
REGEN = "section_regen_plan_only"

GROUP_SECTIONS = {
    "subjective": ("Allergic to penicillin.", ["S7"]),
    "objective": ("Home blood pressure 150/95.", ["A1"]),
    "assessment": ("Hypertension.", ["S420"]),
    "plan": ("Start amlodipine 5 mg once daily; repeat BP in 2 weeks.", ["S420"]),
}


def _answer(keys: list[str], *, redaction: str | None = None) -> str:
    note = "\n\n".join(f"## {key.title()}\n{GROUP_SECTIONS[key][0]}" for key in keys)
    return json.dumps(
        {
            "case_note": note,
            "redactions": [{"text": redaction, "label": "NAME"}] if redaction else [],
            "sources": [{"sectionKey": key, "ids": GROUP_SECTIONS[key][1]} for key in keys],
        }
    )


def _call_keys(request: NoteCallRequest) -> list[str]:
    return list(request.section_keys)


# ---------------------------------------------------------------------------------------------
# Parallel groups
# ---------------------------------------------------------------------------------------------


async def test_section_groups_run_in_parallel_with_one_prefix_and_their_directive_last() -> None:
    plan = _plan(GROUPS)
    in_flight = 0
    peak = 0
    both_started = asyncio.Event()
    requests: list[NoteCallRequest] = []

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        nonlocal in_flight, peak
        requests.append(request)
        in_flight += 1
        peak = max(peak, in_flight)
        if in_flight == 2:
            both_started.set()
        # Neither call finishes before both have started: proves they are concurrent.
        await asyncio.wait_for(both_started.wait(), timeout=2)
        in_flight -= 1
        return NoteCallResult(content=_answer(_call_keys(request)), stats={})

    prefix = render_user_prefix(plan)
    execution = await execute_plan(plan, system="SYS", user_prefix=prefix, generate=generate)

    assert peak == 2
    assert sorted(r.call_id for r in requests) == ["g1", "g2"]
    for request in requests:
        call = next(c for c in plan.calls if c.call_id == request.call_id)
        assert request.system == "SYS"
        assert request.user == f"{prefix}\n\n{call.directive}"
        assert request.max_tokens == call.max_tokens
        assert request.kind == "call"
    assert execution.coverage.status == "complete", execution.coverage.gaps


def test_the_block_prefix_keeps_the_plan_block_order() -> None:
    plan = _plan(GROUPS)
    prefix = render_user_prefix(plan)
    positions = [prefix.index(f'section="{block.key}"') for block in plan.blocks]
    assert positions == sorted(positions)
    for block in plan.blocks:
        assert block.content in prefix
    # The directive is never part of the shared prefix.
    for call in plan.calls:
        assert call.directive not in prefix


async def test_parallelism_is_bounded() -> None:
    raw = _raw(SINGLE)
    keys = [f"s{i}" for i in range(MAX_NOTE_PLAN_CALLS)]
    raw["headings"] = [{"key": k, "title": k.upper()} for k in keys]
    raw["calls"] = [
        {
            "callId": k,
            "sectionKeys": [k],
            "directive": f"Write {k}",
            "maxTokens": 64,
            "promptTokens": 1,
        }
        for k in keys
    ]
    raw["coverage"]["criticalFacts"] = []
    plan = NotePlanV1.model_validate(raw)

    in_flight = 0
    peak = 0

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        key = request.section_keys[0]
        return NoteCallResult(content=f"## {key.upper()}\nok", stats={})

    await execute_plan(plan, system=None, user_prefix="P", generate=generate, max_parallel=3)
    assert peak == 3
    peak = 0
    await execute_plan(plan, system=None, user_prefix="P", generate=generate, max_parallel=50)
    assert peak == MAX_PARALLEL_CALLS == MAX_NOTE_PLAN_CALLS


async def test_one_failed_group_fails_the_note_and_reports_every_failure() -> None:
    plan = _plan(GROUPS)

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        if request.call_id == "g2":
            raise RuntimeError("engine down")
        return NoteCallResult(content=_answer(_call_keys(request)), stats={})

    with pytest.raises(NotePlanCallFailed) as excinfo:
        await execute_plan(plan, system=None, user_prefix="P", generate=generate)
    failed = [record for record in excinfo.value.records if record.error is not None]
    assert [record.call_id for record in failed] == ["g2"]


# ---------------------------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------------------------


async def test_sections_merge_in_heading_order_whatever_order_the_groups_finish() -> None:
    plan = _plan(GROUPS)

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        if request.call_id == "g1":
            await asyncio.sleep(0.02)  # the FIRST group finishes LAST
        keys = list(reversed(_call_keys(request)))  # and each group writes its keys reversed
        return NoteCallResult(content=_answer(keys, redaction=request.call_id), stats={})

    execution = await execute_plan(plan, system=None, user_prefix="P", generate=generate)

    note = execution.document["case_note"]
    order = [note.index(f"## {h.title}") for h in plan.headings]
    assert order == sorted(order)
    assert [s["sectionKey"] for s in execution.document["sources"]] == [
        "subjective",
        "objective",
        "assessment",
        "plan",
    ]
    assert execution.document["sources"][0]["refs"] == ["S7"]
    # Redactions are concatenated in CALL order, not completion order.
    assert [r["text"] for r in execution.document["redactions"]] == ["g1", "g2"]


def test_a_group_cannot_write_a_section_it_was_not_given() -> None:
    plan = _plan(GROUPS)
    call = plan.calls[0]  # subjective + objective
    sections = split_sections(
        "## Subjective\nA\n\n## Plan\nSneaky\n\n## Objective\nB", plan, call.section_keys
    )
    assert sections == {"subjective": "A", "objective": "B"}


def test_untitled_text_of_a_one_section_call_is_that_section() -> None:
    plan = _plan(REGEN)
    assert split_sections("Increase metformin.", plan, ["plan"]) == {"plan": "Increase metformin."}


def test_an_unwritten_heading_renders_the_not_discussed_marker() -> None:
    plan = _plan(SINGLE)
    note = merge_sections(plan, {"subjective": "S", "objective": "O", "assessment": "A"}, {})
    assert note.endswith(f"## Plan\n{NOT_DISCUSSED_MARKER}")


async def test_a_non_json_answer_is_the_case_note_itself() -> None:
    plan = _plan(SINGLE)

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        return NoteCallResult(
            content=(
                "## Subjective\nChest tightness.\n\n## Objective\nTroponin 12 ng/L.\n\n"
                "## Assessment\nStable.\n\n## Plan\nIncrease metformin to 1000 mg; review in "
                "four weeks."
            ),
            stats={},
        )

    execution = await execute_plan(plan, system=None, user_prefix="P", generate=generate)
    assert execution.document["case_note"].startswith("## Subjective\nChest tightness.")
    assert execution.document["sources"] == []
    assert execution.coverage.status == "complete"


# ---------------------------------------------------------------------------------------------
# section_regen
# ---------------------------------------------------------------------------------------------


async def test_section_regen_carries_the_preserved_sections_unchanged() -> None:
    plan = _plan(REGEN)
    preserved = {
        "subjective": "Kept subjective — clinician wording.",
        "objective": "Kept objective.",
        "assessment": "Kept assessment.",
    }
    requests: list[NoteCallRequest] = []

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        requests.append(request)
        return NoteCallResult(
            content=json.dumps(
                {
                    "case_note": "## Plan\nIncrease metformin to 1000 mg twice daily.",
                    "redactions": [],
                    "sources": [{"sectionKey": "plan", "refs": ["S5"]}],
                }
            ),
            stats={},
        )

    execution = await execute_plan(
        plan, system=None, user_prefix="P", generate=generate, preserved_sections=preserved
    )

    assert [r.section_keys for r in requests] == [("plan",)]
    note = execution.document["case_note"]
    for key, body in preserved.items():
        assert f"## {plan.heading_title(key)}\n{body}" in note
    assert note.index("## Subjective") < note.index("## Plan")
    assert execution.document["sources"] == [{"sectionKey": "plan", "refs": ["S5"]}]
    assert execution.regenerated_keys == ("plan",)
    assert execution.coverage.status == "complete"


async def test_section_regen_without_the_preserved_text_fails_closed() -> None:
    plan = _plan(REGEN)

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        return NoteCallResult(content="## Plan\nx", stats={})

    with pytest.raises(ValueError, match="preserved"):
        await execute_plan(plan, system=None, user_prefix="P", generate=generate)


# ---------------------------------------------------------------------------------------------
# Trajectory seq offsets (pinned) + the activity
# ---------------------------------------------------------------------------------------------


def test_the_seq_offsets_are_pinned_inside_the_sixteen_stride() -> None:
    assert NODE_STEP_OFFSET == 0
    assert CALL_STEP_OFFSET_BASE == 1
    assert CALL_STEP_OFFSET_BASE + MAX_NOTE_PLAN_CALLS - 1 == 10
    assert REPAIR_STEP_OFFSET == 11
    assert FAILED_STEP_OFFSET_BASE == 12
    assert FAILED_STEP_OFFSET_BASE + MAX_FAILED_STEPS - 1 == 15
    assert executor_module.call_step_offset(0) == 1
    assert executor_module.call_step_offset(MAX_NOTE_PLAN_CALLS - 1) == 10
    assert executor_module.failed_step_offset(0) == 12
    assert executor_module.failed_step_offset(MAX_FAILED_STEPS) is None


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)

        class _R:
            accepted = len(steps)

        return _R()


class _Api:
    def __init__(self, plan: dict[str, Any]) -> None:
        self.plan = plan
        self.calls: list[tuple[str, str, str]] = []

    async def verify_governed_prompts(self, **_kwargs: Any) -> dict[str, Any]:
        # TASK-1047 V7: an unstamped agent is verified through the gateway registry; the stub
        # registry vouches for nothing unless a test says otherwise.
        return {"governed": False, "policyVersion": None}

    async def get_note_plan(self, consultation_id: str, plan_id: str, *, tenant_id: str):
        from harness.services.api_client import NotePlanEnvelope

        self.calls.append((consultation_id, plan_id, tenant_id))
        return NotePlanEnvelope.from_wire(self.plan)


class _Text:
    def __init__(self, *, fail: set[str] | None = None, script: dict[str, list[str]] | None = None):
        self.fail = fail or set()
        self.script = script or {}
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        user = kwargs["prompt"]
        if any(user.endswith(d) for d in self.fail):
            from harness.services.text_client import TextServiceError

            raise TextServiceError("down")
        for directive, answers in self.script.items():
            if user.endswith(directive) and answers:
                content = answers.pop(0)
                break
        else:
            raise AssertionError("unscripted call")
        return TextGenerationResult(
            content=content,
            model="gemma-4-e2b-it-qat",
            provider="lmstudio",
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            stats={"provider": "lmstudio", "model": "gemma-4-e2b-it-qat", "prompt_tokens": 100},
        )


def _wire(monkeypatch, *, api: _Api, text: _Text, cap: _CapTraj) -> None:
    monkeypatch.setattr(activities, "get_settings", lambda: Settings())
    monkeypatch.setattr(activities, "_api_client", lambda s: api)
    monkeypatch.setattr(activities, "_text_client", lambda s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)


def _env() -> ActivityEnvironment:
    """An activity context with a realistic budget, so the repair call fits in it."""
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, start_to_close_timeout=timedelta(seconds=900))
    return env


def _input(raw: dict[str, Any], *, seq: int = 32) -> ExecuteNotePlanInput:
    return ExecuteNotePlanInput(
        tenant_id=raw["tenantId"],
        note_plan_ref=NotePlanRef(
            consultation_id=raw["consultationId"], plan_id=raw["planId"], mode=raw["mode"]
        ),
        hyperparameters={"temperature": 0},
        trajectory=TrajectoryContext(
            tenant_id=raw["tenantId"], consultation_id=raw["consultationId"], seq=seq
        ),
    )


async def test_the_activity_records_one_step_per_group_at_the_pinned_offsets(monkeypatch) -> None:
    raw = _raw(GROUPS)
    plan = NotePlanV1.model_validate(raw)
    api, cap = _Api(raw), _CapTraj()
    text = _Text(
        script={
            plan.calls[0].directive: [_answer(["subjective", "objective"])],
            plan.calls[1].directive: [_answer(["assessment", "plan"])],
        }
    )
    _wire(monkeypatch, api=api, text=text, cap=cap)

    result = await _env().run(activities.execute_note_plan, _input(raw))

    assert api.calls == [(raw["consultationId"], raw["planId"], raw["tenantId"])]
    # The executor never picks a model: the plan's model, the plan's maxTokens.
    assert {(c["provider"], c["model"], c["max_tokens"]) for c in text.calls} == {
        ("lmstudio", "gemma-4-e2b-it-qat", 1024)
    }
    assert {c["temperature"] for c in text.calls} == {0}
    # Each call is constrained to exactly its own sections.
    assert sorted(
        tuple(sorted(c["response_format"]["json_schema"]["schema"]["properties"]))
        for c in text.calls
    ) == [
        ("assessment", "plan", "redactions", "sources"),
        ("objective", "redactions", "sources", "subjective"),
    ]
    assert result.coverage is not None and result.coverage["status"] == "complete"
    assert result.generation.content.startswith("## Subjective")
    assert result.generation.model == "gemma-4-e2b-it-qat"

    steps = sorted(cap.steps, key=lambda s: s.seq)
    assert [(s.seq, s.step_type, s.status) for s in steps] == [
        (33, "LLM_CALL", "OK"),
        (34, "LLM_CALL", "OK"),
    ]
    for index, step in enumerate(steps, start=1):
        assert step.stats["activity_kind"] == "NOTE_SECTION_GROUP"
        assert step.stats["plan_id"] == raw["planId"]
        assert step.stats["call_index"] == index
        assert step.stats["call_count"] == 2
        assert step.stats["context_window"] == 32768
        assert step.stats["max_tokens"] == 1024
        assert step.stats["budget_strategy"] == "ledger_prior+section_groups"
        assert step.stats["encounter_seq"] == 2
        assert step.stats["provider"] == "lmstudio"
        # No free text on a run-record step.
        assert "Allergic" not in json.dumps(step.stats)

    # The note-level record (NOTE_GENERATE) is stamped by persist_draft once the note id exists.
    assert result.note_run_stats is not None
    assert result.note_run_stats["activity_kind"] == "NOTE_GENERATE"
    assert result.note_run_stats["call_count"] == 2
    assert result.note_run_stats["coverage_status"] == "complete"


async def test_the_activity_records_the_repair_and_failed_steps_at_their_offsets(
    monkeypatch,
) -> None:
    raw = _raw(SINGLE)
    plan = NotePlanV1.model_validate(raw)
    gappy = json.dumps(
        {
            "case_note": (
                "## Subjective\nChest tightness.\n\n## Objective\nTroponin 12 ng/L.\n\n"
                "## Assessment\nStable.\n\n## Plan\nIncrease metformin to 1000 mg."
            ),
            "redactions": [],
            "sources": [{"sectionKey": "plan", "refs": ["S5"]}],
        }
    )
    api, cap = _Api(raw), _CapTraj()
    # The repair call (its directive is code-composed) fails: the note keeps its gaps.
    text = _Text(script={plan.calls[0].directive: [gappy]})
    _wire(monkeypatch, api=api, text=text, cap=cap)
    original = text.generate

    async def generate(**kwargs: Any) -> TextGenerationResult:
        if "Rewrite only these sections" in kwargs["prompt"].rsplit("\n\n", 1)[-1]:
            text.calls.append(kwargs)
            from harness.services.text_client import TextServiceError

            raise TextServiceError("down")
        return await original(**kwargs)

    text.generate = generate  # type: ignore[method-assign]

    result = await _env().run(activities.execute_note_plan, _input(raw, seq=0))

    assert result.coverage is not None
    assert result.coverage["status"] == "gaps"
    steps = sorted(cap.steps, key=lambda s: s.seq)
    assert [(s.seq, s.status, s.stats["activity_kind"]) for s in steps] == [
        (1, "OK", "NOTE_SECTION_GROUP"),
        (FAILED_STEP_OFFSET_BASE, "ERROR", "NOTE_REPAIR"),
    ]


async def test_a_successful_repair_lands_on_offset_eleven(monkeypatch) -> None:
    raw = _raw(SINGLE)
    plan = NotePlanV1.model_validate(raw)
    gappy = (
        "## Subjective\nChest tightness.\n\n## Objective\nTroponin 12 ng/L.\n\n"
        "## Assessment\nStable.\n\n## Plan\nIncrease metformin to 1000 mg [S5]."
    )
    api, cap = _Api(raw), _CapTraj()
    text = _Text(script={plan.calls[0].directive: [gappy]})
    _wire(monkeypatch, api=api, text=text, cap=cap)
    original = text.generate

    async def generate(**kwargs: Any) -> TextGenerationResult:
        if "Rewrite only these sections" in kwargs["prompt"].rsplit("\n\n", 1)[-1]:
            text.script["@repair"] = [
                "## Plan\nIncrease metformin to 1000 mg; review in four weeks."
            ]
            kwargs = {**kwargs, "prompt": kwargs["prompt"] + "@repair"}
        return await original(**kwargs)

    text.generate = generate  # type: ignore[method-assign]

    result = await _env().run(activities.execute_note_plan, _input(raw, seq=16))

    assert result.coverage is not None and result.coverage["status"] == "complete"
    assert result.coverage["repairPasses"] == 1
    steps = sorted(cap.steps, key=lambda s: s.seq)
    assert [(s.seq, s.stats["activity_kind"]) for s in steps] == [
        (17, "NOTE_SECTION_GROUP"),
        (16 + REPAIR_STEP_OFFSET, "NOTE_REPAIR"),
    ]


async def test_a_plan_for_another_tenant_is_refused(monkeypatch) -> None:
    raw = _raw(SINGLE)
    api, cap, text = _Api(raw), _CapTraj(), _Text()
    _wire(monkeypatch, api=api, text=text, cap=cap)
    inp = _input(raw).model_copy(update={"tenant_id": "someone-else"})

    from temporalio.exceptions import ApplicationError

    with pytest.raises(ApplicationError) as excinfo:
        await _env().run(activities.execute_note_plan, inp)
    assert excinfo.value.non_retryable is True
    assert text.calls == []


# ---------------------------------------------------------------------------------------------
# The governed finalizer (`core.agent`, cadence onEnd) prefers the handoff's note_plan_ref
# ---------------------------------------------------------------------------------------------

_GOV_TENANT = "10000000-0000-0000-0000-000000000001"
_GOV_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"


def _governed_agent() -> dict[str, Any]:
    return {
        "agentId": "agent-fin",
        "agentVersionId": "agent-fin-v3",
        "slug": "casenote-finalization",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _GOV_TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {"id": "m-1", "slug": "gemma-4-e2b", "provider": "lm-studio"},
            "fallbacks": [],
            "instruction": {"systemPrompt": "Finalize the case note."},
            "resolvedPrompt": {"source": "inline", "content": "Finalize the case note."},
            "parameters": {"generation": {"temperature": 0}},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "priority": 0,
                "slug": "gemma-4-e2b",
                "sourceUri": "gemma-4-e2b-it-qat",
                "provider": "lm-studio",
                "format": "GGUF",
                "tenantId": _GOV_TENANT,
            }
        ],
        "textFallback": {"autoSwitch": False, "chain": []},
    }


async def test_the_governed_finalizer_executes_the_handoff_note_plan(monkeypatch) -> None:
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    plan = NotePlanV1.model_validate(raw)

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return _governed_agent()

    api, cap = _GovApi(raw), _CapTraj()
    text = _Text(
        script={
            plan.calls[0].directive: [_answer(["subjective", "objective"])],
            plan.calls[1].directive: [_answer(["assessment", "plan"])],
        }
    )
    persisted: list[Any] = []

    async def _persist_draft(payload: Any) -> Any:
        persisted.append(payload)
        from harness.services.api_client import DraftResponse

        return DraftResponse(context_item_id="ctx-1", version_number=7)

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

    assert result.status == "SUCCEEDED", result.reason
    # One call per plan group, on the PLAN's model, each ending with its directive.
    assert len(text.calls) == 2
    assert {(c["model"], c["max_tokens"]) for c in text.calls} == {("gemma-4-e2b-it-qat", 1024)}
    prefixes = {c["prompt"].rsplit("\n\n", 1)[0] for c in text.calls}
    assert len(prefixes) == 1
    assert "Finalize the case note." in text.calls[0]["system_prompt"]
    # The plan call's own section schema, not the agent's whole-note contract.
    assert sorted(
        tuple(sorted(c["response_format"]["json_schema"]["schema"]["properties"]))
        for c in text.calls
    ) == [
        ("assessment", "plan", "redactions", "sources"),
        ("objective", "redactions", "sources", "subjective"),
    ]

    # The finalizer output keeps its shape; case_note is the merged note.
    data = result.output["data"]
    assert set(data) == {"case_note", "redactions", "sources"}
    assert data["case_note"].startswith("## Subjective\nAllergic to penicillin.")
    assert data["sources"][0] == {"sectionKey": "subjective", "refs": ["S7"]}

    [draft] = persisted
    assert draft.content == data["case_note"]
    assert draft.coverage["status"] == "complete"

    steps = sorted(cap.steps, key=lambda s: s.seq)
    assert [(s.seq, s.step_type, s.stats["activity_kind"]) for s in steps] == [
        (48, "NODE", "NOTE_GENERATE"),
        (49, "LLM_CALL", "NOTE_SECTION_GROUP"),
        (50, "LLM_CALL", "NOTE_SECTION_GROUP"),
    ]
    node = steps[0].stats
    assert node["context_item_id"] == "ctx-1"
    assert node["output_version"] == 7
    assert node["agent_slug"] == "casenote-finalization"
    assert node["agent_version"] == 3
    assert node["plan_id"] == raw["planId"]
    assert steps[1].stats["agent_slug"] == "casenote-finalization"


async def test_a_governed_plan_for_another_consultation_degrades(monkeypatch) -> None:
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT  # consultationId stays the fixture's — not this run's

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return _governed_agent()

    api, cap, text = _GovApi(raw), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

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
            run_context={"trigger": {}, "vars": {}, "nodes": {}},
            run_id="run-1",
        ),
    )

    assert result.status == "DEGRADED"
    assert "note_plan_mismatch" in (result.reason or "")
    assert text.calls == []


async def test_a_handoff_note_plan_error_degrades_the_finalizer_with_that_code(monkeypatch) -> None:
    """The handoff could not compose the plan: the finalizer degrades NAMING the composer's code
    (not ``no_bound_text``) and writes nothing — even when a ``context`` value is bound, so the
    note is never generated from a partial input."""
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return _governed_agent()

    api, cap, text = _GovApi(_raw(GROUPS)), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

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
            bound_inputs={
                "in": [{"text": "", "note_plan_error": "NOTE_INPUT_EXCEEDS_CONTEXT"}],
                "context": [{"patient": "synthetic"}],
            },
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id="run-1",
            trajectory=TrajectoryContext(
                tenant_id=_GOV_TENANT, consultation_id=_GOV_CONSULTATION, seq=48
            ),
        ),
    )

    assert result.status == "DEGRADED"
    assert "NOTE_INPUT_EXCEEDS_CONTEXT" in (result.reason or "")
    assert "no_bound_text" not in (result.reason or "")
    assert text.calls == []
    assert [s.error_code for s in cap.steps] == ["NOTE_INPUT_EXCEEDS_CONTEXT"]


async def test_a_handoff_note_plan_error_alone_degrades_with_that_code(monkeypatch) -> None:
    """Nothing else bound: still the composer's code, never ``no_bound_text``."""
    from harness.temporal.interpreter.models import NodeActivityInput
    from harness.temporal.interpreter.nodes import core

    class _GovApi(_Api):
        async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
            return _governed_agent()

    api, cap, text = _GovApi(_raw(GROUPS)), _CapTraj(), _Text()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

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
            bound_inputs={"in": [{"text": "", "note_plan_error": "NOTE_MODEL_CONTEXT_UNDECLARED"}]},
            run_payload={"consultationId": _GOV_CONSULTATION, "userId": "doctor-1"},
            run_context={"trigger": {"consultationId": _GOV_CONSULTATION}, "vars": {}, "nodes": {}},
            run_id="run-1",
        ),
    )

    assert result.status == "DEGRADED"
    assert "NOTE_MODEL_CONTEXT_UNDECLARED" in (result.reason or "")
    assert text.calls == []
