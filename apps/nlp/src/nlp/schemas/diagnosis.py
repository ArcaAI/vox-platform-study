
from pydantic import BaseModel, Field

from nlp.schemas.common import SupportedLanguage

# REST


# Diagnosis Suggestion


class DiagnosisSuggestion(BaseModel):
    disease: str = Field(..., description="Medical condition name")
    confidence: float | None = Field(default=0.1, ge=0.0, le=1.0, description="Confidence score for this suggestion")


class DiagnosisSuggestionRequest(BaseModel):
    text: str = Field(..., description="Patient conversation transcript")
    min_confidence: float | None = Field(default=0.1, ge=0.0, le=1.0, description="Minimum confidence threshold")
    language: SupportedLanguage | None = Field(default=SupportedLanguage.ENGLISH, description="Language of the text")
    # TASK-506 — overrides ONLY the suggester's disease-classification model;
    # its internal NER stays the default token classifier.
    model_name: str | None = Field(default=None, description="Optional HF model id overriding the classification model")


class DiagnosisSuggestionResponse(BaseModel):
    suggestions: list[DiagnosisSuggestion] = Field(..., description="List of suggested medical findings")
    symptoms_analyzed: list[str] = Field(..., description="Symptoms that were analyzed")
    model_version: str = Field(..., description="AI model version used")
