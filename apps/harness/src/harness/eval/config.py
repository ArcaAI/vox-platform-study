"""Eval-harness configuration (pydantic-settings).

Extends the ``apps/harness`` config conventions (see ``harness.core.config``):
every knob is env-driven with the ``HARNESS_`` family of prefixes; nothing is
hardcoded. The judge is **model-agnostic** — pick the provider via
``HARNESS_JUDGE_PROVIDER`` and configure it with that provider's prefix:

* ``openai_compat`` (default, priority) — a small ≤20B judge on an LM Studio /
  vLLM / any OpenAI-compatible local endpoint (``HARNESS_JUDGE_OPENAI_COMPAT_*``).
* ``azure`` — a large judge via Azure OpenAI (``HARNESS_JUDGE_AZURE_*``).
* ``bedrock`` — a large judge via AWS Bedrock (``HARNESS_JUDGE_BEDROCK_*``).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class JudgeProvider(StrEnum):
    """Selects which backend serves the LLM-as-judge."""

    OPENAI_COMPAT = "openai_compat"  # LM Studio / vLLM / any OpenAI-compatible server
    AZURE = "azure"
    BEDROCK = "bedrock"


class OpenAICompatJudgeConfig(BaseSettings):
    """OpenAI-compatible local endpoint (LM Studio default)."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_OPENAI_COMPAT_")

    base_url: str = "http://localhost:1234/v1"  # LM Studio default
    api_key: SecretStr = SecretStr("lm-studio")
    organization: str | None = None


class AzureJudgeConfig(BaseSettings):
    """Azure OpenAI judge endpoint."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_AZURE_")

    api_key: SecretStr = SecretStr("")
    endpoint: str = ""
    api_version: str = "2024-12-01-preview"
    deployment: str = ""


class BedrockJudgeConfig(BaseSettings):
    """AWS Bedrock judge endpoint."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_BEDROCK_")

    region: str = "us-east-1"


class JudgeConfig(BaseSettings):
    """Root, model-agnostic judge configuration."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_")

    # Priority/default = a small ≤20B model on a local OpenAI-compatible endpoint.
    provider: JudgeProvider = JudgeProvider.OPENAI_COMPAT
    model: str = "qwen2.5-14b-instruct"
    temperature: float = 0.0
    max_tokens: int = 2048
    timeout_s: float = 120.0
    max_retries: int = 2

    # Provider sub-configs (each reads its own env prefix at instantiation).
    openai_compat: OpenAICompatJudgeConfig = Field(default_factory=OpenAICompatJudgeConfig)
    azure: AzureJudgeConfig = Field(default_factory=AzureJudgeConfig)
    bedrock: BedrockJudgeConfig = Field(default_factory=BedrockJudgeConfig)


class EvalConfig(BaseSettings):
    """Eval-run thresholds + golden-set pin (the release-gate knobs)."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_EVAL_")

    # Pinned golden-set version the gate runs against (CI overrides via env).
    golden_set_version: str = "synthetic-v0.1.0"
    golden_set_path: str = ""

    # Release-gate thresholds.
    icc_threshold: float = 0.8
    faithfulness_threshold: float = 0.85
    pdsqi_accurate_threshold: float = 4.0
    pdsqi_thorough_threshold: float = 4.0
    pdsqi_mean_threshold: float = 4.0

    judge: JudgeConfig = Field(default_factory=JudgeConfig)

    @field_validator("icc_threshold", "faithfulness_threshold")
    @classmethod
    def _unit_interval(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError("threshold must be within [0, 1]")
        return v


def _load_env() -> None:
    """Populate ``os.environ`` from ``.env`` files (reuses the core loader)."""
    from harness.core.config import _load_dotenv_into_environ

    _load_dotenv_into_environ()


def get_judge_config() -> JudgeConfig:
    """Build :class:`JudgeConfig` from env / ``.env`` (call once at startup)."""
    _load_env()
    return JudgeConfig()


def get_eval_config() -> EvalConfig:
    """Build :class:`EvalConfig` from env / ``.env`` (call once at startup)."""
    _load_env()
    return EvalConfig()
