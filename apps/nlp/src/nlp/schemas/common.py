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


class AssertionStatus(StrEnum):
    """TASK-518 — the claim an entity mention makes about the patient.

    ConText/NegEx-style assertion axis. Mirrors the ``NamedEntity.assertion``
    column so the polarity round-trips NLP → API → DB. ``PRESENT`` is the safe
    default (an un-triggered mention is a positive assertion about the patient).
    """

    PRESENT = "PRESENT"
    ABSENT = "ABSENT"
    HISTORICAL = "HISTORICAL"
    FAMILY = "FAMILY"
    HYPOTHETICAL = "HYPOTHETICAL"


class Entity(BaseModel):
    id: str = Field(..., description="Unique entity identifier")
    text: str = Field(..., description="Original text of the entity")
    normalized_text: str = Field(..., description="Normalized/cleaned text")
    entity_type: str = Field(..., description="Type of medical entity")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score")
    position: TextPosition = Field(..., description="Position in source text")

    # TASK-476 C1 — clinical ontology codes resolved by the entity linker
    # (OntologyLinker). Nullable: un-codable spans stay None so every downstream
    # NamedEntity write is null-safe. Field names mirror the NamedEntity columns.
    umls_cui: str | None = Field(default=None, description="UMLS Concept Unique Identifier")
    snomed_code: str | None = Field(default=None, description="SNOMED CT concept id")
    rxnorm_code: str | None = Field(default=None, description="RxNorm RxCUI")
    icd_code: str | None = Field(default=None, description="ICD-10-CM code")
    loinc_code: str | None = Field(default=None, description="LOINC code")

    # TASK-518 — negation/assertion polarity. Defaults to PRESENT so any entity
    # constructed outside the assertion pass is still a well-defined positive
    # claim. Downstream faithfulness/concept-F1 sensors exclude ABSENT entities
    # from positive-claim checks.
    assertion: AssertionStatus = Field(
        default=AssertionStatus.PRESENT,
        description="Assertion status (PRESENT/ABSENT/HISTORICAL/FAMILY/HYPOTHETICAL)",
    )

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
