"""TASK-1050 W2f — a ``core.agent`` text generation and the guardrail (README §9.7, §9.8).

* warn / unverified notices the text service returned are emitted as PUBLIC ``guardrail.notice``
  events (run protocol v2) and carried on the activity result (the walk collects them into
  ``run.completed.guardrailNotices``); a notice that does not conform is dropped, never emitted;
* the evaluation ids land on the LLM_CALL trajectory step (``stats.guardrail_evaluation_ids``);
* the correlation headers and a resolved hold's override reach the text client;
* a BLOCK (or a cloud pseudonymiser outage) stops the candidate walk and comes back as a
  ``guardrail_hold`` — the workflow then pauses the run at the node (W2f §9.8.1);
* the note-plan finalizer turns a blocked plan call into the same hold.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services import composed_prompt_recorder as recorder
from harness.services.text_client import TextGenerationResult, TextGuardrailBlocked
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.run_protocol import (
    guardrail_notice_problems,
    run_event_problems,
)
from harness.temporal.models import TrajectoryContext
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis
from harness.tests.unit.temporal.interpreter.test_task1035_core_agent_composer import (
    _TENANT,
    _fallback,
    _wire,
)

_RUN = "run-1050-agent"

_WARN: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": "01927f6e-9999-7000-8000-0000000000aa",
    "type": "guardrail.warning",
    "direction": "inbound",
    "action": "warn",
    "checks": [{"checkId": "unsafe_content_judge", "category": "violence", "severity": "medium"}],
    "itemIds": ["item-1"],
    "messageKey": "guardrail.warning.generic",
    "defaultMessage": "A safety check flagged this content. Review it before you rely on it.",
    "requiresAcknowledgement": True,
    "resumable": False,
    "policyVersion": "pv-1",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}
_BLOCK: dict[str, Any] = {
    **_WARN,
    "noticeId": "01927f6e-9999-7000-8000-0000000000ab",
    "type": "guardrail.blocked",
    "action": "block",
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": "A safety check stopped this request. Review the flagged input to continue.",
    "resumable": True,
}


class _Text:
    def __init__(self, *, raise_: BaseException | None = None, **extra: Any) -> None:
        self.raise_ = raise_
        self.extra = extra
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        if self.raise_ is not None:
            raise self.raise_
        return TextGenerationResult(
            content="the note", provider=kwargs["provider"], model="m", usage={}, **self.extra
        )


@pytest.fixture
def run_agent(monkeypatch: pytest.MonkeyPatch):
    stream = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", stream, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    flushed: dict[str, list[dict[str, Any]]] = {"node": [], "generation": []}

    async def _record(_payload: Any, **kwargs: Any) -> None:
        flushed["node"].append(kwargs)

    async def _record_generation(_payload: Any, **kwargs: Any) -> None:
        flushed["generation"].append(kwargs)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _record)
    monkeypatch.setattr(core, "record_generation_and_flush", _record_generation)
    monkeypatch.setattr(recorder, "_send", _noop)
    monkeypatch.setattr(core, "_temporal_identity", lambda: ("wf-1050", "trun-1"))

    async def _go(
        text: _Text,
        *,
        chain: list[dict[str, Any]] | None = None,
        override: str | None = None,
    ) -> tuple[Any, list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        class _Api:
            async def verify_governed_prompts(self, **_kwargs: Any) -> dict[str, Any]:
                return {"governed": False, "policyVersion": None}

            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return _wire({"source": "inline", "content": "Summarise."}, chain=chain)

        monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        payload = NodeActivityInput(
            node_id="n_note",
            node_type="core.agent",
            config={"agentRef": {"slug": "clinic-summarizer"}},
            tenant_id=_TENANT,
            bound_inputs={"in": "Ada reports chest pain."},
            run_payload={"consultationId": "c-1"},
            run_id=_RUN,
            run_context={"trigger": {"q": 1}},
            protocol=2,
            trajectory=TrajectoryContext(tenant_id=_TENANT, seq=32),
            guardrail_override=override,
        )
        result = await core.interpreter_core_agent(payload)
        await recorder.drain_pending()
        return result, stream.events(_RUN), flushed

    return _go


class TestWarnNotices:
    @pytest.mark.asyncio
    async def test_a_warn_notice_is_emitted_public_and_carried_on_the_result(
        self, run_agent
    ) -> None:
        text = _Text(guardrail_notices=[_WARN], guardrail_evaluation_ids=["ev-1", "ev-2"])
        result, events, _ = await run_agent(text)
        assert result.status == "SUCCEEDED"
        (notice_event,) = [e for e in events if e["type"] == "guardrail.notice"]
        assert run_event_problems(notice_event, plane="public") == []
        assert notice_event["nodeId"] == "n_note"
        filled = notice_event["data"]
        assert filled["runId"] == _RUN
        assert filled["nodeId"] == "n_note"
        assert filled["consultationId"] == "c-1"
        assert result.guardrail_notices == [filled]
        assert result.guardrail_hold is None

    @pytest.mark.asyncio
    async def test_a_non_conforming_notice_is_dropped(self, run_agent) -> None:
        bad = {**_WARN, "defaultMessage": "Patient Ada said something violent."}
        result, events, _ = await run_agent(_Text(guardrail_notices=[bad]))
        assert result.status == "SUCCEEDED"
        assert not [e for e in events if e["type"] == "guardrail.notice"]
        assert not result.guardrail_notices

    @pytest.mark.asyncio
    async def test_evaluation_ids_land_on_the_llm_call_step(self, run_agent) -> None:
        text = _Text(guardrail_evaluation_ids=["ev-1", "ev-2"])
        _, _, flushed = await run_agent(text)
        (generation,) = flushed["generation"]
        assert generation["stats"]["guardrail_evaluation_ids"] == ["ev-1", "ev-2"]


class TestHeaders:
    @pytest.mark.asyncio
    async def test_correlation_reaches_the_text_client(self, run_agent) -> None:
        text = _Text()
        await run_agent(text)
        (call,) = text.calls
        assert call["correlation"] == {
            "runId": _RUN,
            "nodeId": "n_note",
            "consultationId": "c-1",
            # The LLM_CALL step's own key (`AiActivityRun.runKey`): seq base + offset 1.
            "runKey": "trajectory:wf-1050:trun-1:33",
        }
        assert call["guardrail_override"] is None

    @pytest.mark.asyncio
    async def test_a_resolved_hold_override_is_forwarded(self, run_agent) -> None:
        text = _Text()
        await run_agent(text, override=_BLOCK["noticeId"])
        assert text.calls[0]["guardrail_override"] == _BLOCK["noticeId"]


class TestBlock:
    @pytest.mark.asyncio
    async def test_a_block_is_a_hold_and_no_fallback_candidate_is_tried(self, run_agent) -> None:
        blocked = TextGuardrailBlocked(
            kind="blocked",
            status_code=422,
            notice=_BLOCK,
            evaluation_ids=["ev-9"],
            error_code="CONTENT_BLOCKED",
        )
        text = _Text(raise_=blocked)
        result, events, flushed = await run_agent(
            text, chain=[_fallback("You summarise consultations.")]
        )
        assert (
            len(text.calls) == 1
        ), "a block is a policy verdict, never an outage to fall back from"
        assert result.status == "DEGRADED"
        assert result.reason.startswith("GUARDRAIL_BLOCKED")
        hold = result.guardrail_hold
        assert hold is not None and hold.kind == "blocked"
        assert hold.notice["noticeId"] == _BLOCK["noticeId"]
        assert hold.notice["runId"] == _RUN and hold.notice["nodeId"] == "n_note"
        assert guardrail_notice_problems(hold.notice) == []
        assert hold.evaluation_ids == ["ev-9"]
        (node_step,) = flushed["node"]
        assert node_step["error_code"] == "guardrail_blocked"
        assert node_step["stats"] == {"guardrail_evaluation_ids": ["ev-9"]}
        # The WORKFLOW emits the block notice (and `run.paused`); the activity does not.
        assert not [e for e in events if e["type"] == "guardrail.notice"]

    @pytest.mark.asyncio
    async def test_a_redaction_outage_is_a_hold_with_a_minted_privacy_notice(
        self, run_agent
    ) -> None:
        down = TextGuardrailBlocked(
            kind="redaction_unavailable",
            status_code=503,
            notice=None,
            evaluation_ids=[],
            error_code="EGRESS_REDACTION_UNAVAILABLE",
        )
        result, _, flushed = await run_agent(_Text(raise_=down))
        hold = result.guardrail_hold
        assert hold is not None and hold.kind == "redaction_unavailable"
        assert guardrail_notice_problems(hold.notice) == []
        assert hold.notice["messageKey"] == "guardrail.blocked.redaction_unavailable"
        assert hold.notice["type"] == "guardrail.blocked"
        assert hold.notice["checks"] == []
        assert hold.notice["resumable"] is True
        assert flushed["node"][0]["error_code"] == "egress_redaction_unavailable"

    @pytest.mark.asyncio
    async def test_a_block_without_a_usable_notice_mints_a_generic_one(self, run_agent) -> None:
        blocked = TextGuardrailBlocked(
            kind="blocked",
            status_code=422,
            notice={"type": "guardrail.blocked"},
            evaluation_ids=[],
            error_code="CONTENT_BLOCKED",
        )
        result, _, _ = await run_agent(_Text(raise_=blocked))
        hold = result.guardrail_hold
        assert hold is not None
        assert guardrail_notice_problems(hold.notice) == []
        assert hold.notice["type"] == "guardrail.blocked"


class TestAttribution:
    @pytest.mark.asyncio
    async def test_the_invoked_agent_is_named_and_no_response_item_is_guessed(
        self, run_agent
    ) -> None:
        text = _Text()
        await run_agent(text)
        (call,) = text.calls
        assert call["agent_slug"] == "clinic-summarizer"
        assert "response_items" not in call
