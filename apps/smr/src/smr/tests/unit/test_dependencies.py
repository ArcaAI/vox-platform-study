"""Tests for core/dependencies.py — DI functions that read from app.state."""

from __future__ import annotations

from unittest.mock import MagicMock

from smr.core.dependencies import (
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
    def test_returns_settings_from_state(self):
        sentinel = object()
        req = _make_request(settings=sentinel)
        assert get_settings(req) is sentinel


class TestGetHttpClient:
    def test_returns_http_client_from_state(self):
        sentinel = object()
        req = _make_request(http_client=sentinel)
        assert get_http_client(req) is sentinel


class TestGetRedis:
    def test_returns_redis_from_state(self):
        sentinel = object()
        req = _make_request(redis=sentinel)
        assert get_redis(req) is sentinel


class TestGetProviderRegistry:
    def test_returns_registry_from_state(self):
        sentinel = object()
        req = _make_request(provider_registry=sentinel)
        assert get_provider_registry(req) is sentinel


class TestGetTaskManager:
    def test_returns_task_manager_from_state(self):
        sentinel = object()
        req = _make_request(task_manager=sentinel)
        assert get_task_manager(req) is sentinel
