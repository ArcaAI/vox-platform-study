"""TDD tests for warm-then-register (TASK-488 Phase 4).

A local model that fails to load must leave the provider unregistered without
crashing startup.
"""

from __future__ import annotations

import pytest

from tts_v2.providers.base import ProviderRegistry
from tts_v2.providers.registration import warm_and_register


class _OkProvider:
    async def warmup(self) -> None:
        return None


class _FailProvider:
    async def warmup(self) -> None:
        raise RuntimeError("model download / load failed")


@pytest.mark.asyncio
async def test_registers_on_successful_warmup():
    registry = ProviderRegistry()
    ok = await warm_and_register(registry, "kokoro", _OkProvider())
    assert ok is True
    assert "kokoro" in registry


@pytest.mark.asyncio
async def test_skips_registration_on_warmup_failure():
    registry = ProviderRegistry()
    ok = await warm_and_register(registry, "indic_parler", _FailProvider())
    assert ok is False
    assert "indic_parler" not in registry
