"""TDD tests for OllamaProvider.

Tests mock httpx responses to avoid requiring a running Ollama instance.
RED: Written before implementation.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from text.core.config import OllamaConfig
from text.models.requests import GenerateRequest


@pytest.fixture
def ollama_config():
    return OllamaConfig(base_url="http://localhost:11434", default_model="llama3.2:latest")


@pytest.fixture
def mock_http_client():
    return AsyncMock(spec=httpx.AsyncClient)


# ── OllamaProvider init ──


class TestOllamaProviderInit:
    def test_creates_with_config(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        assert provider is not None

    def test_default_model_from_config(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        assert provider._default_model == "llama3.2:latest"


# ── generate (non-streaming) ──


class TestOllamaGenerate:
    @pytest.mark.asyncio
    async def test_generate_returns_text(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        response_data = {"model": "llama3.2:latest", "response": "Hello there!", "done": True}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = response_data
        mock_response.raise_for_status = MagicMock()
        mock_http_client.post.return_value = mock_response

        from text.models.stats import GenerationStats

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        content, _reasoning, stats = await provider.generate(GenerateRequest(prompt="hi"))
        assert content == "Hello there!"
        assert isinstance(stats, GenerationStats)

    @pytest.mark.asyncio
    async def test_generate_uses_correct_endpoint(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "ok", "done": True}
        mock_response.raise_for_status = MagicMock()
        mock_http_client.post.return_value = mock_response

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        await provider.generate(GenerateRequest(prompt="hi"))

        call_args = mock_http_client.post.call_args
        assert "/api/generate" in call_args[0][0] or "/api/generate" in str(call_args)

    @pytest.mark.asyncio
    async def test_generate_sends_model_and_prompt(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "ok", "done": True}
        mock_response.raise_for_status = MagicMock()
        mock_http_client.post.return_value = mock_response

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        await provider.generate(GenerateRequest(prompt="tell me a joke", model="llama3.2:latest"))

        call_kwargs = mock_http_client.post.call_args
        body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        assert body["prompt"] == "tell me a joke"
        assert body["model"] == "llama3.2:latest"

    @pytest.mark.asyncio
    async def test_generate_raises_on_http_error(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error", request=MagicMock(), response=mock_response
        )
        mock_http_client.post.return_value = mock_response

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        with pytest.raises(httpx.HTTPStatusError):
            await provider.generate(GenerateRequest(prompt="hi"))


# ── generate_stream ──


class TestOllamaGenerateStream:
    @pytest.mark.asyncio
    async def test_stream_yields_chunks(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        _raw_lines = [
            json.dumps({"response": "Hello", "done": False}).encode() + b"\n",
            json.dumps({"response": " world", "done": False}).encode() + b"\n",
            json.dumps({"response": "", "done": True}).encode() + b"\n",
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        def _aiter_lines():
            return _async_iter(
                [
                    json.dumps({"response": "Hello", "done": False}),
                    json.dumps({"response": " world", "done": False}),
                    json.dumps({"response": "", "done": True}),
                ]
            )

        mock_response.aiter_lines = _aiter_lines

        mock_http_client.stream = _mock_stream_context(mock_response)

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        chunks = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
            chunks.append(chunk)

        text_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(text_chunks) >= 2
        assert text_chunks[0].content == "Hello"
        assert text_chunks[1].content == " world"

    @pytest.mark.asyncio
    async def test_stream_requests_thinking(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        def _aiter_lines():
            return _async_iter(
                [
                    json.dumps({"response": "", "done": True}),
                ]
            )

        mock_response.aiter_lines = _aiter_lines
        mock_http_client.stream = _mock_stream_context(mock_response)

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        captured = {}
        original_stream = mock_http_client.stream

        def _capturing_stream(*args, **kwargs):
            captured["kwargs"] = kwargs
            return original_stream(*args, **kwargs)

        mock_http_client.stream = _capturing_stream
        async for _ in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
            pass

        assert captured["kwargs"]["json"]["think"] is True

    @pytest.mark.asyncio
    async def test_stream_yields_reasoning_chunks_from_thinking_field(
        self, ollama_config, mock_http_client
    ):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        def _aiter_lines():
            return _async_iter(
                [
                    json.dumps({"thinking": "Let me think", "response": "", "done": False}),
                    json.dumps({"thinking": "", "response": "Answer", "done": False}),
                    json.dumps({"response": "", "done": True}),
                ]
            )

        mock_response.aiter_lines = _aiter_lines
        mock_http_client.stream = _mock_stream_context(mock_response)

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        chunks = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
            chunks.append(chunk)

        reasoning_chunks = [c for c in chunks if c.type == "reasoning"]
        content_chunks = [c for c in chunks if c.type == "chunk"]
        assert len(reasoning_chunks) == 1
        assert reasoning_chunks[0].content == "Let me think"
        assert len(content_chunks) == 1
        assert content_chunks[0].content == "Answer"

    @pytest.mark.asyncio
    async def test_stream_parses_inline_think_tags_when_no_native_thinking_field(
        self, ollama_config, mock_http_client
    ):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        def _aiter_lines():
            return _async_iter(
                [
                    json.dumps({"response": "<think>", "done": False}),
                    json.dumps({"response": "Let me ", "done": False}),
                    json.dumps({"response": "think", "done": False}),
                    json.dumps({"response": "</think>", "done": False}),
                    json.dumps({"response": "Answer", "done": False}),
                    json.dumps({"response": "", "done": True}),
                ]
            )

        mock_response.aiter_lines = _aiter_lines
        mock_http_client.stream = _mock_stream_context(mock_response)

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        chunks = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
            chunks.append(chunk)

        reasoning_chunks = [c for c in chunks if c.type == "reasoning"]
        content_chunks = [c for c in chunks if c.type == "chunk"]
        assert "".join(c.content for c in reasoning_chunks) == "Let me think"
        assert "".join(c.content for c in content_chunks) == "Answer"

    @pytest.mark.asyncio
    async def test_stream_ends_with_done(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        def _aiter_lines():
            return _async_iter(
                [
                    json.dumps({"response": "Hi", "done": False}),
                    json.dumps({"response": "", "done": True}),
                ]
            )

        mock_response.aiter_lines = _aiter_lines
        mock_http_client.stream = _mock_stream_context(mock_response)

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        chunks = []
        async for chunk in provider.generate_stream(GenerateRequest(prompt="hi", stream=True)):
            chunks.append(chunk)

        done_chunks = [c for c in chunks if c.type == "done"]
        assert len(done_chunks) == 1


# ── health_check ──


class TestOllamaHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_returns_true_when_up(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_http_client.get.return_value = mock_response

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_returns_false_when_down(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_http_client.get.side_effect = httpx.ConnectError("Connection refused")

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        assert await provider.health_check() is False


# ── get_info ──


class TestOllamaGetInfo:
    @pytest.mark.asyncio
    async def test_get_info_returns_provider_info(self, ollama_config, mock_http_client):
        from text.providers.ollama import OllamaProvider

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"models": [{"name": "llama3.2:latest"}]}
        mock_http_client.get.return_value = mock_response

        provider = OllamaProvider(config=ollama_config, http_client=mock_http_client)
        info = await provider.get_info()
        assert info.name == "ollama"
        assert info.supports_streaming is True


# ── Helpers ──


async def _async_iter(items):
    for item in items:
        yield item


def _mock_stream_context(mock_response):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _stream(*args, **kwargs):
        yield mock_response

    return _stream
