"""tts local engines are lazy + evictable.

Providers register unconditionally, the model loads on first synth
request, and an idle model is released by the shared cache's TTL sweep.

Health-semantics: a broken model surfaces as a first-request 503 rather than
boot-time non-registration (documented in the runbook).
`TTS_WARMUP_ENABLED=true` restores fail-at-boot behaviour.

RED: written before the implementation.
"""

from __future__ import annotations

import pytest

from tts.core.config import KokoroConfig, Settings
from tts.providers.base import AudioFormat, SynthesisRequest


class _FakePipeline:
    """Stands in for `KPipeline` — records how often it was constructed."""

    constructed = 0

    def __init__(self) -> None:
        type(self).constructed += 1

    def __call__(self, text: str, voice: str | None = None):  # noqa: ANN204
        import numpy as np

        return [(None, None, np.zeros(240, dtype=np.float32))]


def _request(text: str = "hello") -> SynthesisRequest:
    return SynthesisRequest(
        text=text, locale="en-US", fmt=AudioFormat.PCM, provider_voice=None, sample_rate=24000
    )


# ── the warmup switch ───────────────────────────────────────────────────────


def test_warmup_is_disabled_by_default() -> None:
    """Lazy loading only works if warmup is off by default."""
    settings = Settings()
    assert settings.warmup_enabled is False


