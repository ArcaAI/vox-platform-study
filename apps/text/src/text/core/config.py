"""Text configuration — the BOOTSTRAP FLOOR, and nothing else.

`apps/text` is a STATELESS gateway. It selects no provider, holds no vendor
credential, owns no endpoint and stores no tuning value. Everything that varies
— by tenant, by provider, by model, by deployment — arrives from the control
plane through exactly two channels ( owner decision D-1):

| Channel | Carries | How it gets here |
|---|---|---|
| **PUSH** (per request) | provider connection, BYO credential, model selection, per-tenant policy | `ProviderOverride` / request body, resolved by the gateway's tenant → SYSTEM cascade with `funding` DERIVED from the row |
| **PULL** (per service) | platform-scope capacity, timeouts, lane budgets, retention, generation defaults | `GET /internal/effective-config?service=text`, TTL-cached with push invalidation |

What survives here is only what a process needs *before either channel can
answer*: its own port and log level, the addresses of the things it must reach,
the one shared internal credential it authenticates those hops with, and the
PHI-safe-telemetry boot guard. `.claude/rules/09-infrastructure-devops.md`
Tiers: *"the only sanctioned defaults are bootstrap TRANSPORT
addresses."*

Everything else that used to live here is gone, not renamed:

* **Eight per-provider blocks** (`TEXT_{OLLAMA,AZURE,BEDROCK,OPENAI,ANTHROPIC,
  VERTEX,OPENAI_COMPAT,VLLM,LLAMA_CPP,SARVAM,TEI}_*`) — endpoint, credential,
  model and capacity now ride `AiProviderConnection` / `AiTaskDefault` /
  `AiRuntimeProfile`. An adapter with no injected connection FAILS CLOSED
  (`core/connection.py`); it never substitutes a process-wide value, because a
  process-wide value is one no tenant could ever override.
* **Three spellings of four resilience concepts** (`TEXT_CB_*`, `TEXT_QUEUE_*`,
  `TEXT_JUDGE_*`) — one `AiRuntimeProfile` keyed `(provider, lane)` replaces all
  twelve (`core/runtime_defaults.py`).
* **The `TEXT_V2_*` alias window** — nothing in the repo read the other side.

The remaining literals in `core/runtime_defaults.py` are RESOURCE-SAFETY FLOORS,
not configuration: the ceiling that keeps one wedged upstream from exhausting
the process until the control plane answers. They are deliberately not settable.
"""

from __future__ import annotations

from hope_env import first_real_secret, hope_settings_sources, load_env, real_secret
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: This deployable's identity. A constant, not a setting: a process cannot be
#: told what it is by the environment it runs in, and a mislabelled span is
#: worse than an unlabelled one. Mirrors `build-info.json`'s `service`.
SERVICE_NAME = "text"
#: The platform every HOPE deployable reports under.
SERVICE_NAMESPACE = "hope"


class ExternalGuardrailConfig(BaseSettings):
    """Where the guardrail peer lives. TRANSPORT ONLY.

    The POSTURE — whether moderation runs, its retry budget, and whether a
    prompt must classify as medical — is no longer here. It resolves through the
    control plane (`core/guardrail_posture.py`): the platform default arrives on
    the PULL channel, and a tenant's own opinion is PUSHED per request, so a
    non-clinical tenant can be exempted without a redeploy (owner decision D-1).

    The fail posture itself is code, not config, and stays that way: a transient
    error is absorbed by a bounded retry and a sustained outage REJECTS. There
    has never been a `fail_open` and there must not be one.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_EXTERNAL_GUARDRAIL_")

    base_url: str = "http://localhost:8863"


class InternalAccessConfig(BaseSettings):
    """THE canonical internal service credential (owner decision D-D, 2026-08-17).

    ONE shared access token for ALL internal service-to-service communication,
    identical across every HOPE service, set by the DevOps engineer, internal use
    only. It is what this service ACCEPTS as inbound ``X-Service-Token`` and what
    it PRESENTS on every outbound peer call.

    Unprefixed on purpose: it belongs to no single service, so this nested config
    carries no prefix of its own — exactly like :class:`TelemetryPhiGuardConfig`.

    The legacy per-pair fallbacks (``TEXT_SERVICE_TOKEN``,
    ``TEXT_EXTERNAL_GUARDRAIL_SERVICE_TOKEN``) are RETIRED: they were declared as
    a transition window that nothing on the other side ever used, and a second
    accepted credential is a second thing to rotate.
    """

    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(populate_by_name=True)

    token: SecretStr = Field(default=SecretStr(""), validation_alias="INTERNAL_ACCESS_TOKEN")


class TelemetryPhiGuardConfig(BaseSettings):
    """PHI-safe telemetry boot guard.

    ``NODE_ENV`` and ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT``
    are cross-process conventions read identically by every HOPE deployable —
    the TypeScript gateway's ``assertGenaiContentCaptureDisabled``
    (``apps/api/src/bootstrap/genai-content-capture-audit.ts``) reads the
    SAME bare names, so this nested config carries no prefix of its own.

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

    ``node_env`` doubles as this service's DEPLOYMENT ENVIRONMENT label. It is
    read here rather than declared a second time as ``TEXT_OTEL_DEPLOYMENT_
    ENVIRONMENT``: two names for one fact drift, and the drift direction that
    matters is a developer laptop's spans arriving tagged ``production``.
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


