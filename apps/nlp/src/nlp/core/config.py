import os
from enum import IntEnum, StrEnum
from typing import Any

from hope_env import build_hope_sources, hope_settings_sources, load_env
from pydantic import AliasChoices, Field, SecretStr
from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from nlp.utils import get_project_root

# NODE_ENV-selected root env file (.env.dev / .env.test); host env always wins.
# Runs before any BaseSettings class below is instantiated.
load_env()


# model identity (which model to run) is selected from the DB via the
# gateway-injected request `model_name`, never from environment variables. These
# fields are dropped from env/dotenv sources so `*_MODEL_NAME` / `*_TOKENIZER_NAME`
# can no longer *select* a model; all other (tuning) env still applies.
_MODEL_IDENTITY_FIELDS = frozenset({"model_name", "tokenizer_name", "model_path", "model_version"})


class _ModelIdentityFilteredSource(PydanticBaseSettingsSource):
    """Wrap an env/dotenv settings source, dropping model-identity keys."""

    def __init__(self, wrapped: PydanticBaseSettingsSource) -> None:
        super().__init__(wrapped.settings_cls)
        self._wrapped = wrapped

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        # Unused: the whole source is materialized via __call__ below.
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        return {k: v for k, v in self._wrapped().items() if k not in _MODEL_IDENTITY_FIELDS}


def _model_identity_filtered_sources(
    cls: type[BaseSettings],
    settings_cls: type[BaseSettings],
    init_settings: PydanticBaseSettingsSource,
    env_settings: PydanticBaseSettingsSource,
    dotenv_settings: PydanticBaseSettingsSource,
    file_secret_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, ...]:
    """`settings_customise_sources` that drops model-identity keys.

    COMPOSES with the shared HOPE order rather than replacing it: `build_hope_sources`
    supplies `init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default`,
    and the model-identity filter is then applied to every source except
    `init_settings`.

    Constructor kwargs (`init_settings`) still set model identity — that is the
    path the per-request cache factories use to load the DB-selected model.

    The filter now covers the Vault `secrets_dir` source too. Before
    that source was inert (no `secrets_dir` was ever configured), so leaving it
    unfiltered cost nothing; now that a Vault Agent can populate it, an
    unfiltered `secrets_dir` would reopen exactly the hole this filter closes —
    a `/vault/secrets/NLP_MODEL_NAME` file selecting a model. Model identity
    comes from the DB, never from the environment or the filesystem.
    """
    ordered = build_hope_sources(
        settings_cls,
        init_settings=init_settings,
        env_settings=env_settings,
        dotenv_settings=dotenv_settings,
        file_secret_settings=file_secret_settings,
    )
    return tuple(
        source if source is init_settings else _ModelIdentityFilteredSource(source)
        for source in ordered
    )


class Environment(StrEnum):
    """Deployment environments"""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class LogLevel(IntEnum):
    """Possible log levels."""

    NOTSET = 0
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    FATAL = 50


def _parse_otel_resource_attributes(raw: str | None) -> dict[str, str]:
    """Parse OTel-standard `key=val,key=val` format into a dict."""
    if not raw:
        return {}
    result: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" in pair:
            key, value = pair.split("=", 1)
            result[key.strip()] = value.strip()
    return result


