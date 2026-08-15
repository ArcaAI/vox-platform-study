"""SMR configuration using pydantic-settings.

SMR is a stateless gateway: it does NOT select a provider or model
from env. The gateway (apps/api) injects ``{provider, model}`` (DB-driven) on
every request; SMR only needs each provider's CONNECTION config (base_url /
api_key / region / tuning). There is deliberately NO ``*_ENABLED`` selection
flag — a provider is available iff its connection config is present, and it is
instantiated lazily on first use (see ``main.py`` / ``ProviderRegistry``).

The SERVICE-LEVEL knobs below (``max_concurrent``, ``timeout_s``) are
bootstrap fallbacks — their runtime values come from the control plane via
``core/effective_config.py`` and are applied by ``services/runtime_limits.py``.
The selection contract above is UNCHANGED: effective-config carries capacity and
timeouts only, never a provider or model choice.

the five CLOUD sub-configs (``AzureOpenAIConfig``, ``BedrockConfig``,
``OpenAIConfig``, ``AnthropicConfig``, ``VertexConfig``) carry no compiled-in
vendor ``default_model`` — the field defaults to ``""`` and is retained ONLY
as informational metadata for the ``/providers`` listing. Provider/model
SELECTION is ``failMode=closed``: a cloud generate request that resolves no
model raises ``ModelNotSelectedError`` (``providers/base.py`` ``require_model``)
instead of silently substituting a vendor model. Local/built-in engines
(``OllamaConfig``, ``OpenAICompatConfig``, ``VllmConfig``, ``LlamaCppConfig``)
are unaffected — their model default is acceptable built-in topology.
"""

from __future__ import annotations

import os

from hope_env import hope_settings_sources, load_env
from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Env_prefix is TEXT_*; AliasChoices("…", "V2_…") + env_prefix_target
# "all" also accepts TEXT_V2_* for the transition window.
_SETTINGS_ALIASES = SettingsConfigDict(
    env_prefix="TEXT_",
    env_prefix_target="all",
    populate_by_name=True,
)


class OllamaConfig(BaseSettings):
    """Ollama provider configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_OLLAMA_")

    base_url: str = "http://localhost:11434"
    # An OLLAMA-format tag, not a Hugging Face path. This read
    # `google/gemma-4-e4b` — an id no Ollama has ever served, copied from the
    # LM Studio config below, which was itself wrong (see OpenAICompatConfig).
    # Note in-cluster Ollama was retired in favour of LM Studio, so this default
    # is currently unreachable in the deployed topology; it is corrected rather
    # than removed because the provider is still a supported local engine.
    default_model: str = "gemma4:e2b-it-qat"
    # Bootstrap fallback; runtime value comes from the control plane
    # (effective-config). Applies to `timeout_s` and `max_concurrent` below.
    timeout_s: int = 300
    max_concurrent: int = 4
    queue_backoff_s: float = 2.0


class AzureOpenAIConfig(BaseSettings):
    """Azure OpenAI provider configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_AZURE_")

    # Azure OpenAI is BYOK-only. The api_key is NEVER sourced from env —
    # the `validation_alias` is a dead name no env var (nor Vault-Agent secrets_dir
    # file) matches, and `populate_by_name` is OFF, so `TEXT_AZURE_API_KEY` cannot
    # repopulate it either. The platform default and per-tenant keys both arrive as
    # a request `ProviderOverride` (gateway tenant→SYSTEM cascade). A non-empty
    # api_key here only occurs in tests (constructed via `model_copy`) — the
    # provider builds its shared client lazily from it; empty ⇒ no client, and a
    # keyless generate raises `ProviderCredentialsError` (503).
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TEXT_AZURE_API_KEY__ENV_REMOVED_TASK_602",
    )
    endpoint: str = ""
    api_version: str = "2024-12-01-preview"
    deployment_name: str = ""
    # No compiled-in vendor model — provider/model SELECTION is
    # failMode=closed (09-infrastructure-devops.md §Configuration Tiers).
    # Informational only (providers listing); never substituted into a
    # generation request — a missing model raises (see `providers/base.py`
    # `require_model`).
    default_model: str = ""
    # Bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 80_000
    rpm_limit: int = 480
    adaptive_limits: bool = True
    content_filter_severity: str = "medium"


