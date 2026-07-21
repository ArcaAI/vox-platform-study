
from pydantic import BaseModel, Field

from nlp.schemas.common import Entity, SupportedLanguage

# REST

# Text Classification


class TextClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")
    # Optional per-request model override (gateway-injected from the
    # AiTaskDefault registry). None → the startup default instance, unchanged.
    model_name: str | None = Field(default=None, description="Optional HF model id overriding the default classifier")
    # Gateway-injected `AiModel.localPath`. Registry-derived,
    # never caller-chosen; absent ⇒ load by `model_name` exactly as before.
    model_path: str | None = Field(default=None, description="Optional local weights directory (gateway-injected AiModel.localPath)")


class TextClassificationResponse(BaseModel):
    predicted_label: str = Field(..., description="Top predicted classification label")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Classification confidence")
    probabilities: dict[str, float] = Field(..., description="All class probabilities")
    model_version: str = Field(..., description="Text classification model version")


# Token Classification


class TokenClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    aggregation_strategy: str = Field(default="simple", description="Entity aggregation strategy")
    language: SupportedLanguage | None = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")
    # Optional per-request model override (gateway-injected from the
    # AiTaskDefault registry). None → the startup default instance, unchanged.
    model_name: str | None = Field(default=None, description="Optional HF model id overriding the default NER model")
    # Gateway-injected `AiModel.localPath`.
    model_path: str | None = Field(default=None, description="Optional local weights directory (gateway-injected AiModel.localPath)")


class TokenClassificationResponse(BaseModel):
    entities: list[Entity] = Field(..., description="Extracted entities")
    model_version: str = Field(..., description="Token classification model version")


# WebSocket


# Text Classification


class WebSocketTextClassifyIncoming(TextClassificationRequest):
    pass


class WebSocketTextClassifyOutgoing(TextClassificationResponse):
    pass


# Token Classification


class WebSocketTokenClassifyIncoming(TokenClassificationRequest):
    pass


class WebSocketTokenClassifyOutgoing(TokenClassificationResponse):
    pass