class NLPServiceConfig(BaseSettings):
    """Main configuration for NLP service"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    name: str = Field(default="nlp")
    version: str = Field(default="0.1.0")
    namespace: str = Field(default="hope")
    environment: Environment = Field(default=Environment.DEVELOPMENT)
    debug: bool = Field(default=False)
    log_level: int = Field(default=LogLevel.INFO)

    host: str = Field(default=os.getenv("HOST", "0.0.0.0"))
    port: int = Field(default=int(os.getenv("PORT", "8864")))
    workers: int = Field(default=int(os.getenv("WORKERS", "1")))

    opentelemetry_endpoint: str | None = Field(
        default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None)
    )
    otlp_endpoint: str | None = Field(default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None))
    resource_attributes_raw: str | None = Field(default=None)
    # Master switch: gates traces, metrics, AND log export (default off).
    otel_enabled: bool = Field(default=os.getenv("NLP_OTEL_ENABLED", "false").lower() == "true")
    traces_enabled: bool = Field(default=os.getenv("OTEL_TRACES_ENABLED", "true").lower() == "true")
    # Gates the Prometheus /metrics endpoint AND the OTLP metric reader.
    #
    # Reads NLP_METRICS_ENABLED first (the fleet convention — every other
    # service uses its own prefixed switch: TEXT_METRICS_ENABLED,
    # TTS_METRICS_ENABLED, GUARDRAIL_V2_METRICS_ENABLED, HARNESS_METRICS_ENABLED,
    # METRICS_ENABLED for STT). It used to read ONLY the gateway-scoped
    # OTEL_METRICS_ENABLED, which .env.dev sets to false — so NLP's /metrics
    # was disabled by a variable documented under the API gateway. OTEL_METRICS_ENABLED is kept as a fallback for compatibility.
    metrics_enabled: bool = Field(
        default=os.getenv(
            "NLP_METRICS_ENABLED", os.getenv("OTEL_METRICS_ENABLED", "true")
        ).lower()
        == "true"
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

    # LEGACY per-service credential. Reads NLP_SERVICE_TOKEN via the env_prefix
    # below — superseded by INTERNAL_ACCESS_TOKEN above, kept as the fallback.
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

    # Where the control plane lives (env NLP_GATEWAY_URL). This is
    # BOOTSTRAP TRANSPORT (the address of the config source), NOT config
    # authority: the service-level knobs themselves come from the
    # effective-config route this URL points at.
    gateway_url: str = Field(default="http://localhost:8868/api/v1")

    # Bootstrap fallback; the runtime value comes from the control
    # plane (`nlp.inference.maxConcurrent`).
    inference_max_concurrent: int = Field(default=4, ge=1)

    # Model-cache retention.
    #
    # BOOTSTRAP FALLBACK ONLY — the runtime value comes from the control plane
    # (`nlp.modelCache.{ttlSeconds,maxModels}`). Env: NLP_MODEL_CACHE_TTL_SECONDS
    # / NLP_MODEL_CACHE_MAX_MODELS.
    model_cache_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    model_cache_max_models: int = Field(default=3, ge=1)

    model_config = SettingsConfigDict(env_prefix="NLP_")

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("name", os.getenv("OTEL_SERVICE_NAME", os.getenv("SERVICE_NAME", "nlp")))
        kwargs.setdefault(
            "version", os.getenv("OTEL_SERVICE_VERSION", os.getenv("SERVICE_VERSION", "0.1.0"))
        )
        kwargs.setdefault(
            "namespace", os.getenv("OTEL_SERVICE_NAMESPACE", os.getenv("SERVICE_NAMESPACE", "hope"))
        )
        kwargs.setdefault("host", os.getenv("HOST", "0.0.0.0"))
        kwargs.setdefault("port", int(os.getenv("PORT", "8864")))
        kwargs.setdefault("workers", int(os.getenv("WORKERS", "1")))
        kwargs.setdefault("otlp_endpoint", os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
        kwargs.setdefault("resource_attributes_raw", os.getenv("OTEL_RESOURCE_ATTRIBUTES"))
        kwargs.setdefault("otel_enabled", os.getenv("NLP_OTEL_ENABLED", "false").lower() == "true")
        kwargs.setdefault(
            "traces_enabled", os.getenv("OTEL_TRACES_ENABLED", "true").lower() == "true"
        )
        kwargs.setdefault(
            "metrics_enabled",
            os.getenv("NLP_METRICS_ENABLED", os.getenv("OTEL_METRICS_ENABLED", "true")).lower()
            == "true",
        )
        super().__init__(**kwargs)

    @property
    def resource_attributes(self) -> dict[str, str]:
        return _parse_otel_resource_attributes(self.resource_attributes_raw)


# Sentinel default for the document-type text classifier.
#
# OPEN DECISION: the `/classify/text` endpoint is meant for clinical
# *document-type* classification (e.g. clinical note vs discharge summary vs lab report),
# but no clinical doc-type model or label taxonomy has been chosen yet. The previous
# default, `michellejieli/emotion_text_classifier`, is an *emotion* model and was only ever
# a placeholder — it would emit emotion labels for clinical text. Until a product owner
# picks the intended model + taxonomy, the default is this non-functional sentinel so the
# service refuses to silently run the wrong model and instead reports the feature as
# unconfigured (see `TransformerTextClassifier.initialize`). the endpoint is now
# fail-closed-until-configured driven by the REQUIRED, gateway-injected `model_name` (from a
# DB AiModel) rather than an env var — configure a real doc-type model in the DB to enable it.
UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL = "__UNCONFIGURED_DOC_TYPE_CLASSIFIER__"


class TextClassificationConfig(BaseSettings):
    """Text classification model configuration"""

    # Model settings
    model_name: str = Field(default=UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL)
    model_version: str = Field(default="1.0.0")
    model_path: str | None = Field(default=None)
    tokenizer_name: str = Field(default=UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL)

    # Processing settings
    max_sequence_length: int = Field(default=512)
    batch_size: int = Field(default=16)
    num_labels: int = Field(default=11)  # Number of text classification labels

    # Performance settings
    use_gpu: bool = Field(default=True)
    fp16: bool = Field(default=False)

    # Confidence settings
    confidence_threshold: float = Field(default=0.6, ge=0.0, le=1.0)
    return_all_probabilities: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="TEXT_CLASSIFIER_")

    # model identity comes from the DB (gateway-injected request
    # `model_name`), never from env; tuning env (thresholds, GPU, etc.) stays.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)

    @property
    def is_configured(self) -> bool:
        """True once a real doc-type model is set (i.e. not the placeholder sentinel)."""
        return self.model_name != UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL


class TokenClassificationConfig(BaseSettings):
    """Token classification model configuration"""

    # Model settings
    model_name: str = Field(default="blaze999/Medical-NER")
    model_version: str = Field(default="1.0.0")
    model_path: str | None = Field(default=None)
    tokenizer_name: str = Field(default="blaze999/Medical-NER")

    # Processing settings
    max_sequence_length: int = Field(default=512)
    batch_size: int = Field(default=16)
    stride: int = Field(default=128)  # For long text handling

    # NER specific settings
    aggregation_strategy: str = Field(default="simple")  # simple, first, max, average
    ignore_labels: list[str] = Field(default_factory=lambda: ["O"])
    # negation/assertion pass over recognized spans (ConText/NegEx).
    # Default ON; deterministic + offline. Disable to skip the pass entirely.
    assertion_enabled: bool = Field(default=True)

    # Performance settings
    use_gpu: bool = Field(default=True)
    fp16: bool = Field(default=False)

    # Confidence settings
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    entity_confidence_aggregation: str = Field(default="mean")  # mean, max, min

    model_config = SettingsConfigDict(env_prefix="TOKEN_CLASSIFIER_")

    # model identity is DB/gateway-selected, never env-selected.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)


class OntologyLinkerConfig(BaseSettings):
    """Clinical ontology linker configuration.

    Gates the deterministic ``OntologyLinker`` wired into token classification:
    a master toggle plus a confidence floor below which a recognized span is
    left un-coded (avoids coding low-confidence NER noise). Reads ``NLP_LINKER_*``
    via the env_prefix. The bundled vocabulary is self-hosted — no cloud PHI.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    linker_enabled: bool = Field(default=True)
    linker_confidence_floor: float = Field(default=0.0, ge=0.0, le=1.0)

    model_config = SettingsConfigDict(env_prefix="NLP_")