class BedrockConfig(BaseSettings):
    """AWS Bedrock provider configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_BEDROCK_")

    region: str = "us-east-1"
    # No compiled-in vendor model — see AzureOpenAIConfig.default_model.
    default_model: str = ""
    # Bootstrap fallbacks; runtime values come from the control plane.
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_OPENAI_COMPAT_")

    base_url: str = "http://localhost:1234/v1"
    api_key: SecretStr = SecretStr("not-needed")
    # This must be an identifier LM Studio actually serves — it is sent verbatim
    # as the OpenAI-wire `model`. It read `google/gemma-4-e4b`, which LM Studio
    # has never served under any configuration (the installed E4B build is
    # `google/gemma-4-e4b-qat`), so anything reaching this default got a 400
    # "Failed to load model". The same missing `-qat` reached the AiModel
    # catalogue and broke `harness.judge`.
    # Set to the model the SYSTEM AiTaskDefault actually selects for smr.live /
    # smr.finalize, and the one pre-loaded on the dev host. Verified served:
    # `curl http://<lmstudio>:1234/v1/models`.
    default_model: str = "gemma-4-e2b-it-qat"
    # Bootstrap fallbacks; runtime values come from the control plane.
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

    model_config = SettingsConfigDict(env_prefix="TEXT_VLLM_")

    base_url: str = "http://localhost:8000/v1"
    default_model: str = ""
    # Bootstrap fallback; runtime value comes from the control plane.
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_LLAMA_CPP_")

    base_url: str = "http://localhost:8080"
    default_model: str = ""
    # Bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 300
    max_concurrent: int = 4


class OpenAIConfig(BaseSettings):
    """OpenAI (api.openai.com) provider configuration — BYO/tenant-first.

    The OpenAI wire is identical to ``OpenAICompatConfig``'s, but this is the
    governed first-class ``openai`` provider (a tenant BYO key arrives per
    request as a ``ProviderOverride``).

    the api_key is BYOK-only — NEVER sourced from env (dead
    `validation_alias`, `populate_by_name` OFF; ``TEXT_OPENAI_API_KEY`` no longer
    populates it). The platform default and per-tenant keys both arrive as a
    request ``ProviderOverride``; a keyless generate raises
    ``ProviderCredentialsError`` (503). A non-empty api_key occurs only in tests
    (via ``model_copy``).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_OPENAI_")

    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TEXT_OPENAI_API_KEY__ENV_REMOVED_TASK_602",
    )
    base_url: str = "https://api.openai.com/v1"
    # No compiled-in vendor model — see AzureOpenAIConfig.default_model.
    default_model: str = ""
    organization: str | None = None
    # Bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 0
    rpm_limit: int = 0


class AnthropicConfig(BaseSettings):
    """Anthropic (Claude Messages API) provider configuration — BYO/tenant-first.

    ``base_url`` empty ⇒ the SDK default (``https://api.anthropic.com``).

    same BYOK-only credential rule as ``OpenAIConfig`` — the api_key is
    NEVER sourced from env (dead `validation_alias`, `populate_by_name` OFF;
    ``TEXT_ANTHROPIC_API_KEY`` no longer populates it). The credential arrives per
    request as a ``ProviderOverride``; a keyless generate raises
    ``ProviderCredentialsError`` (503).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_ANTHROPIC_")

    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TEXT_ANTHROPIC_API_KEY__ENV_REMOVED_TASK_602",
    )
    base_url: str = ""
    # No compiled-in vendor model — see AzureOpenAIConfig.default_model.
    default_model: str = ""
    # Bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 0
    rpm_limit: int = 0


class VertexConfig(BaseSettings):
    """Google Vertex AI (Gemini) provider configuration — BYO/tenant-first.

    A Vertex client is bound to a ``(project, location)`` pair and authenticated
    with Application Default Credentials by default. A tenant BYO credential
    instead carries a service-account JSON (``ProviderOverride.api_key``) plus
    its ``project``/``location``. The env values below are the platform fallback
    (ADC-authenticated) used when no tenant override is present; an empty
    ``project`` means no platform fallback is configured.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_VERTEX_")

    project: str = ""
    location: str = "us-central1"
    # No compiled-in vendor model — see AzureOpenAIConfig.default_model.
    default_model: str = ""
    # Bootstrap fallbacks; runtime values come from the control plane.
    timeout_s: int = 120
    max_concurrent: int = 10
    tpm_limit: int = 0
    rpm_limit: int = 0


