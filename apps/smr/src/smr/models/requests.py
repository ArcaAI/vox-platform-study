"""Request models for the generate API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator


class RetryConfig(BaseModel):
    max_retries: int = 3
    retry_on: list[str] = Field(default_factory=lambda: ["timeout", "provider_error"])


class ResponseFormat(BaseModel):
    type: Literal["text", "json", "json_schema"] = "text"
    json_schema: dict[str, Any] | None = None
    strict: bool = True


class ProviderOverride(BaseModel):
    """Per-request BYO cloud credential the gateway injects for the resolved
    cloud provider (`apps/api` ``SmrProxyController.applyTenantProviderOverrides``).

    ``api_key`` is a ``SecretStr`` so it never surfaces via ``repr()``/``str()``/
    ``model_dump()``/logging — a provider client must call
    ``.get_secret_value()`` at the single point it hands the key to the SDK.
    """

    api_key: SecretStr
    base_url: str | None = None
    region: str | None = None
    api_version: str | None = None
    deployment_name: str | None = None
    # C4 wire shape: an override MAY pin the model (override-wins over the
    # caller-supplied ``request.model``). Absent ⇒ the caller's model stands.
    model: str | None = None
    # Google Vertex routing — a Vertex client is bound to a (project, location);
    # the tenant's BYO service-account key (``api_key``) is scoped to a project,
    # so both travel with the override. Ignored by every non-Vertex provider.
    project: str | None = None
    location: str | None = None


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
    # Gateway-injected tenant BYO credential, keyed by the SAME provider name
    # as ``provider`` (e.g. ``{"azure": {...}}``). Absent for every caller
    # until a tenant configures an enabled cloud (azure/bedrock) connection —
    # override-wins-over-env/config semantics live in the provider clients.
    provider_overrides: dict[str, ProviderOverride] | None = None

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prompt must not be blank or whitespace-only")
        return v
