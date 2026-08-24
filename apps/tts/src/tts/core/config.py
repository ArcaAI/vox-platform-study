"""TTS configuration using pydantic-settings.

Root settings use the ``TTS_`` env prefix; each provider sub-config carries
its own prefix (``TTS_AZURE_``, ``TTS_KOKORO_``, ``TTS_PARLER_``).

cloud credentials (Azure Speech, Sarvam) are BYOK-only — the
subscription KEY is never sourced from env; it arrives per request as a
provider override (tenant → SYSTEM ``AiProviderConnection``). Only the non-secret
Azure ``REGION`` remains env-set (``TTS_AZURE_REGION`` / ``AZURE_SPEECH_REGION``).
"""

from __future__ import annotations

import os
from typing import Annotated, Any

from hope_env import hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from tts.core.control_plane import moved_alias


def _split_csv(value: Any) -> Any:
    """Parse a comma-separated string into a list; pass non-strings through."""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class AzureSpeechConfig(BaseSettings):
    """Azure AI Speech TTS provider configuration (primary managed cloud path)."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_AZURE_")

    # ── `enabled` — control-plane SERVED, env BOOTSTRAP (TASK-799 lane H) ────
    # The value now comes from the settings registry (`tts.<engine>.enabled`,
    # tier `global-kv`, seeded by `seed/11d-tts-engine-flags.ts`), and this env
    # path REMAINS OPEN as the bootstrap fallback. Only a value a DATABASE ROW
    # supplied overrides it — see `control_plane.py#ENV_BOOTSTRAP_KEYS`.
    #
    # The env read survives because closing it is a THIRD step that belongs to
    # a repository this one cannot change: `TTS_KOKORO_ENABLED=true` in the k8s
    # ConfigMap (`arca/hope-v2-deployment`) is what makes a keyless deployment
    # REACH READY at all (`test_keyless_readiness_task642`), and closing the
    # path while the manifest still supplies it would leave `hope-tts` answering
    # 503 forever with no Service endpoints — the outage that test exists for.
    #
    # These fields are read ONLY by boot registration in `main.py`, so a served
    # value converges on the next restart and can never deregister a live
    # provider mid-process.
    enabled: bool = False
    # Azure Speech is BYOK-only. The subscription KEY is never sourced
    # from env — the `validation_alias` is a dead name no env var matches, and
    # `populate_by_name` is intentionally OFF so the field name cannot re-open an
    # env path either. The platform default and per-tenant keys both arrive as a
    # request `provider_override`, which the router applies via `model_copy`
    # (bypassing validation).
    #
    # ⚠️ This guard is the REFERENCE PATTERN the assessment points every other
    # adapter at (F-01: "Structural enforcement to copy"). Do not weaken it, and
    # do not add `populate_by_name=True` to this class — that single flag would
    # re-open an env path to a cloud credential for every field here at once.
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TTS_AZURE_API_KEY__ENV_REMOVED_TASK_602",
    )
    # The REGION moved to the control plane with the rest of the connection
    # (TASK-799). Same mechanism as the key above, different reason: the key is
    # closed because it is a secret, the region because it is config an admin
    # must be able to change without a redeploy.
    region: str = Field(default="eastus", validation_alias=moved_alias("TTS_AZURE_REGION"))
    # There are deliberately NO `voice_en` / `voice_ml` fields. They held
    # `en-IN-NeerjaNeural` / `ml-IN-SobhanaNeural` — the SAME two strings the
    # voice catalog already binds for `en-female-1` / `ml-female-1`. Worse, they
    # were unreachable: the router resolves `req.provider_voice` from the catalog
    # on every request and `candidates()` skips any provider the voice is not
    # bound to, so these could never be consulted. One fact, one place: the
    # catalog (`catalog/voices.py`).
    timeout_s: int = Field(default=30, validation_alias=moved_alias("TTS_AZURE_TIMEOUT_S"))
    max_concurrent: int = Field(
        default=10, validation_alias=moved_alias("TTS_AZURE_MAX_CONCURRENT")
    )


class KokoroConfig(BaseSettings):
    """Self-hosted Kokoro (English) engine configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_KOKORO_")

    # ── `enabled` — control-plane SERVED, env BOOTSTRAP (TASK-799 lane H) ────
    # The value now comes from the settings registry (`tts.<engine>.enabled`,
    # tier `global-kv`, seeded by `seed/11d-tts-engine-flags.ts`), and this env
    # path REMAINS OPEN as the bootstrap fallback. Only a value a DATABASE ROW
    # supplied overrides it — see `control_plane.py#ENV_BOOTSTRAP_KEYS`.
    #
    # The env read survives because closing it is a THIRD step that belongs to
    # a repository this one cannot change: `TTS_KOKORO_ENABLED=true` in the k8s
    # ConfigMap (`arca/hope-v2-deployment`) is what makes a keyless deployment
    # REACH READY at all (`test_keyless_readiness_task642`), and closing the
    # path while the manifest still supplies it would leave `hope-tts` answering
    # 503 forever with no Service endpoints — the outage that test exists for.
    #
    # These fields are read ONLY by boot registration in `main.py`, so a served
    # value converges on the next restart and can never deregister a live
    # provider mid-process.
    enabled: bool = False
    # No `voice` field: `af_heart` is already the catalog's kokoro binding for
    # `en-female-1`, and the router supplies it as `req.provider_voice`. The
    # warm-up path takes its voice from the catalog too (see `main.create_app`),
    # so the string exists in exactly one place.
    device: str = Field(default="cpu", validation_alias=moved_alias("TTS_KOKORO_DEVICE"))


