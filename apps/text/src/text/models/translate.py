"""Request/response models for the translate API.

Reuses the existing ``ProviderOverride`` (``models/requests.py``) for BYOK — a
per-request tenant credential keyed by the SAME provider name as ``provider``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from text.models.requests import (
    KnownPhi,
    ProviderLocalityStamp,
    ProviderOverride,
    RegionItemRef,
)
from text.models.responses import EgressSummary


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
    # TASK-1035 §5.0 — the same egress contract as `/generate`.
    provider_locality: dict[str, ProviderLocalityStamp] | None = None
    known_phi: list[KnownPhi] | None = Field(default=None, max_length=200)
    medical_exempt: Literal["internal"] | None = None
    # TASK-1050 — as on `/generate`; the texts are screened as region ``user``.
    region_items: dict[str, list[RegionItemRef]] | None = Field(default=None, max_length=256)
    agent_slug: str | None = Field(default=None, max_length=200)
    response_items: list[RegionItemRef] | None = Field(default=None, max_length=64)


class TranslateResponse(BaseModel):
    translations: list[str]
    provider: str
    model: str | None = None
    # Courtesy consumption hook (input character count). Metering is owned by a
    # separate ticket — no metrics are emitted here.
    chars: int = 0
    # TASK-1035 — counts only, never values.
    egress: EgressSummary | None = None
    # TASK-1050 — see `GenerateResponse`.
    guardrail_notices: list[dict[str, Any]] = Field(default_factory=list)
    guardrail_evaluation_ids: list[str] = Field(default_factory=list)
