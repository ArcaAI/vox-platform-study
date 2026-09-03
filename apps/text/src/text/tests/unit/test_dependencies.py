"""Tests for core/dependencies.py — DI functions that read from app.state.

Every provider is `async def` : a sync `Depends` callable is
dispatched to anyio's worker threadpool by `solve_dependencies`, one handoff per
request per dependency. These tests therefore await — the asserted VALUE is
unchanged, only the call protocol is.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from text.core.dependencies import (
    get_http_client,
    get_provider_registry,
    get_redis,
    get_settings,
    get_task_manager,
)


def _make_request(**state_attrs):
    """Build a mock Request whose app.state has the given attributes."""
    request = MagicMock()
    for k, v in state_attrs.items():
        setattr(request.app.state, k, v)
    return request


class TestGetSettings:
    async def test_returns_settings_from_state(self):
        sentinel = object()
        req = _make_request(settings=sentinel)
        assert await get_settings(req) is sentinel


class TestGetHttpClient:
    async def test_returns_http_client_from_state(self):
        sentinel = object()
        req = _make_request(http_client=sentinel)
        assert await get_http_client(req) is sentinel


class TestGetRedis:
    async def test_returns_redis_from_state(self):
        sentinel = object()
        req = _make_request(redis=sentinel)
        assert await get_redis(req) is sentinel


class TestGetProviderRegistry:
    async def test_returns_registry_from_state(self):
        sentinel = object()
        req = _make_request(provider_registry=sentinel)
        assert await get_provider_registry(req) is sentinel


class TestGetTaskManager:
    async def test_returns_task_manager_from_state(self):
        sentinel = object()
        req = _make_request(task_manager=sentinel)
        assert await get_task_manager(req) is sentinel
