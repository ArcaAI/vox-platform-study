"""TASK-1038 R8 / TASK-1036 §10.3 (lane B1) — text deltas STREAM from workflows, and the model
step is traced.

* ``TextClient.generate_stream`` posts ``stream: true`` and reads the text service's SSE (``meta``,
  ``chunk``…, terminal ``done`` / ``error``), handing each chunk to a callback and returning the
  same ``TextGenerationResult`` the blocking call does.
* A ``core.agent`` text node wired into End (or flagged ``stream``) generates with
  ``stream: true`` under run protocol v2 and appends ``output.text.delta { field: 'text' }`` per
  chunk (OD-24, OD-33); any other node is unchanged (blocking, no deltas).
* Every attempt appends the admin ``prompt.composed`` (sizes only, never content),
  ``model.request`` and — from the text service's egress report — ``guardrail.inbound``.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from harness.services import composed_prompt_recorder as recorder
from harness.services.text_client import TextClient, TextGenerationResult, TextServiceError
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.run_protocol import run_event_problems
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis
from harness.tests.unit.temporal.interpreter.test_task1035_core_agent_composer import (
    _TENANT,
    _wire,
)

_RUN = "run-stream-1"

_SSE = (
    'event: meta\ndata: {"generation_id":"g-1"}\nid: g-1:0\n\n'
    'event: chunk\ndata: {"type":"chunk","content":"Hel"}\nid: g-1:1\n\n'
    'event: chunk\ndata: {"type":"chunk","content":"lo"}\nid: g-1:2\n\n'
    'event: done\ndata: {"type":"done","data":{"finish_reason":"stop",'
    '"usage":{"prompt_tokens":5,"completion_tokens":2},'
    '"egress":{"locality":"local","detected":{"PII.NAME":1},"redacted":false}}}\nid: g-1:3\n\n'
)


def _client(body: str, status: int = 200) -> tuple[TextClient, list[dict[str, Any]]]:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.append(json.loads(request.content))
        return httpx.Response(status, text=body, headers={"content-type": "text/event-stream"})

    return TextClient("http://text", transport=httpx.MockTransport(handler)), seen


class TestGenerateStream:
    @pytest.mark.asyncio
    async def test_deltas_reach_the_callback_and_the_result_is_assembled(self) -> None:
        client, seen = _client(_SSE)
        deltas: list[str] = []

        async def on_delta(text: str) -> None:
            deltas.append(text)

        result = await client.generate_stream(
            tenant_id=_TENANT, prompt="p", provider="lm-studio", model="m", on_delta=on_delta
        )
        assert seen[0]["stream"] is True
        assert deltas == ["Hel", "lo"]
        assert isinstance(result, TextGenerationResult)
        assert result.content == "Hello"
        assert result.usage == {"prompt_tokens": 5, "completion_tokens": 2}
        assert result.egress == {
            "locality": "local",
            "detected": {"PII.NAME": 1},
            "redacted": False,
        }
        assert result.finish_reason == "stop"

    @pytest.mark.asyncio
    async def test_an_error_frame_raises(self) -> None:
        client, _ = _client('event: error\ndata: {"type":"error","data":{"error":"boom"}}\n\n')
        with pytest.raises(TextServiceError):
            await client.generate_stream(tenant_id=_TENANT, prompt="p", on_delta=_ignore)


async def _ignore(_text: str) -> None:
    return None


class _StreamingText:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _result(self, provider: str) -> TextGenerationResult:
        return TextGenerationResult(
            content="Hello",
            provider=provider,
            model="m",
            usage={"prompt_tokens": 5, "completion_tokens": 2},
            egress={"locality": "local", "detected": {"PII.NAME": 1}, "redacted": False},
        )

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(("generate", kwargs))
        return self._result(kwargs["provider"])

    async def generate_stream(self, *, on_delta: Any, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(("generate_stream", kwargs))
        for piece in ("Hel", "lo"):
            await on_delta(piece)
        return self._result(kwargs["provider"])


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch):
    stream = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", stream, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)
    monkeypatch.setattr(recorder, "_send", _noop)

    async def _go(delivery: dict[str, Any] | None) -> tuple[Any, list, list[dict[str, Any]]]:
        text = _StreamingText()

        class _Api:
            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return _wire({"source": "inline", "content": "Summarise."})

        monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        payload = NodeActivityInput(
            node_id="n_note",
            node_type="core.agent",
            config={"agentRef": {"slug": "clinic-summarizer"}},
            tenant_id=_TENANT,
            bound_inputs={"in": "Ada reports chest pain."},
            run_id=_RUN,
            run_context={"trigger": {"q": 1}},
            protocol=2,
            delivery=delivery,
        )
        result = await core.interpreter_core_agent(payload)
        await recorder.drain_pending()
        return result, text.calls, stream.events(_RUN)

    return _go


class TestTheTextNodeStreams:
    @pytest.mark.asyncio
    async def test_an_end_wired_text_node_streams_its_text(self, agent) -> None:
        result, calls, events = await agent({"publicFields": ["text"], "stream": False})
        assert result.status == "SUCCEEDED"
        assert result.output["text"] == "Hello"
        assert [name for name, _ in calls] == ["generate_stream"]
        assert result.io["streamed"] == ["text"]
        for event in events:
            assert run_event_problems(event) == [], event
        deltas = [e["data"] for e in events if e["type"] == "output.text.delta"]
        assert deltas == [{"field": "text", "text": "Hel"}, {"field": "text", "text": "lo"}]
        (request,) = [e for e in events if e["type"] == "model.request"]
        assert request["data"]["stream"] is True and request["data"]["fallback"] is False
        assert request["data"]["attempt"] == 1
        (composed,) = [e for e in events if e["type"] == "prompt.composed"]
        assert {layer["name"] for layer in composed["data"]["layers"]} >= {
            "platformRules",
            "instruction",
            "data",
        }
        assert composed["data"]["charsTotal"] == sum(
            layer["chars"] for layer in composed["data"]["layers"]
        )
        (inbound,) = [e for e in events if e["type"] == "guardrail.inbound"]
        assert inbound["data"] == {
            "action": "ALLOW",
            "detected": 1,
            "categories": ["PII.NAME"],
            "mode": "detect",
        }

    @pytest.mark.asyncio
    async def test_a_node_not_wired_to_end_does_not_stream(self, agent) -> None:
        result, calls, events = await agent(None)
        assert [name for name, _ in calls] == ["generate"]
        assert "streamed" not in (result.io or {})
        assert not [e for e in events if e["type"] == "output.text.delta"]
        (request,) = [e for e in events if e["type"] == "model.request"]
        assert request["data"]["stream"] is False
