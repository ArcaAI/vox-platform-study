"""Translation endpoint — POST /api/v1/translate.

Text's ``translate`` capability. Resolves the named translate provider from the
registry, forwards the per-provider BYOK override (if any), and returns the
translations plus a courtesy input character count. Behind ``X-Service-Token``
(the global auth middleware), like every non-exempt Text route.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException

from text.core.dependencies import get_app_state, get_guardrail_client, get_translate_registry
from text.core.logging import get_logger
from text.models.responses import ErrorResponse
from text.models.translate import TranslateRequest, TranslateResponse
from text.services.egress import prepare_text_egress, run_inbound_gate
from text.services.external_guardrail import ExternalGuardrailClient
from text.services.output_gate import OutputRejectedError, gate_completion
from text.translation.base import TranslateProviderNotFoundError, TranslateProviderRegistry
from text.translation.sarvam import (
    SarvamCredentialError,
    SarvamModelError,
    SarvamTranslateError,
)

logger = get_logger(__name__)

router = APIRouter(tags=["translate"])


@router.post(
    "/translate",
    response_model=TranslateResponse,
    responses={
        200: {"model": TranslateResponse},
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def translate(
    request_body: TranslateRequest,
    registry: TranslateProviderRegistry = Depends(get_translate_registry),
    guardrail_client: ExternalGuardrailClient | None = Depends(get_guardrail_client),
    app_state: Any = Depends(get_app_state),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> TranslateResponse:
    inbound = await run_inbound_gate(
        guardrail_client,
        segments=list(request_body.texts),
        prompt="\n\n".join(request_body.texts),
        system="absent",
        tenant_id=x_tenant_id,
        medical_exempt=request_body.medical_exempt,
    )
    egress, outgoing = prepare_text_egress(
        list(request_body.texts),
        provider=request_body.provider,
        provider_locality=request_body.provider_locality,
        known_phi=request_body.known_phi,
        spans_by_segment=inbound.spans_by_segment,
    )

    try:
        provider = registry.get(request_body.provider)
    except TranslateProviderNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Translate provider '{request_body.provider}' not found",
        ) from None

    overrides = (request_body.provider_overrides or {}).get(request_body.provider)

    try:
        translations = await provider.translate(
            outgoing,
            source_language=request_body.source_language,
            target_language=request_body.target_language,
            overrides=overrides,
        )
    except (SarvamCredentialError, SarvamModelError) as exc:
        # No injected connection, or no resolved model selection. Both are a
        # platform-configuration gap an admin can close, so both are a retryable
        # 503 rather than a caller error — and neither is ever substituted for.
        raise HTTPException(
            status_code=503,
            detail=f"Translation unavailable: {exc}",
        ) from exc
    except SarvamTranslateError as exc:
        # Upstream auth/quota/transport/bad-response failure.
        raise HTTPException(
            status_code=502,
            detail=f"Translation failed: {exc}",
        ) from exc

    # The output screen sees the translations BEFORE re-identification, against
    # what the provider actually received (`pii_leak` per locality).
    try:
        await gate_completion(
            guardrail_client,
            completion="\n\n".join(translations),
            source_regions=egress.source_regions,
            tenant_id=x_tenant_id,
            tenant_policy=None,
            app_state=app_state,
            where="translate.post_receive_gate",
            locality=egress.locality,
        )
    except OutputRejectedError as rejected:
        egress.pii_leak_blocked = rejected.pii_leak
        egress.log("translate")
        raise rejected.as_text_error() from None
    translations = [egress.restore(text) for text in translations]
    egress.log("translate")

    # override model wins over the provider's configured model for reporting.
    resolved_model = (overrides.model if overrides and overrides.model else None) or getattr(
        provider, "model", None
    )

    return TranslateResponse(
        translations=translations,
        provider=request_body.provider,
        model=resolved_model,
        chars=sum(len(t) for t in request_body.texts),
        egress=egress.summary,
    )
