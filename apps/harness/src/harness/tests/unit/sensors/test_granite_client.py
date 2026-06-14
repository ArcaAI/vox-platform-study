"""Granite Guardian client tests (TASK-337 Phase B — OpenAI-compatible engine).

The safety sensor screens the generated note through IBM Granite Guardian. By
default the engine is **LM Studio** (OpenAI-compatible): the client posts the
canonical 4.1 ``<guardian>`` BYOC block — one no-think call per harm dimension —
to ``{base_url}/chat/completions`` (the note-to-judge is the ``assistant`` message,
the ``<guardian>`` block the final ``user`` message) and reads the verdict from
``choices[0].message.content``. With ``provider="ollama"`` it falls back to the
native ``/api/chat`` (reading ``message.content``). ``<score>yes</score>`` means
the criterion is met => the risk IS present => unsafe. A transport error raises
:class:`GraniteServiceError`; an unparseable verdict raises
:class:`GraniteParseError` (so the sensor degrades rather than guessing). Mirrors
the stubbed-``httpx.MockTransport`` style of ``services/test_api_client``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.core.config import SafetyGuardConfig
from harness.sensors.inferential.granite_client import (
    GraniteGuardianClient,
    GraniteParseError,
    GraniteServiceError,
)


def _cfg(**overrides) -> SafetyGuardConfig:
    base: dict[str, Any] = {
        "enabled": True,
        "provider": "lm-studio",
        "base_url": "http://lmstudio:1234/v1",
        "model": "granite-test",
        "no_think": True,
        "timeout_s": 5.0,
        "harm_criteria": ["harm", "violence"],
    }
    base.update(overrides)
    return SafetyGuardConfig(**base)


def _client(handler, **overrides) -> GraniteGuardianClient:
    return GraniteGuardianClient(_cfg(**overrides), transport=httpx.MockTransport(handler))


def _openai_response(verdict: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"role": "assistant", "content": f"<score>{verdict}</score>"}}]},
    )


class TestScreen:
    @pytest.mark.asyncio
    async def test_one_chat_call_per_criterion_parses_scores(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            block = json.loads(request.content)["messages"][-1]["content"]
            verdict = "yes" if "violence" in block else "no"
            return _openai_response(verdict)

        dims = await _client(handler).screen("patient note text")

        assert dims == {"harm": False, "violence": True}
        assert len(seen) == 2, "one screen call per harm dimension"
        # OpenAI-compatible transport: POST {base_url}/chat/completions.
        assert str(seen[0].url) == "http://lmstudio:1234/v1/chat/completions"
        body0 = json.loads(seen[0].content)
        assert body0["model"] == "granite-test"
        assert body0["stream"] is False
        assert body0["temperature"] == 0.0
        # The note-to-judge is the assistant message; the guardian block the last user message.
        assert body0["messages"][0]["role"] == "assistant"
        assert body0["messages"][0]["content"] == "patient note text"
        assert body0["messages"][-1]["role"] == "user"
        assert "<guardian>" in body0["messages"][-1]["content"]

    @pytest.mark.asyncio
    async def test_canonical_byoc_block_present(self):
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["block"] = json.loads(request.content)["messages"][-1]["content"]
            return _openai_response("no")

        await _client(handler, harm_criteria=["social_bias"]).screen("x")
        block = captured["block"]
        # Canonical 4.1 no-think BYOC structure.
        assert "<guardian><no-think>" in block
        assert "### Criteria:" in block
        assert "### Scoring Schema:" in block
        # The underscored dimension is humanised into the criterion text.
        assert "social bias" in block

    @pytest.mark.asyncio
    async def test_thinking_mode_omits_no_think_tag(self):
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["block"] = json.loads(request.content)["messages"][-1]["content"]
            return _openai_response("no")

        await _client(handler, harm_criteria=["harm"], no_think=False).screen("x")
        assert "<no-think>" not in captured["block"]
        assert "<guardian>" in captured["block"]

    @pytest.mark.asyncio
    async def test_ollama_provider_uses_native_api_chat(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"message": {"content": "<score>yes</score>"}})

        dims = await _client(
            handler,
            provider="ollama",
            base_url="http://granite:11434",
            harm_criteria=["harm"],
        ).screen("patient note text")

        assert dims == {"harm": True}
        # Legacy Ollama transport: POST {base_url}/api/chat, temperature under options.
        assert str(seen[0].url) == "http://granite:11434/api/chat"
        body0 = json.loads(seen[0].content)
        assert body0["options"]["temperature"] == 0.0
        assert "temperature" not in body0
        assert body0["messages"][0]["content"] == "patient note text"
        assert "<guardian>" in body0["messages"][-1]["content"]

    @pytest.mark.asyncio
    async def test_parallel_screen_keeps_criteria_order_and_mapping(self):
        # TASK-355 R-4: screen() now fans the criteria out via asyncio.gather; the
        # result dict must stay byte-identical to the serial version — same per-criterion
        # verdicts AND same key order (criteria order), independent of completion order.
        def handler(request: httpx.Request) -> httpx.Response:
            block = json.loads(request.content)["messages"][-1]["content"]
            verdict = "yes" if "violence" in block else "no"
            return _openai_response(verdict)

        dims = await _client(handler, harm_criteria=["harm", "social_bias", "violence"]).screen("x")
        assert dims == {"harm": False, "social_bias": False, "violence": True}
        assert list(dims.keys()) == ["harm", "social_bias", "violence"]

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
    async def test_terminated_400_is_retried_via_governor(self, monkeypatch):
        # The guardian shares the LM Studio box with the judge: a burst-induced
        # 'terminated' 400 must be retried (governor) so the safety screen recovers
        # instead of degrading. (Governor retry is neutralised suite-wide, so enable
        # it explicitly for this case.)
        from harness.core.llm_concurrency import reset_endpoint_limiters

        monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "3")
        monkeypatch.setenv("HARNESS_LLM_BACKOFF_BASE_S", "0")
        monkeypatch.setenv("HARNESS_LLM_BACKOFF_JITTER_S", "0")
        reset_endpoint_limiters()
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(400, json={"error": "terminated"})
            return _openai_response("no")

        result = await _client(handler, harm_criteria=["harm"]).screen("x")
        assert calls["n"] == 2  # retried the terminated 400, then succeeded
        assert result == {"harm": False}

    @pytest.mark.asyncio
    async def test_missing_score_tag_raises_parse_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"choices": [{"message": {"content": "It seems fine to me."}}]}
            )

        with pytest.raises(GraniteParseError):
            await _client(handler, harm_criteria=["harm"]).screen("x")

    @pytest.mark.asyncio
    async def test_empty_choices_raises_parse_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": []})

        with pytest.raises(GraniteParseError):
            await _client(handler, harm_criteria=["harm"]).screen("x")

    def test_parse_error_is_a_service_error(self):
        assert issubclass(GraniteParseError, GraniteServiceError)

    def test_model_attribute_exposed(self):
        client = _client(lambda r: _openai_response("no"), model="granite-x")
        assert client.model == "granite-x"
