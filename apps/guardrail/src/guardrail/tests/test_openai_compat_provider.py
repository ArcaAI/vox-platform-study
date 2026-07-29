from __future__ import annotations

from typing import Any

import httpx
import pytest

from guardrail.core.config import OpenAICompatConfig
from guardrail.providers.openai_compat import (
    OpenAICompatGuardianProvider,
    OpenAICompatProvider,
)


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeChatClient:
    """Records the last POST and returns a canned chat-completion body."""

    def __init__(self, content: str) -> None:
        self.content = content
        self.requests: list[dict[str, Any]] = []

    async def post(
        self, url: str, json: dict[str, Any] | None = None, headers=None, timeout=None
    ) -> _FakeResponse:
        self.requests.append({"url": url, "json": json, "headers": headers})
        return _FakeResponse({"choices": [{"message": {"content": self.content}}]})


class _RaisingClient:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    async def post(self, *args: Any, **kwargs: Any) -> _FakeResponse:
        raise self.exc


def _provider(client: Any, use_granite: bool = True) -> OpenAICompatProvider:
    return OpenAICompatProvider(
        settings=OpenAICompatConfig(),
        http_client=client,  # type: ignore[arg-type]
        use_granite=use_granite,
    )


@pytest.mark.asyncio
async def test_granite_request_shape() -> None:
    client = _FakeChatClient("<score>no</score>")
    provider = _provider(client)

    result = await provider.analyze_content("patient note text", "content_safety")

    assert len(client.requests) == 1
    req = client.requests[0]
    assert req["url"].endswith("/v1/chat/completions")
    assert req["json"]["model"] == "granite-guardian-4.1-8b"
    assert req["json"]["stream"] is False
    assert req["headers"]["Authorization"] == "Bearer lm-studio"

    messages = req["json"]["messages"]
    assert messages[0] == {"role": "assistant", "content": "patient note text"}
    assert messages[-1]["role"] == "user"
    assert "<guardian>" in messages[-1]["content"]
    assert "### Criteria:" in messages[-1]["content"]
    assert "harmful" in messages[-1]["content"]

    assert result["safe"] is True
    assert result["issues"] == []
    assert result["confidence"] == 0.9


@pytest.mark.asyncio
async def test_score_yes_marks_unsafe() -> None:
    provider = _provider(_FakeChatClient("<think>\n</think><score>yes</score>"))

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is False
    assert result["issues"] == ["harmful_content"]
    assert result["confidence"] == 0.9


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("guardrail_type", "issue"),
    [
        ("pii_detection", "pii_detected"),
        ("prompt_injection", "prompt_injection"),
    ],
)
async def test_score_parsing_per_type(guardrail_type: str, issue: str) -> None:
    provider = _provider(_FakeChatClient("<score>yes</score>"))

    result = await provider.analyze_content("text", guardrail_type)

    assert result["safe"] is False
    assert result["issues"] == [issue]


@pytest.mark.asyncio
async def test_unparseable_score_fails_open() -> None:
    provider = _provider(_FakeChatClient("the model rambled without a score tag"))

    result = await provider.analyze_content("text", "prompt_injection")

    assert result["safe"] is True
    assert result["issues"] == ["invalid_response"]
    assert result["confidence"] == 0.0


@pytest.mark.asyncio
async def test_comprehensive_combines_checks() -> None:
    provider = _provider(_FakeChatClient("<score>yes</score>"))

    result = await provider.analyze_content("text", "comprehensive")

    assert result["safe"] is False
    assert set(result["issues"]) == {"harmful_content", "pii_detected", "prompt_injection"}
    assert result["confidence"] == 0.9


@pytest.mark.asyncio
async def test_timeout_fails_open() -> None:
    provider = _provider(_RaisingClient(httpx.TimeoutException("boom")))

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is True
    assert result["issues"] == ["timeout"]
    assert result["error"] == "Request timeout"


@pytest.mark.asyncio
async def test_unexpected_error_fails_open() -> None:
    provider = _provider(_RaisingClient(ValueError("kaboom")))

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is True
    assert result["issues"] == ["error"]
    assert "kaboom" in result["error"]


@pytest.mark.asyncio
async def test_disabled_provider_short_circuits() -> None:
    client = _FakeChatClient("<score>yes</score>")
    provider = OpenAICompatProvider(
        settings=OpenAICompatConfig(enabled=False),
        http_client=client,  # type: ignore[arg-type]
    )

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is True
    assert client.requests == []
    assert "disabled" in result["error"]


@pytest.mark.asyncio
async def test_generic_fallback_uses_plain_prompt() -> None:
    client = _FakeChatClient("UNSAFE")
    provider = _provider(client, use_granite=False)

    result = await provider.analyze_content("text", "content_safety")

    messages = client.requests[0]["json"]["messages"]
    assert messages[0]["role"] == "system"
    assert "<guardian>" not in messages[-1]["content"]
    assert result["safe"] is False
    assert result["issues"] == ["harmful_content"]


@pytest.mark.asyncio
async def test_guardian_parses_json() -> None:
    client = _FakeChatClient(
        '{"is_medical": true, "confidence": 0.92, "context_type": "clinical", "reasoning": "ok"}'
    )
    guardian = OpenAICompatGuardianProvider(
        settings=OpenAICompatConfig(),
        http_client=client,  # type: ignore[arg-type]
    )

    result = await guardian.validate_medical_context("patient presents with chest pain")

    assert client.requests[0]["json"]["response_format"] == {"type": "json_object"}
    assert result["is_medical"] is True
    assert result["confidence"] == 0.92
    assert result["context_type"] == "clinical"


@pytest.mark.asyncio
async def test_guardian_fails_open_on_timeout() -> None:
    guardian = OpenAICompatGuardianProvider(
        settings=OpenAICompatConfig(),
        http_client=_RaisingClient(httpx.TimeoutException("boom")),  # type: ignore[arg-type]
    )

    result = await guardian.validate_medical_context("text")

    assert result["is_medical"] is True
    assert result["error"] == "timeout"
