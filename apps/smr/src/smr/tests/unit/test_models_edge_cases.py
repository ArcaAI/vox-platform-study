"""Edge case tests for Pydantic models — boundary values, validation, serialization."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from smr.models.provider import ModelInfo, ProviderInfo, RateLimitState
from smr.models.requests import GenerateRequest, RetryConfig
from smr.models.responses import (
    GenerateResponse,
    TaskResponse,
    TokenUsage,
)
from smr.models.stream import StreamChunk
from smr.models.task import TaskState, TaskStatus


class TestGenerateRequestEdgeCases:
    def test_whitespace_only_prompt_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="   ")

    def test_max_tokens_exactly_one(self):
        req = GenerateRequest(prompt="hi", max_tokens=1)
        assert req.max_tokens == 1

    def test_max_tokens_zero_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", max_tokens=0)

    def test_temperature_exactly_zero(self):
        req = GenerateRequest(prompt="hi", temperature=0.0)
        assert req.temperature == 0.0

    def test_temperature_exactly_two(self):
        req = GenerateRequest(prompt="hi", temperature=2.0)
        assert req.temperature == 2.0

    def test_temperature_below_zero_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", temperature=-0.1)

    def test_temperature_above_two_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", temperature=2.1)

    def test_top_p_exactly_zero(self):
        req = GenerateRequest(prompt="hi", top_p=0.0)
        assert req.top_p == 0.0

    def test_top_p_exactly_one(self):
        req = GenerateRequest(prompt="hi", top_p=1.0)
        assert req.top_p == 1.0

    def test_top_p_above_one_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", top_p=1.1)

    def test_top_p_below_zero_rejected(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", top_p=-0.01)

    def test_default_retry_config_embedded(self):
        req = GenerateRequest(prompt="hi")
        assert req.retry_config.max_retries == 3
        assert "timeout" in req.retry_config.retry_on

    def test_custom_retry_config(self):
        req = GenerateRequest(prompt="hi", retry_config=RetryConfig(max_retries=0, retry_on=[]))
        assert req.retry_config.max_retries == 0

    def test_context_none_by_default(self):
        req = GenerateRequest(prompt="hi")
        assert req.context is None

    def test_context_accepts_nested_dict(self):
        req = GenerateRequest(prompt="hi", context={"a": {"b": [1, 2, 3]}})
        assert req.context["a"]["b"] == [1, 2, 3]

    def test_provider_defaults_to_lm_studio(self):
        req = GenerateRequest(prompt="hi")
        assert req.provider == "lm-studio"

    def test_model_none_by_default(self):
        req = GenerateRequest(prompt="hi")
        assert req.model is None

    def test_serializes_to_json(self):
        req = GenerateRequest(prompt="hi", temperature=0.5)
        j = req.model_dump_json()
        assert '"prompt":"hi"' in j or '"prompt": "hi"' in j


class TestTaskStateEdgeCases:
    def test_all_statuses_serializable(self):
        for status in TaskStatus:
            state = TaskState(task_id="t", status=status, provider="p", model="m")
            d = state.model_dump()
            assert d["status"] == status.value

    def test_roundtrip_json(self):
        state = TaskState(task_id="t", status=TaskStatus.RUNNING, provider="p", model="m", retry_count=2, error="oops")
        j = state.model_dump_json()
        restored = TaskState.model_validate_json(j)
        assert restored.task_id == "t"
        assert restored.error == "oops"
        assert restored.retry_count == 2


class TestTokenUsageEdgeCases:
    def test_large_values(self):
        u = TokenUsage(prompt_tokens=1_000_000, completion_tokens=500_000, total_tokens=1_500_000)
        assert u.total_tokens == 1_500_000

    def test_serialization(self):
        u = TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        d = u.model_dump()
        assert d == {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}


class TestStreamChunkEdgeCases:
    def test_error_chunk(self):
        c = StreamChunk(type="error", data={"error": "connection refused"})
        assert c.type == "error"
        assert c.data["error"] == "connection refused"

    def test_chunk_with_no_content(self):
        c = StreamChunk(type="chunk", content=None)
        assert c.content is None

    def test_invalid_type_rejected(self):
        with pytest.raises(ValidationError):
            StreamChunk(type="invalid")

    def test_json_roundtrip(self):
        c = StreamChunk(type="chunk", content="hello")
        j = c.model_dump_json()
        restored = StreamChunk.model_validate_json(j)
        assert restored.content == "hello"


class TestProviderInfoEdgeCases:
    def test_empty_models_list(self):
        p = ProviderInfo(name="x", display_name="X", default_model="m", models=[])
        assert len(p.models) == 0

    def test_model_info_optional_context_window(self):
        m = ModelInfo(name="m")
        assert m.context_window is None

    def test_model_info_with_context_window(self):
        m = ModelInfo(name="m", context_window=128000)
        assert m.context_window == 128000


class TestRateLimitStateEdgeCases:
    def test_all_zeros(self):
        s = RateLimitState(provider="p")
        assert s.rpm_limit == 0
        assert s.tpm_limit == 0
        assert s.is_rate_limited is False
        assert s.retry_after_seconds is None

    def test_serialization_roundtrip(self):
        s = RateLimitState(provider="azure", rpm_limit=100, tpm_limit=50000, is_rate_limited=True, retry_after_seconds=30.0)
        j = s.model_dump_json()
        restored = RateLimitState.model_validate_json(j)
        assert restored.is_rate_limited is True
        assert restored.retry_after_seconds == 30.0


class TestGenerateResponseEdgeCases:
    def test_empty_content(self):
        r = GenerateResponse(task_id="t", status="completed", content="", provider="p", model="m")
        assert r.content == ""

    def test_with_usage(self):
        r = GenerateResponse(
            task_id="t", status="completed", content="hi", provider="p", model="m",
            usage=TokenUsage(prompt_tokens=5, completion_tokens=1, total_tokens=6)
        )
        assert r.usage.total_tokens == 6


class TestTaskResponseEdgeCases:
    def test_with_content_and_error(self):
        r = TaskResponse(task_id="t", status="failed", provider="p", model="m", error="boom", content="partial")
        assert r.error == "boom"
        assert r.content == "partial"

    def test_default_timestamps_none(self):
        r = TaskResponse(task_id="t", status="pending", provider="p", model="m")
        assert r.started_at is None
        assert r.completed_at is None
