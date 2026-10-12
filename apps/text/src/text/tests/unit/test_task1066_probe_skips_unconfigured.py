"""A self-hosted provider nobody configured is skipped, not probed (no get_info.failed noise)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from text.api.endpoints.providers import _probe
from text.models.provider import ProviderInfo
from text.services.pool_health import PoolHealthTracker


def _registry(provider: Any) -> Any:
    return SimpleNamespace(get=lambda name: provider)


def _selfhosted(last_base_url: str | None) -> Any:
    info = ProviderInfo(name="ollama", display_name="o", status="available", default_model="")
    return SimpleNamespace(
        _last_base_url=last_base_url,
        get_info=AsyncMock(return_value=info),
    )


@pytest.mark.asyncio
async def test_no_connection_and_no_memo_is_skipped_without_probing() -> None:
    provider = _selfhosted(None)
    out = await _probe(_registry(provider), "ollama", 1.0, pool_health_tracker=PoolHealthTracker())
    assert out["probe_status"] == "skipped"
    assert out["status"] == "unavailable"
    provider.get_info.assert_not_called()


@pytest.mark.asyncio
async def test_a_served_endpoint_memo_is_still_probed() -> None:
    provider = _selfhosted("http://lm:1234")
    out = await _probe(_registry(provider), "ollama", 1.0, pool_health_tracker=PoolHealthTracker())
    assert out["probe_status"] == "ok"
    provider.get_info.assert_awaited_once()
