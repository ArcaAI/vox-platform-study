"""SMR V2 configuration using pydantic-settings.

All provider configs are loaded simultaneously at startup.
Providers are enabled/disabled via SMR_V2_*_ENABLED flags.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OllamaConfig(BaseSettings):
    """Ollama provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_OLLAMA_")

    enabled: bool = False
    base_url: str = "http://localhost:11434"
    default_model: str = "qwen3.5:2b"
    timeout_s: int = 300
    max_concurrent: int = 4
    queue_backoff_s: float = 2.0


class AzureOpenAIConfig(BaseSettings):
    """Azure OpenAI provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_AZURE_")

    enabled: bool = False
    api_key: SecretStr = SecretStr("")
    endpoint: str = ""
    api_version: str = "2024-12-01-preview"
    deployment_name: str = ""
    default_model: str = "gpt-4"
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 80_000
    rpm_limit: int = 480
    adaptive_limits: bool = True
    content_filter_severity: str = "medium"


class BedrockConfig(BaseSettings):
    """AWS Bedrock provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_BEDROCK_")

    enabled: bool = False
    region: str = "us-east-1"
    default_model: str = "anthropic.claude-3-haiku-20240307-v1:0"
    timeout_s: int = 120
    max_concurrent: int = 10
    max_pool_connections: int = 150
    tpm_limit: int = 100_000
    rpm_limit: int = 100
    throttle_backoff_s: float = 30.0
    guardrail_id: str = ""
    guardrail_version: str = "DRAFT"


class OpenAICompatConfig(BaseSettings):
    """Generic OpenAI-compatible provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_OPENAI_COMPAT_")

    enabled: bool = False
    base_url: str = "http://localhost:1234/v1"
    api_key: SecretStr = SecretStr("not-needed")
    default_model: str = "local-model"
    timeout_s: int = 300
    max_concurrent: int = 4
    organization: str | None = None


class ExternalGuardrailConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SMR_V2_EXTERNAL_GUARDRAIL_")

    enabled: bool = False
    base_url: str = "http://localhost:8863"
    timeout_s: int = 10
    fail_open: bool = False
    require_medical: bool = True
    include_reasoning: bool = False
    service_token: SecretStr = SecretStr("")


class RedisConfig(BaseSettings):
    """Redis configuration for task management."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_")

    redis_url: str = "redis://localhost:6379/0"
    task_ttl_seconds: int = 3600
    stream_max_len: int = 10_000


class CircuitBreakerConfig(BaseSettings):
    """Circuit breaker configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_CB_")

    failure_threshold: int = 5
    recovery_timeout_s: float = 30.0
    half_open_max_calls: int = 3
    reset_timeout_s: float = 120.0
    count_rate_limits: bool = True


class QueueConfig(BaseSettings):
    """Request queue configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_QUEUE_")

    max_size: int = 200
    max_wait_s: float = 60.0


class Settings(BaseSettings):
    """Root application settings.

    All provider sub-configs are loaded independently so every provider
    is available simultaneously at startup.
    """

    model_config = SettingsConfigDict(env_prefix="SMR_V2_")

    # Application
    host: str = "0.0.0.0"
    port: int = 8862
    debug: bool = False
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)
    cors_enabled: bool = False

    # Inter-service authentication (empty = auth disabled for local dev)
    service_token: SecretStr = SecretStr("")

    # Connection pooling
    httpx_max_connections: int = 200
    httpx_max_keepalive: int = 100

    # Guardrails
    guardrail_mode: str = "log"
    guardrail_enabled: bool = True

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "smr-v2"
    metrics_enabled: bool = True

    # Sub-configs (loaded from their own env prefixes)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    azure: AzureOpenAIConfig = Field(default_factory=AzureOpenAIConfig)
    bedrock: BedrockConfig = Field(default_factory=BedrockConfig)
    openai_compat: OpenAICompatConfig = Field(default_factory=OpenAICompatConfig)
    external_guardrail: ExternalGuardrailConfig = Field(default_factory=ExternalGuardrailConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    circuit_breaker: CircuitBreakerConfig = Field(default_factory=CircuitBreakerConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()


def _load_dotenv_into_environ() -> None:
    """Load .env files into os.environ with correct precedence.

    Walks up from this file to find all .env files (up to 10 levels).
    Loads root-level first, then closer ones, so app-level .env
    overrides monorepo root .env.  Explicit env vars always win.
    """
    import os
    import pathlib

    env_files: list[pathlib.Path] = []
    current = pathlib.Path(__file__).resolve().parent
    for _ in range(10):
        candidate = current / ".env"
        if candidate.is_file():
            env_files.append(candidate)
        current = current.parent

    for env_file in reversed(env_files):
        with open(env_file) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = val


def get_settings() -> Settings:
    """Create settings instance.  Not cached — call once at startup."""
    _load_dotenv_into_environ()
    return Settings()
