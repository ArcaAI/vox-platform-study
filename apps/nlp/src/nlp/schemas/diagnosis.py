from pydantic import BaseModel, Field

from nlp.schemas.common import SupportedLanguage

# REST


# Diagnosis Suggestion


class DiagnosisSuggestion(BaseModel):
    disease: str = Field(..., description="Medical condition name")
    confidence: float | None = Field(
        default=0.1, ge=0.0, le=1.0, description="Confidence score for this suggestion"
    )


class DiagnosisSuggestionRequest(BaseModel):
    text: str = Field(..., description="Patient conversation transcript")
    min_confidence: float | None = Field(
        default=0.1, ge=0.0, le=1.0, description="Minimum confidence threshold"
    )
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    # The suggester runs TWO models and BOTH selections are gateway-injected
    # (`AiTaskDefault` ⋈ `AiModel`, tenant → SYSTEM). The NER pair used to be
    # absent, which left that half of the route running a hardcoded default.
    # Either one missing fails the request closed with 503.
    model_name: str | None = Field(
        default=None, description="Gateway-injected AiModel.sourceUri for the disease classifier"
    )
    # Gateway-injected `AiModel.localPath`.
    model_path: str | None = Field(
        default=None,
        description="Optional local weights directory (gateway-injected AiModel.localPath)",
    )
    ner_model_name: str | None = Field(
        default=None,
        description="Gateway-injected AiModel.sourceUri for the symptom-extraction NER model",
    )
    ner_model_path: str | None = Field(
        default=None,
        description="Optional local weights directory for the NER model (AiModel.localPath)",
    )
    tenant_id: str | None = Field(
        default=None, description="Gateway-injected tenant id; cross-checked against X-Tenant-Id"
    )


class DiagnosisSuggestionResponse(BaseModel):
    suggestions: list[DiagnosisSuggestion] = Field(
        ..., description="List of suggested medical findings"
    )
    symptoms_analyzed: list[str] = Field(..., description="Symptoms that were analyzed")
    model_version: str = Field(..., description="AI model version used")
