"""Guardrail-class executor routes (TASK-735 Phases 3 & 6).

`apps/guardrail` holds no resident model weights. It owns POLICY — the label
taxonomy, the thresholds, the verdict shape, the fail-closed posture — and
delegates INFERENCE here, the service that already owns NER, token/text
classification and the model cache (rule 06).

Three routes, one contract each way:

* ``POST /guard/pii``        — GLiNER2 entity spans, byte-exact offsets back;
* ``POST /guard/classify``   — GLiNER2 multi-task safety moderation;
* ``POST /guard/entailment`` — MiniCheck NLI, raw support probabilities back.

Every one receives its model id AND its taxonomy from the caller. Fail posture,
declared per rule 06: a MISSING selection or taxonomy is 503 (fail-closed,
never a substituted default), a runtime failure is 503 (never an empty result
that reads as "nothing found"), and an absent tenant is 428.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from nlp.core.concurrency import ResizableSemaphore
from nlp.core.logging import get_logger
from nlp.dependencies import (
    get_inference_bound,
    pinned_entailment_scorer,
    pinned_gliner2_guard,
)
from nlp.schemas.guard import (
    GuardClassifyRequest,
    GuardClassifyResponse,
    GuardEntailmentRequest,
    GuardEntailmentResponse,
    GuardEntity,
    GuardPiiRequest,
    GuardPiiResponse,
)
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/guard", tags=["NLP REST Guard"])


def _require(model_name: str | None, tenant_id: str | None, what: str) -> str:
    """Fail closed on an unresolved selection (503) and on absent attribution (428)."""
    if not (tenant_id or "").strip():
        raise HTTPException(
            status_code=428,
            detail=(
                "tenant_id is required for tenant-scoped guardrail inference. The caller "
                "must inject it; declare 'tenantless:<reason>' for genuinely tenant-less work."
            ),
        )
    if not (model_name or "").strip():
        raise HTTPException(
            status_code=503,
            detail=(
                f"{what} model selection is unresolved. apps/nlp names no model of its own — "
                "the caller resolves it from AiTaskDefault (fail-closed)."
            ),
        )
    return model_name  # type: ignore[return-value]


# Seam, so route tests can inject a fake runtime without touching the cache.
@asynccontextmanager
async def _acquire_guard(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    async with pinned_gliner2_guard(model_name, model_path) as service:
        yield service


@asynccontextmanager
async def _acquire_scorer(
    model_name: str, model_path: str | None = None
) -> AsyncIterator[Any]:
    async with pinned_entailment_scorer(model_name, model_path) as scorer:
        yield scorer


@router.post("/pii", response_model=GuardPiiResponse)
async def guard_pii(
    request: GuardPiiRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardPiiResponse:
    """Extract PII spans with the caller's taxonomy.

    Offsets index the SUBMITTED `text` byte-exactly — guardrail's `/guardrail/redact`
    slices the original string with them, so the round trip must be lossless.
    """
    model_name = _require(request.model_name, request.tenant_id, "PII")
    if not request.labels:
        raise HTTPException(
            status_code=503,
            detail="no PII label taxonomy supplied; the caller owns it as policy (fail-closed).",
        )

    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            async with inference_bound:
                raw = await _maybe_await(
                    service.extract_entities(
                        request.text, request.labels, request.threshold
                    )
                )
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # FAIL-CLOSED: an inference failure must NEVER read back as "no PII found".
        # PHI-safe — log the error type only, never the text.
        logger.error(f"nlp.guard.pii.failed error={type(exc).__name__}")
        raise HTTPException(status_code=503, detail="PII extraction failed") from exc

    return GuardPiiResponse(
        entities=[GuardEntity(**entity) for entity in raw or []],
        model_version=model_name,
    )


@router.post("/classify", response_model=GuardClassifyResponse)
async def guard_classify(
    request: GuardClassifyRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardClassifyResponse:
    """Run the caller's moderation task schema; return ONLY the tasks requested."""
    model_name = _require(request.model_name, request.tenant_id, "safety")
    if not request.tasks:
        raise HTTPException(
            status_code=503,
            detail="no classification task schema supplied; the caller owns it (fail-closed).",
        )

    tasks: dict[str, Any] = {}
    for name, spec in request.tasks.items():
        entry: dict[str, Any] = {
            "labels": list(spec.labels),
            "multi_label": spec.multi_label,
        }
        if spec.cls_threshold is not None:
            entry["cls_threshold"] = spec.cls_threshold
        tasks[name] = entry

    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            async with inference_bound:
                raw = await _maybe_await(
                    service.classify_text(request.text, tasks, request.threshold)
                )
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # A generated label must RAISE, never be fabricated (rule 06).
        logger.error(f"nlp.guard.classify.failed error={type(exc).__name__}")
        raise HTTPException(
            status_code=503, detail="safety classification failed"
        ) from exc

    results: dict[str, str | list[str]] = {}
    for name in request.tasks:
        value = (raw or {}).get(name)
        if isinstance(value, str):
            results[name] = value
        elif isinstance(value, (list, tuple)):
            results[name] = [str(v) for v in value]
        # An absent task is OMITTED, never defaulted to a benign label.
    return GuardClassifyResponse(results=results, model_version=model_name)


@router.post("/entailment", response_model=GuardEntailmentResponse)
async def guard_entailment(
    request: GuardEntailmentRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardEntailmentResponse:
    """Score `P(claim entailed by document)` per pair; the caller owns the threshold."""
    model_name = _require(request.model_name, request.tenant_id, "entailment")
    if not request.pairs:
        return GuardEntailmentResponse(scores=[], model_version=model_name)

    pairs = [(pair.document, pair.claim) for pair in request.pairs]
    try:
        async with _acquire_scorer(model_name, request.model_path) as scorer:
            async with inference_bound:
                scores = await _maybe_await(scorer.score_pairs(pairs))
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # Never fabricate an entailment score — an unscored claim must not read
        # back as grounded. Guardrail degrades to `unverified` on this 503.
        logger.error(f"nlp.guard.entailment.failed error={type(exc).__name__}")
        raise HTTPException(
            status_code=503, detail="entailment scoring failed"
        ) from exc

    return GuardEntailmentResponse(
        scores=[float(score) for score in scores], model_version=model_name
    )


async def _maybe_await(value: Any) -> Any:
    """Accept both sync and async runtimes behind the same seam."""
    if hasattr(value, "__await__"):
        return await value
    return value
