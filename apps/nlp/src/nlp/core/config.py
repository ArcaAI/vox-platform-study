from typing import List, Optional
from pydantic_settings import BaseSettings
from pydantic import Field
from enum import Enum
import os
import dotenv
from nlp.utils import get_project_root

dotenv.load_dotenv()


class Environment(str, Enum):
    """Deployment environments"""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class LogLevel(int, Enum):
    """Possible log levels."""

    NOTSET = 0
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    FATAL = 50

class NLPServiceConfig(BaseSettings):
    """Main configuration for NLP service"""

    name: str = Field(default=os.getenv("OTEL_SERVICE_NAME", os.getenv("SERVICE_NAME", "nlp")))
    version: str = Field(default=os.getenv("OTEL_SERVICE_VERSION", os.getenv("SERVICE_VERSION", "0.1.0")))
    namespace: str = Field(default=os.getenv("OTEL_SERVICE_NAMESPACE", os.getenv("SERVICE_NAMESPACE", "hope")))
    environment: Environment = Field(default=Environment.DEVELOPMENT)
    debug: bool = Field(default=False)
    log_level: int = Field(default=LogLevel.INFO)

    host: str = Field(default=os.getenv("HOST", "0.0.0.0"))
    port: int = Field(default=int(os.getenv("PORT", "8864")))
    workers: int = Field(default=int(os.getenv("WORKERS", "1")))

    opentelemetry_endpoint: Optional[str] = Field(default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None))
    otlp_endpoint: Optional[str] = Field(default=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", None))
    resource_attributes: Optional[dict[str, str]] = Field(default=None)
    traces_enabled: bool = Field(default=os.getenv("OTEL_TRACES_ENABLED", "true").lower() == "true")
    metrics_enabled: bool = Field(default=os.getenv("OTEL_METRICS_ENABLED", "true").lower() == "true")

    class Config:
        env_prefix = "NLP_"


class TextClassificationConfig(BaseSettings):
    """Text classification model configuration"""

    # Model settings
    model_name: str = Field(default="michellejieli/emotion_text_classifier")
    model_version: str = Field(default="1.0.0")
    model_path: Optional[str] = Field(default=None)
    tokenizer_name: str = Field(default="michellejieli/emotion_text_classifier")

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


class TokenClassificationConfig(BaseSettings):
    """Token classification model configuration"""

    # Model settings
    model_name: str = Field(default="blaze999/Medical-NER")
    model_version: str = Field(default="1.0.0")
    model_path: Optional[str] = Field(default=None)
    tokenizer_name: str = Field(default="blaze999/Medical-NER")

    # Processing settings
    max_sequence_length: int = Field(default=512)
    batch_size: int = Field(default=16)
    stride: int = Field(default=128)  # For long text handling

    # NER specific settings
    aggregation_strategy: str = Field(default="simple")  # simple, first, max, average
    ignore_labels: List[str] = Field(default_factory=lambda: ["O"])

    # Performance settings
    use_gpu: bool = Field(default=True)
    fp16: bool = Field(default=False)

    # Confidence settings
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    entity_confidence_aggregation: str = Field(default="mean")  # mean, max, min

    class Config:
        env_prefix = "TOKEN_CLASSIFIER_"


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

    cors_origins: List[str] = Field(default=["*"])
    cors_methods: List[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    cors_headers: List[str] = Field(default=["*"])
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

    def __init__(self):
        self.service = NLPServiceConfig()
        self.text_classification = TextClassificationConfig()
        self.token_classification = TokenClassificationConfig()
        self.medical_suggester = MedicalSuggesterConfig()
        self.security = SecurityConfig()
        self.text_corrector = TextCorrectorConfig()


settings = Settings()