class SarvamConfig(BaseSettings):
    """Sarvam AI translation provider configuration — BYOK-ONLY.

    SMR's ``translate`` capability routes to Sarvam's REST ``/translate``
    endpoint. Sarvam is BYOK-only: the api_key NEVER comes from env — it always
    arrives per request as a ``ProviderOverride`` (the gateway resolves it from
    the tenant/global-admin provider-connection). This config therefore carries
    only NON-secret operational settings; a request with no override key fails
    closed (endpoint → 503).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_SARVAM_")

    base_url: str = "https://api.sarvam.ai"
    model: str | None = None


class ExternalGuardrailConfig(BaseSettings):
    """Input moderation posture for /generate.

    Fail posture is degrade-safe → fail-CLOSED: a transient guardrail error is
    absorbed by a bounded retry, a sustained outage rejects, and an errored
    guardrail NEVER allows (there is deliberately no ``fail_open`` option — that
    foot-gun was retired).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_EXTERNAL_GUARDRAIL_")

    # Dev/CI bypass switch. When False (default) input moderation is intentionally
    # OFF so local dev + hermetic CI run without a guardrail service (mirrors the
    # empty-service-token bypass). Clinical/production deployments MUST
    # enable it — an ops rollout step (guardrail reachable), not a code default that
    # would break dev.
    enabled: bool = False
    base_url: str = "http://localhost:8863"
    timeout_s: int = 10
    # Bounded retry for a transient guardrail blip: the moderation call is
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


class TelemetryPhiGuardConfig(BaseSettings):
    """PHI-safe telemetry boot guard.

    ``NODE_ENV`` and ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT``
    are cross-process conventions read identically by every HOPE deployable —
    the TypeScript gateway's ``assertGenaiContentCaptureDisabled``
    (``apps/api/src/bootstrap/genai-content-capture-audit.ts``) reads the
    SAME bare names. ``Settings`` applies ``env_prefix="TEXT_"`` with
    ``env_prefix_target="all"``, which would otherwise turn these into
    ``TEXT_NODE_ENV`` / ``TEXT_OTEL_INSTRUMENTATION_...`` — names nothing else
    reads — so this nested config carries no prefix of its own.

    OTel GenAI instrumentation defaults to NOT capturing prompt/completion
    content, but the capture switch is an instrumentation-library convention
    absent from the official OTel SDK env-var spec: a library that ignores it
    captures content (PHI) anyway. Layer 1 of the 4-layer PHI-safe telemetry
    defense (docs/operations/telemetry-phi-guardrails.md) is pinning this
    switch to ``NO_CONTENT`` everywhere; the validator below turns "pinned"
    into "enforced" for production, mirroring the gateway boot audit's
    posture — refuse to construct rather than silently run unsafe.

    Deliberately no default other than the empty string for
    ``genai_capture_message_content``: "unset" and "explicitly NO_CONTENT"
    must stay distinguishable so a production deploy that forgot to set the
    var fails loudly instead of resolving to a safe-looking default. Outside
    production the var is unenforced (dev/test are not a PHI exposure
    surface, and the env-sample flow already pins ``NO_CONTENT`` as the
    template default there).
    """

    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(populate_by_name=True)

    node_env: str = Field(default="development", validation_alias="NODE_ENV")
    genai_capture_message_content: str = Field(
        default="", validation_alias="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
    )

    @model_validator(mode="after")
    def _assert_content_capture_disabled_in_production(self) -> TelemetryPhiGuardConfig:
        if self.node_env == "production" and self.genai_capture_message_content != "NO_CONTENT":
            raise ValueError(
                "Refusing to boot: OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT must be "
                f"exactly 'NO_CONTENT' in production (got {self.genai_capture_message_content!r} "
                "-- unset counts as wrong). This switch prevents OTel GenAI instrumentation from "
                "capturing PHI-bearing prompt/completion content in spans. See "
                "docs/operations/telemetry-phi-guardrails.md."
            )
        return self


