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

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from nlp.api.tenant import TENANT_HEADER, assert_tenant_matches_header
from nlp.core.batching import InferenceQueueFull, InferenceQueueTimeout
from nlp.core.concurrency import ResizableSemaphore
from nlp.core.logging import get_logger
from nlp.core.metrics import observe_queue_wait, publish_queue_depths, record_rejection
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
from nlp.services.guard_dispatch import (
    batch_size_for,
    classify_group_key,
    get_batcher,
    live_batchers,
    normalize_lane,
    pii_group_key,
)
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/guard", tags=["NLP REST Guard"])


def _slot_key(model_name: str, model_path: str | None) -> str:
    """The batcher slot — the SAME weight identity the model cache keys on, so an
    admin flipping `AiModel.localPath` gets a fresh batcher with the fresh
    weights instead of a queue still pointed at the old runtime."""
    return f"{model_name}\x00{model_path}" if model_path else model_name


def _require(
    model_name: str | None, tenant_id: str | None, what: str, header_tenant: str | None
) -> str:
    """Fail closed on an unresolved selection (503) and on absent attribution (428).

    A header that CONTRADICTS the body is refused first (400): a request that
    names two tenants cannot be attributed to either.
    """
    assert_tenant_matches_header(tenant_id, header_tenant)
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
async def _acquire_guard(model_name: str, model_path: str | None = None) -> AsyncIterator[Any]:
    async with pinned_gliner2_guard(model_name, model_path) as service:
        yield service


@asynccontextmanager
async def _acquire_scorer(
    model_name: str, model_path: str | None = None, calibration: Any = None
) -> AsyncIterator[Any]:
    async with pinned_entailment_scorer(model_name, model_path, calibration) as scorer:
        yield scorer


def _shed(route: str, exc: Exception, reason: str, lane: str) -> HTTPException:
    """Turn a declared backpressure signal into a retryable 503.

    Deliberately NOT an empty result: an empty PII list means "scanned, found
    nothing", so returning one under overload would silently switch redaction
    off at exactly the moment the platform is busiest.
    """
    # Shedding is attributed to a SERVICE CLASS: the interactive ceiling is
    # deliberately short, so its timeouts are an expected, declared outcome and
    # must not read as bulk-lane overload on a dashboard.
    record_rejection(route, reason, lane)
    logger.warning(f"nlp.guard.shed route={route} lane={lane} reason={reason}")
    return HTTPException(
        status_code=503,
        detail=f"inference {reason.replace('_', ' ')}: {exc}",
        headers={"Retry-After": "1"},
    )


def _publish_depths() -> None:
    publish_queue_depths(
        {batcher.name: batcher.queue_depth for batcher in live_batchers().values()}
    )


async def _submit_pii(
    service: Any,
    slot_key: str,
    text: str,
    labels: list[str],
    threshold: float,
    batch_size: int,
    lane: str,
) -> list[dict[str, Any]]:
    """Enqueue one text onto the (slot, pii) batcher and await ITS spans.

    The batch closure captures the labels/threshold that DEFINE the group, so a
    request can only ever be evaluated under the policy it was grouped by.
    """

    async def run_batch(_group: str, texts: list[str]) -> list[list[dict[str, Any]]]:
        spans: list[list[dict[str, Any]]] = await service.batch_extract_entities(
            texts, labels, threshold, batch_size
        )
        return spans

    batcher = await get_batcher(slot_key, "pii", run_batch, lane)
    started = time.perf_counter()
    try:
        entities: list[dict[str, Any]] = await batcher.submit(
            pii_group_key(labels, threshold), text
        )
        return entities
    finally:
        observe_queue_wait(batcher.name, time.perf_counter() - started)
        _publish_depths()


