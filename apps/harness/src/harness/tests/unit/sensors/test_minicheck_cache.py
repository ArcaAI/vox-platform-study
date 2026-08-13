"""The MiniCheck entailer is bounded and evictable.

The entailer lives behind ``hope_runtime_models.SyncModelCache`` — the
same policy as every other HOPE cache, driven by threads rather than asyncio
because ``_atomic_fact_entailer`` (activities.py) is a plain ``def`` and a
``llama_cpp.Llama`` construction is a blocking CPU/GPU call, not awaited I/O.
This bounds and evicts what would otherwise be a module dict
(``_ENTAILER_CACHE: dict[str, LlamaCppMiniCheckEntailer]``) that keeps a GGUF
loaded by one activity resident for the life of the Temporal worker, with no
TTL, no bound and no unload.

Hermetic by construction: no llama.cpp, no weights, no network. The construction
seam ``_build_entailer`` is monkeypatched, so what is exercised here is the
CACHE behaviour (evict → reload → re-calibrate) over a fake entailer.
"""

from __future__ import annotations

import gc
import inspect
import weakref

import pytest

from harness.core.config import Settings
from harness.sensors.inferential import minicheck_entailer as me
from harness.sensors.inferential.atomic_fact import DeterministicOverlapEntailer
from harness.sensors.inferential.minicheck_entailer import (
    LlamaCppMiniCheckEntailer,
    MiniCheckCalibrationError,
    load_minicheck_entailer,
)
from harness.temporal.activities import _atomic_fact_entailer

MODEL_PATH = "/staged/minicheck-flan-t5-large-q6_k.gguf"


class FakeClock:
    """Monotonic fake clock; `advance` is the only way time moves."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeLlama:
    """Stands in for the loaded ``llama_cpp.Llama`` handle (weakref-trackable)."""


def _calibrated_logits(llama: FakeLlama, calls: list[str], *, calibrated: bool = True):
    """A fake first-step logit reader that keeps the llama handle alive via closure.

    Mirrors the real `_make_llama_logit_fn`, whose closure is the ONLY thing
    holding the llama handle — so a weakref to `llama` dying proves the cache
    released the weights.
    """

    def logit_fn(prompt: str) -> tuple[float, float]:
        calls.append(prompt)
        assert llama is not None  # keep the closure reference explicit
        supported = me._CAL_SUPPORTED_CLAIM in prompt
        if not calibrated:
            return (0.0, 0.0)  # collapsed ≈0.5 → fails the calibration gate
        return (-5.0, 5.0) if supported else (5.0, -5.0)

    return logit_fn


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture(autouse=True)
def _fresh_cache(clock: FakeClock):
    """Every test gets its own cache on a fake clock; teardown drops it."""
    me.reset_entailer_cache(time_func=clock)
    yield
    me.reset_entailer_cache()


def _install_builder(monkeypatch: pytest.MonkeyPatch, builds: list[FakeLlama], **kwargs):
    """Monkeypatch the construction seam; records one FakeLlama per build."""
    logit_calls: list[str] = []

    def fake_build(spec) -> LlamaCppMiniCheckEntailer:  # noqa: ANN001 — module-private spec
        llama = FakeLlama()
        builds.append(llama)
        flags = kwargs.get("calibrated_builds", [True])
        # The last flag repeats, so a caller only lists the builds it cares about.
        calibrated = flags[min(len(builds) - 1, len(flags) - 1)]
        return LlamaCppMiniCheckEntailer(
            _calibrated_logits(llama, logit_calls, calibrated=calibrated),
            threshold=spec.threshold,
        )

    monkeypatch.setattr(me, "_build_entailer", fake_build)
    return logit_calls


# ── the seam that keeps the call site synchronous ───────────────────────────


def test_load_minicheck_entailer_signature_unchanged() -> None:
    """`_atomic_fact_entailer` is a plain `def` — this loader must stay sync.

    the decision to add a SYNC cache rather than convert the entailer path
    to async rests entirely on this signature. If it ever grows an `async`, the
    blast radius moves into the clinical activity chain.
    """
    assert not inspect.iscoroutinefunction(load_minicheck_entailer)

    params = inspect.signature(load_minicheck_entailer).parameters
    assert list(params) == [
        "model_path",
        "n_ctx",
        "n_threads",
        "n_gpu_layers",
        "threshold",
    ]
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in params.values())
    assert inspect.signature(load_minicheck_entailer).return_annotation == (
        "LlamaCppMiniCheckEntailer"
    )


def test_module_dict_cache_is_gone() -> None:
    """The unbounded, never-evicting module dict must not come back."""
    assert not hasattr(me, "_ENTAILER_CACHE")


# ── residency, eviction and reload ──────────────────────────────────────────


def test_repeat_load_within_ttl_reuses_the_entailer(monkeypatch: pytest.MonkeyPatch) -> None:
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    first = load_minicheck_entailer(model_path=MODEL_PATH)
    second = load_minicheck_entailer(model_path=MODEL_PATH)

    assert first is second
    assert len(builds) == 1


def test_entailer_evicted_after_ttl_and_reloaded(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    first = load_minicheck_entailer(model_path=MODEL_PATH)
    clock.advance(601)  # idle past the 600 s default TTL

    assert me.sweep_entailer_cache() == 1, "an idle entailer must be released by the sweep"

    second = load_minicheck_entailer(model_path=MODEL_PATH)
    assert second is not first
    assert len(builds) == 2


def test_unload_releases_llama_handle(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> None:
    """An eviction that frees nothing is not an eviction.

    The llama handle is reachable ONLY through the entailer's logit closure, so
    once the cache drops the entailer and the caller lets go, a weakref to the
    handle must die. Before this, the module dict held it forever.
    """
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    entailer = load_minicheck_entailer(model_path=MODEL_PATH)
    handle = weakref.ref(builds[0])
    builds.clear()
    assert handle() is not None

    clock.advance(601)
    assert me.sweep_entailer_cache() == 1

    del entailer
    gc.collect()
    assert handle() is None, "the GGUF handle is still pinned after eviction"


def test_max_models_bounds_residency(monkeypatch: pytest.MonkeyPatch) -> None:
    """`harness.modelCache.maxModels` default 1 preserves today's residency."""
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    load_minicheck_entailer(model_path=MODEL_PATH)
    load_minicheck_entailer(model_path="/staged/other.gguf")

    assert me.entailer_cache_stats().resident_models == 1


