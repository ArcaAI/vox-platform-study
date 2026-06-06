"""Model-agnostic judge configuration + provider factory tests (TASK-330, 0.5).

RED-first. The judge model MUST be configurable & model-agnostic via env/config:
* an OpenAI-compatible local endpoint (LM Studio / vLLM) is the priority/default
  for a small ≤20B judge,
* Azure OpenAI and AWS Bedrock are opt-in for a large judge,
all selected through env/config — nothing hardcoded. Provider construction is
offline (no network, no boto3 import at build time).
"""

from __future__ import annotations

import pytest

from harness.eval.config import JudgeConfig, JudgeProvider, get_judge_config
from harness.eval.judge.providers import (
    AzureOpenAIJudgeClient,
    BedrockJudgeClient,
    OpenAICompatJudgeClient,
    build_judge_client,
)


class TestDefaults:
    def test_default_provider_is_local_openai_compatible(self):
        cfg = JudgeConfig()
        assert cfg.provider == JudgeProvider.OPENAI_COMPAT
        # LM Studio default endpoint; small ≤20B model by default
        assert "1234" in cfg.openai_compat.base_url
        client = build_judge_client(cfg)
        assert isinstance(client, OpenAICompatJudgeClient)
        assert client.model == cfg.model

    def test_default_model_is_small(self):
        # The default judge is a small (≤20B) self-hosted model (honours D3).
        assert "70b" not in JudgeConfig().model.lower()


class TestProviderSelection:
    def test_build_azure_client(self):
        cfg = JudgeConfig(
            provider=JudgeProvider.AZURE,
            model="gpt-4o",
        )
        cfg.azure.endpoint = "https://example.openai.azure.com"
        cfg.azure.api_key = "secret"  # type: ignore[assignment]
        cfg.azure.deployment = "gpt-4o-judge"
        client = build_judge_client(cfg)
        assert isinstance(client, AzureOpenAIJudgeClient)

    def test_build_bedrock_client_without_importing_boto3(self):
        cfg = JudgeConfig(
            provider=JudgeProvider.BEDROCK,
            model="anthropic.claude-3-5-sonnet-20240620-v1:0",
        )
        client = build_judge_client(cfg)
        assert isinstance(client, BedrockJudgeClient)
        assert client.model == "anthropic.claude-3-5-sonnet-20240620-v1:0"

    def test_unknown_provider_raises(self):
        with pytest.raises((ValueError, TypeError)):
            build_judge_client(JudgeConfig(provider="totally-not-a-provider"))  # type: ignore[arg-type]


class TestFailClosed:
    def test_azure_without_endpoint_fails_closed(self):
        cfg = JudgeConfig(provider=JudgeProvider.AZURE, model="gpt-4o")
        cfg.azure.api_key = "secret"  # type: ignore[assignment]
        cfg.azure.deployment = "dep"
        # endpoint missing → fail closed
        with pytest.raises(ValueError):
            build_judge_client(cfg)

    def test_bedrock_without_model_fails_closed(self):
        # No safe default model id for Bedrock → must be explicit.
        cfg = JudgeConfig(provider=JudgeProvider.BEDROCK, model="")
        with pytest.raises(ValueError):
            build_judge_client(cfg)


class TestEnvDriven:
    def test_env_selects_provider_and_settings(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_JUDGE_PROVIDER", "bedrock")
        monkeypatch.setenv("HARNESS_JUDGE_MODEL", "anthropic.claude-3-haiku-20240307-v1:0")
        monkeypatch.setenv("HARNESS_JUDGE_BEDROCK_REGION", "ap-south-1")

        cfg = get_judge_config()
        assert cfg.provider == JudgeProvider.BEDROCK
        assert cfg.model == "anthropic.claude-3-haiku-20240307-v1:0"
        assert cfg.bedrock.region == "ap-south-1"

        client = build_judge_client(cfg)
        assert isinstance(client, BedrockJudgeClient)

    def test_env_overrides_local_endpoint(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL", "http://my-lmstudio:4321/v1")
        cfg = get_judge_config()
        assert cfg.openai_compat.base_url == "http://my-lmstudio:4321/v1"
