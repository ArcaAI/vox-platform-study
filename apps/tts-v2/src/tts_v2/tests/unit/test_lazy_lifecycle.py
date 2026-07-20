"""TASK-529 §4.7 (D-09) — tts-v2 local engines become lazy + evictable.

Before this ticket the local engines were loaded EAGERLY in the lifespan
(`warm_and_register` called `provider.warmup()` and only registered on success)
and were never unloaded — no unload path existed at all. A booted tts-v2 pinned
Kokoro + IndicParler weights for the life of the process regardless of traffic.

After: providers register unconditionally, the model loads on first synth
request, and an idle model is released by the shared cache's TTL sweep.

Health-semantics shift (documented in the runbook): a broken model now surfaces
as a first-request 503 rather than boot-time non-registration.
`TTS_WARMUP_ENABLED=true` restores the old fail-at-boot behaviour.

RED: written before the implementation.
"""

from __future__ import annotations

import pytest

from tts_v2.core.config import KokoroConfig, Settings
from tts_v2.providers.base import AudioFormat, SynthesisRequest


class _FakePipeline:
    """Stands in for `KPipeline` — records how often it was constructed."""

    constructed = 0

    def __init__(self) -> None:
        type(self).constructed += 1

    def __call__(self, text: str, voice: str | None = None):  # noqa: ANN204
        import numpy as np

        return [(None, None, np.zeros(240, dtype=np.float32))]


def _request(text: str = "hello") -> SynthesisRequest:
    return SynthesisRequest(text=text, locale="en-US", fmt=AudioFormat.PCM, provider_voice=None, sample_rate=24000)


# ── the warmup switch ───────────────────────────────────────────────────────


def test_warmup_is_disabled_by_default() -> None:
    """Lazy-by-default is the whole point of D-09."""
    settings = Settings()
    assert settings.warmup_enabled is False


def test_warmup_can_be_re_enabled_for_fail_at_boot_operators(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TTS_WARMUP_ENABLED", "true")
    assert Settings().warmup_enabled is True


# ── registration no longer gated on a successful load ───────────────────────


@pytest.mark.asyncio
async def test_provider_registers_even_when_its_model_cannot_load() -> None:
    """Registration must not depend on warmup: that was the eager-load gate."""
    from tts_v2.providers.registration import register_local_provider

    class _Broken:
        async def warmup(self) -> None:
            raise RuntimeError("weights missing")

    registered: dict[str, object] = {}
    registry = type("R", (), {"register": lambda _s, n, p: registered.__setitem__(n, p)})()

    ok = await register_local_provider(registry, "kokoro", _Broken(), warmup=False)

    assert ok is True
    assert "kokoro" in registered, "provider must be registered without loading"


@pytest.mark.asyncio
async def test_warmup_enabled_still_loads_at_registration() -> None:
    from tts_v2.providers.registration import register_local_provider

    warmed: list[str] = []

    class _Provider:
        async def warmup(self) -> None:
            warmed.append("kokoro")

    registry = type("R", (), {"register": lambda _s, n, p: None})()
    await register_local_provider(registry, "kokoro", _Provider(), warmup=True)

    assert warmed == ["kokoro"]


@pytest.mark.asyncio
async def test_warmup_failure_no_longer_unregisters_the_provider() -> None:
    """Degraded, not absent: the 503 surfaces at request time instead."""
    from tts_v2.providers.registration import register_local_provider

    class _Broken:
        async def warmup(self) -> None:
            raise RuntimeError("weights missing")

    registered: dict[str, object] = {}
    registry = type("R", (), {"register": lambda _s, n, p: registered.__setitem__(n, p)})()

    await register_local_provider(registry, "kokoro", _Broken(), warmup=True)

    assert "kokoro" in registered


# ── load on first request, release when idle ────────────────────────────────


@pytest.mark.asyncio
async def test_first_synth_request_loads_the_model() -> None:
    _FakePipeline.constructed = 0
    from tts_v2.providers.kokoro import KokoroProvider

    provider = KokoroProvider(KokoroConfig(), pipeline_factory=_FakePipeline)

    assert _FakePipeline.constructed == 0, "constructing the provider must not load"

    async for _ in provider.synthesize(_request()):
        pass

    assert _FakePipeline.constructed == 1


@pytest.mark.asyncio
async def test_second_request_reuses_the_loaded_model() -> None:
    _FakePipeline.constructed = 0
    from tts_v2.providers.kokoro import KokoroProvider

    provider = KokoroProvider(KokoroConfig(), pipeline_factory=_FakePipeline)
    for _ in range(2):
        async for _ in provider.synthesize(_request()):
            pass

    assert _FakePipeline.constructed == 1


@pytest.mark.asyncio
async def test_idle_model_is_unloaded_and_gauge_returns_to_zero() -> None:
    from tts_v2.core.metrics import TTS_MODEL_LOADED
    from tts_v2.providers.kokoro import KokoroProvider

    _FakePipeline.constructed = 0
    clock = {"now": 1000.0}
    provider = KokoroProvider(
        KokoroConfig(),
        pipeline_factory=_FakePipeline,
        ttl_seconds=600,
        time_func=lambda: clock["now"],
    )

    async for _ in provider.synthesize(_request()):
        pass
    assert TTS_MODEL_LOADED.labels(model="kokoro")._value.get() == 1

    clock["now"] += 601
    assert await provider.sweep() == 1
    assert TTS_MODEL_LOADED.labels(model="kokoro")._value.get() == 0

    # ...and it reloads on the next request.
    async for _ in provider.synthesize(_request()):
        pass
    assert _FakePipeline.constructed == 2
