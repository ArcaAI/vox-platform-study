import os
from enum import IntEnum, StrEnum
from typing import Any

import dotenv
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings

from nlp.utils import get_project_root

dotenv.load_dotenv()


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

    name: str = Field(default="nlp")
    version: str = Field(default="0.1.0")
    namespace: str = Field(default="hope")
    environment: Environment = Field(default=Environment.DEVELOPMENT)
    debug: bool = Field(default=False)
    log_level: int = Field(default=LogLevel.INFO)

    host: str = Field(default=os.getenv("HOST", "0.0.0.0"))
    port: int = Field(default=int(os.getenv("PORT", "8864")))
    workers: int = Field(default=int(os.getenv("WORKERS", "1")))

    opentelemetry_endpoint: str | None = Field(default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None))
    otlp_endpoint: str | None = Field(default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None))
    resource_attributes_raw: str | None = Field(default=None)
    # TASK-411 master switch: gates traces, metrics, AND log export (default off).
    otel_enabled: bool = Field(default=os.getenv("NLP_OTEL_ENABLED", "false").lower() == "true")
    traces_enabled: bool = Field(default=os.getenv("OTEL_TRACES_ENABLED", "true").lower() == "true")
    metrics_enabled: bool = Field(default=os.getenv("OTEL_METRICS_ENABLED", "true").lower() == "true")

    # Inter-service authentication (TASK-465). Reads NLP_SERVICE_TOKEN via the
    # env_prefix below — the exact key the gateway provisions. Empty by default
    # so local dev / hermetic CI bypass auth; a set value enforces the header.
    service_token: SecretStr = SecretStr("")

    class Config:
        env_prefix = "NLP_"

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("name", os.getenv("OTEL_SERVICE_NAME", os.getenv("SERVICE_NAME", "nlp")))
        kwargs.setdefault("version", os.getenv("OTEL_SERVICE_VERSION", os.getenv("SERVICE_VERSION", "0.1.0")))
        kwargs.setdefault("namespace", os.getenv("OTEL_SERVICE_NAMESPACE", os.getenv("SERVICE_NAMESPACE", "hope")))
        kwargs.setdefault("host", os.getenv("HOST", "0.0.0.0"))
        kwargs.setdefault("port", int(os.getenv("PORT", "8864")))
        kwargs.setdefault("workers", int(os.getenv("WORKERS", "1")))
        kwargs.setdefault("otlp_endpoint", os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
        kwargs.setdefault("resource_attributes_raw", os.getenv("OTEL_RESOURCE_ATTRIBUTES"))
        kwargs.setdefault("otel_enabled", os.getenv("NLP_OTEL_ENABLED", "false").lower() == "true")
        kwargs.setdefault("traces_enabled", os.getenv("OTEL_TRACES_ENABLED", "true").lower() == "true")
        kwargs.setdefault("metrics_enabled", os.getenv("OTEL_METRICS_ENABLED", "true").lower() == "true")
        super().__init__(**kwargs)

    @property
    def resource_attributes(self) -> dict[str, str]:
        return _parse_otel_resource_attributes(self.resource_attributes_raw)


# Sentinel default for the document-type text classifier.
#
# OPEN DECISION (TASK-330 §3.4): the `/classify/text` endpoint is meant for clinical
# *document-type* classification (e.g. clinical note vs discharge summary vs lab report),
# but no clinical doc-type model or label taxonomy has been chosen yet. The previous
# default, `michellejieli/emotion_text_classifier`, is an *emotion* model and was only ever
# a placeholder — it would emit emotion labels for clinical text. Until a product owner
# picks the intended model + taxonomy, the default is this non-functional sentinel so the
# service refuses to silently run the wrong model and instead reports the feature as
# unconfigured (see `TransformerTextClassifier.initialize`). Configure a real model via the
# `TEXT_CLASSIFIER_MODEL_NAME` env var to enable the endpoint.
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

    class Config:
        env_prefix = "TEXT_CLASSIFIER_"

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
    # TASK-518 — negation/assertion pass over recognized spans (ConText/NegEx).
    # Default ON; deterministic + offline. Disable to skip the pass entirely.
    assertion_enabled: bool = Field(default=True)

    # Performance settings
    use_gpu: bool = Field(default=True)
    fp16: bool = Field(default=False)

    # Confidence settings
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    entity_confidence_aggregation: str = Field(default="mean")  # mean, max, min

    class Config:
        env_prefix = "TOKEN_CLASSIFIER_"


class OntologyLinkerConfig(BaseSettings):
    """Clinical ontology linker configuration (TASK-476 C1).

    Gates the deterministic ``OntologyLinker`` wired into token classification:
    a master toggle plus a confidence floor below which a recognized span is
    left un-coded (avoids coding low-confidence NER noise). Reads ``NLP_LINKER_*``
    via the env_prefix. The bundled vocabulary is self-hosted — no cloud PHI.
    """

    linker_enabled: bool = Field(default=True)
    linker_confidence_floor: float = Field(default=0.0, ge=0.0, le=1.0)

    class Config:
        env_prefix = "NLP_"


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

    class Config:
        env_prefix = "MEDICAL_SUGGESTER_"


class WebSocketConfig(BaseSettings):
    """WebSocket configuration"""

    # WebSocket settings
    max_connections: int = Field(default=100)
    connection_timeout: int = Field(default=300)
    heartbeat_interval: int = Field(default=30)
    ping_timeout: int = Field(default=10)

    class Config:
        env_prefix = "WEBSOCKET_"


class WebSocketTokenClassificationConfig(BaseSettings):
    """WebSocket token classification configuration"""

    class Config:
        env_prefix = "WEBSOCKET_TOKEN_CLASSIFICATION_"


class SecurityConfig(BaseSettings):
    """Security configuration"""

    cors_origins: list[str] = Field(default=["*"])
    cors_methods: list[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    cors_headers: list[str] = Field(default=["*"])
    cors_allow_credentials: bool = Field(default=True)
    cors_max_age: int = Field(default=3600)

    class Config:
        env_prefix = "SECURITY_"


class TextCorrectorConfig(BaseSettings):
    """Text corrector configuration"""

    dictionary_path: str = Field(default=str(get_project_root() / "data" / "dictionaries"))

    symspell_max_edit_distance: int = Field(default=2)
    symspell_prefix_length: int = Field(default=7)
    symspell_max_suggestions: int = Field(default=5)
    symspell_preserve_case: bool = Field(default=True)
    symspell_ignore_non_words: bool = Field(default=True)
    symspell_ignore_term_with_digits: bool = Field(default=True)

    class Config:
        env_prefix = "SPELLING_CORRECTOR_"


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


settings = Settings()