class MedicalSuggesterConfig(BaseSettings):
    """Medical Suggester configuration"""

    # Model settings
    model_name: str = Field(default="shanover/symps_disease_bert_v3_c41")
    model_version: str = Field(default="1.0.0")
    tokenizer_name: str = Field(default="shanover/symps_disease_bert_v3_c41")

    # Performance settings
    use_gpu: bool = Field(default=True)
    fp16: bool = Field(default=False)

    # Confidence settings
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)

    model_config = SettingsConfigDict(env_prefix="MEDICAL_SUGGESTER_")

    # model identity is DB/gateway-selected, never env-selected.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)


class WebSocketConfig(BaseSettings):
    """WebSocket configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    # WebSocket settings
    max_connections: int = Field(default=100)
    connection_timeout: int = Field(default=300)
    heartbeat_interval: int = Field(default=30)
    ping_timeout: int = Field(default=10)

    model_config = SettingsConfigDict(env_prefix="WEBSOCKET_")


class WebSocketTokenClassificationConfig(BaseSettings):
    """WebSocket token classification configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    class Config:
        env_prefix = "WEBSOCKET_TOKEN_CLASSIFICATION_"


class SecurityConfig(BaseSettings):
    """Security configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    cors_origins: list[str] = Field(default=["*"])
    cors_methods: list[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    cors_headers: list[str] = Field(default=["*"])
    cors_allow_credentials: bool = Field(default=True)
    cors_max_age: int = Field(default=3600)

    model_config = SettingsConfigDict(env_prefix="SECURITY_")


class TextCorrectorConfig(BaseSettings):
    """Text corrector configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    dictionary_path: str = Field(default=str(get_project_root() / "data" / "dictionaries"))

    symspell_max_edit_distance: int = Field(default=2)
    symspell_prefix_length: int = Field(default=7)
    symspell_max_suggestions: int = Field(default=5)
    symspell_preserve_case: bool = Field(default=True)
    symspell_ignore_non_words: bool = Field(default=True)
    symspell_ignore_term_with_digits: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="SPELLING_CORRECTOR_")


class ExternalTextConfig(BaseSettings):
    """apps/nlp's peer-to-peer client config for calling `text` (TASK-729).

    Mirrors `apps/text`'s `ExternalGuardrailConfig` field-for-field: this is
    the first outbound peer-service call `apps/nlp` makes (§2.3/§2.4 of the
    ticket — every prior `httpx` call site targets the gateway, never a peer
    AI service). Used by `nlp.topic`/`nlp.intent` to delegate open-taxonomy
    labeling to a real LLM call, with the tenant's topic/intent list injected
    into the prompt as per-tenant instructions (resolved server-side from
    `TenantNlpTaskInstructions` and gateway-injected into the request body —
    `apps/nlp` itself never touches Postgres).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="NLP_EXTERNAL_TEXT_")

    base_url: str = "http://localhost:8862"
    timeout_s: int = 30
    # Bounded retry for a transient blip, mirroring
    # `ExternalGuardrailConfig`: total tries = max_retries + 1, linear backoff.
    max_retries: int = 2
    retry_backoff_ms: int = 100
    service_token: SecretStr = SecretStr("")


class Settings:
    """Main settings container for dual-model architecture"""

    def __init__(self) -> None:
        self.service = NLPServiceConfig()
        self.text_classification = TextClassificationConfig()
        self.token_classification = TokenClassificationConfig()
        self.ontology_linker = OntologyLinkerConfig()
        self.medical_suggester = MedicalSuggesterConfig()
        self.security = SecurityConfig()
        self.text_corrector = TextCorrectorConfig()
        self.external_text = ExternalTextConfig()


settings = Settings()
