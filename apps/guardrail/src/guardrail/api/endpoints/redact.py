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

DECISION #12 (TASK-710 §6/§7, CONFIRMED) — the pseudonymization mechanism is stable
per-label, per-distinct-value token substitution, verified against `apps/nlp`'s
actual entity-linking (`ontology_linker.py` + `token_classifier.py`), not assumed:
`OntologyLinker.link()` is a stateless per-span dictionary lookup with no
coreference machinery, so it neither needs nor benefits from stable tokens — but
that is moot either way, because GLiNER's `PII_LABELS` never include a clinical
entity category, so medication/condition/symptom/lab/procedure spans are never
masked under EITHER mode; clinical-term preservation is a structural property of
the label taxonomy, not of the masking choice. The real reason to prefer distinct
per-entity tokens over a single collapsed `[REDACTED]` for `pseudonymize` is the
transformer NER model in `token_classifier.py` that re-tags the WHOLE
pseudonymized document: collapsing every identifier to one repeated literal
string is an unnatural, degenerate token pattern (rare in the model's training
distribution) that transformer attention can latch onto, whereas distinct tokens
(`[PERSON_1]`, `[PERSON_2]`, `[EMAIL_1]`, ...) preserve ordinary token diversity
and keep `NegExAssertionClassifier`'s pre-context trigger scan unaffected either
way (its lexicon never matches on names). `_apply_mask`'s pseudonymize branch
stays the single-function seam for a future mechanism change.

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
from dataclasses import dataclass
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

#: Fallback character budget for ONE GLiNER extraction call, used when the
#: control plane has no opinion (fresh database, gateway unreachable). The
#: authoritative value is the `guardrail.redact.chunkChars` registry key a
#: platform admin manages; see `_resolve_chunk_chars`. Deliberately NOT an env
#: var — a chunk budget must be tunable without redeploying guardrail.
#:
#: 4,000 is the measured knee of the cost curve (100,000-char corpus, CPU-only):
#: 8,000 → 17.5s, 4,000 → 9.7s, 2,000 → 9.3s, 1,000 → 9.9s, with peak RSS flat at
#: ~2.7-2.9GB throughout (the floor is the model itself, not the chunk) and an
#: IDENTICAL entity count at every size. Smaller chunks are faster because the
#: per-call cost is super-linear; below ~2,000 the per-call overhead starts
#: winning it back, and shrinking further would only cost the model context.
_DEFAULT_CHUNK_CHARS = 4000

#: Split points, most-preferred first. The DNA corpus separator comes first so a
#: chunk boundary lands between two whole samples where possible.
_CHUNK_SEPARATORS = ("\n\n---\n\n", "\n\n", "\n", ". ", " ")


@dataclass(frozen=True)
class _Span:
    """One PII span with offsets re-based onto the SUBMITTED document.

    GLiNER reports offsets relative to whatever string it was handed, so a
    chunked extraction yields chunk-local offsets. Normalizing to this type at
    the extraction seam means everything downstream (`_apply_mask`, the response
    model) works in document coordinates only.
    """

    label: str
    start: int
    end: int
    score: float


def _split_for_extraction(text: str, chunk_chars: int) -> list[str]:
    """Partition `text` into chunks of at most `chunk_chars`, cutting on whitespace.

    GLiNER's cost is super-linear in input length (TASK-710 §7 Task 6: 20k chars
    → 3.6s/5.2GB, 50k → 17.5s/17.8GB), so an unbounded call over a large corpus
    exhausts both the caller's HTTP timeout and the worker's memory. Chunking
    makes both linear and bounded.

    Cuts land on a separator boundary so an identifier is never split in half —
    a mid-token cut would hide PII from BOTH chunks, the one way this
    optimization could silently weaken redaction. A run of `chunk_chars` with no
    separator at all (pathological input) is cut hard rather than growing the
    chunk without limit: the memory bound is the invariant that must hold.

    The result is a pure partition — `"".join(result) == text`.
    """
    if chunk_chars <= 0 or len(text) <= chunk_chars:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        if len(text) - start <= chunk_chars:
            chunks.append(text[start:])
            break

        window = text[start : start + chunk_chars]
        cut = -1
        for separator in _CHUNK_SEPARATORS:
            # `rfind` keeps the separator itself at the END of the current
            # chunk, so joining the chunks reproduces the input exactly.
            found = window.rfind(separator)
            if found > 0:
                cut = found + len(separator)
                break

        if cut <= 0:
            cut = chunk_chars  # no boundary in range — hard cut, bound wins
        chunks.append(text[start : start + cut])
        start += cut

    return chunks


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


async def _resolve_chunk_chars(app_state: Any) -> int:
    """Read the admin-managed chunk budget from the control plane.

    `global-kv` tier: the value lives in `GlobalSetting`
    (`guardrail.redact.chunkChars`) and arrives over the same
    `/internal/effective-config` pull the model-cache retention knobs use, so a
    platform admin can retune it without a redeploy. NEVER raises and never
    yields "unbounded": no client, a down gateway, or no opinion all fall back
    to `_DEFAULT_CHUNK_CHARS`.
    """
    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return _DEFAULT_CHUNK_CHARS

    try:
        snapshot = await client.get()
        return int(snapshot.redaction().get("chunk_chars", _DEFAULT_CHUNK_CHARS))
    except Exception as exc:  # noqa: BLE001 — a config read may never break redaction
        logger.warning(
            "guardrail.redact.chunk_config_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return _DEFAULT_CHUNK_CHARS


async def _extract_spans(gliner_provider: Any, text: str, chunk_chars: int) -> list[_Span]:
    """Extract PII spans over bounded chunks, in document coordinates.

    Chunks are processed SEQUENTIALLY on purpose: running them concurrently
    would restore exactly the peak-memory problem chunking exists to solve (the
    provider's own thread pool is shared across requests anyway). Any chunk
    raising propagates — the endpoint's fail-closed posture is unchanged, and a
    partially-extracted document must never be answered with 200.
    """
    spans: list[_Span] = []
    offset = 0
    for chunk in _split_for_extraction(text, chunk_chars):
        entities = await gliner_provider.extract_pii_entities(chunk)
        for entity in entities or []:
            spans.append(
                _Span(
                    label=entity.label,
                    start=entity.start + offset,
                    end=entity.end + offset,
                    score=entity.score,
                )
            )
        offset += len(chunk)
    return spans


def _apply_mask(text: str, entities: list[_Span], mode: RedactMode) -> str:
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
    chunk_chars = await _resolve_chunk_chars(app_state)

    try:
        async with pinned_gliner_provider(
            app_state, http_request.headers.get("X-Tenant-Id"), model_id=model_id
        ) as gliner_provider:
            entities = await _extract_spans(gliner_provider, request.text, chunk_chars)
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
