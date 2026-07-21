"""Schemas for the document extraction endpoint."""

from pydantic import BaseModel, ConfigDict, Field


class ExtractionResponse(BaseModel):
    """Result of extracting text from an uploaded lab/exam document.

    Serialized with camelCase aliases (`pageCount` / `ocrUsed`) so the contract
    matches the TS orchestration's expected `{ text, pageCount, ocrUsed }` shape.
    """

    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(default="", description="Extracted text (trimmed + capped at 20k chars).")
    page_count: int = Field(default=0, serialization_alias="pageCount", description="Number of pages parsed (0 for non-paged / unsupported).")
    ocr_used: bool = Field(default=False, serialization_alias="ocrUsed", description="True when at least one page/image went through OCR.")
