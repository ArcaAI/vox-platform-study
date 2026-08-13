"""Request models for the generate API."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator


class RetryConfig(BaseModel):
    max_retries: int = 3
    retry_on: list[str] = Field(default_factory=lambda: ["timeout", "provider_error"])


class ResponseFormat(BaseModel):
    type: Literal["text", "json", "json_schema"] = "text"
    json_schema: dict[str, Any] | None = None
    strict: bool = True


ProviderFunding = Literal["tenant", "platform"]
"""WHO PAID for an injected credential.

The gateway can inject a credential from two tiers — the caller tenant's own
connection row, or the SYSTEM-tenant platform default — and they are the same
bytes on the wire with opposite economics. Tenant-funded spend is metered
notionally and never invoiced; platform-funded spend is real COGS the platform
must recover. SMR must therefore be TOLD which it was, not left to infer it
from the presence of an override.
"""


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
    # Funding origin. Carried PER ENTRY rather than once per
    # request because the platform-default cascade merges tenant-over-platform
    # per provider: one request can legitimately hold a tenant-funded entry and
    # a platform-funded one, which a request-level field cannot express.
    # Non-secret metadata, so deliberately NOT a SecretStr — the attribution
    # must survive ``model_dump()``.
    funding: ProviderFunding = "tenant"

    @field_validator("funding", mode="before")
    @classmethod
    def _unknown_funding_is_tenant(cls, value: object) -> object:
        """Degrade an unrecognized value to ``"tenant"`` instead of 422-ing.

        ABSENT means ``"tenant"`` and that is exact, not a hedge: a gateway
        that does not stamp funding has no platform tier to draw from, so every
        credential it can inject is the caller's own. For a MALFORMED value,
        rejecting the request would take generation down over a metering label
        — the opposite of this lane's fail-open posture for BYO credentials —
        so it degrades to the same conservative default, which can never
        silently convert tenant-funded spend into a platform COGS charge.
        """
        return value if value in ("tenant", "platform") else "tenant"


class TextContentPart(BaseModel):
    """A text segment of a multimodal ``content_parts`` payload."""

    type: Literal["text"] = "text"
    text: str = Field(..., min_length=1)


class ImageContentPart(BaseModel):
    """An image segment of a multimodal ``content_parts`` payload.

    ``data`` is base64-encoded image bytes with NO ``data:`` URI prefix — that
    prefix is one provider's (OpenAI) wire convention, not a property of the
    image itself. Each adapter builds its own native wire shape from
    ``data``/``media_type`` (OpenAI-wire prepends ``data:``, Anthropic/Bedrock/
    Vertex decode/use the raw bytes, Ollama sends the base64 string as-is).
    """

    type: Literal["image"] = "image"
    data: str = Field(..., min_length=1)
    media_type: str = Field(default="image/png", min_length=1)

    @field_validator("media_type")
    @classmethod
    def _media_type_is_image(cls, v: str) -> str:
        if not v.startswith("image/"):
            raise ValueError(f"media_type must be an image/* MIME type, got '{v}'")
        return v


ContentPart = Annotated[TextContentPart | ImageContentPart, Field(discriminator="type")]


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
    # ADDITIVE multimodal input. ``None``/absent ⇒ every existing
    # text-only caller is byte-identical to before — adapters only branch on
    # this when ``image_parts()`` is non-empty. ``prompt`` remains the single
    # source of the textual instruction every adapter sends; a ``TextContentPart``
    # here is advisory (room for future fine-grained multimodal ordering).
    content_parts: list[ContentPart] | None = None

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prompt must not be blank or whitespace-only")
        return v

    def image_parts(self) -> list[ImageContentPart]:
        """Return the image parts of ``content_parts`` (empty when absent)."""
        if not self.content_parts:
            return []
        return [p for p in self.content_parts if isinstance(p, ImageContentPart)]
