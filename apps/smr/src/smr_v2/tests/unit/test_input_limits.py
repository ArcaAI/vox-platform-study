"""Tests for input size limits (Task 1.4) and ws_url removal (Task 1.9)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from smr_v2.models.requests import GenerateRequest
from smr_v2.models.responses import StreamingGenerateResponse


# ── Task 1.4: Input Size Limits ──


class TestPromptLimits:
    def test_prompt_within_limit(self):
        req = GenerateRequest(prompt="a" * 1_000)
        assert len(req.prompt) == 1_000

    def test_prompt_at_max_limit(self):
        req = GenerateRequest(prompt="a" * 200_000)
        assert len(req.prompt) == 200_000

    def test_prompt_exceeds_limit(self):
        with pytest.raises(ValidationError) as exc_info:
            GenerateRequest(prompt="a" * 200_001)
        errors = exc_info.value.errors()
        assert any(e["type"] == "string_too_long" for e in errors)

    def test_system_prompt_within_limit(self):
        req = GenerateRequest(prompt="valid", system_prompt="s" * 1_000)
        assert len(req.system_prompt) == 1_000

    def test_system_prompt_at_max_limit(self):
        req = GenerateRequest(prompt="valid", system_prompt="s" * 50_000)
        assert len(req.system_prompt) == 50_000

    def test_system_prompt_exceeds_limit(self):
        with pytest.raises(ValidationError) as exc_info:
            GenerateRequest(prompt="valid", system_prompt="s" * 50_001)
        errors = exc_info.value.errors()
        assert any(e["type"] == "string_too_long" for e in errors)

    def test_system_prompt_none_is_valid(self):
        req = GenerateRequest(prompt="valid", system_prompt=None)
        assert req.system_prompt is None


# ── Task 1.9: Remove ws_url ──


class TestWsUrlRemoved:
    def test_streaming_response_has_no_ws_url(self):
        resp = StreamingGenerateResponse(
            task_id="t1",
            status="running",
            stream_url="/api/v1/tasks/t1/stream",
        )
        assert not hasattr(resp, "ws_url")
        assert "ws_url" not in StreamingGenerateResponse.model_fields

    def test_streaming_response_has_stream_url(self):
        resp = StreamingGenerateResponse(
            task_id="t1",
            status="running",
            stream_url="/api/v1/tasks/t1/stream",
        )
        assert resp.stream_url == "/api/v1/tasks/t1/stream"