async def _submit_classify(
    service: Any,
    slot_key: str,
    text: str,
    tasks: dict[str, Any],
    threshold: float,
    batch_size: int,
    lane: str,
) -> dict[str, Any]:
    """Enqueue one text onto the (slot, classify) batcher and await ITS verdicts."""

    async def run_batch(_group: str, texts: list[str]) -> list[dict[str, Any]]:
        verdicts: list[dict[str, Any]] = await service.batch_classify_text(
            texts, tasks, threshold, batch_size
        )
        return verdicts

    batcher = await get_batcher(slot_key, "classify", run_batch, lane)
    started = time.perf_counter()
    try:
        results: dict[str, Any] = await batcher.submit(
            classify_group_key(tasks, threshold), text
        )
        return results
    finally:
        observe_queue_wait(batcher.name, time.perf_counter() - started)
        _publish_depths()


@router.post("/pii", response_model=GuardPiiResponse)
async def guard_pii(
    request: GuardPiiRequest,
    http_request: Request,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardPiiResponse:
    """Extract PII spans with the caller's taxonomy.

    Offsets index the SUBMITTED `text` byte-exactly — guardrail's `/guardrail/redact`
    slices the original string with them, so the round trip must be lossless.
    """
    model_name = _require(
        request.model_name,
        request.tenant_id,
        "PII",
        http_request.headers.get(TENANT_HEADER),
    )
    if not request.labels:
        raise HTTPException(
            status_code=503,
            detail="no PII label taxonomy supplied; the caller owns it as policy (fail-closed).",
        )

    # The lane decides the geometry, so the runtime `batch_size` comes from the
    # lane rather than from the single global bound TASK-778 used.
    lane = normalize_lane(request.latency_class)
    batch_size = batch_size_for(lane)
    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            # The semaphore still bounds how many requests may be RESIDENT in the
            # inference stage; the batcher bounds how many forward passes those
            # requests turn into. Both are needed: without the semaphore a burst
            # would pin unbounded memory in flight, and without the batcher each
            # resident request would cost its own pass.
            async with inference_bound:
                raw = await _submit_pii(
                    service,
                    _slot_key(model_name, request.model_path),
                    request.text,
                    list(request.labels),
                    request.threshold,
                    batch_size,
                    lane,
                )
    except InferenceQueueFull as exc:
        raise _shed("guard_pii", exc, "queue_full", lane) from exc
    except InferenceQueueTimeout as exc:
        raise _shed("guard_pii", exc, "queue_timeout", lane) from exc
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
    http_request: Request,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardClassifyResponse:
    """Run the caller's moderation task schema; return ONLY the tasks requested."""
    model_name = _require(
        request.model_name,
        request.tenant_id,
        "safety",
        http_request.headers.get(TENANT_HEADER),
    )
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

    lane = normalize_lane(request.latency_class)
    batch_size = batch_size_for(lane)
    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            async with inference_bound:
                raw = await _submit_classify(
                    service,
                    _slot_key(model_name, request.model_path),
                    request.text,
                    tasks,
                    request.threshold,
                    batch_size,
                    lane,
                )
    except InferenceQueueFull as exc:
        raise _shed("guard_classify", exc, "queue_full", lane) from exc
    except InferenceQueueTimeout as exc:
        raise _shed("guard_classify", exc, "queue_timeout", lane) from exc
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # A generated label must RAISE, never be fabricated (rule 06).
        logger.error(f"nlp.guard.classify.failed error={type(exc).__name__}")
        raise HTTPException(status_code=503, detail="safety classification failed") from exc

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
    http_request: Request,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> GuardEntailmentResponse:
    """Score `P(claim entailed by document)` per pair; the caller owns the threshold."""
    model_name = _require(
        request.model_name,
        request.tenant_id,
        "entailment",
        http_request.headers.get(TENANT_HEADER),
    )
    if not request.pairs:
        return GuardEntailmentResponse(scores=[], model_version=model_name)

    pairs = [(pair.document, pair.claim) for pair in request.pairs]
    try:
        async with _acquire_scorer(model_name, request.model_path, request.calibration) as scorer:
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
        raise HTTPException(status_code=503, detail="entailment scoring failed") from exc

    return GuardEntailmentResponse(
        scores=[float(score) for score in scores], model_version=model_name
    )


async def _maybe_await(value: Any) -> Any:
    """Accept both sync and async runtimes behind the same seam."""
    if hasattr(value, "__await__"):
        return await value
    return value
