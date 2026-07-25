"""TDD tests for smr Pydantic models.

Written BEFORE implementation — these must fail first (RED),
then we write minimal code to make them pass (GREEN).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

# ── TaskStatus enum ──


class TestTaskStatus:
    def test_has_pending_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.PENDING == "pending"

    def test_has_running_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.RUNNING == "running"

    def test_has_completed_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.COMPLETED == "completed"

    def test_has_failed_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.FAILED == "failed"

    def test_has_cancelled_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.CANCELLED == "cancelled"

    def test_has_retrying_state(self):
        from smr.models.task import TaskStatus
        assert TaskStatus.RETRYING == "retrying"


# ── TaskState model ──


class TestTaskState:
    def test_create_minimal_task_state(self):
        from smr.models.task import TaskState, TaskStatus
        state = TaskState(task_id="abc-123", status=TaskStatus.PENDING, provider="ollama", model="llama3.2:latest")
        assert state.task_id == "abc-123"
        assert state.status == TaskStatus.PENDING
        assert state.retry_count == 0
        assert state.max_retries == 3

    def test_task_state_defaults(self):
        from smr.models.task import TaskState, TaskStatus
        state = TaskState(task_id="t1", status=TaskStatus.RUNNING, provider="ollama", model="m")
        assert state.error is None
        assert state.total_chunks == 0
        assert state.total_tokens == 0
        assert state.created_at is not None

    def test_task_state_serializes_to_dict(self):
        from smr.models.task import TaskState, TaskStatus
        state = TaskState(task_id="t1", status=TaskStatus.PENDING, provider="ollama", model="m")
        d = state.model_dump()
        assert d["task_id"] == "t1"
        assert d["status"] == "pending"


# ── TokenUsage model ──


class TestTokenUsage:
    def test_create_token_usage(self):
        from smr.models.responses import TokenUsage
        usage = TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        assert usage.total_tokens == 30

    def test_token_usage_defaults_to_zero(self):
        from smr.models.responses import TokenUsage
        usage = TokenUsage()
        assert usage.prompt_tokens == 0
        assert usage.completion_tokens == 0
        assert usage.total_tokens == 0


# ── RetryConfig model ──


class TestRetryConfig:
    def test_default_retry_config(self):
        from smr.models.requests import RetryConfig
        cfg = RetryConfig()
        assert cfg.max_retries == 3
        assert "timeout" in cfg.retry_on
        assert "provider_error" in cfg.retry_on

    def test_custom_retry_config(self):
        from smr.models.requests import RetryConfig
        cfg = RetryConfig(max_retries=5, retry_on=["timeout"])
        assert cfg.max_retries == 5
        assert cfg.retry_on == ["timeout"]


# ── GenerateRequest model ──


class TestGenerateRequest:
    def test_minimal_request(self):
        from smr.models.requests import GenerateRequest
        req = GenerateRequest(prompt="Hello world")
        assert req.prompt == "Hello world"
        assert req.provider == "lm-studio"
        assert req.temperature is None
        assert req.max_tokens is None
        assert req.top_p is None
        assert req.response_format is None
        assert req.stream is False

    def test_full_request(self):
        from smr.models.requests import GenerateRequest
        req = GenerateRequest(
            prompt="Summarize this",
            system_prompt="You are helpful",
            provider="azure_openai",
            model="gpt-4",
            temperature=0.3,
            max_tokens=2048,
            top_p=0.9,
            stream=True,
            context={"department": "cardiology"},
        )
        assert req.system_prompt == "You are helpful"
        assert req.provider == "azure_openai"
        assert req.model == "gpt-4"
        assert req.stream is True
        assert req.context["department"] == "cardiology"

    def test_empty_prompt_rejected(self):
        from smr.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="")

    def test_negative_max_tokens_rejected(self):
        from smr.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", max_tokens=-1)

    def test_temperature_out_of_range_rejected(self):
        from smr.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hi", temperature=3.0)


# ── GenerateResponse model ──


class TestGenerateResponse:
    def test_non_streaming_response(self):
        from smr.models.responses import GenerateResponse
        resp = GenerateResponse(
            task_id="t1",
            status="completed",
            content="Hello!",
            provider="ollama",
            model="llama3.2:latest",
            latency_ms=100,
            finish_reason="stop",
        )
        assert resp.content == "Hello!"
        assert resp.task_id == "t1"

    def test_streaming_response_has_urls(self):
        from smr.models.responses import StreamingGenerateResponse
        resp = StreamingGenerateResponse(
            task_id="t1",
            status="running",
            stream_url="/api/v1/tasks/t1/stream",
        )
        assert resp.stream_url.endswith("/stream")
        assert "ws_url" not in StreamingGenerateResponse.model_fields


# ── TaskResponse model ──


class TestTaskResponse:
    def test_task_response_fields(self):
        from smr.models.responses import TaskResponse
        resp = TaskResponse(
            task_id="t1",
            status="running",
            provider="bedrock",
            model="claude-3",
            retry_count=0,
            max_retries=3,
        )
        assert resp.task_id == "t1"
        assert resp.status == "running"


# ── StreamChunk model ──


class TestStreamChunk:
    def test_text_chunk(self):
        from smr.models.stream import StreamChunk
        chunk = StreamChunk(type="chunk", content="Hello")
        assert chunk.type == "chunk"
        assert chunk.content == "Hello"

    def test_meta_chunk(self):
        from smr.models.stream import StreamChunk
        chunk = StreamChunk(type="meta", data={"provider": "ollama"})
        assert chunk.type == "meta"
        assert chunk.data["provider"] == "ollama"

    def test_done_chunk(self):
        from smr.models.stream import StreamChunk
        chunk = StreamChunk(type="done", data={"finish_reason": "stop"})
        assert chunk.data["finish_reason"] == "stop"

    def test_usage_chunk(self):
        from smr.models.stream import StreamChunk
        chunk = StreamChunk(type="usage", data={"prompt_tokens": 10, "total_tokens": 30})
        assert chunk.data["total_tokens"] == 30


# ── ProviderInfo / ModelInfo ──


class TestProviderModels:
    def test_model_info(self):
        from smr.models.provider import ModelInfo
        m = ModelInfo(name="llama3.2:latest", supports_streaming=True)
        assert m.name == "llama3.2:latest"

    def test_provider_info(self):
        from smr.models.provider import ModelInfo, ProviderInfo
        p = ProviderInfo(
            name="ollama",
            display_name="Ollama (Self-Hosted)",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest", supports_streaming=True)],
            supports_streaming=True,
        )
        assert p.name == "ollama"
        assert len(p.models) == 1

    def test_provider_info_unavailable(self):
        from smr.models.provider import ProviderInfo
        p = ProviderInfo(
            name="bedrock",
            display_name="AWS Bedrock",
            status="unavailable",
            default_model="claude-3",
            models=[],
            supports_streaming=True,
        )
        assert p.status == "unavailable"


# ── RateLimitState model ──


class TestRateLimitState:
    def test_rate_limit_state(self):
        from smr.models.provider import RateLimitState
        state = RateLimitState(
            provider="azure_openai",
            rpm_limit=480,
            rpm_remaining=400,
            rpm_reset_seconds=10.0,
            tpm_limit=80000,
            tpm_remaining=60000,
            tpm_reset_seconds=45.0,
            is_rate_limited=False,
        )
        assert state.rpm_remaining == 400
        assert not state.is_rate_limited

    def test_rate_limit_state_when_limited(self):
        from smr.models.provider import RateLimitState
        state = RateLimitState(
            provider="bedrock",
            rpm_limit=100,
            rpm_remaining=0,
            rpm_reset_seconds=30.0,
            tpm_limit=100000,
            tpm_remaining=0,
            tpm_reset_seconds=60.0,
            is_rate_limited=True,
            retry_after_seconds=30.0,
        )
        assert state.is_rate_limited
        assert state.retry_after_seconds == 30.0