# ── calibration must survive a reload ───────────────────────────────────────


def test_calibration_reverified_on_reload(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    """A reloaded entailer that skipped calibration could silently mis-score."""
    builds: list[FakeLlama] = []
    logit_calls = _install_builder(monkeypatch, builds)

    load_minicheck_entailer(model_path=MODEL_PATH)
    calls_after_first = len(logit_calls)
    assert calls_after_first == 2, "calibration scores the published reference pair"

    clock.advance(601)
    me.sweep_entailer_cache()
    load_minicheck_entailer(model_path=MODEL_PATH)

    assert len(logit_calls) == 2 * calls_after_first, "reload must re-verify calibration"


def test_calibration_failure_on_reload_falls_back_to_deterministic(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    """`_atomic_fact_entailer`'s safety net must survive a RELOAD failure too.

    The existing test only covers a failing FIRST load. With eviction in play the
    second build can fail on a host whose weights moved — and the sensor must
    still degrade to the safe deterministic entailer, never auto-PASS.
    """
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds, calibrated_builds=[True, False])
    settings = Settings(atomic_fact_model_path=MODEL_PATH)

    first = _atomic_fact_entailer(settings)
    assert isinstance(first, LlamaCppMiniCheckEntailer)

    clock.advance(601)
    me.sweep_entailer_cache()

    with pytest.raises(MiniCheckCalibrationError):
        load_minicheck_entailer(model_path=MODEL_PATH)

    reloaded = _atomic_fact_entailer(settings)
    assert isinstance(reloaded, DeterministicOverlapEntailer)


def test_failed_load_is_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A miscalibrated build must not poison the slot — the next load retries."""
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds, calibrated_builds=[False, True])

    with pytest.raises(MiniCheckCalibrationError):
        load_minicheck_entailer(model_path=MODEL_PATH)

    assert isinstance(load_minicheck_entailer(model_path=MODEL_PATH), LlamaCppMiniCheckEntailer)
    assert len(builds) == 2


# ── admin-controlled retention (`harness.modelCache.*`) ─────────────────────


def test_retention_defaults_come_from_settings() -> None:
    settings = Settings()
    assert settings.model_cache_ttl_seconds == 600
    assert settings.model_cache_max_models == 1


def test_configure_entailer_cache_adopts_control_plane_values(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    load_minicheck_entailer(model_path=MODEL_PATH)
    me.configure_entailer_cache({"ttl_seconds": 3600})
    assert me.entailer_cache_stats().ttl_seconds == 3600

    clock.advance(601)
    assert me.sweep_entailer_cache() == 0, "the raised TTL keeps the entailer resident"

    clock.advance(3000)
    assert me.sweep_entailer_cache() == 1


def test_configure_entailer_cache_reapplies_the_product_clamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    load_minicheck_entailer(model_path=MODEL_PATH)
    me.configure_entailer_cache({"ttl_seconds": 99_999})
    assert me.entailer_cache_stats().ttl_seconds == 3600

    me.configure_entailer_cache({"ttl_seconds": 1})
    assert me.entailer_cache_stats().ttl_seconds == 60


def test_configure_entailer_cache_ignores_absent_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A gateway outage yields a partial payload — behaviour must not change."""
    builds: list[FakeLlama] = []
    _install_builder(monkeypatch, builds)

    load_minicheck_entailer(model_path=MODEL_PATH)
    me.configure_entailer_cache({})

    stats = me.entailer_cache_stats()
    assert stats.ttl_seconds == 600
    assert stats.max_size == 1
