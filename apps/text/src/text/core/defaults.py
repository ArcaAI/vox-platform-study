"""Generation defaults — applied only when request values are None."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from text.models.requests import GenerateRequest

GENERATION_DEFAULTS: dict[str, float | int] = {
    "temperature": 0.1,
    "max_tokens": 16_384,
    "top_p": 0.95,
}


def resolve_request_defaults(request: GenerateRequest) -> dict[str, float | int]:
    """Return resolved hyperparameters, using defaults only for None values."""
    return {
        "temperature": (
            request.temperature
            if request.temperature is not None
            else GENERATION_DEFAULTS["temperature"]
        ),
        "max_tokens": (
            request.max_tokens
            if request.max_tokens is not None
            else GENERATION_DEFAULTS["max_tokens"]
        ),
        "top_p": request.top_p if request.top_p is not None else GENERATION_DEFAULTS["top_p"],
    }
