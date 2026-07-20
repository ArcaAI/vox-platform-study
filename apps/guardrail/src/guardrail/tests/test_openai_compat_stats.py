"""per-call generation stats capture on guardrail LLM/judge calls.

Guardrail mirrors the AD-1 ``GenerationStats`` field names locally (it must NOT
import from smr). Stats capture is additive and null-safe: a response missing
``usage`` must still yield a stats object with zeroed counts and no exception.
"""

from __future__ import annotations

from typing import Any

import pytest

from guardrail.core.config import OpenAICompatConfig
from guardrail.providers.openai_compat import (
    OpenAICompatGuardianProvider,
    OpenAICompatProvider,
)
from guardrail.providers.stats import (
    GuardrailCallStats,
    normalize_stop_reason,
    stats_from_openai_response,
)


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeBodyClient:
    """Returns a caller-supplied full chat-completion body."""

    def __init__(self, body: dict[str, Any]) -> None:
        self.body = body
        self.requests: list[dict[str, Any]] = []

    async def post(
        self, url: str, json: dict[str, Any] | None = None, headers=None, timeout=None
    ) -> _FakeResponse:
        self.requests.append({"url": url, "json": json, "headers": headers})
        return _FakeResponse(self.body)


def _granite_body(
    content: str, *, usage: dict[str, Any] | None = None, finish_reason: str | None = None
) -> dict[str, Any]:
    choice: dict[str, Any] = {"message": {"content": content}}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    body: dict[str, Any] = {"choices": [choice]}
    if usage is not None:
        body["usage"] = usage
    return body


def _provider(client: Any, use_granite: bool = True) -> OpenAICompatProvider:
    return OpenAICompatProvider(
        settings=OpenAICompatConfig(),
        http_client=client,  # type: ignore[arg-type]
        use_granite=use_granite,
    )


# --- stats helper (pure) -----------------------------------------------------


def test_normalize_stop_reason_openai_wire() -> None:
    assert normalize_stop_reason("stop") == "stop"
    assert normalize_stop_reason("length") == "length"
    assert normalize_stop_reason("content_filter") == "content_filter"
    assert normalize_stop_reason("tool_calls") == "tool_call"
    assert normalize_stop_reason(None) == "other"
    assert normalize_stop_reason("something-novel") == "other"


def test_stats_from_openai_response_populates_and_normalizes() -> None:
    body = _granite_body(
        "<score>no</score>",
        usage={"prompt_tokens": 40, "completion_tokens": 10, "total_tokens": 50},
        finish_reason="length",
    )
    stats = stats_from_openai_response(
        provider="openai_compat", model="granite-guardian-4.1-8b", data=body, total_ms=200
    )

    assert isinstance(stats, GuardrailCallStats)
    assert stats.stop_reason == "length"
    assert stats.stop_reason_raw == "length"
    assert stats.prompt_tokens == 40
    assert stats.predicted_tokens == 10
    assert stats.total_tokens == 50
    assert stats.provider == "openai_compat"
    assert stats.model == "granite-guardian-4.1-8b"
    assert stats.total_ms == 200
    assert stats.ttft_ms is None
    # 10 predicted tokens / 0.2s decode = 50 tok/s
    assert stats.tokens_per_second == pytest.approx(50.0)


def test_stats_from_openai_response_null_safe_without_usage() -> None:
    body = _granite_body("<score>no</score>")  # no usage, no finish_reason

    stats = stats_from_openai_response(
        provider="openai_compat", model="m", data=body, total_ms=0
    )

    assert stats.stop_reason == "other"
    assert stats.stop_reason_raw == ""
    assert stats.prompt_tokens == 0
    assert stats.predicted_tokens == 0
    assert stats.total_tokens == 0
    assert stats.tokens_per_second is None
    assert stats.engine_native is None


# --- provider integration ----------------------------------------------------


@pytest.mark.asyncio
async def test_granite_result_carries_stats() -> None:
    body = _granite_body(
        "<score>yes</score>",
        usage={"prompt_tokens": 30, "completion_tokens": 5, "total_tokens": 35},
        finish_reason="stop",
    )
    provider = _provider(_FakeBodyClient(body))

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is False
    stats = result["stats"]
    assert stats["stop_reason"] == "stop"
    assert stats["prompt_tokens"] == 30
    assert stats["predicted_tokens"] == 5
    assert stats["total_tokens"] == 35
    assert stats["model"] == "granite-guardian-4.1-8b"


@pytest.mark.asyncio
async def test_generic_result_carries_stats() -> None:
    body = _granite_body(
        "UNSAFE",
        usage={"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13},
        finish_reason="stop",
    )
    provider = _provider(_FakeBodyClient(body), use_granite=False)

    result = await provider.analyze_content("text", "content_safety")

    assert result["issues"] == ["harmful_content"]
    assert result["stats"]["prompt_tokens"] == 12
    assert result["stats"]["stop_reason"] == "stop"


@pytest.mark.asyncio
async def test_analyze_result_stats_null_safe_when_usage_missing() -> None:
    body = _granite_body("<score>no</score>")  # no usage
    provider = _provider(_FakeBodyClient(body))

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is True
    stats = result["stats"]
    assert stats["prompt_tokens"] == 0
    assert stats["predicted_tokens"] == 0
    assert stats["tokens_per_second"] is None


@pytest.mark.asyncio
async def test_guardian_result_carries_stats() -> None:
    body = {
        "choices": [
            {
                "message": {
                    "content": '{"is_medical": true, "confidence": 0.9, '
                    '"context_type": "clinical", "reasoning": "ok"}'
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    }
    guardian = OpenAICompatGuardianProvider(
        settings=OpenAICompatConfig(),
        http_client=_FakeBodyClient(body),  # type: ignore[arg-type]
    )

    result = await guardian.validate_medical_context("patient presents with chest pain")

    assert result["is_medical"] is True
    stats = result["stats"]
    assert stats["prompt_tokens"] == 100
    assert stats["predicted_tokens"] == 20
    assert stats["stop_reason"] == "stop"
    assert stats["model"] == "granite-guardian-4.1-8b"