class RedisConfig(BaseSettings):
    """Redis configuration for task management."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_")

    redis_url: str = "redis://localhost:6379/0"
    task_ttl_seconds: int = 3600
    stream_max_len: int = 10_000


class CircuitBreakerConfig(BaseSettings):
    """Circuit breaker configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_CB_")

    failure_threshold: int = 5
    recovery_timeout_s: float = 30.0
    # ``None`` preserves the default unlimited/undecayed behavior
    # (unlimited HALF_OPEN trial calls / no time-based failure-count decay) — a
    # non-null literal default would silently start capping/decaying on every
    # unconfigured deployment now that these fields are wired. Operators opt in
    # via TEXT_CB_HALF_OPEN_MAX_CALLS / TEXT_CB_RESET_TIMEOUT_S.
    half_open_max_calls: int | None = None
    reset_timeout_s: float | None = None
    count_rate_limits: bool = True


class QueueConfig(BaseSettings):
    """Request queue configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_QUEUE_")

    max_size: int = 200
    max_wait_s: float = 60.0


class Settings(BaseSettings):
    """Root application settings.

    Each provider sub-config carries only CONNECTION settings (no selection
    flag). A provider is available when its connection config is present and is
    built lazily on first request.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = _SETTINGS_ALIASES

    # Application — AliasChoices accepts TEXT_* and TEXT_V2_* (env_prefix_target=all).
    host: str = Field(default="0.0.0.0", validation_alias=AliasChoices("HOST", "V2_HOST"))
    port: int = Field(default=8862, validation_alias=AliasChoices("PORT", "V2_PORT"))
    debug: bool = Field(default=False, validation_alias=AliasChoices("DEBUG", "V2_DEBUG"))
    log_level: str = Field(
        default="info", validation_alias=AliasChoices("LOG_LEVEL", "V2_LOG_LEVEL")
    )
    cors_origins: list[str] = Field(
        default_factory=list, validation_alias=AliasChoices("CORS_ORIGINS", "V2_CORS_ORIGINS")
    )
    cors_enabled: bool = Field(
        default=False, validation_alias=AliasChoices("CORS_ENABLED", "V2_CORS_ENABLED")
    )

    # Inter-service authentication (empty = auth disabled for local dev)
    service_token: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("SERVICE_TOKEN", "V2_SERVICE_TOKEN")
    )

    # Where the control plane lives. This is BOOTSTRAP TRANSPORT (the
    # address of the config source), NOT config authority: service-level knobs
    # themselves come from the effective-config route this URL points at.
    # Env var: TEXT_GATEWAY_URL.
    gateway_url: str = Field(
        default="http://localhost:8868/api/v1",
        validation_alias=AliasChoices("GATEWAY_URL", "V2_GATEWAY_URL"),
    )

    # Connection pooling
    httpx_max_connections: int = Field(
        default=200,
        validation_alias=AliasChoices("HTTPX_MAX_CONNECTIONS", "V2_HTTPX_MAX_CONNECTIONS"),
    )
    httpx_max_keepalive: int = Field(
        default=100, validation_alias=AliasChoices("HTTPX_MAX_KEEPALIVE", "V2_HTTPX_MAX_KEEPALIVE")
    )

    # Observability
    otel_enabled: bool = Field(
        default=False, validation_alias=AliasChoices("OTEL_ENABLED", "V2_OTEL_ENABLED")
    )
    otel_exporter_endpoint: str = Field(
        default="http://localhost:4317",
        validation_alias=AliasChoices("OTEL_EXPORTER_ENDPOINT", "V2_OTEL_EXPORTER_ENDPOINT"),
    )
    otel_service_name: str = Field(
        default="smr", validation_alias=AliasChoices("OTEL_SERVICE_NAME", "V2_OTEL_SERVICE_NAME")
    )
    otel_service_namespace: str = Field(
        default="hope",
        validation_alias=AliasChoices("OTEL_SERVICE_NAMESPACE", "V2_OTEL_SERVICE_NAMESPACE"),
    )
    # Resolved from the environment, defaulting to DEVELOPMENT.
    #
    # This defaulted to "production" and was the ORIGIN of the defect across the
    # fleet: `apps/text/core/observability.py` is the reference implementation
    # every other service's OTel setup was copied from, so harness and TTS both
    # inherited a hardcoded "production" when they were added in this ticket.
    # STT had the same literal in its resource builder.
    #
    # A hardcoded "production" tags a developer laptop's spans as production
    # data. That is the dangerous direction — a mislabelled dev span is noise,
    # a mislabelled prod span corrupts an audit trail.
    otel_deployment_environment: str = Field(
        default_factory=lambda: os.getenv("DEPLOYMENT_ENVIRONMENT")
        or os.getenv("NODE_ENV")
        or "development",
        validation_alias=AliasChoices(
            "OTEL_DEPLOYMENT_ENVIRONMENT", "V2_OTEL_DEPLOYMENT_ENVIRONMENT"
        ),
    )
    otel_insecure: bool = Field(
        default=True, validation_alias=AliasChoices("OTEL_INSECURE", "V2_OTEL_INSECURE")
    )
    otel_logs_enabled: bool = Field(
        default=True, validation_alias=AliasChoices("OTEL_LOGS_ENABLED", "V2_OTEL_LOGS_ENABLED")
    )
    metrics_enabled: bool = Field(
        default=True, validation_alias=AliasChoices("METRICS_ENABLED", "V2_METRICS_ENABLED")
    )

    # Sub-configs (loaded from their own env prefixes)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    azure: AzureOpenAIConfig = Field(default_factory=AzureOpenAIConfig)
    bedrock: BedrockConfig = Field(default_factory=BedrockConfig)
    openai: OpenAIConfig = Field(default_factory=OpenAIConfig)
    anthropic: AnthropicConfig = Field(default_factory=AnthropicConfig)
    vertex: VertexConfig = Field(default_factory=VertexConfig)
    openai_compat: OpenAICompatConfig = Field(default_factory=OpenAICompatConfig)
    vllm: VllmConfig = Field(default_factory=VllmConfig)
    llama_cpp: LlamaCppConfig = Field(default_factory=LlamaCppConfig)
    sarvam: SarvamConfig = Field(default_factory=SarvamConfig)
    external_guardrail: ExternalGuardrailConfig = Field(default_factory=ExternalGuardrailConfig)
    # Raises at construction time (propagates out of
    # `Settings()` -> `get_settings()` -> `create_app()`) when NODE_ENV=production
    # and OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT is not pinned.
    telemetry_phi_guard: TelemetryPhiGuardConfig = Field(default_factory=TelemetryPhiGuardConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    circuit_breaker: CircuitBreakerConfig = Field(default_factory=CircuitBreakerConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)

    # Per-provider cap for the `/providers` LISTING probe only
    # (never generation). One hung engine must not stall the endpoint: the
    # shared httpx/AsyncOpenAI clients carry a 300 s generation timeout, which
    # is far too long for an admin-facing listing.
    # Env var: TEXT_PROVIDER_PROBE_TIMEOUT_S.
    provider_probe_timeout_s: int = Field(
        default=5,
        validation_alias=AliasChoices("PROVIDER_PROBE_TIMEOUT_S", "V2_PROVIDER_PROBE_TIMEOUT_S"),
    )

    # Model retention hint forwarded to SERVER-MANAGED engines
    # (Ollama `keep_alive`, LM Studio `ttl`). SMR holds no weights of its own, so
    # this is propagation, not a cache.
    #
    # BOOTSTRAP FALLBACK ONLY — the runtime value comes from the control plane
    # (`GET /internal/effective-config?service=smr` → `retention.ttlSeconds`).
    # Env var: TEXT_MODEL_RETENTION_TTL_S.
    model_retention_ttl_s: int = Field(
        default=600,
        validation_alias=AliasChoices("MODEL_RETENTION_TTL_S", "V2_MODEL_RETENTION_TTL_S"),
    )

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()


def get_settings() -> Settings:
    """Create settings instance.  Not cached — call once at startup."""
    load_env()
    return Settings()
