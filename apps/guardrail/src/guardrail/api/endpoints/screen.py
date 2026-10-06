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

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from guardrail.core.dependencies import (
    ModelUnavailableError,
    admitted,
    build_pii_span_client,
    build_screener,
    require_tenant_id,
)
from guardrail.core.logging import get_logger
from guardrail.services.injection_defense import wrap_untrusted
from guardrail.services.pii_extraction import windowed_spans
from guardrail.services.windowing import RegionSpan

logger = get_logger(__name__)

router = APIRouter()


class ScreenRegion(BaseModel):
    """One independently-windowed piece of content (TASK-1047 FC-5).

    `key` names it — a data block's name, `system` for an UNTRUSTED system prompt,
    `user` for caller text outside any block — and is echoed on its PII spans.
    """

    key: str = Field(..., min_length=1, description="Region name, echoed on its spans")
    text: str = Field(..., description="The region's content")
    trust: Literal["instruction", "data"] = Field(
        default="instruction",
        description="TASK-1047 FC-5b: `instruction` (default) — a flag blocks; `data` — "
        "classified exactly the same way, but a flag is reported in `data_findings` and "
        "does not block. An undetermined check blocks for either trust.",
    )


class InboundScreenRequest(BaseModel):
    text: str = Field(
        default="",
        description="Untrusted inbound content to screen (legacy single-text shape). "
        "Must be empty when `regions` is given.",
    )
    regions: list[ScreenRegion] | None = Field(
        default=None,
        description="TASK-1047 FC-5: content as regions, each windowed from its own "
        "start. When present `text` must be empty (422 otherwise).",
    )
    kind: str = Field(
        default="content",
        description="What the content IS (transcript, note, document, prompt) — "
        "labels the containment envelope; affects no policy",
    )
    wrap: bool = Field(
        default=True,
        description="Return a nonce-fenced containment envelope for the sanitized text",
    )
    include_pii_spans: bool = Field(
        default=False,
        description="Also return the PII spans of `text` (selection `guardrail.pii.spans`), "
        "extracted concurrently with the safety classification. Used by `apps/text` to "
        "pseudonymize a cloud-bound prompt (TASK-1035).",
    )

    @model_validator(mode="after")
    def _regions_xor_text(self) -> InboundScreenRequest:
        if self.regions is not None and self.text:
            raise ValueError("`text` must be empty when `regions` is given")
        return self


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
    source_regions: list[ScreenRegion] | None = Field(
        default=None,
        description="TASK-1047 FC-5: the source as regions (the data blocks the "
        "response was generated from). Replaces `source_context` when present.",
    )


class PiiSpanModel(BaseModel):
    """One PII span; offsets index the SUBMITTED `text` — or, with `regions`, the
    text of the region named by `region` — and `text` is that slice.

    The value travels back to the internal caller ONLY so it can be replaced on the
    way to a cloud provider. It is never logged here.
    """

    label: str
    start: int
    end: int
    text: str
    score: float
    #: The region key (TASK-1047 FC-5); `null` for a legacy single-`text` request.
    region: str | None = None


class DataFindingModel(BaseModel):
    """A `data`-trust region on which ≥1 inbound check flagged (TASK-1047 FC-5b).

    Region key and check names only — never the region text.
    """

    region: str = Field(..., description="The region key")
    reasons: list[str] = Field(
        default_factory=list, description="The flagged check names, in inbound task order"
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
    #: Inbound only, and only when `include_pii_spans` was set (TASK-1035).
    pii_spans: list[PiiSpanModel] | None = None
    #: TASK-1047 FC-5: on a `regions` (inbound) / `source_regions` (outbound)
    #: request, every key windowed and screened, in the order sent — on ALLOW and
    #: BLOCK alike. `null` on a legacy request. `apps/text` fails closed when a key
    #: it sent is missing, so a guardrail that ignored `regions` can never pass.
    screened_regions: list[str] | None = None
    #: TASK-1047 FC-5b: inbound `regions` requests carrying ≥1 `data` region — one
    #: item per data region with a flagged check (reported, never blocking). `[]`
    #: when nothing flagged; `null` when no `data` region was sent.
    data_findings: list[DataFindingModel] | None = None


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
        data_findings=(
            [DataFindingModel(**finding) for finding in payload["dataFindings"]]
            if payload.get("dataFindings") is not None
            else None
        ),
        **extra,
    )


