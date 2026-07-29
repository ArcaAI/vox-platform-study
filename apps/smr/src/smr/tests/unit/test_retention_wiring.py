"""Control-plane retention reaches the live SMR providers.

The provider objects are lazily built and memoized by `ProviderRegistry`, so
retention has to be (re-)applied on every refresh rather than only at
construction. A provider instantiated after the last refresh therefore carries
the bootstrap TTL for at most one request — documented, not a defect.

RED: written before the implementation.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from smr.core.effective_config import EffectiveConfigSnapshot


class _RetentionProvider:
    def __init__(self) -> None:
        self.applied: list[dict[str, int]] = []

    def apply_retention(self, retention: dict[str, int]) -> None:
        self.applied.append(retention)


class _PlainProvider:
    """A provider with no retention support (Azure, Bedrock) — must be skipped."""


def test_snapshot_exposes_retention_ttl() -> None:
    snapshot = EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 900}}, ok=True)
    assert snapshot.retention() == {"ttl_seconds": 900}


def test_snapshot_omits_absent_or_null_retention() -> None:
    assert EffectiveConfigSnapshot(raw={}, ok=True).retention() == {}
    assert (
        EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": None}}, ok=True).retention() == {}
    )
    assert EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 0}}, ok=True).retention() == {}


def test_apply_retention_reaches_instantiated_providers() -> None:
    from smr.services.runtime_limits import apply_provider_retention

    provider = _RetentionProvider()
    registry = SimpleNamespace(
        _providers={"ollama": provider},
        is_instantiated=lambda name: True,
    )
    snapshot = EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 900}}, ok=True)

    apply_provider_retention(snapshot, registry)

    assert provider.applied == [{"ttl_seconds": 900}]


def test_apply_retention_skips_providers_without_support() -> None:
    from smr.services.runtime_limits import apply_provider_retention

    registry = SimpleNamespace(
        _providers={"azure": _PlainProvider()}, is_instantiated=lambda name: True
    )
    snapshot = EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 900}}, ok=True)

    apply_provider_retention(snapshot, registry)  # must not raise


def test_negative_cached_snapshot_leaves_providers_untouched() -> None:
    """Gateway down ⇒ keep env values, exactly as the concurrency lane does."""
    from smr.services.runtime_limits import apply_provider_retention

    provider = _RetentionProvider()
    registry = SimpleNamespace(_providers={"ollama": provider}, is_instantiated=lambda name: True)

    apply_provider_retention(EffectiveConfigSnapshot(raw={}, ok=False), registry)

    assert provider.applied == []


@pytest.mark.asyncio
async def test_refresh_runtime_limits_applies_retention() -> None:
    from smr.services.runtime_limits import refresh_runtime_limits

    provider = _RetentionProvider()

    class _Client:
        async def get(self) -> EffectiveConfigSnapshot:
            return EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 1200}}, ok=True)

    state = SimpleNamespace(
        effective_config_client=_Client(),
        provider_semaphores={},
        provider_timeouts={},
        provider_registry=SimpleNamespace(
            _providers={"ollama": provider}, is_instantiated=lambda n: True
        ),
    )

    await refresh_runtime_limits(state)

    assert provider.applied == [{"ttl_seconds": 1200}]
