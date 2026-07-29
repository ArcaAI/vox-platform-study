"""nlp model-cache retention becomes admin-controlled.

Without this, the three nlp cache singletons were constructed as
`ModelCache(factory=…)` with NO ttl/max_size argument at all, so they were
permanently pinned to the module defaults (3600 s / 3) with not even an env
knob — a service whose retention could not be changed without a code deploy.

RED: written before the implementation.
"""

from __future__ import annotations

import pytest

from nlp.core.effective_config import EffectiveConfigSnapshot

# ── the effective-config subset ─────────────────────────────────────────────


def test_snapshot_exposes_retention() -> None:
    snapshot = EffectiveConfigSnapshot(
        raw={"retention": {"ttlSeconds": 900, "maxModels": 4}}, ok=True
    )
    assert snapshot.retention() == {"ttl_seconds": 900, "max_models": 4}


def test_snapshot_omits_keys_without_an_opinion() -> None:
    """Omitted ⇒ keep the env/bootstrap value; never coerce null into a number."""
    assert EffectiveConfigSnapshot(raw={}, ok=True).retention() == {}
    assert EffectiveConfigSnapshot(
        raw={"retention": {"ttlSeconds": None, "maxModels": 4}}, ok=True
    ).retention() == {"max_models": 4}
    assert EffectiveConfigSnapshot(raw={"retention": {"ttlSeconds": 0}}, ok=True).retention() == {}


def test_negative_cached_snapshot_yields_no_retention() -> None:
    assert EffectiveConfigSnapshot(raw={}, ok=False).retention() == {}


# ── singletons actually receive resolved config ─────────────────────────────


def test_settings_expose_model_cache_bootstrap_knobs() -> None:
    """Bootstrap fallbacks must EXIST."""
    from nlp.core.config import settings

    assert settings.service.model_cache_ttl_seconds == 600, "OD-5 default"
    assert settings.service.model_cache_max_models == 3, "behaviour-preserving"


def test_dependencies_pass_retention_config_to_all_three_singletons() -> None:
    """Each cache is built with the resolved ttl/max — not the module defaults."""
    import nlp.dependencies as deps

    deps.reset_model_caches()

    caches = [
        deps._token_classifier_cache(),
        deps._text_classifier_cache(),
        deps._medical_suggester_cache(),
    ]

    for cache in caches:
        stats = cache.stats()
        assert stats.ttl_seconds == 600, "must come from settings, not the 3600 default"
        assert stats.max_size == 3


def test_apply_retention_reconfigures_all_three_singletons() -> None:
    """A control-plane change reaches every cache without a redeploy."""
    import nlp.dependencies as deps

    deps.reset_model_caches()
    deps.apply_model_cache_retention({"ttl_seconds": 1800, "max_models": 5})

    for cache in (
        deps._token_classifier_cache(),
        deps._text_classifier_cache(),
        deps._medical_suggester_cache(),
    ):
        assert cache.stats().ttl_seconds == 1800
        assert cache.stats().max_size == 5


def test_apply_retention_clamps_out_of_range_ttl() -> None:
    import nlp.dependencies as deps

    deps.reset_model_caches()
    deps.apply_model_cache_retention({"ttl_seconds": 99999})

    assert deps._token_classifier_cache().stats().ttl_seconds == 3600


def test_apply_retention_with_empty_payload_keeps_current_values() -> None:
    """Gateway down ⇒ byte-identical behaviour."""
    import nlp.dependencies as deps

    deps.reset_model_caches()
    before = deps._token_classifier_cache().stats().ttl_seconds

    deps.apply_model_cache_retention({})

    assert deps._token_classifier_cache().stats().ttl_seconds == before


@pytest.mark.asyncio
async def test_sweep_releases_idle_models_never_requested_again() -> None:
    """The §2.2 sweeper gap: an idle model whose key is never re-requested."""
    import nlp.dependencies as deps

    deps.reset_model_caches()
    swept = await deps.sweep_model_caches()

    assert swept == 0, "nothing resident yet, but the entry point must exist"
