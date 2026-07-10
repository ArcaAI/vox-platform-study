"""Guardrail configuration using pydantic-settings."""

from __future__ import annotations

from pydantic import AliasChoices, Field, SecretStr, field_validator
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


class DatabaseConfig(BaseSettings):
    """Per-tenant config DB access (TASK-338, decision Q3c).

    When ``db_config_enabled`` is true the service resolves the admin-chosen
    guardrail provider/model **per tenant** at request time by reading
    ``core.GlobalSetting`` directly (SQLAlchemy + asyncpg, mirroring STT-v2),
    with a short TTL cache. When false (the default) the service keeps using the
    env-only engine selected by ``GUARDRAIL_V2_PROVIDER`` — existing deployments
    are unaffected.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_")

    # Disabled by default so env-only deployments behave exactly as before.
    db_config_enabled: bool = False

    # Read-only connection string to the shared HOPE core DB.
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/hope"

    # Fallback tenant used when the request omits X-Tenant-Id or the request
    # tenant has no guardrail rows. Defaults to the seeded GLOBAL tenant
    # (SEED_TENANT_ID) where the cross-worker seed places default guardrail config.
    default_tenant_id: str = "50000000-0000-0000-0000-000000000000"

    # TTL (seconds) for the resolved per-tenant config cache (OQ2 ~60s).
    config_cache_ttl_s: int = 60

    pool_size: int = 5
    max_overflow: int = 10

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Normalize Prisma-style postgres:// URLs to asyncpg form.

        Mirrors STT-v2: convert ``postgres://``/``postgresql://`` to
        ``postgresql+asyncpg://`` and strip the Prisma-only ``?schema=`` param
        that asyncpg rejects.
        """
        if not isinstance(v, str):
            return v
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://") and "+asyncpg" not in v:
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)

        from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

        parsed = urlparse(v)
        if parsed.query:
            params = parse_qs(parsed.query)
            params.pop("schema", None)
            v = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))
        return v


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

    # Inter-service authentication. The gateway provisions this under the
    # canonical GUARDRAIL_SERVICE_TOKEN key (turbo.json / .env.example), so read
    # it verbatim via validation_alias — NOT the GUARDRAIL_V2_ env_prefix, which
    # never matched the gateway and left prod enforcement silently disabled.
    service_token: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("GUARDRAIL_SERVICE_TOKEN"),
    )

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
    db: DatabaseConfig = Field(default_factory=DatabaseConfig)

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

    def engine_for(self, provider: str) -> OpenAICompatConfig | OllamaConfig:
        """Return the env sub-config for an arbitrary provider switch value.

        Falls back to the env-default provider's engine when ``provider`` is
        unknown. ``self.provider`` is always a validated key, so this never
        recurses indefinitely.
        """
        engines: dict[str, OpenAICompatConfig | OllamaConfig] = {
            "lm-studio": self.openai_compat,
            "ollama": self.ollama,
            "azure": self.azure,
            "bedrock": self.bedrock,
        }
        return engines.get((provider or "").strip().lower(), engines[self.provider])

    @property
    def engine(self) -> OpenAICompatConfig | OllamaConfig:
        """Return the sub-config for the selected LLM engine."""
        return self.engine_for(self.provider)


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
