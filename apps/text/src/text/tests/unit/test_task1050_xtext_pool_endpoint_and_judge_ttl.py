"""TASK-1050 follow-ups L and M.

L — pool health is keyed to the endpoint it was observed on: a request resolved to a
DIFFERENT endpoint is not refused on the old endpoint's verdict.
M — the internal judge route never sends LM Studio's JIT ``ttl`` (judge residency is
managed explicitly on /model-residency); ordinary generation keeps it.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from text.core.exceptions import PoolUnhealthyError
from text.models.requests import GenerateRequest
from text.services.judge_guard import judge_scope
from text.services.pool_health import PoolHealthTracker
from text.services.pool_router import resolve_pool_route
from text.tests.conftest import stub_client

OLD = "http://hope-lmstudio:1234/v1"
NEW = "http://localhost:1234/v1"


class TestPoolHealthIsEndpointScoped:
    def test_unhealthy_on_old_endpoint_is_unknown_on_new(self):
        tracker = PoolHealthTracker()
        tracker.record("lm-studio", False, endpoint=OLD)
        assert tracker.is_healthy("lm-studio", endpoint=OLD) is False
        assert tracker.is_healthy("lm-studio", endpoint=NEW) is None

    def test_route_not_refused_when_request_endpoint_differs(self):
        tracker = PoolHealthTracker()
        tracker.record("lm-studio", False, endpoint=OLD)
        assert resolve_pool_route("lm-studio", tracker=tracker, endpoint=NEW) == "lm-studio"

    def test_route_still_refused_on_the_same_endpoint(self):
        tracker = PoolHealthTracker()
        tracker.record("lm-studio", False, endpoint=OLD)
        with pytest.raises(PoolUnhealthyError):
            resolve_pool_route("lm-studio", tracker=tracker, endpoint=OLD)

    def test_unscoped_record_still_applies_to_every_endpoint(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        assert tracker.is_healthy("ollama", endpoint=NEW) is False


def _completion() -> MagicMock:
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
    return resp


class TestJudgeCallsSendNoJitTtl:
    @pytest.mark.asyncio
    async def test_judge_scope_omits_ttl(self):
        from text.providers.lmstudio import LMStudioProvider

        provider = LMStudioProvider()
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        with judge_scope():
            await provider.generate(GenerateRequest(prompt="hi", model="m", provider="lm-studio"))

        assert "ttl" not in (create.await_args.kwargs.get("extra_body") or {})

    @pytest.mark.asyncio
    async def test_ordinary_generation_keeps_ttl(self):
        from text.providers.lmstudio import LMStudioProvider

        provider = LMStudioProvider()
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="lm-studio"))

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900}
