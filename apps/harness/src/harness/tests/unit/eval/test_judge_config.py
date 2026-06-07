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
from pydantic import ValidationError

from harness.eval.config import JudgeConfig, JudgeProvider, get_judge_config
from harness.eval.judge.providers import (
    AzureOpenAIJudgeClient,
    BedrockJudgeClient,
    OpenAICompatJudgeClient,
    build_judge_client,
)


class TestDefaults:
    def test_default_provider_is_local_openai_compatible(self, monkeypatch):
        # Isolate from any ambient .env (dev/CI may redirect the judge to a
        # different endpoint/model, e.g. a local Ollama); this asserts the
        # in-code default, not the operator's environment override.
        for var in (
            "HARNESS_JUDGE_PROVIDER",
            "HARNESS_JUDGE_MODEL",
            "HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL",
        ):
            monkeypatch.delenv(var, raising=False)
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


class TestJsonResponseFormat:
    """json_mode must adapt response_format to the backend (LM Studio rejects
    OpenAI's ``json_object``; the knob lets us omit it and rely on the prompt)."""

    @staticmethod
    def _patch_capture(client: OpenAICompatJudgeClient) -> dict:
        import types

        captured: dict = {}

        async def fake_create(**kwargs):  # noqa: ANN003
            captured.update(kwargs)
            msg = types.SimpleNamespace(content='{"supported": true}')
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])

        client._client.chat.completions.create = fake_create  # type: ignore[attr-defined]
        return captured

    @pytest.mark.asyncio
    async def test_text_format_omits_response_format(self):
        cfg = JudgeConfig(model="google/gemma-4-e4b")
        cfg.openai_compat.json_response_format = "text"
        client = OpenAICompatJudgeClient(cfg)
        captured = self._patch_capture(client)
        await client.complete([{"role": "user", "content": "hi"}], json_mode=True)
        assert "response_format" not in captured  # LM Studio would 400 on json_object

    @pytest.mark.asyncio
    async def test_json_object_format_is_passed_through(self):
        cfg = JudgeConfig(model="google/gemma-4-e4b")  # e.g. Ollama/vLLM backend
        cfg.openai_compat.json_response_format = "json_object"
        client = OpenAICompatJudgeClient(cfg)
        captured = self._patch_capture(client)
        await client.complete([{"role": "user", "content": "hi"}], json_mode=True)
        assert captured.get("response_format") == {"type": "json_object"}


class TestRobustnessDefaults:
    """TASK-330 cross-family hardening: a large token budget + reasoning-aware
    levers so the judge survives reasoning-runaway across model families
    (qwen3.5, gpt-oss, gemma 3/4, medgemma) on LM Studio / Azure / Bedrock."""

    def test_token_budget_and_temperature_defaults(self):
        cfg = JudgeConfig()
        # 8192 (not 2048): a reasoning model can spend thousands of tokens
        # "thinking" before any JSON, so a small budget truncates the answer.
        assert cfg.max_tokens == 8192
        assert cfg.temperature == 0.0
        assert cfg.sc_temperature == 0.2

    def test_reasoning_mode_defaults_to_auto(self):
        assert JudgeConfig().reasoning_mode == "auto"

    def test_extra_body_defaults_to_none(self):
        assert JudgeConfig().extra_body is None

    def test_extra_body_env_json_parses_to_dict(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_JUDGE_EXTRA_BODY", '{"reasoning_effort": "low"}')
        cfg = get_judge_config()
        assert cfg.extra_body == {"reasoning_effort": "low"}

    def test_extra_body_json_string_parses_on_construction(self):
        cfg = JudgeConfig(extra_body='{"chat_template_kwargs": {"enable_thinking": false}}')
        assert cfg.extra_body == {"chat_template_kwargs": {"enable_thinking": False}}

    def test_blank_extra_body_stays_none(self):
        assert JudgeConfig(extra_body="").extra_body is None
        assert JudgeConfig(extra_body=None).extra_body is None

    def test_valid_reasoning_modes_accepted(self):
        for mode in ("auto", "think", "none"):
            assert JudgeConfig(reasoning_mode=mode).reasoning_mode == mode

    def test_invalid_reasoning_mode_raises(self):
        with pytest.raises(ValidationError):
            JudgeConfig(reasoning_mode="loud")