class IndicParlerConfig(BaseSettings):
    """Self-hosted AI4Bharat Indic Parler-TTS (Malayalam) engine configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_PARLER_")

    # ── `enabled` — control-plane SERVED, env BOOTSTRAP (TASK-799 lane H) ────
    # The value now comes from the settings registry (`tts.<engine>.enabled`,
    # tier `global-kv`, seeded by `seed/11d-tts-engine-flags.ts`), and this env
    # path REMAINS OPEN as the bootstrap fallback. Only a value a DATABASE ROW
    # supplied overrides it — see `control_plane.py#ENV_BOOTSTRAP_KEYS`.
    #
    # The env read survives because closing it is a THIRD step that belongs to
    # a repository this one cannot change: `TTS_KOKORO_ENABLED=true` in the k8s
    # ConfigMap (`arca/hope-v2-deployment`) is what makes a keyless deployment
    # REACH READY at all (`test_keyless_readiness_task642`), and closing the
    # path while the manifest still supplies it would leave `hope-tts` answering
    # 503 forever with no Service endpoints — the outage that test exists for.
    #
    # These fields are read ONLY by boot registration in `main.py`, so a served
    # value converges on the next restart and can never deregister a live
    # provider mid-process.
    enabled: bool = False
    hf_model: str = Field(
        default="ai4bharat/indic-parler-tts", validation_alias=moved_alias("TTS_PARLER_HF_MODEL")
    )
    device: str = Field(default="cpu", validation_alias=moved_alias("TTS_PARLER_DEVICE"))
    # No `speaker_ml` / `speaker_en`. `Anjali` was the catalog's `indic_parler`
    # binding for `ml-female-1` written a second time — and this provider was the
    # one that read its OWN copy instead of `req.provider_voice`, so the catalog
    # binding was silently discarded. Two representations of one fact, with the
    # wrong one winning. `_describe()` now takes the resolved binding.
    #
    # Internal-mirror overrides. The HF repo is click-through gated, so
    # prod loads from an ungated local mirror instead of hf.co. When model_path is
    # set the model + prompt tokenizer load from it (local_files_only); when
    # desc_encoder_path is set the description tokenizer (google/flan-t5-large,
    # baked into config as a Hub id) loads from it instead of fetching. Empty =
    # dev fallback to the gated hub pull. Pair with HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE.
    model_path: str = Field(default="", validation_alias=moved_alias("TTS_PARLER_MODEL_PATH"))
    desc_encoder_path: str = Field(
        default="", validation_alias=moved_alias("TTS_PARLER_DESC_ENCODER_PATH")
    )


class IndicF5Config(BaseSettings):
    """AI4Bharat IndicF5 (Malayalam, voice-clone) — EXPERIMENTAL, gated OFF.

    ⚠️ Prod/commercial enablement is NO-GO pending the owner's license review:
    the released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS
    base — the MIT tag can't override NonCommercial. Never set
    TTS_INDICF5_ENABLED=true in production without written clearance.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_INDICF5_")

    # ── `enabled` — control-plane SERVED, env BOOTSTRAP (TASK-799 lane H) ────
    # The value now comes from the settings registry (`tts.<engine>.enabled`,
    # tier `global-kv`, seeded by `seed/11d-tts-engine-flags.ts`), and this env
    # path REMAINS OPEN as the bootstrap fallback. Only a value a DATABASE ROW
    # supplied overrides it — see `control_plane.py#ENV_BOOTSTRAP_KEYS`.
    #
    # The env read survives because closing it is a THIRD step that belongs to
    # a repository this one cannot change: `TTS_KOKORO_ENABLED=true` in the k8s
    # ConfigMap (`arca/hope-v2-deployment`) is what makes a keyless deployment
    # REACH READY at all (`test_keyless_readiness_task642`), and closing the
    # path while the manifest still supplies it would leave `hope-tts` answering
    # 503 forever with no Service endpoints — the outage that test exists for.
    #
    # These fields are read ONLY by boot registration in `main.py`, so a served
    # value converges on the next restart and can never deregister a live
    # provider mid-process.
    #
    # RESOLVED for this flag (lane H): the licensing gate above used to be
    # enforced by the docstring alone. `tts.indicf5.enabled` is now a
    # `globalOnly` registry key on a `locked` SYSTEM row seeded `'false'`, so
    # enabling it is a SUPER_ADMIN write with an audit trail rather than an
    # unreviewed env edit. The docstring warning stands as the REASON; the row
    # is the enforcement. All five moved together — splitting one out of a
    # family of five is how the "configured in two places" defect starts.
    enabled: bool = False
    hf_model: str = Field(
        default="ai4bharat/IndicF5", validation_alias=moved_alias("TTS_INDICF5_HF_MODEL")
    )
    # local mirror dir; gated hub repo otherwise
    model_path: str = Field(default="", validation_alias=moved_alias("TTS_INDICF5_MODEL_PATH"))
    device: str = Field(default="cpu", validation_alias=moved_alias("TTS_INDICF5_DEVICE"))
    # voice-clone reference wav + its transcript. NOT catalog data: these are
    # deployment PATHS to a reference recording, not a voice name.
    ref_audio_path: str = Field(
        default="", validation_alias=moved_alias("TTS_INDICF5_REF_AUDIO_PATH")
    )
    ref_text: str = Field(default="", validation_alias=moved_alias("TTS_INDICF5_REF_TEXT"))


