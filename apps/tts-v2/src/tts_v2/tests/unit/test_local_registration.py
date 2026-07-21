"""Tests for local-engine registration.

`register_local_provider` does NOT warm-then-register by default: that policy
would make every local engine eager (weights pinned for the process lifetime
with no unload path) and would turn a broken model into a *missing* provider,
which is harder to diagnose than a 503.

The guarantee — a failed model load must never crash startup — is asserted
below, alongside the provider staying registered either way, so the failure
surfaces at request time.
"""

from __future__ import annotations

import pytest

from tts_v2.providers.base import ProviderRegistry
from tts_v2.providers.registration import register_local_provider


class _OkProvider:
    async def warmup(self) -> None:
        return None


class _FailProvider:
    async def warmup(self) -> None:
        raise RuntimeError("model download / load failed")


@pytest.mark.asyncio
async def test_registers_without_warming_by_default():
    """Lazy-by-default: registration must not touch the weights."""
    registry = ProviderRegistry()
    ok = await register_local_provider(registry, "kokoro", _FailProvider())

    assert ok is True
    assert "kokoro" in registry


@pytest.mark.asyncio
async def test_registers_after_a_successful_opt_in_warmup():
    registry = ProviderRegistry()
    ok = await register_local_provider(registry, "kokoro", _OkProvider(), warmup=True)

    assert ok is True
    assert "kokoro" in registry


@pytest.mark.asyncio
async def test_warmup_failure_does_not_crash_startup_and_keeps_the_provider():
    """The no-crash guarantee holds; the outcome is 'degraded' not absent."""
    registry = ProviderRegistry()
    ok = await register_local_provider(registry, "indic_parler", _FailProvider(), warmup=True)

    assert ok is True
    assert "indic_parler" in registry, "degraded, not absent — a 503 beats a vanished route"
