"""Faster-entailment-judge candidate tests — Granite Guardian *groundedness* mode as a
drop-in judge.

The residual <2 min gap is the 31 groundedness
calls paying a *reasoning* judge (gemma-4-e4b) for a 1-token verdict. This candidate reuses the
already-resident IBM Granite Guardian (single no-think ``<score>yes/no</score>`` verdict)
in *groundedness* mode, exposed as a :class:`~harness.eval.judge.base.JudgeClient` so the
groundedness/citation sensors swap with ZERO code change (a config flip).

Contract under test (mirrors the gemma client + the sensors' conservative fallback):
* speaks the sensors' ``PREMISE:/HYPOTHESIS:`` envelope and reframes it as a Granite
  groundedness BYOC call (premise = Context, hypothesis = the assistant statement);
* ``<score>no</score>`` (no ungroundedness risk) -> ``{"supported": true}``;
  ``<score>yes</score>`` (risk present) -> ``{"supported": false}``;
* an unparseable verdict (200, no ``<score>``) -> ``{"supported": false}`` (conservative
  ungrounded — NOT a degrade, matching ``_is_supported`` raising -> ungrounded per claim);
* a transport / non-2xx failure -> :class:`JudgeConnectionError` (so the sensor degrades,
  never auto-PASSes);
* the returned JSON parses through the sensors' own ``_is_supported`` (drop-in proof).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.core.config import SafetyGuardConfig
from harness.eval.judge.base import JudgeClient, JudgeConnectionError
from harness.sensors.inferential.granite_client import GraniteGroundednessJudge
from harness.sensors.inferential.groundedness import _entailment_messages, _is_supported


def _cfg(**overrides: Any) -> SafetyGuardConfig:
    base: dict[str, Any] = {
        "enabled": True,
        "provider": "lm-studio",
        "base_url": "http://lmstudio:1234/v1",
        "model": "granite-guardian-test",
        "no_think": True,
        "timeout_s": 5.0,
    }
    base.update(overrides)
    return SafetyGuardConfig(**base)


def _judge(handler, **overrides: Any) -> GraniteGroundednessJudge:
    return GraniteGroundednessJudge(_cfg(**overrides), transport=httpx.MockTransport(handler))


def _score(verdict: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"role": "assistant", "content": f"<score>{verdict}</score>"}}]},
    )


class TestVerdictMapping:
    @pytest.mark.asyncio
    async def test_no_risk_maps_to_supported_true(self):
        raw = await _judge(lambda r: _score("no")).complete(
            _entailment_messages("transcript premise", "patient has a fever"), json_mode=True
        )
        assert _is_supported(raw) is True

    @pytest.mark.asyncio
    async def test_risk_maps_to_supported_false(self):
        raw = await _judge(lambda r: _score("yes")).complete(
            _entailment_messages("transcript premise", "patient prescribed 500mg amoxicillin"),
            json_mode=True,
        )
        assert _is_supported(raw) is False

    @pytest.mark.asyncio
    async def test_unparseable_verdict_is_conservative_ungrounded(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": "looks fine"}}]})

        raw = await _judge(handler).complete(
            _entailment_messages("p", "h"), json_mode=True
        )
        assert _is_supported(raw) is False  # missing <score> -> ungrounded, not a crash

    @pytest.mark.asyncio
    async def test_transport_error_raises_judge_connection_error(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "model unavailable"})

        with pytest.raises(JudgeConnectionError):
            await _judge(handler).complete(_entailment_messages("p", "h"), json_mode=True)


class TestRequestShape:
    @pytest.mark.asyncio
    async def test_premise_and_hypothesis_reframed_as_groundedness_byoc(self):
        captured: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            captured["url"] = str(request.url)
            return _score("no")

        await _judge(handler).complete(
            _entailment_messages("the full consultation transcript", "BP was 120/80"),
            json_mode=True,
        )
        body = captured["body"]
        assert captured["url"] == "http://lmstudio:1234/v1/chat/completions"
        # The hypothesis (claim under check) is the assistant message; the guardian
        # block carries the premise as Context + a groundedness criterion.
        assert body["messages"][0]["role"] == "assistant"
        assert body["messages"][0]["content"] == "BP was 120/80"
        block = body["messages"][-1]["content"]
        assert body["messages"][-1]["role"] == "user"
        assert "<guardian><no-think>" in block
        assert "### Context:" in block
        assert "the full consultation transcript" in block
        assert "### Criteria:" in block
        assert "### Scoring Schema:" in block
        assert body["temperature"] == 0.0
        assert body["stream"] is False

    @pytest.mark.asyncio
    async def test_thinking_mode_omits_no_think_tag(self):
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["block"] = json.loads(request.content)["messages"][-1]["content"]
            return _score("no")

        await _judge(handler, no_think=False).complete(_entailment_messages("p", "h"))
        assert "<no-think>" not in captured["block"]
        assert "<guardian>" in captured["block"]

    @pytest.mark.asyncio
    async def test_ollama_provider_uses_native_api_chat(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"message": {"content": "<score>no</score>"}})

        raw = await _judge(
            handler, provider="ollama", base_url="http://granite:11434"
        ).complete(_entailment_messages("p", "h"))
        assert _is_supported(raw) is True
        assert str(seen[0].url) == "http://granite:11434/api/chat"


class TestProtocol:
    def test_satisfies_judge_client_protocol(self):
        judge = _judge(lambda r: _score("no"))
        assert isinstance(judge, JudgeClient)

    def test_model_attribute_exposed(self):
        assert _judge(lambda r: _score("no"), model="granite-x").model == "granite-x"