def test_warmup_can_be_re_enabled_for_fail_at_boot_operators(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The switch moved to the control plane, so `TTS_WARMUP_ENABLED` is inert.

    TASK-799 lane C. It is still fully available to an operator — as
    `tts.warmupEnabled`, written once through the settings registry rather than
    per deployment in an env file — and it still defaults OFF. What changed is
    only which lane sets it, so the assertion tests the new lane rather than
    dropping the coverage.
    """
    from tts.core.control_plane import apply_control_plane

    monkeypatch.setenv("TTS_WARMUP_ENABLED", "true")
    settings = Settings()
    assert settings.warmup_enabled is False

    apply_control_plane(
        settings,
        {
            "settings": {
                "tts.warmupEnabled": {"value": True, "dataType": "boolean", "source": "db"}
            }
        },
    )
    assert settings.warmup_enabled is True


# ── registration no longer gated on a successful load ───────────────────────


@pytest.mark.asyncio
async def test_provider_registers_even_when_its_model_cannot_load() -> None:
    """Registration must not depend on warmup: that was the eager-load gate."""
    from tts.providers.registration import register_local_provider

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
    from tts.providers.registration import register_local_provider

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
    from tts.providers.registration import register_local_provider

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
    from tts.providers.kokoro import KokoroProvider

    provider = KokoroProvider(KokoroConfig(), pipeline_factory=_FakePipeline)

    assert _FakePipeline.constructed == 0, "constructing the provider must not load"

    async for _ in provider.synthesize(_request()):
        pass

    assert _FakePipeline.constructed == 1


@pytest.mark.asyncio
async def test_second_request_reuses_the_loaded_model() -> None:
    _FakePipeline.constructed = 0
    from tts.providers.kokoro import KokoroProvider

    provider = KokoroProvider(KokoroConfig(), pipeline_factory=_FakePipeline)
    for _ in range(2):
        async for _ in provider.synthesize(_request()):
            pass

    assert _FakePipeline.constructed == 1


@pytest.mark.asyncio
async def test_idle_model_is_unloaded_and_gauge_returns_to_zero() -> None:
    from tts.core.metrics import TTS_MODEL_LOADED
    from tts.providers.kokoro import KokoroProvider

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


# ── ALL THREE local engines, not just Kokoro ───
#
# Kokoro/IndicParler/IndicF5 are all lazy AND behind the shared cache, so
# each is TTL-unloaded when idle rather than staying resident forever. The
# same clauses run against every local engine.

LOCAL_ENGINES = ("kokoro", "indic_parler", "indic_f5")


class _LoadCounter:
    """A model factory that counts how many times the engine was actually loaded."""

    def __init__(self, build) -> None:  # noqa: ANN001 — per-engine builder
        self.count = 0
        self._build = build

    def __call__(self):  # noqa: ANN204
        self.count += 1
        return self._build()


def _fake_generate():  # noqa: ANN202 — parler `(text, description)` / f5 `(text)`
    import numpy as np

    return lambda *_args: np.zeros(240, dtype=np.float32)


def _make_engine(
    name: str, factory, *, ttl_seconds: int = 600, time_func=None
):  # noqa: ANN001,ANN202
    kwargs = {"ttl_seconds": ttl_seconds}
    if time_func is not None:
        kwargs["time_func"] = time_func

    if name == "kokoro":
        from tts.providers.kokoro import KokoroProvider

        return KokoroProvider(KokoroConfig(), pipeline_factory=factory, **kwargs)
    if name == "indic_parler":
        from tts.core.config import IndicParlerConfig
        from tts.providers.indic_parler import IndicParlerProvider

        return IndicParlerProvider(IndicParlerConfig(), generate_factory=factory, **kwargs)

    from tts.core.config import IndicF5Config
    from tts.providers.indic_f5 import IndicF5Provider

    return IndicF5Provider(IndicF5Config(), generate_factory=factory, **kwargs)


def _engine_factory(name: str) -> _LoadCounter:
    return _LoadCounter(_FakePipeline if name == "kokoro" else _fake_generate)


def _engine_request(name: str) -> SynthesisRequest:
    locale = "en-US" if name == "kokoro" else "ml-IN"
    return SynthesisRequest(
        text="hello", locale=locale, fmt=AudioFormat.PCM, provider_voice=None, sample_rate=24000
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", LOCAL_ENGINES)
async def test_local_engine_loads_on_first_request_only(engine: str) -> None:
    from tts.core.metrics import TTS_MODEL_LOADED

    factory = _engine_factory(engine)
    provider = _make_engine(engine, factory)

    assert factory.count == 0, "constructing the provider must not load weights"

    for _ in range(2):
        async for _ in provider.synthesize(_engine_request(engine)):
            pass

    assert factory.count == 1
    assert TTS_MODEL_LOADED.labels(model=engine)._value.get() == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", LOCAL_ENGINES)
async def test_local_engine_idle_weights_are_released_and_gauge_zeroed(engine: str) -> None:
    from tts.core.metrics import TTS_MODEL_LOADED

    clock = {"now": 1000.0}
    factory = _engine_factory(engine)
    provider = _make_engine(engine, factory, ttl_seconds=600, time_func=lambda: clock["now"])

    async for _ in provider.synthesize(_engine_request(engine)):
        pass
    assert TTS_MODEL_LOADED.labels(model=engine)._value.get() == 1

    clock["now"] += 601
    assert await provider.sweep() == 1
    assert TTS_MODEL_LOADED.labels(model=engine)._value.get() == 0

    # ...and it reloads on the next request.
    async for _ in provider.synthesize(_engine_request(engine)):
        pass
    assert factory.count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", LOCAL_ENGINES)
async def test_local_engine_load_failure_is_not_cached(engine: str) -> None:
    """A broken load surfaces per-request (→ 503) and the next request retries."""
    attempts = {"n": 0}

    def flaky():  # noqa: ANN202
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("weights missing")
        return (_FakePipeline if engine == "kokoro" else _fake_generate)()

    provider = _make_engine(engine, flaky)

    with pytest.raises(RuntimeError, match="weights missing"):
        async for _ in provider.synthesize(_engine_request(engine)):
            pass

    async for _ in provider.synthesize(_engine_request(engine)):
        pass
    assert attempts["n"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", LOCAL_ENGINES)
async def test_local_engine_warmup_loads_eagerly_for_fail_at_boot_operators(
    engine: str,
) -> None:
    factory = _engine_factory(engine)
    provider = _make_engine(engine, factory)

    await provider.warmup()

    assert factory.count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", LOCAL_ENGINES)
async def test_local_engine_adopts_control_plane_retention(engine: str) -> None:
    clock = {"now": 1000.0}
    factory = _engine_factory(engine)
    provider = _make_engine(engine, factory, ttl_seconds=600, time_func=lambda: clock["now"])

    async for _ in provider.synthesize(_engine_request(engine)):
        pass

    provider.configure_retention({"ttl_seconds": 3600})
    clock["now"] += 601
    assert await provider.sweep() == 0, "the raised TTL keeps the weights resident"

    clock["now"] += 3000
    assert await provider.sweep() == 1
