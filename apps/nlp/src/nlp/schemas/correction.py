from enum import Enum
from pydantic import BaseModel, Field
from typing import Optional, List

from nlp.schemas.common import SupportedLanguage


class CorrectionType(str, Enum):
    ALL = "all"
    SPELLING = "spelling"
    GRAMMAR = "grammar"


# REST

# Text Correction


class TextCorrectionRequest(BaseModel):
    type: CorrectionType = Field(default=CorrectionType.SPELLING, description="Type of correction")
    text: str = Field(..., description="Text to correct")
    language: SupportedLanguage = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")
    min_confidence: float = Field(0.7, ge=0.0, le=1.0, description="Minimum confidence for corrections")
    include_alternatives: bool = Field(True, description="Include alternative correction suggestions")


class TextCorrectionResponse(BaseModel):
    original_text: str = Field(..., description="Original text (word for individual correction, full text for overall result)")
    corrected_text: str = Field(..., description="Corrected text (word for individual correction, full text for overall result)")
    language: SupportedLanguage = Field(default=SupportedLanguage.ENGLISH, description="Language of the text/correction")
    alternatives: List[str] = Field(default_factory=list, description="List of individual corrections made")


# WebSocket


class WebSocketTerminologyCorrectIncoming(TextCorrectionRequest):
    pass

class WebSocketTerminologyCorrectOutgoing(TextCorrectionResponse):
    pass