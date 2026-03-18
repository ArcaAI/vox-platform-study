from pydantic import BaseModel, Field
from typing import Optional, List

from nlp.schemas.common import SupportedLanguage

# REST


# Diagnosis Suggestion


class DiagnosisSuggestion(BaseModel):
    disease: str = Field(..., description="Medical condition name")
    confidence: Optional[float] = Field(default=0.1, ge=0.0, le=1.0, description="Confidence score for this suggestion")


class DiagnosisSuggestionRequest(BaseModel):
    text: str = Field(..., description="Patient conversation transcript")
    min_confidence: Optional[float] = Field(default=0.1, ge=0.0, le=1.0, description="Minimum confidence threshold")
    language: Optional[SupportedLanguage] = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")


class DiagnosisSuggestionResponse(BaseModel):
    suggestions: List[DiagnosisSuggestion] = Field(..., description="List of suggested medical findings")
    symptoms_analyzed: List[str] = Field(..., description="Symptoms that were analyzed")
    model_version: str = Field(..., description="AI model version used")
