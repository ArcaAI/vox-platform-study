"""Guardrail configuration using pydantic-settings."""

from __future__ import annotations

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OllamaConfig(BaseSettings):
    """Ollama engine configuration (optional, lower-priority local engine).

    Ollama serves generic chat models (e.g. ``gemma3``) over its native API, so the
    providers backed by this config use generic SAFE/UNSAFE prompts rather than the
    Granite Guardian protocol. Select it via ``GUARDRAIL_V2_PROVIDER=ollama``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_OLLAMA_")

    enabled: bool = True
    base_url: str = "http://localhost:11434"

    # Default fallback model for generic guardrail analysis.
    guardrail_model: str = "gemma3:latest"
    content_safety_model: str = "gemma3:latest"
    pii_detection_model: str = "gemma3:latest"
    prompt_injection_model: str = "gemma3:latest"
    comprehensive_model: str = "gemma3:latest"

    # Dedicated guardian model for medical context validation
    guardian_model: str = "gemma3:latest"
    guardian_enabled: bool = True

    timeout_s: int = 60
    max_concurrent: int = 4
    queue_backoff_s: float = 2.0

    # Guardrail-specific settings
    temperature: float = 0.1  # Low temperature for consistent guardrail results
    max_tokens: int = 500    # Reasonable limit for guardrail responses

    # Guardian-specific settings
    guardian_temperature: float = 0.05  # Even lower for medical validation
    guardian_max_tokens: int = 300
    guardian_min_confidence: float = 0.75  # Minimum confidence for medical context


class OpenAICompatConfig(BaseSettings):
    """OpenAI-compatible engine configuration (LM Studio default).

    Drives the Granite Guardian ``<guardian>``/``<score>`` protocol over the
    OpenAI-compatible chat completions API. All guardrail task models default to
    ``granite-guardian-4.1-8b`` (load the matching GGUF in LM Studio, e.g.
    ``lmstudio-community/granite-guardian-4.1-8b-GGUF``). Select it via the default
    ``GUARDRAIL_V2_PROVIDER=lm-studio``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_OPENAI_COMPAT_")

    enabled: bool = True
    base_url: str = "http://localhost:1234/v1"
    api_key: SecretStr = SecretStr("lm-studio")

    # Default fallback model for generic guardrail analysis.
    guardrail_model: str = "granite-guardian-4.1-8b"
    content_safety_model: str = "granite-guardian-4.1-8b"
    pii_detection_model: str = "granite-guardian-4.1-8b"
    prompt_injection_model: str = "granite-guardian-4.1-8b"
    comprehensive_model: str = "granite-guardian-4.1-8b"

    # Dedicated guardian model for medical context validation
    guardian_model: str = "granite-guardian-4.1-8b"
    guardian_enabled: bool = True

    timeout_s: int = 60
    max_concurrent: int = 4
    queue_backoff_s: float = 2.0

    # Guardrail-specific settings
    temperature: float = 0.1  # Low temperature for consistent guardrail results
    max_tokens: int = 500    # Reasonable limit for guardrail responses

    # Guardian-specific settings
    guardian_temperature: float = 0.05  # Even lower for medical validation
    guardian_max_tokens: int = 300
    guardian_min_confidence: float = 0.75  # Minimum confidence for medical context


class AzureOpenAIConfig(OpenAICompatConfig):
    """Azure OpenAI engine (optional). REQUIRES a guardian-capable deployment.

    Azure does not host Granite Guardian, so this engine uses the generic
    SAFE/UNSAFE prompt fallback. Point ``base_url``/``api_key`` at an Azure
    OpenAI-compatible deployment and override the task models. Select it via
    ``GUARDRAIL_V2_PROVIDER=azure``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_AZURE_")

    enabled: bool = False
    base_url: str = ""
    api_key: SecretStr = SecretStr("")


class BedrockConfig(OpenAICompatConfig):
    """AWS Bedrock engine (optional). REQUIRES a guardian-capable model.

    Bedrock is not natively OpenAI-compatible; front it with an OpenAI-compatible
    gateway (e.g. LiteLLM / Bedrock Access Gateway). Uses the generic SAFE/UNSAFE
    prompt fallback. Select it via ``GUARDRAIL_V2_PROVIDER=bedrock``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_BEDROCK_")

    enabled: bool = False
    base_url: str = ""
    api_key: SecretStr = SecretStr("")


class GlinerConfig(BaseSettings):
    """GLiNER ONNX provider configuration for content safety/adversarial/PII."""

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_GLINER_")

    enabled: bool = True
    model_id: str = "hivetrace/gliner-guard-uniencoder-onnx"
    precision: str = "fp32"
    providers: list[str] = Field(
        default_factory=lambda: ["CPUExecutionProvider"],
    )
    classification_threshold: float = 0.4
    pii_threshold: float = 0.5
    max_workers: int = 2  # Thread-pool size for CPU-bound inference


class RedisConfig(BaseSettings):
    """Redis configuration for job queue and caching."""

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_REDIS_")

    redis_url: str = "redis://localhost:6379/0"
    task_ttl_seconds: int = 3600  # 1 hour
    stream_max_len: int = 10000
    cache_ttl_seconds: int = 1800  # 30 minutes


class QueueConfig(BaseSettings):
    """Job queue configuration."""

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_QUEUE_")

    max_wait_s: float = 60.0
    max_retries: int = 3
    retry_backoff_s: float = 1.0
    batch_size: int = 10


class Settings(BaseSettings):
    """Root application settings."""

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_")

    # LLM engine selector: lm-studio (default) | ollama | azure | bedrock
    provider: str = "lm-studio"

    # Application
    host: str = "0.0.0.0"
    port: int = 8863
    debug: bool = False
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)
    cors_enabled: bool = False

    # Inter-service authentication
    service_token: SecretStr = SecretStr("")

    # Connection pooling
    httpx_max_connections: int = 100
    httpx_max_keepalive: int = 50

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "guardrail-v2"
    metrics_enabled: bool = True

    # Sub-configs
    openai_compat: OpenAICompatConfig = Field(default_factory=OpenAICompatConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    azure: AzureOpenAIConfig = Field(default_factory=AzureOpenAIConfig)
    bedrock: BedrockConfig = Field(default_factory=BedrockConfig)
    gliner: GlinerConfig = Field(default_factory=GlinerConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        return v.lower()

    @field_validator("provider")
    @classmethod
    def _validate_provider(cls, v: str) -> str:
        allowed = {"lm-studio", "ollama", "azure", "bedrock"}
        normalized = v.strip().lower()
        if normalized not in allowed:
            raise ValueError(f"provider must be one of {sorted(allowed)}, got {v!r}")
        return normalized

    @property
    def engine(self) -> OpenAICompatConfig | OllamaConfig:
        """Return the sub-config for the selected LLM engine."""
        return {
            "lm-studio": self.openai_compat,
            "ollama": self.ollama,
            "azure": self.azure,
            "bedrock": self.bedrock,
        }[self.provider]


def _load_dotenv_into_environ() -> None:
    """Load .env files into os.environ with correct precedence."""
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
    """Create settings instance."""
    _load_dotenv_into_environ()
    return Settings()
