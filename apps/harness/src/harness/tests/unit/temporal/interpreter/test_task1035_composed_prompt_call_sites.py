"""OD-9 — the durable `generate` activity and the realtime nodes record what they sent.

`core.agent` and `generate.text` are pinned in their own composer suites. Here: the legacy
``HarnessDocWorkflow`` ``generate`` activity and the three realtime nodes record EXACTLY the
system / user text that reached ``apps/text``, once per successful call, with the locality text
reported — and a recording failure never costs the step.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.sensors.base import NEREntity
from harness.services import composed_prompt_recorder as recorder
from harness.services.api_client import ResolvedPromptTemplateResponse, TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_realtime as rt
from harness.temporal.models import GenerateInput, TrajectoryContext

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1"}
_EGRESS = {"locality": "local", "detected": {}, "redacted": 0}


class _Text:
    def __init__(self, *contents: str) -> None:
        self._contents = list(contents) or ["DRAFT"]
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        content = self._contents[min(len(self.calls) - 1, len(self._contents) - 1)]
        return TextGenerationResult(
            content=content, provider="lm-studio", model="m", egress=_EGRESS
        )


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[tuple[dict[str, Any], str]]:
    captured: list[tuple[dict[str, Any], str]] = []

    async def _capture(body: dict[str, Any], tenant_id: str) -> None:
        captured.append((body, tenant_id))

    monkeypatch.setattr(recorder, "_send", _capture)
    return captured


class _Traj:
    async def report_trajectory(self, steps: Any, *, idempotency_key: str | None = None) -> Any:
        return TrajectoryReportResponse(accepted=len(steps))


class TestDurableGenerate:
    @pytest.mark.asyncio
    async def test_records_the_dispatched_messages(self, monkeypatch, recorded) -> None:
        text = _Text()
        monkeypatch.setattr(activities, "_text_client", lambda _s: text)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _Traj())

        await ActivityEnvironment().run(
            activities.generate,
            GenerateInput(
                tenant_id=_TENANT,
                prompt="USER",
                system_prompt="SYSTEM",
                prompt_block="KB",
                provider="lm-studio",
                model="m",
                trajectory=TrajectoryContext(tenant_id=_TENANT, consultation_id="c-9", seq=1),
            ),
        )
        await recorder.drain_pending()

        assert recorded == [
            (
                {
                    "consultationId": "c-9",
                    "phase": "finalize",
                    "provider": "lm-studio",
                    "locality": "local",
                    "system": "SYSTEM",
                    "user": text.calls[0]["prompt"],
                },
                _TENANT,
            )
        ]
        assert recorded[0][0]["user"] == "USER\n\nKB"

    @pytest.mark.asyncio
    async def test_a_recording_failure_never_fails_the_activity(self, monkeypatch) -> None:
        async def _down(_body: dict[str, Any], _tenant_id: str) -> None:
            raise RuntimeError("gateway down")

        monkeypatch.setattr(recorder, "_send", _down)
        monkeypatch.setattr(activities, "_text_client", lambda _s: _Text())
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _Traj())

        result = await ActivityEnvironment().run(
            activities.generate, GenerateInput(tenant_id=_TENANT, prompt="USER")
        )
        await recorder.drain_pending()

        assert result.content == "DRAFT"


class _Api:
    async def get_resolved_prompt_template(self, template_id: str, tenant_id: str | None = None):
        return ResolvedPromptTemplateResponse(
            found=True, approved=True, content="TENANT INSTRUCTION", version_number=1
        )

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"textProvider": "lm-studio", "textModel": "m"}

    async def report_loop_event(self, *_args: Any, **_kwargs: Any) -> bool:
        return True

    async def publish_live_summary(self, *_args: Any, **_kwargs: Any) -> bool:
        return True

    async def publish_live_assist(self, *_args: Any, **_kwargs: Any) -> bool:
        return True


def _node(node_type: str, config: dict[str, Any], text: str) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n1",
        node_type=node_type,
        config=config,
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": text},
        run_payload=dict(_RUN),
    )


def _expect(text: _Text, recorded: list[tuple[dict[str, Any], str]]) -> None:
    assert len(recorded) == len(text.calls)
    for call, (body, tenant) in zip(text.calls, recorded, strict=True):
        assert tenant == _TENANT
        assert body == {
            "consultationId": "c1",
            "phase": "live",
            "provider": "lm-studio",
            "locality": "local",
            "system": call["system_prompt"],
            "user": call["prompt"],
        }


class TestRealtimeNodes:
    @pytest.mark.asyncio
    async def test_realtime_summary_records_every_window(self, monkeypatch, recorded) -> None:
        text = _Text('{"subjective": "s"}')
        monkeypatch.setattr(rt, "_api_client", lambda _s: _Api())
        monkeypatch.setattr(rt, "_text_client", lambda _s: text)

        await rt.interpreter_consultation_realtime_summary(
            _node("consultation.realtimeSummary", {"windowChars": 5}, "abcdefghij")
        )
        await recorder.drain_pending()

        assert len(text.calls) == 2
        _expect(text, recorded)

    @pytest.mark.asyncio
    async def test_suggestions_record_the_call(self, monkeypatch, recorded) -> None:
        text = _Text('{"suggestions": []}')
        monkeypatch.setattr(rt, "_api_client", lambda _s: _Api())
        monkeypatch.setattr(rt, "_text_client", lambda _s: text)

        await rt.interpreter_consultation_suggestions(
            _node("consultation.suggestions", {"promptTemplateId": "tpl"}, "chest pain")
        )
        await recorder.drain_pending()

        _expect(text, recorded)

    @pytest.mark.asyncio
    async def test_corrections_record_the_call(self, monkeypatch, recorded) -> None:
        text = _Text('{"proposals": []}')

        async def _extract(_payload: Any) -> Any:
            return type("R", (), {"entities": [NEREntity(text="x", type="DRUG", start=0, end=1)]})()

        monkeypatch.setattr(rt, "_api_client", lambda _s: _Api())
        monkeypatch.setattr(rt, "_text_client", lambda _s: text)
        monkeypatch.setattr(rt, "extract_entities", _extract)

        await rt.interpreter_consultation_propose_corrections(
            _node("consultation.proposeCorrections", {"promptTemplateId": "tpl"}, "x y")
        )
        await recorder.drain_pending()

        _expect(text, recorded)
