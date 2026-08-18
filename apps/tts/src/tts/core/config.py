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

from hope_env import hope_settings_sources, load_env
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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

    enabled: bool = False
    # Azure Speech is BYOK-only. The subscription KEY is never sourced
    # from env — the `validation_alias` is a dead name no env var matches, and
    # `populate_by_name` is intentionally OFF so the field name cannot re-open an
    # env path either. The platform default and per-tenant keys both arrive as a
    # request `provider_override`, which the router applies via `model_copy`
    # (bypassing validation). The non-secret REGION stays env-set.
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TTS_AZURE_API_KEY__ENV_REMOVED_TASK_602",
    )
    region: str = Field(
        default="eastus",
        validation_alias=AliasChoices("TTS_AZURE_REGION", "AZURE_SPEECH_REGION"),
    )
    voice_en: str = "en-IN-NeerjaNeural"
    voice_ml: str = "ml-IN-SobhanaNeural"
    timeout_s: int = 30
    max_concurrent: int = 10


class KokoroConfig(BaseSettings):
    """Self-hosted Kokoro (English) engine configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_KOKORO_")

    enabled: bool = False
    voice: str = "af_heart"
    device: str = "cpu"


class IndicParlerConfig(BaseSettings):
    """Self-hosted AI4Bharat Indic Parler-TTS (Malayalam) engine configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_PARLER_")

    enabled: bool = False
    hf_model: str = "ai4bharat/indic-parler-tts"
    device: str = "cpu"
    speaker_ml: str = "Anjali"
    speaker_en: str = "Mary"
    # Internal-mirror overrides. The HF repo is click-through gated, so
    # prod loads from an ungated local mirror instead of hf.co. When model_path is
    # set the model + prompt tokenizer load from it (local_files_only); when
    # desc_encoder_path is set the description tokenizer (google/flan-t5-large,
    # baked into config as a Hub id) loads from it instead of fetching. Empty =
    # dev fallback to the gated hub pull. Pair with HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE.
    model_path: str = ""
    desc_encoder_path: str = ""


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

    enabled: bool = False
    hf_model: str = "ai4bharat/IndicF5"
    model_path: str = ""  # local mirror dir; gated hub repo otherwise
    device: str = "cpu"
    ref_audio_path: str = ""  # voice-clone reference wav
    ref_text: str = ""  # transcript of the reference wav


class SarvamConfig(BaseSettings):
    """Sarvam AI Bulbul TTS provider (cloud; best code-switched Malayalam).

    ⚠️ The public API is NOT PHI-safe (no HIPAA/BAA, 30-day retention, not
    India-resident) — point `base_url` at the enterprise VPC/on-prem host before
    enabling for real patient data.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="TTS_SARVAM_")

    enabled: bool = False
    # Sarvam is BYOK-only. The api-subscription-KEY is never sourced from
    # env — the `validation_alias` is a dead name and `populate_by_name` is OFF, so
    # neither `TTS_SARVAM_API_KEY` nor the field name populates it. The key arrives
    # as a request `provider_override`, applied by the router via `model_copy`.
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="TTS_SARVAM_API_KEY__ENV_REMOVED_TASK_602",
    )
    base_url: str = "https://api.sarvam.ai"
    model: str = "bulbul:v3"
    voice_ml: str = "ishita"
    voice_en: str = "ishita"
    sample_rate: int = 24000
    timeout_s: int = 30
    max_concurrent: int = 4
    use_streaming: bool = False  # phase 2: WebSocket streaming API


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

    # LEGACY per-service credential (empty = auth disabled for local dev).
    service_token: SecretStr = SecretStr("")

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``, shared token first.

        Empty tuple ⇒ auth is bypassed (local dev / hermetic CI) — the pre-existing
        behaviour when no token is configured at all.
        """
        return tuple(
            t
            for t in (
                self.internal_access_token.get_secret_value(),
                self.service_token.get_secret_value(),
            )
            if t
        )

    def peer_service_token(self, legacy: SecretStr) -> str:
        """Token to PRESENT on an outbound peer call: shared first, legacy fallback."""
        return self.internal_access_token.get_secret_value() or legacy.get_secret_value()

    # Synthesis limits / defaults
    max_input_chars: int = 4096
    default_format: str = "pcm"
    sample_rate: int = 24000

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
    warmup_enabled: bool = False

    # Where the control plane lives (env TTS_GATEWAY_URL). BOOTSTRAP
    # TRANSPORT (the address of the config source), NOT config authority.
    gateway_url: str = "http://localhost:8868/api/v1"

    # Idle TTL for local engine weights. BOOTSTRAP FALLBACK ONLY — the runtime
    # value comes from the control plane (`tts.modelCache.ttlSeconds`), consumed
    # via `core/effective_config.py`.
    model_cache_ttl_seconds: int = 600

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
    # Copied "production" from the SMR reference, which was itself the origin of
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
