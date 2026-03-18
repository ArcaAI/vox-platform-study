"""FastAPI exception handlers that map domain exceptions to HTTP responses."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from smr_v2.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ContentBlockedError,
    InputValidationError,
    ProviderError,
    ProviderNotFoundError,
    ProviderTimeoutError,
    QueueFullError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
    SmrError,
)

_STATUS_MAP: dict[type, int] = {
    InputValidationError: 422,
    ContentBlockedError: 422,
    RateLimitError: 429,
    QueueFullError: 429,
    QueueTimeoutError: 429,
    ProviderNotFoundError: 404,
    CircuitOpenError: 503,
    ShutdownError: 503,
    ConcurrencyLimitError: 503,
    ProviderTimeoutError: 502,
    ProviderError: 502,
    SmrError: 500,
}


def _get_status_code(exc: SmrError) -> int:
    for exc_type, code in _STATUS_MAP.items():
        if isinstance(exc, exc_type):
            return code
    return 500


def _get_headers(exc: SmrError) -> dict[str, str] | None:
    if isinstance(exc, RateLimitError) and exc.retry_after is not None:
        return {"Retry-After": str(int(exc.retry_after) + 1)}
    if isinstance(exc, CircuitOpenError):
        return {"Retry-After": "30"}
    if isinstance(exc, ConcurrencyLimitError):
        return {"Retry-After": "5"}
    return None


async def smr_exception_handler(request: Request, exc: SmrError) -> JSONResponse:
    status = _get_status_code(exc)
    headers = _get_headers(exc)
    return JSONResponse(
        status_code=status,
        content={"detail": exc.message, "error_code": exc.error_code},
        headers=headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(SmrError, smr_exception_handler)
