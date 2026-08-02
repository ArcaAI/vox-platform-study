"""Request/response models for the translate API.

Reuses the existing ``ProviderOverride`` (``models/requests.py``) for BYOK — a
per-request tenant credential keyed by the SAME provider name as ``provider``.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from smr.models.requests import ProviderOverride


class TranslateRequest(BaseModel):
    texts: list[str] = Field(..., description="Texts to translate, 1:1 with the response.")
    source_language: str = "auto"
    target_language: str = "en-IN"
    provider: str = "sarvam"
    # Gateway-injected tenant BYO credential, keyed by the SAME provider name as
    # ``provider`` (e.g. ``{"sarvam": {...}}``). Absent for every caller until a
    # tenant configures a BYO connection — override-wins-over-config semantics
    # live in the provider client.
    provider_overrides: dict[str, ProviderOverride] | None = None


class TranslateResponse(BaseModel):
    translations: list[str]
    provider: str
    model: str | None = None
    # Courtesy consumption hook (input character count). Metering is owned by a
    # separate ticket — no metrics are emitted here.
    chars: int = 0
