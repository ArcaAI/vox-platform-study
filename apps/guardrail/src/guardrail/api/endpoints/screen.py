"""Bidirectional screening routes — the inbound prompt AND the outbound response.

`/guardrail/analyze` answers guardrail's legacy `{safe, issues, confidence}` shape
and is unchanged; these routes answer the question that shape cannot:
**who decided, with which model, from whose policy tier, and what would have
happened had the check failed** ( C-4).

Both routes carry tenant-scoped work, so `X-Tenant-Id` is mandatory (428), both
run under the admission gate (503 + `Retry-After` when saturated), and both fail
CLOSED: a check that could not run yields `decision: "block"`, never `"allow"`.

`POST /guardrail/screen/inbound` additionally returns the CONTAINMENT ENVELOPE —
the sanitized content wrapped in a nonce fence with an instruction-data-separation
preamble. A caller that forwards `envelope` instead of its own raw text gets OWASP
LLM01 context segregation for free, and can hand the `nonce` back on the outbound
call so a response that echoes the fence is caught (T6).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from guardrail.core.dependencies import (
    ModelUnavailableError,
    admitted,
    build_screener,
    require_tenant_id,
)
from guardrail.core.logging import get_logger
from guardrail.services.injection_defense import wrap_untrusted

logger = get_logger(__name__)

router = APIRouter()


class InboundScreenRequest(BaseModel):
    text: str = Field(..., description="Untrusted inbound content to screen")
    kind: str = Field(
        default="content",
        description="What the content IS (transcript, note, document, prompt) — "
        "labels the containment envelope; affects no policy",
    )
    wrap: bool = Field(
        default=True,
        description="Return a nonce-fenced containment envelope for the sanitized text",
    )


class OutboundScreenRequest(BaseModel):
    response: str = Field(..., description="Model response to screen before delivery")
    source_context: str | None = Field(
        default=None,
        description="The source the response was generated FROM. Required for the "
        "PII-leakage check; without it that check is reported `skipped`, never `pass`.",
    )
    nonce: str | None = Field(
        default=None,
        description="The containment nonce from the inbound screen, for echo detection",
    )


class ScreenResponse(BaseModel):
    decision: str
    direction: str
    reasons: list[str] = Field(default_factory=list)
    checks: list[dict[str, Any]] = Field(default_factory=list)
    tenant_id: str
    policy_source_tenant_id: str | None = None
    #: WHICH tier supplied the AVAILABILITY set — this tenant, or SYSTEM
    #: (TASK-886). Distinct from `policy_source_tenant_id`: the policy blob rides
    #: the selected model's registry row while the availability set is its own
    #: row, so the two cascades can answer from different tiers and a verdict
    #: needs both to be reconstructible.
    availability_source_tenant_id: str | None = None
    sanitization: dict[str, Any] | None = None
    #: The delegated executor's OWN per-call usage for this screen, forwarded
    #: VERBATIM (TASK-878/G2). Same shape and same ride-back channel as the
    #: `usage_detail` `/api/medical/validate` carries, which `apps/text` already
    #: lifts (`models/usage.guardrail_usage_from_verdict`). `null` when no
    #: delegated call reported one — which is the case for every screen whose
    #: executor is `apps/nlp`, since it runs local weights and meters nothing.
    #: Never `{}` and never zeros: a zero row would tell the billing plane the
    #: call was free rather than that it never happened.
    usage_detail: dict[str, Any] | None = None
    envelope: str | None = Field(
        default=None, description="Nonce-fenced containment envelope (inbound only)"
    )
    nonce: str | None = None


def _to_response(decision: Any, **extra: Any) -> ScreenResponse:
    payload = decision.to_dict()
    return ScreenResponse(
        decision=payload["decision"],
        direction=payload["direction"],
        reasons=payload["reasons"],
        checks=payload["checks"],
        tenant_id=payload["tenantId"],
        policy_source_tenant_id=payload["policySourceTenantId"],
        availability_source_tenant_id=payload["availabilitySourceTenantId"],
        sanitization=payload["sanitization"],
        usage_detail=payload["usageDetail"],
        **extra,
    )


@router.post("/guardrail/screen/inbound", response_model=ScreenResponse)
async def screen_inbound(request: InboundScreenRequest, http_request: Request) -> ScreenResponse:
    """Screen untrusted inbound content and return a containment envelope."""
    tenant_id = require_tenant_id(http_request)
    try:
        async with admitted(http_request):
            screener = await build_screener(http_request.app.state, tenant_id)
            decision = await screener.screen_inbound(request.text, kind=request.kind)
    except HTTPException:
        raise
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        # FAIL-CLOSED backstop. PHI-safe: the error TYPE, never the screened text.
        logger.error("guardrail.screen.inbound.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="inbound screening failed — refusing to report 'allow'",
        ) from exc

    envelope = nonce = None
    if request.wrap:
        sanitized_length = decision.sanitization.sanitized_length if decision.sanitization else 0
        # Wrap the SANITIZED text — wrapping the raw text would place smuggled
        # characters inside the envelope, defeating the point of both defenses.
        envelope, nonce = wrap_untrusted(
            request.text[:sanitized_length] if decision.sanitization else request.text,
            kind=request.kind,
        )
    return _to_response(decision, envelope=envelope, nonce=nonce)


@router.post("/guardrail/screen/outbound", response_model=ScreenResponse)
async def screen_outbound(request: OutboundScreenRequest, http_request: Request) -> ScreenResponse:
    """Screen a model response before it reaches a clinician."""
    tenant_id = require_tenant_id(http_request)
    try:
        async with admitted(http_request):
            screener = await build_screener(http_request.app.state, tenant_id)
            decision = await screener.screen_outbound(
                request.response,
                source_context=request.source_context,
                nonce=request.nonce,
            )
    except HTTPException:
        raise
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("guardrail.screen.outbound.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="outbound screening failed — refusing to report 'allow'",
        ) from exc

    return _to_response(decision)
