"""Guardrail configuration using pydantic-settings."""

from __future__ import annotations

from typing import Annotated

from hope_env import first_real_secret, hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OpenAICompatConfig(BaseSettings):
    """OpenAI-compatible engine configuration (LM Studio default).

    Drives the Granite Guardian ``<guardian>``/``<score>`` protocol over the
    OpenAI-compatible chat completions API. All guardrail task models default to
    ``granite-guardian-4.1-8b`` (load the matching GGUF in LM Studio, e.g.
    ``lmstudio-community/granite-guardian-4.1-8b-GGUF``). Select it via the default
    ``GUARDRAIL_V2_PROVIDER=lm-studio``.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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
    max_tokens: int = 500  # Reasonable limit for guardrail responses

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


class VLLMConfig(OpenAICompatConfig):
    """vLLM engine (production self-host, AD-4). OpenAI-compatible wire.

    Point ``base_url`` at the vLLM server (``/v1``) serving a guardian-capable
    model (Granite Guardian). Disabled by default — enable it and select via
    ``GUARDRAIL_V2_PROVIDER=vllm``. Config prefix ``GUARDRAIL_VLLM_``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_VLLM_")

    enabled: bool = False
    base_url: str = "http://localhost:8000/v1"


class LlamaCppConfig(OpenAICompatConfig):
    """llama.cpp server engine (production self-host, AD-4). OpenAI-compatible
    ``/v1`` wire. GGUF tier; select via ``GUARDRAIL_V2_PROVIDER=llama-cpp``.
    Config prefix ``GUARDRAIL_LLAMA_CPP_``.
    """

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_LLAMA_CPP_")

    enabled: bool = False
    base_url: str = "http://localhost:8080/v1"


class GlinerConfig(BaseSettings):
    """GLiNER ONNX provider configuration for content safety/adversarial/PII."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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


class GroundednessConfig(BaseSettings):
    """Live output-side NLI groundedness gate.

    ``False`` (default) is the dev / hermetic-CI
    bypass — the gate answers honestly with ``unverified`` verdicts and never loads a
    model; ``True`` is the clinical enforce posture and requires the SELF-HOSTED
    MiniCheck-class NLI model staged on the host (track guardrail: no cloud PHI).
    Fail posture is FAIL-CLOSED throughout: a disabled gate, an un-staged model, or a
    scoring error all degrade to ``unverified`` — no path ever yields ``grounded``
    without the model actually entailing the segment.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_GROUNDEDNESS_")

    enabled: bool = False

    # Self-hosted NLI entailment model — MiniCheck-Flan-T5-Large, GGUF/llama.cpp backend
    # (owner directive 2026-07-11). `model_id`/`model_file` are provenance + logging;
    # the scorer loads from the explicit local `model_path` (no network pull in the
    # clinical gate). >500 docs/min live-loop target; Q6 quant is CPU-friendly.
    model_id: str = "nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"
    model_file: str = "minicheck-flan-t5-large-q6_k.gguf"
    # Explicit local .gguf path.
    # BOOTSTRAP FALLBACK ONLY. The runtime value now comes from
    # the `AiModel` registry row (`minicheck-flan-t5-large`): `localPath` first,
    # then a resolvable `file://` / `s3://` `sourceUri`. This env var is used when
    # the registry carries no path, which keeps deployments working
    # byte-for-byte. Unset in BOTH places ⇒ fail-closed to 'unverified', unchanged.
    model_path: str | None = None
    # Cache dir for weights materialised from an `s3://` source_uri.
    model_cache_dir: str = "/models/guardrail-cache"
    # llama.cpp runtime knobs (CPU-default: the Q6 quant needs no GPU).
    # n_ctx = 512 matches Flan-T5's training context (`n_ctx_train`); MiniCheck itself
    # windows long documents to ~512-token chunks, so a larger context only wastes the
    # encoder KV alloc and trips llama.cpp's `n_ctx_seq > n_ctx_train` overflow warning.
    n_ctx: int = 512
    n_threads: int | None = None
    n_gpu_layers: int = 0

    # A segment is `grounded` only when its entailment score >= this threshold.
    # Bounded to [0,1] so a fat-fingered threshold (e.g. a
    # negative or >1 value) is rejected at startup ("fail fast") rather than silently
    # marking everything grounded on an honest checked:true response (a config fail-open
    # on a clinical gate).
    # Annotated (not a Field default) so a plain `0.5` default keeps GroundednessConfig
    # zero-arg constructible for mypy — a bare `Field(0.5, ...)` default makes the model
    # look arg-required without the pydantic mypy plugin and breaks the parent's
    # `default_factory=GroundednessConfig` typing. Same ge/le validation as before.
    entailment_threshold: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5

    # Segments per scorer batch — the throughput lever for the >500 docs/min target.
    batch_size: int = 16

    # Hard per-request bound on scored segments; excess segments degrade to `unverified`
    # (never silently skipped as if verified).
    max_segments: int = 200