class Settings(BaseSettings):
    """Root application settings — the bootstrap floor (see module docstring)."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TEXT_", populate_by_name=True)

    # --- process identity ---------------------------------------------------
    port: int = 8862
    log_level: str = "info"

    # --- bootstrap transport ------------------------------------------------
    # Where the control plane lives. This is the ADDRESS of the config source,
    # not config authority: everything the route serves is itself control-plane
    # owned. Env var: TEXT_GATEWAY_URL.
    gateway_url: str = "http://localhost:8868/api/v1"
    # Env var: TEXT_REDIS_URL. Task state + the config-invalidation channel.
    redis_url: str = "redis://localhost:6379/0"
    # Env var: TEXT_OTEL_EXPORTER_ENDPOINT. The presence of a collector address
    # IS the enable signal, so there is no separate `TEXT_OTEL_ENABLED` that can
    # disagree with it — and the default is EMPTY, i.e. no export, matching the
    # `TEXT_OTEL_ENABLED=false` default it replaces. A default address would turn
    # export on everywhere and make every process that has no collector spend its
    # startup retrying one.
    otel_exporter_endpoint: str = ""

    # --- nested (own prefixes) ----------------------------------------------
    external_guardrail: ExternalGuardrailConfig = Field(default_factory=ExternalGuardrailConfig)
    internal_access: InternalAccessConfig = Field(default_factory=InternalAccessConfig)
    # Raises at construction time (propagates out of `Settings()` ->
    # `get_settings()` -> `create_app()`) when NODE_ENV=production and
    # OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT is not pinned.
    telemetry_phi_guard: TelemetryPhiGuardConfig = Field(default_factory=TelemetryPhiGuardConfig)

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()

    # --- derived process facts (NOT settings) -------------------------------
    # Each of these used to be its own env var that could only ever disagree
    # with something the process already knows.

    @property
    def node_env(self) -> str:
        return self.telemetry_phi_guard.node_env

    @property
    def debug(self) -> bool:
        return self.node_env != "production"

    @property
    def otel_enabled(self) -> bool:
        """Export iff a collector address was given."""
        return bool(self.otel_exporter_endpoint.strip())

    @property
    def otel_insecure(self) -> bool:
        """TLS follows the endpoint SCHEME.

        A separate boolean can contradict the URL it describes; the scheme
        cannot contradict itself.
        """
        return not self.otel_exporter_endpoint.strip().lower().startswith("https://")

    @property
    def otel_service_name(self) -> str:
        return SERVICE_NAME

    @property
    def otel_service_namespace(self) -> str:
        return SERVICE_NAMESPACE

    @property
    def otel_deployment_environment(self) -> str:
        return self.node_env

    # --- the one internal credential ----------------------------------------

    @property
    def internal_access_token(self) -> SecretStr:
        """The CANONICAL shared internal credential (``INTERNAL_ACCESS_TOKEN``)."""
        return self.internal_access.token

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``.

        Empty tuple ⇒ auth is bypassed (local dev / hermetic CI), which is the
        pre-existing behaviour when no token is configured at all.
        """
        # `real_secret` maps the unfilled-secret sentinel onto "" so a `CHANGE_ME`
        # token is never ACCEPTED as a credential — see hope_env.placeholders.
        token = real_secret(self.internal_access_token)
        return (token,) if token else ()

    def peer_service_token(self, legacy: SecretStr | None = None) -> str:
        """Token to PRESENT on an outbound peer call.

        ``legacy`` is accepted and ignored — the per-pair tokens it used to carry
        are retired. The parameter survives only so call sites need not be
        rewritten in lockstep; `first_real_secret` still maps the unfilled
        sentinel onto "" (a plain truthiness chain would return "CHANGE_ME" and
        401 every internal hop — see hope_env.placeholders).
        """
        return first_real_secret(self.internal_access_token)


def get_settings() -> Settings:
    """Create settings instance.  Not cached — call once at startup."""
    load_env()
    return Settings()
