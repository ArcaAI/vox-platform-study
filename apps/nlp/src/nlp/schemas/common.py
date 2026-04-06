from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class ModelType(StrEnum):
    TEXT_CLASSIFICATION = "text_classification"
    TOKEN_CLASSIFICATION = "token_classification"


class TextPosition(BaseModel):
    start: int = Field(..., description="Start character position")
    end: int = Field(..., description="End character position")


class Entity(BaseModel):
    id: str = Field(..., description="Unique entity identifier")
    text: str = Field(..., description="Original text of the entity")
    normalized_text: str = Field(..., description="Normalized/cleaned text")
    entity_type: str = Field(..., description="Type of medical entity")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score")
    position: TextPosition = Field(..., description="Position in source text")

    # Metadata
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    model_version: str | None = Field(None, description="Model version used")


class WebSocketMessageType(StrEnum):
    CONNECT = "connect"
    DISCONNECT = "disconnect"
    MESSAGE = "message"
    ERROR = "error"
    HEARTBEAT = "heartbeat"
    STATUS = "status"


class SupportedLanguage(StrEnum):
    ENGLISH = "en"
    MALAYALAM = "ml"


class WebSocketMessage(BaseModel):
    type: WebSocketMessageType = Field(..., description="Type of message")
    session_id: str = Field(..., description="Session ID")
    data: Any | None = Field(None, description="data")
