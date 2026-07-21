"""TTS V2 configuration using pydantic-settings.

Root settings use the ``TTS_`` env prefix; each provider sub-config carries
its own prefix (``TTS_AZURE_``, ``TTS_KOKORO_``, ``TTS_PARLER_``). The Azure
credential falls back to the shared ``AZURE_SPEECH_KEY`` / ``AZURE_SPEECH_REGION``
already used by stt-v2 for ASR (same Azure Speech resource serves TTS).
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _split_csv(value: Any) -> Any:
    """Parse a comma-separated string into a list; pass non-strings through."""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class AzureSpeechConfig(BaseSettings):
    """Azure AI Speech TTS provider configuration (primary managed cloud path)."""

    # populate_by_name lets tests construct the config directly by field name
    # (api_key=...) even though api_key/region carry env validation aliases.
    model_config = SettingsConfigDict(env_prefix="TTS_AZURE_", populate_by_name=True)

    enabled: bool = False
    # Falls back to the shared Azure Speech credential already provisioned for stt-v2.
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("TTS_AZURE_API_KEY", "AZURE_SPEECH_KEY"),
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

    model_config = SettingsConfigDict(env_prefix="TTS_KOKORO_")

    enabled: bool = False
    voice: str = "af_heart"
    device: str = "cpu"


class IndicParlerConfig(BaseSettings):
    """Self-hosted AI4Bharat Indic Parler-TTS (Malayalam) engine configuration."""

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

    model_config = SettingsConfigDict(env_prefix="TTS_SARVAM_", populate_by_name=True)

    enabled: bool = False
    api_key: SecretStr = SecretStr("")
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

    model_config = SettingsConfigDict(env_prefix="TTS_")

    # Application
    host: str = "0.0.0.0"
    port: int = 8865
    debug: bool = False
    log_level: str = "info"
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    cors_enabled: bool = False
    metrics_enabled: bool = True

    # Inter-service authentication (empty = auth disabled for local dev)
    service_token: SecretStr = SecretStr("")

    # Synthesis limits / defaults
    max_input_chars: int = 4096
    default_format: str = "pcm"
    sample_rate: int = 24000

    # Per-locale ordered provider fallback chains (first healthy wins).
    # NoDecode: read as a raw CSV string from env (TTS_ROUTING_EN=azure,kokoro)
    # and split by _parse_csv, rather than pydantic-settings JSON-decoding it.
    routing_en: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["azure", "kokoro"]
    )
    routing_ml: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["azure", "sarvam", "indic_parler"]
    )

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

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()

    @field_validator("routing_en", "routing_ml", "cors_origins", mode="before")
    @classmethod
    def _parse_csv(cls, v: Any) -> Any:
        return _split_csv(v)


def _load_dotenv_into_environ() -> None:
    """Load .env files into os.environ with correct precedence.

    Walks up from this file (up to 10 levels), loading root-level first then
    closer ones, so an app-level .env overrides the monorepo root. Explicit
    environment variables always win.
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
    """Create a settings instance. Not cached — call once at startup."""
    _load_dotenv_into_environ()
    return Settings()
