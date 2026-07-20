"""SMR V2 configuration using pydantic-settings.

SMR is a stateless gateway: it does NOT select a provider or model
from env. The gateway (apps/api) injects ``{provider, model}`` (DB-driven) on
every request; SMR only needs each provider's CONNECTION config (base_url /
api_key / region / tuning). There is deliberately NO ``*_ENABLED`` selection
flag — a provider is available iff its connection config is present, and it is
instantiated lazily on first use (see ``main.py`` / ``ProviderRegistry``).

TASK-525: the SERVICE-LEVEL knobs below (``max_concurrent``, ``timeout_s``) are
bootstrap fallbacks — their runtime values come from the control plane via
``core/effective_config.py`` and are applied by ``services/runtime_limits.py``.
The selection contract above is UNCHANGED: effective-config carries capacity and
timeouts only, never a provider or model choice.
"""

from __future__ import annotations

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OllamaConfig(BaseSettings):
    """Ollama provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_OLLAMA_")

    base_url: str = "http://localhost:11434"
    default_model: str = "google/gemma-4-e4b"
    # TASK-525 — bootstrap fallback; runtime value comes from the control plane
    # (effective-config). Applies to `timeout_s` and `max_concurrent` below.
    timeout_s: int = 300
    max_concurrent: int = 4
    queue_backoff_s: float = 2.0


class AzureOpenAIConfig(BaseSettings):
    """Azure OpenAI provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_AZURE_")

    api_key: SecretStr = SecretStr("")
    endpoint: str = ""
    api_version: str = "2024-12-01-preview"
    deployment_name: str = ""
    default_model: str = "gpt-5-mini"
    # TASK-525 — bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 80_000
    rpm_limit: int = 480
    adaptive_limits: bool = True
    content_filter_severity: str = "medium"


