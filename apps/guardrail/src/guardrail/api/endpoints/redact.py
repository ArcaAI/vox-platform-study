"""Tenant-facing PHI redaction endpoint.

``POST /guardrail/redact`` surfaces the PII entity spans GLiNER already computes
for ``/guardrail/analyze`` — offsets + label + score — and were previously
discarded (see ``gliner.py::_sync_analyze``), then applies a masking function in
one of two modes:

* ``pseudonymize`` — clinical entities (medication/condition names, which GLiNER's
  ``PII_LABELS`` never includes) survive verbatim; identifiers are replaced with
  stable per-label placeholder tokens (``[PERSON_1]``, ``[EMAIL_1]``, ...) so
  co-reference within the text is preserved for a downstream NER call. Used before
  the finalized transcript reaches NLP.
* ``full`` — every flagged span becomes the generic marker ``[REDACTED]`` (no
  label leaks). Used for retained / derived / cross-patient artifacts (the DNA
  writing-style corpus, the gate-edit exemplar bank).

NOTE — the exact pseudonymization mechanism (stable token substitution, below) is
the PROVISIONAL choice pending the HUMAN-GATED sign-off (design correction in
``docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md``
§"Spec red-team of dataset.xml" #1, ticket TASK-710 §6 "Decision #12") informed by
`apps/nlp`'s actual entity-linking behavior. Only ``_apply_mask``'s pseudonymize
branch needs to change if that review lands on a different mechanism — the
route/DI contract is stable either way.

Sits behind the ``X-Service-Token`` middleware exactly like ``/guardrail/analyze``
and ``/guardrail/ground`` (nothing here is exempt).

Fail posture — FAIL-CLOSED, the deliberate inverse of the legacy fail-open
``/guardrail/analyze``: a missing DB model selection is HTTP 503; a runtime
extraction failure is a non-200 error. This endpoint NEVER answers 200 with
`sanitized_text` equal to (or derived from) unredacted input on an error path —
a caller that gets 200 back can trust `text` was actually run through PII
extraction. PHI hygiene: request/response text is never logged, only counts.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from guardrail.core.dependencies import get_gliner_model_id, pinned_gliner_provider
from guardrail.core.logging import get_logger
from guardrail.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter()

RedactMode = Literal["pseudonymize", "full"]

_GENERIC_MASK = "[REDACTED]"


class RedactEntityModel(BaseModel):
    """One masked PII span; offsets index the SUBMITTED `text`."""

    label: str = Field(..., description="GLiNER PII label, e.g. person, date_of_birth, email")
    start: int = Field(..., description="Character offset start within `text`")
    end: int = Field(..., description="Character offset end within `text`")
    score: float = Field(..., description="Confidence score (0.0-1.0)")


class RedactRequest(BaseModel):
    """Request model for PHI redaction."""

    text: str = Field(..., description="Text to redact")
    mode: RedactMode = Field(
        ...,
        description=(
            "pseudonymize (preserve clinical terms; mask identifiers with stable "
            "per-label tokens) | full (blanket redaction of every flagged span)"
        ),
    )
    request_id: str | None = Field(None, description="Optional request ID for tracking")


class RedactResponse(BaseModel):
    """Response model for PHI redaction."""

    sanitized_text: str = Field(
        ..., description="`text` with every flagged PII span masked per `mode`"
    )
    entities: list[RedactEntityModel] = Field(
        ..., description="The PII spans that were masked — offsets index the ORIGINAL `text`"
    )
    mode: RedactMode
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")
    request_id: str = Field(..., description="Request ID for tracking")
    timestamp: str = Field(..., description="Redaction timestamp")


def _apply_mask(text: str, entities: list[Any], mode: RedactMode) -> str:
    """Replace entity spans with a mask, right-to-left so earlier offsets stay valid."""
    if not entities:
        return text

    if mode == "full":
        result = text
        for e in sorted(entities, key=lambda e: e.start, reverse=True):
            result = result[: e.start] + _GENERIC_MASK + result[e.end :]
        return result

    # pseudonymize: stable per-label, per-distinct-value token. Assign tokens in
    # left-to-right (document) order so `_1` is always the first-occurring
    # distinct value of a label, then apply the substitution right-to-left.
    token_by_key: dict[tuple[str, str], str] = {}
    counter_by_label: dict[str, int] = {}
    for e in sorted(entities, key=lambda e: e.start):
        key = (e.label, text[e.start : e.end].strip().lower())
        if key not in token_by_key:
            counter_by_label[e.label] = counter_by_label.get(e.label, 0) + 1
            token_by_key[key] = f"[{e.label.upper()}_{counter_by_label[e.label]}]"

    result = text
    for e in sorted(entities, key=lambda e: e.start, reverse=True):
        key = (e.label, text[e.start : e.end].strip().lower())
        result = result[: e.start] + token_by_key[key] + result[e.end :]
    return result


@router.post("/guardrail/redact", response_model=RedactResponse)
async def redact_text(request: RedactRequest, http_request: Request) -> RedactResponse:
    """Redact PII from `text` per `mode`. Fail-closed: never 200 with unredacted text.

    the GLiNER model is DB-selected (``guardrail.safety`` — the SAME
    selection ``/guardrail/analyze`` uses) and loaded lazily on first use; a
    missing DB selection fails closed with 503 (raised by `get_gliner_model_id`).
    A runtime extraction error is mapped to 502 rather than degrading to an
    unredacted 200 — the opposite posture of `/guardrail/analyze`'s legacy
    fail-open error branch.
    """
    start_time = time.monotonic()
    app_state = http_request.app.state

    model_id = await get_gliner_model_id(http_request)  # raises HTTPException(503) when missing

    try:
        async with pinned_gliner_provider(
            app_state, http_request.headers.get("X-Tenant-Id"), model_id=model_id
        ) as gliner_provider:
            entities = await gliner_provider.extract_pii_entities(request.text)
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        # FAIL-CLOSED: never fall through to a 200 echoing `text` back. PHI-safe:
        # log the error type/count only, never the text.
        logger.error("guardrail.redact.extract_failed", error=type(exc).__name__)
        raise HTTPException(status_code=502, detail="PHI redaction failed") from exc

    sanitized_text = _apply_mask(request.text, entities, request.mode)
    processing_time = (time.monotonic() - start_time) * 1000

    return RedactResponse(
        sanitized_text=sanitized_text,
        entities=[
            RedactEntityModel(label=e.label, start=e.start, end=e.end, score=e.score)
            for e in entities
        ],
        mode=request.mode,
        processing_time_ms=processing_time,
        request_id=request.request_id or f"redact_{int(time.time() * 1000)}",
        timestamp=datetime.now(UTC).isoformat(),
    )
