"""PHI-safe ``RequestValidationError`` handling, shared by every FastAPI service.

FastAPI's default 422 body echoes each violation's ``input`` (and ``ctx``) — the
raw value the caller sent. On this platform that value can be a patient
identifier or clinical text, so the default handler is a PHI leak into the
response body, into any client-side log, and into a gateway that logs upstream
bodies. This handler keeps ``loc``/``msg``/``type`` and drops the rest.

The log line carries ``loc`` and ``type`` only: never ``msg`` (custom validators
may format the value into it) and never ``input``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from hope_obs.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fastapi import FastAPI, Request
    from fastapi.exceptions import RequestValidationError
    from starlette.responses import JSONResponse

VALIDATION_FAILED_EVENT = "hope.request.validation_failed"

_logger = get_logger("hope_obs.validation")


def sanitize_violations(errors: list[Any]) -> list[dict[str, Any]]:
    """``[{loc, msg, type}]`` from pydantic errors, with ``input``/``ctx`` dropped."""
    return [
        {"loc": list(error.get("loc", ())), "msg": error.get("msg", ""), "type": error.get("type", "")}
        for error in errors
    ]


async def validation_exception_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    from starlette.responses import JSONResponse

    violations = sanitize_violations(list(exc.errors()))
    _logger.warning(
        VALIDATION_FAILED_EVENT,
        violations=[{"loc": item["loc"], "type": item["type"]} for item in violations],
    )
    return JSONResponse(status_code=422, content={"detail": violations})


def install_validation_handler(app: FastAPI) -> None:
    """Replace FastAPI's default 422 handler on ``app``. Idempotent."""
    from fastapi.exceptions import RequestValidationError

    app.add_exception_handler(RequestValidationError, validation_exception_handler)  # type: ignore[arg-type]