@router.post("/guardrail/screen/inbound", response_model=ScreenResponse)
async def screen_inbound(request: InboundScreenRequest, http_request: Request) -> ScreenResponse:
    """Screen untrusted inbound content and return a containment envelope.

    With `include_pii_spans`, the PII span extraction runs CONCURRENTLY with the
    classification, and a failed extraction fails the whole call closed (503): a
    caller about to pseudonymize must never mistake "could not look" for "nothing
    found".
    """
    tenant_id = require_tenant_id(http_request)
    spans: list[RegionSpan] | None = None
    # Legacy `text` is ONE region with no key: windowed exactly like a region
    # (TASK-1047 C2), its spans indexing the submitted text as before.
    regions: list[tuple[str | None, str]] = (
        [(region.key, region.text) for region in request.regions]
        if request.regions is not None
        else [(None, request.text)]
    )
    try:
        async with admitted(http_request):
            app_state = http_request.app.state
            screener = await build_screener(app_state, tenant_id)
            if request.regions is not None:
                screen = screener.screen_inbound_regions(
                    [(region.key, region.text, region.trust) for region in request.regions],
                    kind=request.kind,
                )
            else:
                screen = screener.screen_inbound(request.text, kind=request.kind)
            if request.include_pii_spans:
                span_client = await build_pii_span_client(app_state, tenant_id)
                decision, spans = await asyncio.gather(
                    screen,
                    windowed_spans(
                        screener.window_runner,
                        span_client.extract_pii_entities,
                        str(getattr(span_client, "model_id", "") or ""),
                        regions,
                        screener.window_geometry,
                    ),
                )
            else:
                decision = await screen
    except HTTPException:
        raise
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        # FAIL-CLOSED backstop. PHI-safe: the error TYPE, never the screened text.
        logger.exception("guardrail.screen.inbound.failed", error_type=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="inbound screening failed — refusing to report 'allow'",
        ) from exc

    envelope = nonce = None
    # A regions request has no single text to fence; the envelope is a legacy-only
    # convenience (`apps/text` sends `wrap: false`).
    if request.wrap and request.regions is None:
        sanitized_length = decision.sanitization.sanitized_length if decision.sanitization else 0
        # Wrap the SANITIZED text — wrapping the raw text would place smuggled
        # characters inside the envelope, defeating the point of both defenses.
        envelope, nonce = wrap_untrusted(
            request.text[:sanitized_length] if decision.sanitization else request.text,
            kind=request.kind,
        )
    region_text = dict(regions)
    pii_spans = (
        [
            PiiSpanModel(
                label=span.label,
                start=span.start,
                end=span.end,
                text=region_text[span.region][span.start : span.end],
                score=span.score,
                region=span.region,
            )
            for span in spans
        ]
        if spans is not None
        else None
    )
    return _to_response(
        decision,
        envelope=envelope,
        nonce=nonce,
        pii_spans=pii_spans,
        screened_regions=(
            [region.key for region in request.regions] if request.regions is not None else None
        ),
    )


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
                source_regions=(
                    [(region.key, region.text) for region in request.source_regions]
                    if request.source_regions is not None
                    else None
                ),
            )
    except HTTPException:
        raise
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("guardrail.screen.outbound.failed", error_type=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="outbound screening failed — refusing to report 'allow'",
        ) from exc

    return _to_response(
        decision,
        screened_regions=(
            [region.key for region in request.source_regions]
            if request.source_regions is not None
            else None
        ),
    )