class RedisConfig(BaseSettings):
    """Redis configuration for job queue and caching."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_REDIS_")

    redis_url: str = "redis://localhost:6379/0"
    task_ttl_seconds: int = 3600  # 1 hour
    stream_max_len: int = 10000
    cache_ttl_seconds: int = 1800  # 30 minutes


class QueueConfig(BaseSettings):
    """Job queue configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_QUEUE_")

    max_wait_s: float = 60.0
    max_retries: int = 3
    retry_backoff_s: float = 1.0
    batch_size: int = 10


class DatabaseConfig(BaseSettings):
    """Per-tenant config DB access.

    When ``db_config_enabled`` is true (the default) the service
    resolves the admin-chosen guardrail provider/model **per tenant** at request
    time by reading ``core."AiTaskDefault"`` ⋈ ``core."AiModel"`` directly
    (SQLAlchemy + asyncpg, mirroring STT), with a short TTL cache. When false
    the service uses only the env-selected engine (``GUARDRAIL_V2_PROVIDER``).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_")

    # Enabled by default: the resolver (get_resolved_guardian_provider in
    # core/dependencies.py) fails CLOSED (HTTP 503) when the SYSTEM
    # AiTaskDefault selection for "guardrail.validate" is missing or a DB
    # error occurs — there is no silent fallback to an env-selected engine.
    # Setting this to False is a dev-only escape hatch: it makes the service
    # use GUARDRAIL_V2_PROVIDER (below) directly, bypassing DB resolution
    # entirely, for local development without a reachable Postgres.
    db_config_enabled: bool = True

    # Read-only connection string to the shared HOPE core DB.
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/hope"

    # There is deliberately NO `default_tenant_id`. The runtime cascade is
    # exactly request tenant → SYSTEM (`00000000-…`), and SYSTEM is the DECLARED
    # widening target inside the resolver, not a configurable knob. The retired
    # `GUARDRAIL_DEFAULT_TENANT_ID` defaulted to `50000000-…`, which is the
    # "Global" CUSTOMER tenant (a platform-admin playground) — so every tenant
    # without its own rows was served one customer's safety configuration. See
    # `core/tenant_config.py`'s module docstring.

    # TTL (seconds) for the resolved per-tenant config cache (OQ2 ~60s).
    config_cache_ttl_s: int = 60

    pool_size: int = 5
    max_overflow: int = 10

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Normalize Prisma-style postgres:// URLs to asyncpg form.

        Mirrors STT: convert ``postgres://``/``postgresql://`` to
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_")

    # LLM engine selector: lm-studio (default) | vllm | llama-cpp | azure | bedrock
    # Dev-only escape hatch: consumed only when DatabaseConfig.db_config_enabled
    # is False, i.e. DB-backed provider resolution is deliberately bypassed.
    provider: str = "lm-studio"

    # Bootstrap credentials for `s3://` model sources (MinIO-compatible).
    # All optional: unset simply means an `s3://` source_uri errors cleanly and the
    # caller falls back to its env path. Env names: GUARDRAIL_V2_MODEL_S3_*.
    model_s3_endpoint: str | None = None
    model_s3_access_key: SecretStr | None = None
    model_s3_secret_key: SecretStr | None = None
    model_s3_secure: bool = True

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

    # ── CANONICAL internal credential (owner decision D-D, 2026-08-17) ──────
    # ONE shared access token for ALL internal service-to-service communication,
    # identical across every HOPE service, set by the DevOps engineer, internal use
    # only. Unprefixed on purpose (`validation_alias` bypasses the env_prefix) —
    # it belongs to no single service. This is what the service ACCEPTS inbound as
    # `X-Service-Token` and PRESENTS on every outbound peer call.
    # The legacy per-service token below stays accepted / used as a zero-cost
    # backward-compatibility fallback; both empty ⇒ auth bypassed (dev / CI).
    internal_access_token: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("INTERNAL_ACCESS_TOKEN")
    )

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``, shared token first.

        Empty tuple ⇒ auth is bypassed (local dev / hermetic CI) — the pre-existing
        behaviour when no token is configured at all.
        """
        # `real_secret` maps the unfilled-secret sentinel onto "" so a `CHANGE_ME` token is
        # never ACCEPTED as a credential — see hope_env.placeholders.
        return tuple(
            t
            for t in (
                real_secret(self.internal_access_token),
                real_secret(self.service_token),
            )
            if t
        )

    def peer_service_token(self, legacy: SecretStr) -> str:
        """Token to PRESENT on an outbound peer call: shared first, legacy fallback."""
        # `first_real_secret`, not `or`: the sentinel is a NON-EMPTY string, so a plain
        # truthiness chain returns "CHANGE_ME" and never reaches the legacy fallback — the
        # trap that made every internal hop 401 (see hope_env.placeholders).
        return first_real_secret(self.internal_access_token, legacy)

    # Where the control plane lives (env GUARDRAIL_V2_GATEWAY_URL).
    # This is BOOTSTRAP TRANSPORT (the address of the config source), NOT config
    # authority: the retention knobs themselves come from the effective-config
    # route this URL points at.
    gateway_url: str = "http://localhost:8868/api/v1"

    # Connection pooling
    httpx_max_connections: int = 100
    httpx_max_keepalive: int = 50

    # Aux-model cache policy. Infra tuning only — cache-policy bounds,
    # NOT model selection. Idle TTL is clamped to the product window [60s, 3600s]
    # so both GLiNER and MiniCheck release when idle. `model_cache_max_models`
    # bounds how many distinct model ids are held per aux cache.
    # Bootstrap fallback ONLY; the runtime value comes from the
    # control plane (`guardrail.modelCache.{ttlSeconds,maxModels}`), consumed via
    # `core/effective_config.py`.
    model_cache_ttl_s: int = 600
    model_cache_max_models: int = 2

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "guardrail"
    metrics_enabled: bool = True

    # Sub-configs
    openai_compat: OpenAICompatConfig = Field(default_factory=OpenAICompatConfig)
    # production self-host engines (AD-4), OpenAI-compatible wire.
    vllm: VLLMConfig = Field(default_factory=VLLMConfig)
    llama_cpp: LlamaCppConfig = Field(default_factory=LlamaCppConfig)
    azure: AzureOpenAIConfig = Field(default_factory=AzureOpenAIConfig)
    bedrock: BedrockConfig = Field(default_factory=BedrockConfig)
    gliner: GlinerConfig = Field(default_factory=GlinerConfig)
    groundedness: GroundednessConfig = Field(default_factory=GroundednessConfig)
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
        allowed = {"lm-studio", "vllm", "llama-cpp", "azure", "bedrock"}
        normalized = v.strip().lower()
        if normalized not in allowed:
            raise ValueError(f"provider must be one of {sorted(allowed)}, got {v!r}")
        return normalized

    def engine_for(self, provider: str) -> OpenAICompatConfig:
        """Return the env sub-config for an arbitrary provider switch value.

        Falls back to the env-default provider's engine when ``provider`` is
        unknown. ``self.provider`` is always a validated key, so this never
        recurses indefinitely.
        """
        engines: dict[str, OpenAICompatConfig] = {
            "lm-studio": self.openai_compat,
            "vllm": self.vllm,
            "llama-cpp": self.llama_cpp,
            "azure": self.azure,
            "bedrock": self.bedrock,
        }
        return engines.get((provider or "").strip().lower(), engines[self.provider])

    @property
    def engine(self) -> OpenAICompatConfig:
        """Return the sub-config for the selected LLM engine."""
        return self.engine_for(self.provider)


def get_settings() -> Settings:
    """Create settings instance."""
    load_env()
    return Settings()
