"""Settings: env is the bootstrap floor only; the six tuning knobs moved to the control plane."""

from __future__ import annotations

import pytest

from asr_vllm.core.config import Settings

#: The six TASK-1010 spike env vars whose path OD-6 closed (control plane now owns them).
CLOSED_TUNING_ENV = {
    "ASR_VLLM_GPU_MEMORY_UTILIZATION": ("gpu_memory_utilization", "0.3"),
    "ASR_VLLM_MAX_NUM_SEQS": ("max_num_seqs", "48"),
    "ASR_VLLM_ENFORCE_EAGER": ("enforce_eager", "true"),
    "ASR_VLLM_MAX_RESIDENT_ENGINES": ("max_resident_engines", "2"),
    "ASR_VLLM_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND": (
        "truncation_min_chars_per_voiced_second",
        "9.5",
    ),
    "ASR_VLLM_TRUNCATION_VOICED_DBFS": ("truncation_voiced_dbfs", "-20"),
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*CLOSED_TUNING_ENV, "INTERNAL_ACCESS_TOKEN", "ASR_VLLM_API_GATEWAY_URL"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("env_var", sorted(CLOSED_TUNING_ENV))
def test_a_stale_tuning_env_var_can_no_longer_set_its_field(
    monkeypatch: pytest.MonkeyPatch, env_var: str
) -> None:
    """OD-6: a leftover ConfigMap value must not silently win over the control plane."""
    field, value = CLOSED_TUNING_ENV[env_var]
    default = getattr(Settings(), field)
    monkeypatch.setenv(env_var, value)
    assert getattr(Settings(), field) == default


def test_bootstrap_defaults_match_the_platform_descriptor_defaults() -> None:
    """An empty control plane must change nothing: code default == descriptor default (OD-10)."""
    settings = Settings()
    assert settings.gpu_memory_utilization == pytest.approx(0.20)
    assert settings.max_num_seqs == 64
    assert settings.enforce_eager is False
    assert settings.max_resident_engines == 1
    assert settings.truncation_min_chars_per_voiced_second == pytest.approx(3.0)
    assert settings.truncation_voiced_dbfs == pytest.approx(-40.0)


def test_gateway_url_is_the_one_new_bootstrap_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().api_gateway_url == "http://localhost:8868/api/v1"
    monkeypatch.setenv("ASR_VLLM_API_GATEWAY_URL", "http://hope-api:8868/api/v1")
    assert Settings().api_gateway_url == "http://hope-api:8868/api/v1"


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
    """Model choice arrives per request (the resolved spec); it is never env-configured."""
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
