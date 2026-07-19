"""TASK-515 — guardrail engine selector accepts the production engines.

vLLM and llama.cpp are self-hosted OpenAI-compatible engines (AD-4). The
guardrail engine selector accepts ``GUARDRAIL_V2_PROVIDER=vllm|llama-cpp`` and
maps each onto the existing OpenAI-compatible client with its own config prefix
(``GUARDRAIL_VLLM_`` / ``GUARDRAIL_LLAMA_CPP_``).
"""

from __future__ import annotations

import pytest

from guardrail.core.config import LlamaCppConfig, Settings, VLLMConfig
from guardrail.core.tenant_config import (
    _PROVIDER_TO_ATTR,
    GuardrailTenantConfig,
    resolve_guardian_engine,
)


class TestProviderValidation:
    @pytest.mark.parametrize("provider", ["vllm", "llama-cpp"])
    def test_provider_accepts_production_engines(self, provider):
        assert Settings(provider=provider).provider == provider

    def test_rejects_unknown_provider(self):
        with pytest.raises(ValueError):
            Settings(provider="not-an-engine")


class TestEngineResolution:
    def test_engine_for_returns_vllm_subconfig(self):
        s = Settings()
        assert isinstance(s.engine_for("vllm"), VLLMConfig)
        assert isinstance(s.engine_for("llama-cpp"), LlamaCppConfig)

    def test_selected_engine_is_openai_compat_shaped(self):
        # base_url + guardrail model fields (OpenAICompatConfig contract) present.
        eng = Settings(provider="vllm").engine
        assert hasattr(eng, "base_url")
        assert hasattr(eng, "guardrail_model")


class TestEnvPrefix:
    def test_vllm_env_prefix(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("GUARDRAIL_VLLM_BASE_URL", "http://localhost:8000/v1")
        assert VLLMConfig().base_url == "http://localhost:8000/v1"

    def test_llama_cpp_env_prefix(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("GUARDRAIL_LLAMA_CPP_BASE_URL", "http://localhost:8080/v1")
        assert LlamaCppConfig().base_url == "http://localhost:8080/v1"


class TestTenantConfigMapping:
    def test_provider_to_attr_has_production_engines(self):
        assert _PROVIDER_TO_ATTR["vllm"] == "vllm"
        assert _PROVIDER_TO_ATTR["llama-cpp"] == "llama_cpp"

    def test_resolve_guardian_engine_for_vllm(self):
        s = Settings()
        tenant_cfg = GuardrailTenantConfig(provider="vllm", model="granite-guardian-4.1-8b")
        provider, engine = resolve_guardian_engine(s, tenant_cfg)
        assert provider == "vllm"
        assert engine.guardrail_model == "granite-guardian-4.1-8b"
