"""Settings: ASR_VLLM_ prefix, the shared internal credential, the GPU budget invariant."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from asr_vllm.core.config import Settings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "INTERNAL_ACCESS_TOKEN",
        "ASR_VLLM_MAX_RESIDENT_ENGINES",
        "ASR_VLLM_GPU_MEMORY_UTILIZATION",
        "ASR_VLLM_MAX_NUM_SEQS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_engine_tuning_reads_the_service_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASR_VLLM_MAX_NUM_SEQS", "48")
    monkeypatch.setenv("ASR_VLLM_GPU_MEMORY_UTILIZATION", "0.3")
    settings = Settings()
    assert settings.max_num_seqs == 48
    assert settings.gpu_memory_utilization == pytest.approx(0.3)


def test_accepts_the_shared_internal_access_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "tok-123")
    assert Settings().accepted_service_tokens == ("tok-123",)


def test_no_token_configured_means_nothing_accepted() -> None:
    assert Settings().accepted_service_tokens == ()


def test_resident_engines_must_fit_one_gpu_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each vLLM engine claims `gpu_memory_utilization` of the WHOLE card; two at 0.6 cannot fit."""
    monkeypatch.setenv("ASR_VLLM_MAX_RESIDENT_ENGINES", "2")
    monkeypatch.setenv("ASR_VLLM_GPU_MEMORY_UTILIZATION", "0.6")
    with pytest.raises(ValidationError, match="gpu_memory_utilization"):
        Settings()


def test_there_is_no_model_selection_setting() -> None:
    """Model choice arrives per request (the resolved spec); it is never env-configured."""
    forbidden = {"model", "model_path", "model_id", "hf_model", "default_model", "local_path"}
    assert forbidden.isdisjoint(Settings.model_fields)
