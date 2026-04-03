
from pydantic import BaseModel, Field

from nlp.schemas.common import Entity, SupportedLanguage

# REST

# Text Classification


class TextClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")


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


class TokenClassificationResponse(BaseModel):
    # tokens: List[str] = Field(..., description="Input tokens")
    # labels: List[str] = Field(..., description="Predicted labels for each token")
    # confidences: List[float] = Field(..., description="Confidence scores for each token")
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
