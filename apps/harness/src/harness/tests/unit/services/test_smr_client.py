"""Tests for the SMR tool client (POST /api/v1/generate, stream:false).

RED-first: written before ``harness.services.smr_client`` exists. The client
must always send ``stream:false``, pass the SOAP ``response_format`` through
untouched, omit unset optional hyperparameters, and parse the SMR
``GenerateResponse`` (content/model/usage/latency_ms/finish_reason).
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.services.smr_client import SmrClient


def _capture(content: str = '{"subjective": "ok"}'):
    seen: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(
            200,
            json={
                "task_id": "t-1",
                "status": "completed",
                "content": content,
                "provider": "azure-openai",
                "model": "gpt-4o",
                "usage": {"prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40},
                "latency_ms": 1234,
                "finish_reason": "stop",
            },
        )

    return seen, handler


class TestSmrClient:
    @pytest.mark.asyncio
    async def test_generate_posts_stream_false_and_passes_response_format(self):
        seen, handler = _capture()
        client = SmrClient("http://smr:8862", transport=httpx.MockTransport(handler))
        response_format = {
            "type": "json_schema",
            "json_schema": {"type": "object", "properties": {"subjective": {"type": "string"}}},
            "strict": True,
        }

        await client.generate(
            prompt="Summarize the consult.",
            system_prompt="You are a clinical scribe.",
            response_format=response_format,
            temperature=0.1,
            max_tokens=512,
        )

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://smr:8862/api/v1/generate"
        body = json.loads(req.content)
        assert body["stream"] is False
        assert body["prompt"] == "Summarize the consult."
        assert body["system_prompt"] == "You are a clinical scribe."
        assert body["response_format"] == response_format
        assert body["temperature"] == 0.1
        assert body["max_tokens"] == 512
        # Unset optionals are omitted (server applies its own defaults).
        assert "top_p" not in body
        assert "model" not in body

    @pytest.mark.asyncio
    async def test_generate_parses_response(self):
        _seen, handler = _capture(content='{"subjective": "Patient reports cough."}')
        client = SmrClient("http://smr:8862", transport=httpx.MockTransport(handler))

        result = await client.generate(prompt="hi")

        assert result.content == '{"subjective": "Patient reports cough."}'
        assert result.model == "gpt-4o"
        assert result.provider == "azure-openai"
        assert result.usage["total_tokens"] == 40
        assert result.latency_ms == 1234
        assert result.finish_reason == "stop"

    @pytest.mark.asyncio
    async def test_generate_includes_provider_and_model_when_set(self):
        seen, handler = _capture()
        client = SmrClient("http://smr:8862", transport=httpx.MockTransport(handler))

        await client.generate(prompt="hi", provider="azure-openai", model="gpt-4o", top_p=0.9)

        body = json.loads(seen["request"].content)
        assert body["provider"] == "azure-openai"
        assert body["model"] == "gpt-4o"
        assert body["top_p"] == 0.9
