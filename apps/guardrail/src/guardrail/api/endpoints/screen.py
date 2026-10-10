"""Bidirectional screening routes — the inbound prompt AND the outbound response.

`/guardrail/analyze` answers guardrail's legacy `{safe, issues, confidence}` shape
and is unchanged; these routes answer the question that shape cannot:
**who decided, with which model, from whose policy tier, and what would have
happened had the check failed** ( C-4).

Both routes carry tenant-scoped work, so `X-Tenant-Id` is mandatory (428), and both
run under the admission gate (503 + `Retry-After` when saturated). A screen that
cannot be COMPOSED at all (no selection, an unexpected error) is still a 503 — never
"allow". Since TASK-1050 a single check that could not run DEGRADES: the check is
`undetermined`, its action taken is `unverified`, `guardrail_decision` is
`unverified` (a `guardrail.unverified` notice) and the legacy binary `decision` reads
`allow` (README §9.8.1, OD-23). Every screen writes one evaluation record to the
Redis outbox before it answers (README §9.8.2).

`POST /guardrail/screen/inbound` additionally returns the CONTAINMENT ENVELOPE —
the sanitized content wrapped in a nonce fence with an instruction-data-separation
preamble. A caller that forwards `envelope` instead of its own raw text gets OWASP
LLM01 context segregation for free, and can hand the `nonce` back on the outbound
call so a response that echoes the fence is caught (T6).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import structlog
from fastapi import APIRouter, HTTPException, Request
from hope_obs.propagation import valid_request_id
from pydantic import BaseModel, ConfigDict, Field, model_validator

from guardrail.core.dependencies import (
    ModelUnavailableError,
    admitted,
    build_pii_span_client,
    build_screener,
    require_tenant_id,
)
from guardrail.core.logging import get_logger
from guardrail.services.evaluation_outbox import (
    GUARDRAIL_CALLERS,
    build_evaluation_record,
    record_outbox_failure,
)
from guardrail.services.injection_defense import wrap_untrusted
from guardrail.services.notices import (
    GuardrailCorrelation,
    apply_guardrail_override,
    build_notices,
)
from guardrail.services.pii_extraction import windowed_spans
from guardrail.services.windowing import RegionSpan

logger = get_logger(__name__)

router = APIRouter()

#: Who asked (`GuardrailEvaluation.caller`). Optional on the wire; absent ⇒ `text.generate`.
CallerLiteral = Literal[
    "text.generate", "text.translate", "harness.guardrail_check", "playground", "governed_prompt"
]
#: Callers with no client waiting on the answer: recorded, but a notice (a CLIENT message)
#: would be one nobody could ever see or resolve.
_NOTICELESS_CALLERS: frozenset[str] = frozenset({"governed_prompt"})


class ItemRefModel(BaseModel):
    """A context item at the version that was screened (TASK-1050 README §9.7.4)."""

    model_config = ConfigDict(populate_by_name=True)

    item_id: str = Field(..., alias="itemId", min_length=1, max_length=128)
    item_version: int = Field(..., alias="itemVersion", ge=0)


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
        "classified exactly the same way, but a flag takes the check's DATA-region action "
        "(platform default `ignore`: reported in `data_findings`, never blocking).",
    )
    items: list[ItemRefModel] | None = Field(
        default=None,
        description="TASK-1050: the context items (at the screened version) behind this "
        "region. They travel onto the evaluation record and the notices, so the gateway "
        "can mark the right item version.",
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
        "pseudonymize a cloud-bound prompt (TASK-1035). Computed on `data` regions only "
        "(TASK-1049 F8) and not at all when `locality` is `local`.",
    )
    locality: Literal["local", "cloud"] | None = Field(
        default=None,
        description="TASK-1049 F8: where the prompt goes. `local` — spans decide nothing "
        "(detect-only, no pseudonymiser), so none are computed and `pii_spans` is `[]`.",
    )
    caller: CallerLiteral | None = Field(default=None, description="TASK-1050: who asked")
    agent_slug: str | None = Field(default=None, max_length=200)
    exempt: Literal["medical_internal"] | None = Field(
        default=None,
        description="TASK-1050: a named exemption the caller applied (recorded, never invisible)",
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
    response_items: list[ItemRefModel] | None = Field(
        default=None,
        description="TASK-1050: the generated context item(s) the response becomes.",
    )
    caller: CallerLiteral | None = Field(default=None, description="TASK-1050: who asked")
    agent_slug: str | None = Field(default=None, max_length=200)
    prompt_context: str | None = Field(
        default=None,
        description="TASK-1050: the USER prompt the response answers. A native response "
        "judge (Qwen3Guard) moderates the (prompt, response) pair; without it the pair is "
        "judged with an empty prompt.",
    )
    locality: Literal["local", "cloud"] | None = Field(
        default=None,
        description="TASK-1059 C-2: where the response was generated. `local` — a `pii_leak` "
        "that is the ONLY blocking check is taken at `warn` (detect-only: a "
        "`guardrail.warning` notice, never a hold). `cloud` / absent — unchanged.",
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
    #: On the OUTBOUND screen it is always `null`: the FC-5c record-only set
    #: (`outboundRecordOnlyChecks`) is retired (TASK-1050 follow-up B) and every outbound
    #: check decides at its configured action.
    data_findings: list[DataFindingModel] | None = None
    #: TASK-1050: `allow` | `warn` | `block` | `unverified` (block > warn > unverified >
    #: allow). `decision` above stays BINARY — `warn` / `unverified` read `allow` there —
    #: because every caller that predates TASK-1050 refuses any other value.
    guardrail_decision: str | None = None
    #: TASK-1050: the `GuardrailNotice` v1 objects this screen raised (warn / block /
    #: unverified checks). PHI-free by construction.
    notices: list[dict[str, Any]] = Field(default_factory=list)
    #: TASK-1050: the id of the evaluation record written for this screen (the
    #: reconciler's gap-detection key, README §9.8.2).
    evaluation_id: str | None = None
    #: The guardrail policy version the screen was decided under.
    policy_version: str | None = None


def _header(http_request: Request, name: str) -> str | None:
    """A bounded, stripped header value, case-insensitively; `None` when absent."""
    headers = getattr(http_request, "headers", None) or {}
    raw = headers.get(name)
    if raw is None and isinstance(headers, dict):
        lowered = name.lower()
        raw = next((v for k, v in headers.items() if str(k).lower() == lowered), None)
    value = str(raw or "").strip()
    return value[:200] if value else None


def _correlation(http_request: Request) -> GuardrailCorrelation:
    """`X-Request-Id` (TASK-1015) + the `GUARDRAIL_CORRELATION_HEADERS` (TASK-1050)."""
    request_id = valid_request_id(_header(http_request, "X-Request-Id"))
    if request_id is None:
        bound = structlog.contextvars.get_contextvars().get("requestId")
        request_id = valid_request_id(bound) or f"gr-{uuid.uuid4().hex}"
    return GuardrailCorrelation(
        request_id=request_id,
        consultation_id=_header(http_request, "X-Hope-Consultation-Id"),
        run_id=_header(http_request, "X-Hope-Run-Id"),
        run_key=_header(http_request, "X-Hope-Run-Key"),
        node_id=_header(http_request, "X-Hope-Node-Id"),
        item_id=_header(http_request, "X-Hope-Item-Id"),
    )


#: Contract amendment 5d0760a60 (`GUARDRAIL_OVERRIDE_HEADER`): internal only.
GUARDRAIL_OVERRIDE_HEADER = "X-Hope-Guardrail-Override"


async def _apply_override(
    http_request: Request, decision: Any, *, tenant_id: str, correlation: GuardrailCorrelation
) -> Any:
    """Honour `X-Hope-Guardrail-Override` ONLY after a read-only check of the notice.

    The header is a CLAIM. It downgrades block → warn for the checks of that notice's
    dedupe key only when the resolver verifies the notice (same tenant, RESOLVED,
    `acknowledged`, within the 24 h cap); a locked / block-floor check is never touched.
    Any failure — unknown id, wrong tenant, not resolved, no resolver, a DB outage — leaves
    the decision exactly as it was and is logged; it never fails the request.
    """
    notice_id = _header(http_request, GUARDRAIL_OVERRIDE_HEADER)
    if not notice_id:
        return decision
    resolver = getattr(getattr(http_request.app, "state", None), "tenant_config_resolver", None)
    verify = getattr(resolver, "verify_guardrail_override", None)
    reason = "resolver_unavailable"
    verdict: Any = None
    if callable(verify):
        try:
            verdict = await verify(tenant_id, notice_id)
            reason = str(getattr(verdict, "reason", "") or "rejected")
        except Exception as exc:  # noqa: BLE001 — never fail the request over an override
            reason = f"verification_error:{type(exc).__name__}"
            verdict = None
    if (
        verdict is None
        or not getattr(verdict, "ok", False)
        or not getattr(verdict, "dedupe_key", None)
    ):
        logger.warning(
            "guardrail.override.rejected",
            tenant_id=tenant_id,
            notice_id=notice_id,
            reason=reason,
        )
        return decision
    overridden = apply_guardrail_override(
        decision,
        correlation=correlation,
        dedupe_key=str(verdict.dedupe_key),
        notice_id=notice_id,
    )
    logger.info(
        "guardrail.override.applied",
        tenant_id=tenant_id,
        notice_id=notice_id,
        checks=[
            c.name for c in overridden.checks if getattr(c, "override_notice_id", None) == notice_id
        ],
    )
    return overridden


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _item_refs(refs: list[ItemRefModel] | None) -> list[tuple[str, int]]:
    return [(ref.item_id, ref.item_version) for ref in refs or []]


async def _capture(
    http_request: Request,
    decision: Any,
    *,
    tenant_id: str,
    caller: str | None,
    agent_slug: str | None = None,
    exempt: str | None = None,
    response_text: str | None = None,
) -> tuple[Any, list[dict[str, Any]], str]:
    """Build the notices + the evaluation record and append it BEFORE answering.

    Never raises and never changes the verdict: a dead outbox is counted and logged,
    and the screen answers exactly as it would have.
    """
    correlation = _correlation(http_request)
    decision = await _apply_override(
        http_request, decision, tenant_id=tenant_id, correlation=correlation
    )
    occurred_at = _now_iso()
    policy_version = getattr(decision, "policy_version", "") or "unavailable"
    notices = (
        []
        if caller in _NOTICELESS_CALLERS
        else build_notices(
            decision,
            tenant_id=tenant_id,
            correlation=correlation,
            policy_version=policy_version,
            occurred_at=occurred_at,
        )
    )
    record = build_evaluation_record(
        decision,
        tenant_id=tenant_id,
        correlation=correlation,
        caller=caller or GUARDRAIL_CALLERS[0],
        notices=notices,
        occurred_at=occurred_at,
        agent_slug=agent_slug,
        exempt=exempt,
        response_text=response_text,
    )
    outbox = getattr(getattr(http_request.app, "state", None), "evaluation_outbox", None)
    if outbox is None:
        record_outbox_failure("unwired")
    else:
        try:
            await outbox.append(record)
        except Exception as exc:  # noqa: BLE001 — capture never breaks a verdict
            record_outbox_failure("append")
            logger.warning(
                "guardrail.evaluation_outbox.append_failed",
                error_type=type(exc).__name__,
                tenant_id=tenant_id,
            )
    return decision, notices, str(record["evaluationId"])


def _to_response(decision: Any, **extra: Any) -> ScreenResponse:
    payload = decision.to_dict()
    return ScreenResponse(
        guardrail_decision=payload.get("guardrailDecision"),
        policy_version=payload.get("policyVersion"),
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
    # TASK-1049 F8: spans exist only to pseudonymise a CLOUD-bound prompt's patient
    # data. Instruction regions are governed at authoring time, and a LOCAL provider
    # is detect-only, so neither is ever sent to the span model.
    span_regions: list[tuple[str | None, str]] = (
        [(region.key, region.text) for region in request.regions if region.trust == "data"]
        if request.regions is not None
        else list(regions)
    )
    if request.locality == "local":
        span_regions = []
    region_items = (
        {region.key: _item_refs(region.items) for region in request.regions if region.items}
        if request.regions is not None
        else {}
    )
    try:
        async with admitted(http_request):
            app_state = http_request.app.state
            screener = await build_screener(app_state, tenant_id)
            if request.regions is not None:
                screen = screener.screen_inbound_regions(
                    [(region.key, region.text, region.trust) for region in request.regions],
                    kind=request.kind,
                    items=region_items,
                    # TASK-1059 OD-2: the PROMPT is never judged for medical scope at runtime —
                    # context is judged in the gateway before composition, authored prompts at
                    # save time (`/api/medical/validate`). The exemption is still recorded.
                    include_medical=False,
                )
            else:
                screen = screener.screen_inbound(request.text, kind=request.kind)
            if request.include_pii_spans and span_regions:
                span_client = await build_pii_span_client(app_state, tenant_id)
                decision, spans = await asyncio.gather(
                    screen,
                    windowed_spans(
                        screener.window_runner,
                        span_client.extract_pii_entities,
                        str(getattr(span_client, "model_id", "") or ""),
                        span_regions,
                        screener.window_geometry,
                    ),
                )
            else:
                decision = await screen
                if request.include_pii_spans:
                    spans = []
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

    # TASK-1050: the evaluation record goes to the outbox BEFORE the answer.
    decision, notices, evaluation_id = await _capture(
        http_request,
        decision,
        tenant_id=tenant_id,
        caller=request.caller,
        agent_slug=request.agent_slug,
        exempt=request.exempt,
    )

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
        notices=notices,
        evaluation_id=evaluation_id,
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
                response_items=_item_refs(request.response_items),
                prompt_context=request.prompt_context,
                locality=request.locality,
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

    # TASK-1050: the evaluation record goes to the outbox BEFORE the answer; the
    # response text rides it only on an outbound BLOCK (withheld, README §9.7.6).
    decision, notices, evaluation_id = await _capture(
        http_request,
        decision,
        tenant_id=tenant_id,
        caller=request.caller,
        agent_slug=request.agent_slug,
        response_text=request.response,
    )

    return _to_response(
        decision,
        notices=notices,
        evaluation_id=evaluation_id,
        screened_regions=(
            [region.key for region in request.source_regions]
            if request.source_regions is not None
            else None
        ),
    )
