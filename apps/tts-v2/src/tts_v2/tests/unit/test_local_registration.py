"""Tests for local-engine registration.

TASK-488 Phase 4 introduced `warm_and_register`: load the model at boot and
register the provider only if the load succeeded.

TASK-529 (D-09) REPLACED that helper with `register_local_provider`. The
warm-then-register policy is gone on purpose — it made every local engine eager
(weights pinned for the process lifetime with no unload path) and it turned a
broken model into a *missing* provider, which is harder to diagnose than a 503.

The surviving guarantee — a failed model load must never crash startup — is
asserted below, alongside the new one: the provider stays registered either way,
so the failure surfaces at request time.
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
    """Lazy-by-default: registration must not touch the weights (D-09)."""
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
    """The TASK-488 guarantee (no crash) holds; the outcome changed to 'degraded'."""
    registry = ProviderRegistry()
    ok = await register_local_provider(registry, "indic_parler", _FailProvider(), warmup=True)

    assert ok is True
    assert "indic_parler" in registry, "degraded, not absent — a 503 beats a vanished route"
