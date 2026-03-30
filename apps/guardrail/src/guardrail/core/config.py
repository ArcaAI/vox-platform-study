"""Guardrail configuration using pydantic-settings."""

from __future__ import annotations

from typing import Any

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OllamaConfig(BaseSettings):
    """Ollama provider configuration for guardrails."""

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
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        return v.lower()


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
