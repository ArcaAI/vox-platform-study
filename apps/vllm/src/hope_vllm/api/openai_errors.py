"""OpenAI-shaped errors for the ``/v1/*`` surface (C-3).

Every refusal on ``/v1/*`` is ``{"error": {"message", "type", "param", "code"}}`` — the
body a stock OpenAI SDK parses into its typed exceptions (``NotFoundError`` …) — never
FastAPI's ``{"detail": …}``. The ``/api/v1/*`` house routes keep the house shape.

``type`` follows the status, as OpenAI's does:

=====  =========================  ==============================================
400    ``invalid_request_error``  ``audio_too_long`` · ``unsupported_audio`` ·
                                  ``language_required`` · ``tenant_id_required`` ·
                                  ``invalid_value`` · ``missing_required_parameter``
                                  · ``prompt_too_long``
401    ``authentication_error``   ``invalid_service_token``
404    ``invalid_request_error``  ``model_not_found``
409    ``invalid_request_error``  ``model_not_servable`` (the reason is in the message)
429    ``rate_limit_error``       ``engine_saturated`` (+ ``Retry-After``)
503    ``server_error``           ``engine_capacity`` · ``engine_load_failed`` · a named
                                  build refusal (``MODEL_NOT_PUBLISHED`` …) ·
                                  ``serving_spec_unavailable`` · ``draining``
=====  =========================  ==============================================
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from hope_obs import get_logger
from hope_obs.validation import VALIDATION_FAILED_EVENT, validation_exception_handler
from starlette.responses import Response

logger = get_logger(__name__)

#: The OpenAI error ``type`` for each status this surface answers with.
TYPE_BY_STATUS: dict[int, str] = {
    400: "invalid_request_error",
    401: "authentication_error",
    404: "invalid_request_error",
    409: "invalid_request_error",
    429: "rate_limit_error",
    503: "server_error",
}

#: The path prefix of the OpenAI-compatible surface.
OPENAI_PREFIX = "/v1/"


class OpenAIError(Exception):
    """Raised by a ``/v1/*`` handler; rendered by :func:`install_openai_error_handlers`."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        param: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.param = param
        self.headers = headers


def openai_error(
    status: int,
    code: str,
    message: str,
    *,
    param: str | None = None,
    retry_after: str | None = None,
) -> OpenAIError:
    headers = {"Retry-After": retry_after} if retry_after else None
    return OpenAIError(status, code, message, param=param, headers=headers)


def openai_error_body(message: str, type_: str, param: str | None, code: str) -> bytes:
    """The exact bytes of an OpenAI error body (compact, keys in OpenAI's order)."""
    body = {"error": {"message": message, "type": type_, "param": param, "code": code}}
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def openai_error_response(
    status: int,
    code: str,
    message: str,
    *,
    param: str | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    return Response(
        content=openai_error_body(message, TYPE_BY_STATUS.get(status, "server_error"), param, code),
        status_code=status,
        media_type="application/json",
        headers=headers,
    )


def is_openai_path(path: str) -> bool:
    return path.startswith(OPENAI_PREFIX)


async def _render_openai_error(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, OpenAIError)
    return openai_error_response(
        exc.status, exc.code, exc.message, param=exc.param, headers=exc.headers
    )


async def _render_validation_error(request: Request, exc: Exception) -> Response:
    """``/v1/*``: an OpenAI 400 naming the first bad field. Elsewhere: hope_obs's handler.

    PHI-safe like hope_obs's: the log carries ``loc``/``type`` only, the body a message
    built from the field name — never the value that was sent.
    """
    assert isinstance(exc, RequestValidationError)
    if not is_openai_path(request.url.path):
        return await validation_exception_handler(request, exc)
    errors: list[dict[str, Any]] = list(exc.errors())
    logger.warning(
        VALIDATION_FAILED_EVENT,
        violations=[{"loc": list(e.get("loc", ())), "type": e.get("type", "")} for e in errors],
    )
    first = errors[0] if errors else {}
    loc = [str(part) for part in first.get("loc", ()) if part not in ("body", "query", "header")]
    param = loc[-1] if loc else None
    missing = first.get("type") == "missing"
    code = "missing_required_parameter" if missing else "invalid_value"
    message = (
        f"'{param}' is required" if missing else f"'{param}' is invalid: {first.get('msg', '')}"
    )
    return openai_error_response(400, code, message, param=param)


def install_openai_error_handlers(app: FastAPI) -> None:
    """Register both handlers. Call AFTER ``configure_observability`` (it installs its own
    validation handler, which this one wraps for non-``/v1`` paths)."""
    app.add_exception_handler(OpenAIError, _render_openai_error)
    app.add_exception_handler(RequestValidationError, _render_validation_error)
