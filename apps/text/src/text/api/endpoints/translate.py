"""Translation endpoint — POST /api/v1/translate.

Text's ``translate`` capability. Resolves the named translate provider from the
registry, forwards the per-provider BYOK override (if any), and returns the
translations plus a courtesy input character count. Behind ``X-Service-Token``
(the global auth middleware), like every non-exempt Text route.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from text.core.dependencies import get_translate_registry
from text.core.logging import get_logger
from text.models.responses import ErrorResponse
from text.models.translate import TranslateRequest, TranslateResponse
from text.translation.base import TranslateProviderNotFoundError, TranslateProviderRegistry
from text.translation.sarvam import SarvamCredentialError, SarvamTranslateError

logger = get_logger(__name__)

router = APIRouter(tags=["translate"])


@router.post(
    "/translate",
    response_model=TranslateResponse,
    responses={
        200: {"model": TranslateResponse},
        404: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def translate(
    request_body: TranslateRequest,
    registry: TranslateProviderRegistry = Depends(get_translate_registry),
) -> TranslateResponse:
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
            request_body.texts,
            source_language=request_body.source_language,
            target_language=request_body.target_language,
            overrides=overrides,
        )
    except SarvamCredentialError as exc:
        # Missing credential (no override, no platform key) — retryable/config.
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

    # override model wins over the provider's configured model for reporting.
    resolved_model = (overrides.model if overrides and overrides.model else None) or getattr(
        provider, "model", None
    )

    return TranslateResponse(
        translations=translations,
        provider=request_body.provider,
        model=resolved_model,
        chars=sum(len(t) for t in request_body.texts),
    )
