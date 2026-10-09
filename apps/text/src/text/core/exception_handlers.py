"""FastAPI exception handlers that map domain exceptions to HTTP responses."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opentelemetry import trace
from opentelemetry.trace import StatusCode

from text.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ContentBlockedError,
    EgressRedactionUnavailableError,
    GuardrailUnavailableError,
    InputValidationError,
    JudgeProviderNotLocalError,
    PoolUnhealthyError,
    ProviderCredentialsError,
    ProviderError,
    ProviderNotFoundError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    QueueFullError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
    TextError,
)
from text.core.logging import get_logger

logger = get_logger(__name__)

_STATUS_MAP: dict[type, int] = {
    InputValidationError: 422,
    ContentBlockedError: 422,
    EgressRedactionUnavailableError: 503,
    GuardrailUnavailableError: 503,
    JudgeProviderNotLocalError: 503,
    RateLimitError: 429,
    QueueFullError: 429,
    QueueTimeoutError: 429,
    ProviderNotFoundError: 404,
    ProviderCredentialsError: 503,
    CircuitOpenError: 503,
    PoolUnhealthyError: 503,
    ShutdownError: 503,
    ConcurrencyLimitError: 503,
    ProviderUnavailableError: 503,
    ProviderTimeoutError: 502,
    ProviderError: 502,
    TextError: 500,
}


def _get_status_code(exc: TextError) -> int:
    for exc_type, code in _STATUS_MAP.items():
        if isinstance(exc, exc_type):
            return code
    return 500


def _get_headers(exc: TextError) -> dict[str, str] | None:
    if isinstance(exc, RateLimitError) and exc.retry_after is not None:
        headers = {"Retry-After": str(int(exc.retry_after) + 1)}
        # a soft limit answers 429 + `Retry-After` + `RateLimit-Remaining`.
        # Omitted rather than zeroed when the limiter has no number: "0" is an
        # instruction to stop sending, and inventing one is worse than silence.
        if exc.remaining is not None:
            headers["RateLimit-Remaining"] = str(exc.remaining)
        return headers
    if isinstance(exc, CircuitOpenError):
        return {"Retry-After": "30"}
    if isinstance(exc, PoolUnhealthyError):
        return {"Retry-After": "30"}
    if isinstance(exc, ConcurrencyLimitError):
        return {"Retry-After": "5"}
    return None


#: The response class for every error body this service emits.
#:
# proposed `ORJSONResponse` here and as the app's
#: `default_response_class`. It was implemented, measured, and REJECTED — the
#: numbers are in the note above `router` in `api/endpoints/generate.py`. Two
#: facts settle it:
#:
# * The win is microseconds. An error body is `{"detail", "error_code"}`; even
# On a full 770-byte `GenerateResponse` the stdlib-vs-orjson difference was
# 0.0033 ms vs 0.0003 ms, against a ~8 ms/request CPU budget. `orjson` does
# Not avoid `jsonable_encoder`, which is 87% of the render cost.
# * FastAPI 0.141 DEPRECATES `ORJSONResponse` — including when constructed
# Directly in an exception handler, which is exactly what this is. It emits
# A `FastAPIDeprecationWarning` on every error response.
#:
#: Named rather than inlined so the decision is assertable and the next reader
#: does not re-litigate it. The real request-path win was elsewhere entirely:
#: pure-ASGI middleware, ~30% of per-request CPU (`api/middleware/request_id.py`).
ERROR_RESPONSE_CLASS = JSONResponse


async def text_exception_handler(request: Request, exc: TextError) -> JSONResponse:
    status = _get_status_code(exc)
    headers = _get_headers(exc)

    # `exc.message` is deliberately not logged: a provider or validation
    # message can carry prompt or clinical content, and a rendered traceback
    # repeats it, so there is no `exc_info` either. Code, type and status are
    # the stable, searchable part.
    log = logger.error if status >= 500 else logger.warning
    log(
        "text.error",
        error_code=exc.error_code,
        error_type=type(exc).__name__,
        status_code=status,
    )

    span = trace.get_current_span()
    if span.is_recording():
        span.set_status(StatusCode.ERROR, exc.message)
        span.record_exception(exc)

    content: dict[str, object] = {"detail": exc.message, "error_code": exc.error_code}
    # TASK-1050: a guardrail block / redaction hold adds its notice and evaluation ids
    # (PHI-free by construction) beside the house envelope's two fields.
    extra = getattr(exc, "extra_body", None)
    if isinstance(extra, dict):
        content.update(extra)
    return ERROR_RESPONSE_CLASS(status_code=status, content=content, headers=headers)


def register_exception_handlers(app: FastAPI) -> None:
    # Starlette types handlers as (Request, Exception) -> Response; ours narrows
    # exc to TextError (it is only registered for TextError), which mypy flags.
    app.add_exception_handler(TextError, text_exception_handler)  # type: ignore[arg-type]
