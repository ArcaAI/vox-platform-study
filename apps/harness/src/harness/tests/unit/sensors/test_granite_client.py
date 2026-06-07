"""Granite Guardian client tests (RED-first, TASK-330 Phase 2).

The safety sensor screens the generated note through IBM Granite Guardian served
locally by Ollama. This async client posts ONE no-think ``<guardian>`` criteria
block per configured harm dimension to Ollama's native ``/api/chat`` and parses
the ``<score>yes/no</score>`` verdict (``yes`` => the risk IS present => unsafe).
A transport error raises :class:`GraniteServiceError`; an unparseable verdict
raises :class:`GraniteParseError` (so the sensor degrades rather than guessing).
Mirrors the stubbed-``httpx.MockTransport`` style of ``services/test_api_client``.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.core.config import GraniteGuardConfig
from harness.sensors.inferential.granite_client import (
    GraniteGuardianClient,
    GraniteParseError,
    GraniteServiceError,
)


def _cfg(**overrides) -> GraniteGuardConfig:
    base = {
        "enabled": True,
        "base_url": "http://granite:11434",
        "model": "granite-test",
        "no_think": True,
        "timeout_s": 5.0,
        "harm_criteria": ["harm", "violence"],
    }
    base.update(overrides)
    return GraniteGuardConfig(**base)


def _client(handler, **overrides) -> GraniteGuardianClient:
    return GraniteGuardianClient(_cfg(**overrides), transport=httpx.MockTransport(handler))


class TestScreen:
    @pytest.mark.asyncio
    async def test_one_chat_call_per_criterion_parses_scores(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            system = json.loads(request.content)["messages"][0]["content"]
            verdict = "yes" if "violence" in system else "no"
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": f"<score>{verdict}</score>"}}
            )

        dims = await _client(handler).screen("patient note text")

        assert dims == {"harm": False, "violence": True}
        assert len(seen) == 2, "one screen call per harm dimension"
        assert str(seen[0].url) == "http://granite:11434/api/chat"
        body0 = json.loads(seen[0].content)
        assert body0["model"] == "granite-test"
        assert body0["stream"] is False
        assert body0["messages"][-1]["content"] == "patient note text"
        assert "<guardian>" in body0["messages"][0]["content"]

    @pytest.mark.asyncio
    async def test_no_think_block_present_when_configured(self):
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["system"] = json.loads(request.content)["messages"][0]["content"]
            return httpx.Response(200, json={"message": {"content": "<score>no</score>"}})

        await _client(handler, harm_criteria=["harm"], no_think=True).screen("x")
        assert "no_think" in captured["system"]

    @pytest.mark.asyncio
    async def test_parses_generate_style_response_field(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"response": "<score>YES</score>"})

        dims = await _client(handler, harm_criteria=["harm"]).screen("x")
        assert dims == {"harm": True}

    @pytest.mark.asyncio
    async def test_empty_criteria_makes_no_calls(self):
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
            raise AssertionError("no HTTP call expected with empty harm_criteria")

        dims = await _client(handler, harm_criteria=[]).screen("x")
        assert dims == {}


class TestFailures:
    @pytest.mark.asyncio
    async def test_http_error_raises_granite_service_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "model unavailable"})

        with pytest.raises(GraniteServiceError):
            await _client(handler, harm_criteria=["harm"]).screen("x")

    @pytest.mark.asyncio
    async def test_missing_score_tag_raises_parse_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"message": {"content": "It seems fine to me."}})

        with pytest.raises(GraniteParseError):
            await _client(handler, harm_criteria=["harm"]).screen("x")

    def test_parse_error_is_a_service_error(self):
        assert issubclass(GraniteParseError, GraniteServiceError)

    def test_model_attribute_exposed(self):
        client = _client(lambda r: httpx.Response(200, json={}), model="granite-x")
        assert client.model == "granite-x"
