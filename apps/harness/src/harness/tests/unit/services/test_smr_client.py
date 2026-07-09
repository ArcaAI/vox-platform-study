"""Tests for the SMR tool client (POST /api/v1/generate, stream:false).

RED-first: written before ``harness.services.smr_client`` exists. The client
must always send ``stream:false``, pass the SOAP ``response_format`` through
untouched, omit unset optional hyperparameters, and parse the SMR
``GenerateResponse`` (content/model/usage/latency_ms/finish_reason).
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from harness.services.smr_client import SmrClient, SmrServiceError


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


class TestGenerateLostResponseNoReinvoke:
    """C1-04 (TASK-458): a lost response AFTER the request was delivered (the model
    may have run) must NOT be re-POSTed by the endpoint governor — a re-send is a
    second, divergent generation (double LLM spend). Only PRE-send failures retry."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "exc_factory",
        [
            lambda req: httpx.ReadTimeout("read timed out", request=req),
            lambda req: httpx.ReadError("connection lost", request=req),
            lambda req: httpx.RemoteProtocolError("server disconnected", request=req),
        ],
    )
    async def test_post_send_failure_is_not_retried(self, exc_factory, monkeypatch):
        # Budget several attempts so — WITHOUT the fix — the transient-classified read
        # failure would be re-sent up to max_attempts. The fix must cap it at ONE call.
        monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "4")
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            raise exc_factory(request)

        client = SmrClient("http://smr-c104:8862", transport=httpx.MockTransport(handler))
        with pytest.raises(SmrServiceError) as ei:
            await client.generate(prompt="Summarize the consult.")
        # The prompt reached the model EXACTLY once — never re-invoked.
        assert calls["n"] == 1
        # The error is tagged as a post-send failure so the activity can mark the
        # Temporal retry non-retryable too (belt-and-braces against a re-run).
        assert ei.value.after_send is True

    @pytest.mark.asyncio
    async def test_pre_send_connect_failure_still_retries(self, monkeypatch):
        # A pre-send failure (never reached the model) is safe to retry — the model
        # did not run, so a re-send cannot double-generate. Retries stay intact.
        monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "3")
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            raise httpx.ConnectError("connection refused", request=request)

        client = SmrClient("http://smr-c104b:8862", transport=httpx.MockTransport(handler))
        with pytest.raises(SmrServiceError) as ei:
            await client.generate(prompt="hi")
        assert calls["n"] == 3  # retried to the budget (pre-send is safe)
        assert ei.value.after_send is False

    @pytest.mark.asyncio
    async def test_governor_per_call_timeout_is_not_retried(self, monkeypatch):
        """I-1 (TASK-458): the governor's per-call ``asyncio.timeout`` firing WHILE the
        model runs (post-send) must NOT re-POST. Budget several attempts + a tiny per-call
        timeout so, without the fix, the builtin ``TimeoutError`` is classified transient
        and re-invokes the model up to ``max_attempts``. The fix caps it at ONE call."""
        monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "5")
        # Per-call timeout well below the handler's hang so the governor timeout wins.
        monkeypatch.setenv("HARNESS_LLM_REQUEST_TIMEOUT_S", "0.05")
        calls = {"n": 0}

        async def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1  # the prompt reached the model (once per invocation)
            await asyncio.sleep(0.5)  # hang past the 0.05s per-call timeout
            return httpx.Response(200, json={"content": "{}"})

        client = SmrClient("http://smr-c104c:8862", transport=httpx.MockTransport(handler))
        with pytest.raises((SmrServiceError, TimeoutError)) as ei:
            await client.generate(prompt="Summarize the consult.")
        # The model was invoked EXACTLY once — the per-call timeout is not re-issued.
        assert calls["n"] == 1
        # Surfaces as a non-retryable post-send SMR failure (so the activity marks the
        # Temporal retry non-retryable too), NOT a bare retryable TimeoutError.
        assert isinstance(ei.value, SmrServiceError)
        assert ei.value.after_send is True
