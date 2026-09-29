"""Settings: env is the bootstrap floor only; tuning lives in the control plane."""

from __future__ import annotations

import pytest

from hope_vllm.core.config import DEFAULT_POOLS, PoolNotConfiguredError, Settings
from hope_vllm.engine.pool import PoolConfig

#: Control-plane knobs whose env path is CLOSED (the control plane owns them).
CLOSED_TUNING_ENV = {
    "VLLM_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND": (
        "truncation_min_chars_per_voiced_second",
        "9.5",
    ),
    "VLLM_TRUNCATION_VOICED_DBFS": ("truncation_voiced_dbfs", "-20"),
    "VLLM_POOLS": ("pools", '{"x": {}}'),
}

#: TASK-1021 D-11: engine sizing moved from settings to the MODEL ROW (`engine.*` on the
#: serving spec) and the pool (`vllm.pools`). These fields no longer exist at all.
REMOVED_FIELDS = (
    "gpu_memory_utilization",
    "max_num_seqs",
    "enforce_eager",
    "max_resident_engines",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*CLOSED_TUNING_ENV, "INTERNAL_ACCESS_TOKEN", "VLLM_API_GATEWAY_URL", "VLLM_POOL"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("env_var", sorted(CLOSED_TUNING_ENV))
def test_a_stale_tuning_env_var_can_no_longer_set_its_field(
    monkeypatch: pytest.MonkeyPatch, env_var: str
) -> None:
    """A leftover ConfigMap value must not silently win over the control plane."""
    field, value = CLOSED_TUNING_ENV[env_var]
    default = getattr(Settings(), field)
    monkeypatch.setenv(env_var, value)
    assert getattr(Settings(), field) == default


@pytest.mark.parametrize("field", REMOVED_FIELDS)
def test_engine_sizing_is_no_longer_a_setting(field: str) -> None:
    assert field not in Settings.model_fields


def test_bootstrap_defaults_match_the_platform_descriptor_defaults() -> None:
    """An empty control plane must change nothing: code default == descriptor default."""
    settings = Settings()
    assert settings.truncation_min_chars_per_voiced_second == pytest.approx(3.0)
    assert settings.truncation_voiced_dbfs == pytest.approx(-40.0)
    assert settings.pool == "default"
    assert settings.pool_config() == PoolConfig(
        accepted_kinds=frozenset({"asr"}),
        pins=(),
        vram_budget_gib=6.0,
        max_resident=1,
        inflight_factor=2,
    )
    assert DEFAULT_POOLS == {
        "default": {
            "acceptedKinds": ["asr"],
            "pins": [],
            "vramBudgetGiB": 6,
            "maxResidentEngines": 1,
            "inflightFactor": 2,
        }
    }


def test_the_pool_identity_is_the_env_var_vllm_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VLLM_POOL", "asr")
    assert Settings().pool == "asr"


def test_a_pool_name_the_pools_map_does_not_declare_is_a_named_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VLLM_POOL", "missing")
    settings = Settings()  # constructing is fine: the control plane may still declare it
    with pytest.raises(PoolNotConfiguredError) as caught:
        settings.pool_config()
    assert caught.value.pool == "missing"
    assert "vllm.pools" in str(caught.value)


def test_gateway_url_is_the_one_new_bootstrap_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().api_gateway_url == "http://localhost:8868/api/v1"
    monkeypatch.setenv("VLLM_API_GATEWAY_URL", "http://hope-api:8868/api/v1")
    assert Settings().api_gateway_url == "http://hope-api:8868/api/v1"


def test_hf_hub_offline_is_read_from_huggingfaces_own_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    assert Settings().hf_hub_offline is False
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    assert Settings().hf_hub_offline is True


def test_outbound_token_is_the_shared_internal_access_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "tok-123")
    assert Settings().peer_service_token() == "tok-123"


def test_an_unfilled_placeholder_is_never_presented_as_a_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "CHANGE_ME")
    settings = Settings()
    assert settings.peer_service_token() == ""
    assert settings.accepted_service_tokens == ()


def test_accepts_the_shared_internal_access_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "tok-123")
    assert Settings().accepted_service_tokens == ("tok-123",)


def test_no_token_configured_means_nothing_accepted() -> None:
    assert Settings().accepted_service_tokens == ()


def test_there_is_no_model_selection_setting() -> None:
    """Model choice arrives per request (`model=<slug>`); it is never env-configured."""
    forbidden = {
        "model",
        "model_path",
        "model_id",
        "model_slug",
        "hf_model",
        "default_model",
        "local_path",
        "source_uri",
        "engine",
        "pipeline_id",
        "hf_token",
        "huggingface_token",
    }
    assert forbidden.isdisjoint(Settings.model_fields)


def test_importing_settings_registers_no_prometheus_series() -> None:
    """`scripts/python-env-surface.py` imports every service's settings in ONE process;
    settings that dragged in the pool would register `model_resident_bytes`, which stt's
    residency sink also registers — a DuplicateTimeseries crash in the env generator."""
    import subprocess
    import sys
    from pathlib import Path

    src = Path(__file__).resolve().parents[3]
    code = (
        f"import sys; sys.path.insert(0, {str(src)!r}); import hope_vllm.core.config; "
        "print(sorted(m for m in sys.modules if m.startswith(('hope_vllm.engine', "
        "'hope_vllm.core.metrics', 'prometheus_client'))))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert out == "[]"