class SarvamConfig(BaseSettings):
    """Sarvam AI Bulbul TTS provider (cloud; best code-switched Malayalam).

    ⚠️ The public API is NOT PHI-safe (no HIPAA/BAA, 30-day retention, not
    India-resident) — point `base_url` at the enterprise VPC/on-prem host before
    enabling for real patient data.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_SARVAM_")

    # ── `enabled` — control-plane SERVED, env BOOTSTRAP (TASK-799 lane H) ────
    # The value now comes from the settings registry (`tts.<engine>.enabled`,
    # tier `global-kv`, seeded by `seed/11d-tts-engine-flags.ts`), and this env
    # path REMAINS OPEN as the bootstrap fallback. Only a value a DATABASE ROW
    # supplied overrides it — see `control_plane.py#ENV_BOOTSTRAP_KEYS`.
    #
    # The env read survives because closing it is a THIRD step that belongs to
    # a repository this one cannot change: `TTS_KOKORO_ENABLED=true` in the k8s
    # ConfigMap (`arca/hope-v2-deployment`) is what makes a keyless deployment
    # REACH READY at all (`test_keyless_readiness_task642`), and closing the
    # path while the manifest still supplies it would leave `hope-tts` answering
    # 503 forever with no Service endpoints — the outage that test exists for.
    #
    # These fields are read ONLY by boot registration in `main.py`, so a served
    # value converges on the next restart and can never deregister a live
    # provider mid-process.
    enabled: bool = False
    # Sarvam is BYOK-only. The api-subscription-KEY is never sourced from
    # env — the `validation_alias` is a dead name and `populate_by_name` is OFF, so
    # neither `TTS_SARVAM_API_KEY` nor the field name populates it. The key arrives
    # as a request `provider_override`, applied by the router via `model_copy`.
    #
    # ⚠️ Reference pattern — see the note on `AzureSpeechConfig.api_key`.
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TTS_SARVAM_API_KEY__ENV_REMOVED_TASK_602",
    )
    # The base URL is a PHI-safety control, not just a convenience: pointing it
    # at the enterprise VPC host is what makes this provider usable for patient
    # data at all. That is precisely a decision that should be made once, by a
    # platform admin, with an audit trail — not per deployment in a shell.
    base_url: str = Field(
        default="https://api.sarvam.ai", validation_alias=moved_alias("TTS_SARVAM_BASE_URL")
    )
    # A model id that REACHES THE WIRE (`providers/sarvam.py` sends it as the
    # request's `model`), so it is a SELECTION, not a tuning knob — assessment
    # F-11 names this field specifically.
    model: str = Field(default="bulbul:v3", validation_alias=moved_alias("TTS_SARVAM_MODEL"))
    # No `voice_ml` / `voice_en`: both held `ishita`, which is the catalog's
    # sarvam binding for `ml-female-1`. The router passes it as
    # `req.provider_voice`, so the fallback was unreachable.
    sample_rate: int = Field(default=24000, validation_alias=moved_alias("TTS_SARVAM_SAMPLE_RATE"))
    timeout_s: int = Field(default=30, validation_alias=moved_alias("TTS_SARVAM_TIMEOUT_S"))
    max_concurrent: int = Field(
        default=4, validation_alias=moved_alias("TTS_SARVAM_MAX_CONCURRENT")
    )
    # phase 2: WebSocket streaming API
    use_streaming: bool = Field(
        default=False, validation_alias=moved_alias("TTS_SARVAM_USE_STREAMING")
    )


class Settings(BaseSettings):
    """Root TTS service settings."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_")

    # Application
    host: str = "0.0.0.0"
    port: int = 8865
    debug: bool = False
    log_level: str = "info"
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    cors_enabled: bool = False
    metrics_enabled: bool = True

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

    # `TTS_SERVICE_TOKEN` is RETIRED (TASK-799 lane C). It was the pre-D-D
    # per-service credential, kept as a "zero-cost backward-compatibility
    # fallback" — but the cost was not zero: a deployment configured the way
    # owner decision D-D specifies (shared token set, legacy empty) and one
    # configured the old way both "work", so nothing ever forced the migration
    # to finish, and every call site had to remember to consult the fallback.
    # Two of them did not (`main.lifespan` passed `settings.service_token`
    # directly to both the effective-config client and self-registration), which
    # is the same bypass the assessment records as F-06 for the other services:
    # set the shared token, leave the legacy one empty as documented, and those
    # two hops send an EMPTY token and 401 forever.
    #
    # There is now ONE credential, so there is nothing to bypass.

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``.

        A tuple rather than a scalar so the middleware keeps the same shape as
        the other five services' (and so a second credential could be appended
        without touching a call site). Empty ⇒ auth is bypassed (local dev /
        hermetic CI) — the pre-existing behaviour when none is configured.
        """
        # `real_secret` maps the unfilled-secret sentinel onto "" so a `CHANGE_ME` token is
        # never ACCEPTED as a credential — see hope_env.placeholders.
        shared = real_secret(self.internal_access_token)
        return (shared,) if shared else ()

    def peer_service_token(self) -> str:
        """The token to PRESENT on an outbound peer call.

        `real_secret`, not `.get_secret_value()`: the unfilled-secret sentinel is
        a NON-EMPTY string, so a plain truthiness chain returns `"CHANGE_ME"` and
        sends it as a credential — the trap that made every internal hop 401
        (see `hope_env.placeholders`).
        """
        return real_secret(self.internal_access_token)

    # Synthesis limits / defaults — control-plane owned (TASK-799).
    max_input_chars: int = Field(default=4096, validation_alias=moved_alias("TTS_MAX_INPUT_CHARS"))
    default_format: str = Field(default="pcm", validation_alias=moved_alias("TTS_DEFAULT_FORMAT"))
    sample_rate: int = Field(default=24000, validation_alias=moved_alias("TTS_SAMPLE_RATE"))

    # NOTE: there is deliberately NO `routing_en` / `routing_ml` here ( /
    # F1). Per-locale provider SELECTION is DB-sourced — the SYSTEM
    # `TenantTtsConfig` default, resolved by the gateway and injected per request
    # — so env can no longer bake a vendor order. The router fails CLOSED when no
    # chain is injected (see `routing/router.TtsRoutingUnconfiguredError`).

    # Provider sub-configs (loaded from their own env prefixes)
    azure: AzureSpeechConfig = Field(default_factory=AzureSpeechConfig)
    sarvam: SarvamConfig = Field(default_factory=SarvamConfig)
    kokoro: KokoroConfig = Field(default_factory=KokoroConfig)
    indic_parler: IndicParlerConfig = Field(default_factory=IndicParlerConfig)
    indic_f5: IndicF5Config = Field(default_factory=IndicF5Config)

    # Local engines are LAZY by default: they register at boot
    # but load their weights on the first synth request and are TTL-evicted when
    # idle. Set TTS_WARMUP_ENABLED=true to restore boot-warm
    # behaviour (fail-at-boot rather than first-request 503) — see
    # docs/operations/inference/model-retention.md.
    warmup_enabled: bool = Field(default=False, validation_alias=moved_alias("TTS_WARMUP_ENABLED"))

    # Where the control plane lives (env TTS_GATEWAY_URL). BOOTSTRAP
    # TRANSPORT (the address of the config source), NOT config authority.
    gateway_url: str = "http://localhost:8868/api/v1"

    # How this process REACHES Redis, for the `arca:config:invalidate`
    # subscriber (owner decision D-5). Genuinely env-tier for the same reason
    # `gateway_url` is: it is the address of a propagation channel, not a value
    # carried on one, and a service cannot fetch the address of the thing it
    # fetches addresses from.
    #
    # This does NOT make tts stateful. The connection subscribes to one pub/sub
    # channel and evicts a cache; it reads no keys, writes none, and holds no
    # tenant state. `apps/tts` stays the "genuine stateless, gateway-injected
    # service" the assessment records — adding Redis for invalidation must never
    # become a route to local tenant resolution.
    redis_url: str = "redis://localhost:6379/0"

    # Idle TTL for local engine weights. BOOTSTRAP FALLBACK — the runtime value
    # comes from the control plane (`tts.modelCache.ttlSeconds`), consumed via
    # `core/effective_config.py`. Its env path is now CLOSED: it was documented
    # as "BOOTSTRAP FALLBACK ONLY" while remaining fully settable, so an operator
    # could set a value that the next config pull silently replaced.
    model_cache_ttl_seconds: int = Field(
        default=600, validation_alias=moved_alias("TTS_MODEL_CACHE_TTL_SECONDS")
    )

    # Observability. Default OFF (never
    # require a reachable collector to boot/serve). `otel_exporter_endpoint`
    # defaults to empty (no hardcoded localhost target) so tracing activates
    # ONLY when BOTH `otel_enabled` AND an endpoint are explicitly set — see
    # `main.create_app`. TTS receives clinical text to synthesise, so
    # `core/observability.py` wires a PHI-redaction hook into every span.
    otel_enabled: bool = False
    otel_exporter_endpoint: str = ""
    otel_service_name: str = "tts"
    otel_service_namespace: str = "hope"
    # Resolved from the environment, defaulting to DEVELOPMENT.
    # Copied "production" from the TEXT reference, which was itself the origin of
    # this defect fleet-wide. A hardcoded "production" tags a developer laptop's
    # spans as production data — a mislabelled dev span is noise, a mislabelled
    # prod span corrupts an audit trail.
    otel_deployment_environment: str = Field(
        default_factory=lambda: os.getenv("DEPLOYMENT_ENVIRONMENT")
        or os.getenv("NODE_ENV")
        or "development"
    )
    otel_insecure: bool = True
    otel_logs_enabled: bool = True

    @field_validator("otel_deployment_environment", mode="before")
    @classmethod
    def _blank_environment_resolves(cls, v: object) -> object:
        """An empty `TTS_OTEL_DEPLOYMENT_ENVIRONMENT=` re-enters the chain above.

        `.env.dev`/`.env.sample` ship the key blank — that is how they spell "let
        the service resolve it" — but a bound "" wins over the default_factory and
        tags every span with an EMPTY environment. Same defect class as the
        hardcoded "production" this field already guards against, failing the
        other way: unattributable spans rather than mislabelled ones.
        """
        if isinstance(v, str) and v.strip() == "":
            return os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or "development"
        return v

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_csv(cls, v: Any) -> Any:
        return _split_csv(v)


def get_settings() -> Settings:
    """Create a settings instance. Not cached — call once at startup."""
    load_env()
    return Settings()
