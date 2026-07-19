"""Request models for the generate API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class RetryConfig(BaseModel):
    max_retries: int = 3
    retry_on: list[str] = Field(default_factory=lambda: ["timeout", "provider_error"])


class ResponseFormat(BaseModel):
    type: Literal["text", "json", "json_schema"] = "text"
    json_schema: dict[str, Any] | None = None
    strict: bool = True


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=200_000)
    system_prompt: str | None = Field(default=None, max_length=50_000)
    provider: str = "lm-studio"
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    stream: bool = False
    response_format: ResponseFormat | None = None
    context: dict[str, Any] | None = None
    retry_config: RetryConfig = Field(default_factory=RetryConfig)

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prompt must not be blank or whitespace-only")
        return v