class BedrockConfig(BaseSettings):
    """AWS Bedrock provider configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_BEDROCK_")

    region: str = "us-east-1"
    default_model: str = "anthropic.claude-3-5-haiku-20241022-v1:0"
    # TASK-525 — bootstrap fallbacks; runtime values come from the control plane.
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

    base_url: str = "http://localhost:1234/v1"
    api_key: SecretStr = SecretStr("not-needed")
    default_model: str = "google/gemma-4-e4b"
    # TASK-525 — bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 300
    max_concurrent: int = 4
    organization: str | None = None


class VllmConfig(OpenAICompatConfig):
    """vLLM provider configuration.

    vLLM serves the OpenAI wire, so this extends ``OpenAICompatConfig`` (the
    ``VllmProvider`` composes the same async client). ``base_url`` points at the
    ``/v1`` OpenAI surface; ``/health`` and ``/metrics`` live at the server
    root, derived by stripping the ``/v1`` suffix.
    """

    model_config = SettingsConfigDict(env_prefix="SMR_V2_VLLM_")

    base_url: str = "http://localhost:8000/v1"
    default_model: str = ""
    # TASK-525 — bootstrap fallback; runtime value comes from the control plane.
    max_concurrent: int = 8
    # Structured-output routing: vLLM >= 0.8 accepts the native OpenAI
    # ``response_format={"type":"json_schema",...}``. Older builds only support
    # the ``extra_body.guided_json`` path — flip this on for those.
    use_guided_json: bool = False
    # Optional Prometheus scrape target for the prefix-cache hit rate. Empty ⇒
    # derived from ``base_url`` (root + ``/metrics``).
    metrics_url: str = ""


class LlamaCppConfig(BaseSettings):
    """llama.cpp server provider configuration.

    Targets the native ``/completion`` endpoint (richer than llama.cpp's OpenAI
    shim): engine-native ``timings`` + ``stopped_*`` flags feed AD-1 stats, and
    GBNF ``grammar`` / ``json_schema`` structured output are first-class.
    """

    model_config = SettingsConfigDict(env_prefix="SMR_V2_LLAMA_CPP_")

    base_url: str = "http://localhost:8080"
    default_model: str = ""
    # TASK-525 — bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 300
    max_concurrent: int = 4


class ExternalGuardrailConfig(BaseSettings):
    """Input moderation posture for /generate (TASK-338, TASK-478).

    Fail posture is degrade-safe → fail-CLOSED: a transient guardrail error is
    absorbed by a bounded retry, a sustained outage rejects, and an errored
    guardrail NEVER allows (there is deliberately no ``fail_open`` option — that
    foot-gun was retired in TASK-478).
    """

    model_config = SettingsConfigDict(env_prefix="SMR_V2_EXTERNAL_GUARDRAIL_")

    # Dev/CI bypass switch. When False (default) input moderation is intentionally
    # OFF so local dev + hermetic CI run without a guardrail service (mirrors the
    # empty-service-token bypass in TASK-465). Clinical/production deployments MUST
    # enable it — an ops rollout step (guardrail reachable), not a code default that
    # would break dev.
    enabled: bool = False
    base_url: str = "http://localhost:8863"
    timeout_s: int = 10
    # Bounded retry for a transient guardrail blip (TASK-478): the moderation call is
    # retried up to ``max_retries`` extra times (total tries = max_retries + 1) with a
    # linear ``retry_backoff_ms`` backoff before the client fails CLOSED. A momentary
    # error is absorbed (degrade-safe); a sustained outage rejects (never allows).
    max_retries: int = 2
    retry_backoff_ms: int = 100
    # Clinical enforce switch (default True): a reachable guardrail must classify the
    # prompt as medical to allow it. Setting it False is an EXPLICIT, documented
    # non-clinical mode (allow any reachable verdict) — never a silent default.
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
    # D6 (dead-config sweep): these three fields were previously never
    # read by CircuitBreaker. ``None`` preserves the pre-wiring behavior exactly
    # (unlimited HALF_OPEN trial calls / no time-based failure-count decay) — a
    # non-null literal default (the previous 3 / 120.0) would have silently
    # started capping/decaying on every unconfigured deployment now that these
    # are actually wired. Operators opt in via SMR_V2_CB_HALF_OPEN_MAX_CALLS /
    # SMR_V2_CB_RESET_TIMEOUT_S.
    half_open_max_calls: int | None = None
    reset_timeout_s: float | None = None
    count_rate_limits: bool = True


class QueueConfig(BaseSettings):
    """Request queue configuration."""

    model_config = SettingsConfigDict(env_prefix="SMR_V2_QUEUE_")

    max_size: int = 200
    max_wait_s: float = 60.0


class Settings(BaseSettings):
    """Root application settings.

    Each provider sub-config carries only CONNECTION settings (no selection
    flag). A provider is available when its connection config is present and is
    built lazily on first request.
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

    # TASK-525 — where the control plane lives. This is BOOTSTRAP TRANSPORT (the
    # address of the config source), NOT config authority: service-level knobs
    # themselves come from the effective-config route this URL points at.
    # Env var: SMR_V2_GATEWAY_URL.
    gateway_url: str = "http://localhost:8868/api/v1"

    # Connection pooling
    httpx_max_connections: int = 200
    httpx_max_keepalive: int = 100

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "smr-v2"
    otel_service_namespace: str = "hope"
    otel_deployment_environment: str = "production"
    otel_insecure: bool = True
    otel_logs_enabled: bool = True
    metrics_enabled: bool = True

    # Sub-configs (loaded from their own env prefixes)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    azure: AzureOpenAIConfig = Field(default_factory=AzureOpenAIConfig)
    bedrock: BedrockConfig = Field(default_factory=BedrockConfig)
    openai_compat: OpenAICompatConfig = Field(default_factory=OpenAICompatConfig)
    vllm: VllmConfig = Field(default_factory=VllmConfig)
    llama_cpp: LlamaCppConfig = Field(default_factory=LlamaCppConfig)
    external_guardrail: ExternalGuardrailConfig = Field(default_factory=ExternalGuardrailConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    circuit_breaker: CircuitBreakerConfig = Field(default_factory=CircuitBreakerConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)

    # TASK-528 §3.3 — per-provider cap for the `/providers` LISTING probe only
    # (never generation). One hung engine must not stall the endpoint: the
    # shared httpx/AsyncOpenAI clients carry a 300 s generation timeout, which
    # is far too long for an admin-facing listing.
    # Env var: SMR_V2_PROVIDER_PROBE_TIMEOUT_S.
    provider_probe_timeout_s: int = 5

    # TASK-529 (D-10) — model retention hint forwarded to SERVER-MANAGED engines
    # (Ollama `keep_alive`, LM Studio `ttl`). SMR holds no weights of its own, so
    # this is propagation, not a cache.
    #
    # BOOTSTRAP FALLBACK ONLY — the runtime value comes from the control plane
    # (`GET /internal/effective-config?service=smr` → `retention.ttlSeconds`).
    # Env var: SMR_V2_MODEL_RETENTION_TTL_S.
    model_retention_ttl_s: int = 600

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
