"""Model-agnostic judge configuration + provider factory tests.

The judge model MUST be configurable & model-agnostic via env/config:
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
        # different endpoint/model, e.g. a different local vLLM); this asserts
        # the in-code default, not the operator's environment override.
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

    def test_default_model_is_the_canonical_lm_studio_id(self, monkeypatch):
        # gemma-4-e2b-it-qat is the owner-standardized single model
        # resident in LM Studio (verified served by the live dev instance,
        # 2026-08-16) — applied everywhere including harness.judge.
        monkeypatch.delenv("HARNESS_JUDGE_MODEL", raising=False)
        assert JudgeConfig().model == "gemma-4-e2b-it-qat"


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

    def test_ollama_provider_is_accepted_via_openai_compat_client(self):
        # Owner decision 2026-08-20 (/-3): Ollama provider
        # logic stays available platform-wide, including for harness judge
        # selection. Ollama speaks the OpenAI wire over its own ``/v1`` endpoint,
        # so it reuses the shared OpenAICompatJudgeClient — harness gains no
        # Ollama-specific vendor adapter, only an accepted enum member + stop
        # table entry (same treatment as vllm/llama-cpp).
        assert JudgeProvider("ollama") == JudgeProvider.OLLAMA
        cfg = JudgeConfig(provider=JudgeProvider.OLLAMA, model="qwen3:4b")
        cfg.openai_compat.base_url = "http://localhost:11434/v1"
        client = build_judge_client(cfg)
        assert isinstance(client, OpenAICompatJudgeClient)

    # production engines: vllm / llama-cpp are first-class judge
    # providers, both served over the OpenAI-compatible client (they speak the
    # OpenAI wire). Selected via HARNESS_JUDGE_PROVIDER + HARNESS_JUDGE_* config.
    @pytest.mark.parametrize("provider", ["vllm", "llama-cpp"])
    def test_build_vllm_and_llama_cpp_use_openai_compat_client(self, provider):
        cfg = JudgeConfig(provider=JudgeProvider(provider), model="google/gemma-4-e4b")
        cfg.openai_compat.base_url = "http://localhost:8000/v1"
        client = build_judge_client(cfg)
        assert isinstance(client, OpenAICompatJudgeClient)
        assert str(cfg.provider) in ("vllm", "llama-cpp")

    def test_env_selects_vllm_judge(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_JUDGE_PROVIDER", "vllm")
        monkeypatch.setenv("HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL", "http://localhost:8000/v1")
        cfg = get_judge_config()
        assert cfg.provider == JudgeProvider.VLLM
        assert isinstance(build_judge_client(cfg), OpenAICompatJudgeClient)


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

        client._client.chat.completions.create = fake_create  # type: ignore[method-assign,attr-defined]
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
        cfg = JudgeConfig(model="google/gemma-4-e4b")  # e.g. a vLLM backend
        cfg.openai_compat.json_response_format = "json_object"
        client = OpenAICompatJudgeClient(cfg)
        captured = self._patch_capture(client)
        await client.complete([{"role": "user", "content": "hi"}], json_mode=True)
        assert captured.get("response_format") == {"type": "json_object"}


class TestRobustnessDefaults:
    """Cross-family hardening: a large token budget + reasoning-aware
    levers so the judge survives reasoning-runaway across model families
    (qwen3.5, gpt-oss, gemma 3/4, medgemma) on LM Studio / Azure / Bedrock."""

    def test_token_budget_and_temperature_defaults(self):
        cfg = JudgeConfig()
        # 8192 (not 2048): a reasoning model can spend thousands of tokens
        # "thinking" before any JSON, so a small budget truncates the answer.
        assert cfg.max_tokens == 8192
        assert cfg.temperature == 0.0
        assert cfg.sc_temperature == 0.2

    # ── TASK-968: the reasoning levers are GOVERNED, not environmental ──────────
    #
    # These five tests replace the env-driven contract this block used to pin
    # (`reasoning_mode` defaulting to "auto", `HARNESS_JUDGE_EXTRA_BODY` parsing a JSON
    # string, blank-string handling). That contract is gone on purpose: the values now come
    # from `harness.judge.reasoningMode` / `.reasoningEffort` on the platform settings
    # registry, and the env path is closed structurally by a dead `validation_alias`.

    def test_reasoning_defaults_are_off(self):
        """The in-code FLOOR is the directive, not the engine's own default."""
        cfg = JudgeConfig()
        assert cfg.reasoning_mode == "none"
        assert cfg.reasoning_effort == "minimal"
        # `extra_body` stays the GENERIC passthrough; the posture is its own field, so a
        # client that never consulted the control plane still sends one.
        assert cfg.extra_body is None

    @pytest.mark.parametrize(
        "env_name,env_value",
        [
            ("HARNESS_JUDGE_REASONING_MODE", "auto"),
            ("HARNESS_JUDGE_SUPPRESS_REASONING", "true"),
            ("HARNESS_JUDGE_EXTRA_BODY", '{"reasoning_effort": "high"}'),
            ("HARNESS_JUDGE_REASONING_EFFORT", "high"),
        ],
    )
    def test_env_cannot_set_the_reasoning_posture(
        self, monkeypatch: pytest.MonkeyPatch, env_name: str, env_value: str
    ):
        """The env path is CLOSED — a redeploy is no longer how this is retuned."""
        monkeypatch.setenv(env_name, env_value)
        cfg = get_judge_config()
        assert cfg.reasoning_mode == "none"
        assert cfg.reasoning_effort == "minimal"
        assert cfg.extra_body is None

    def test_field_name_construction_is_closed_too(self):
        """`validation_alias` also stops the FIELD NAME re-opening the path."""
        for kwargs in (
            {"reasoning_mode": "auto"},
            {"reasoning_effort": "high"},
            {"extra_body": {"reasoning_effort": "high"}},
            {"suppress_reasoning": True},
        ):
            with pytest.raises(ValidationError):
                JudgeConfig(**kwargs)

    def test_model_copy_is_the_one_way_in(self):
        """What `resolve_judge_reasoning` and `_build_runtime_judge` actually use."""
        cfg = JudgeConfig().model_copy(
            update={"reasoning_mode": "think", "reasoning_effort": "high"}
        )
        assert (cfg.reasoning_mode, cfg.reasoning_effort) == ("think", "high")
