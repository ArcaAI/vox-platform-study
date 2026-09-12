"""Guardrail-class executor routes ( Phases 3 & 6).

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
from collections.abc import AsyncIterator, Mapping
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
from nlp.schemas.common import DeviceLabel
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
                "the caller resolves it from AiRoutingPolicy (fail-closed)."
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
) -> tuple[list[dict[str, Any]], int]:
    """Enqueue one text onto the (slot, pii) batcher and await ITS spans.

    The batch closure captures the labels/threshold that DEFINE the group, so a
    request can only ever be evaluated under the policy it was grouped by.

    Returns the spans alongside this request's SHARE of the batched forward
    pass's wall-clock time (TASK-959 metering): the pass's total time divided
    by how many texts rode it, so a request that happened to share a large
    batch is not billed the whole pass.
    """

    async def run_batch(
        _group: str, texts: list[str]
    ) -> list[tuple[list[dict[str, Any]], int]]:
        started = time.perf_counter()
        spans: list[list[dict[str, Any]]] = await service.batch_extract_entities(
            texts, labels, threshold, batch_size
        )
        per_item_ms = round((time.perf_counter() - started) * 1000 / len(texts))
        return [(item_spans, per_item_ms) for item_spans in spans]

    batcher = await get_batcher(slot_key, "pii", run_batch, lane)
    started = time.perf_counter()
    try:
        entities, inference_ms = await batcher.submit(pii_group_key(labels, threshold), text)
        return entities, inference_ms
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
) -> tuple[dict[str, Any], int]:
    """Enqueue one text onto the (slot, classify) batcher and await ITS verdicts.

    Returns the verdicts alongside this request's SHARE of the batched forward
    pass's wall-clock time — see `_submit_pii`.
    """

    async def run_batch(_group: str, texts: list[str]) -> list[tuple[dict[str, Any], int]]:
        started = time.perf_counter()
        verdicts: list[dict[str, Any]] = await service.batch_classify_text(
            texts, tasks, threshold, batch_size
        )
        per_item_ms = round((time.perf_counter() - started) * 1000 / len(texts))
        return [(verdict, per_item_ms) for verdict in verdicts]

    batcher = await get_batcher(slot_key, "classify", run_batch, lane)
    started = time.perf_counter()
    try:
        results, inference_ms = await batcher.submit(
            classify_group_key(tasks, threshold), text
        )
        return results, inference_ms
    finally:
        observe_queue_wait(batcher.name, time.perf_counter() - started)
        _publish_depths()


def _label_and_score(item: Any) -> tuple[str, float | None]:
    """One classification verdict → ``(label, confidence | None)``.

    ``gliner2`` reports ``{"label": …, "confidence": …}`` when asked with
    ``include_confidence=True`` and a bare label string when not. Both are
    accepted, and a confidence that is not a real number is DROPPED rather than
    coerced — an unparseable score must not become a number a caller can
    threshold against.
    """
    if isinstance(item, Mapping):
        label = item.get("label")
        raw_score = item.get("confidence", item.get("score"))
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            score = None
        return str(label if label is not None else ""), score
    return str(item), None


def _split_verdict(value: Any) -> tuple[str | list[str] | None, dict[str, float]]:
    """Split one task's runtime verdict into its LABELS and its CONFIDENCES.

    `results` must keep the exact `str | list[str]` shape it has always had:
    guardrail parses it in three places as "a string, or a sequence I will
    ``str()`` element-wise", so a reshape would have it comparing
    ``"{'label': 'unsafe', …}"`` against its benign-label set. The confidences
    therefore travel in a SEPARATE map.

    This function is also what makes ``include_confidence=True`` safe to turn on.
    The previous inline reduction accepted only ``str`` and ``list``/``tuple``;
    a mapping fell through both branches and the task was silently OMITTED — and
    an omitted task reads downstream as "this check did not run". Flipping the
    flag without this would have blanked the moderation plane.

    A 2-tuple is treated as a two-element label SEQUENCE, not as
    ``(label, confidence)``: with ``format_results=True`` (always, here) gliner2
    never emits a raw pair, whereas a genuine two-label multi-label result is
    routine, and misreading one as the other would invent a label.
    """
    if value is None:
        return None, {}

    if isinstance(value, (str, Mapping)):
        label, score = _label_and_score(value)
        return label, ({label: score} if score is not None else {})

    if isinstance(value, (list, tuple)):
        labels: list[str] = []
        scores: dict[str, float] = {}
        for item in value:
            label, score = _label_and_score(item)
            labels.append(label)
            if score is not None:
                scores[label] = score
        return labels, scores

    return None, {}


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
    # lane rather than from the single global bound used.
    lane = normalize_lane(request.latency_class)
    batch_size = batch_size_for(lane)
    device: DeviceLabel = "cpu"
    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            # Read once, before inference: a device is a property of the whole
            # loaded service, not of the batch a request happened to share.
            # Fakes/stubs in tests carry no `.device` — fall back to the cheaper
            # unit rather than nothing (TASK-959).
            device = getattr(service, "device", "cpu")
            # The semaphore still bounds how many requests may be RESIDENT in the
            # inference stage; the batcher bounds how many forward passes those
            # requests turn into. Both are needed: without the semaphore a burst
            # would pin unbounded memory in flight, and without the batcher each
            # resident request would cost its own pass.
            async with inference_bound:
                raw, inference_ms = await _submit_pii(
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
        inference_ms=inference_ms,
        device=device,
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
    device: DeviceLabel = "cpu"
    try:
        async with _acquire_guard(model_name, request.model_path) as service:
            # See `guard_pii` — read once, before inference (TASK-959).
            device = getattr(service, "device", "cpu")
            async with inference_bound:
                raw, inference_ms = await _submit_classify(
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
    scores: dict[str, dict[str, float]] = {}
    for name in request.tasks:
        value = (raw or {}).get(name)
        verdict, confidences = _split_verdict(value)
        if verdict is None:
            # An absent task is OMITTED, never defaulted to a benign label.
            continue
        results[name] = verdict
        if confidences:
            scores[name] = confidences
    return GuardClassifyResponse(
        results=results,
        scores=scores,
        model_version=model_name,
        inference_ms=inference_ms,
        device=device,
    )


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
        # No inference ran — 0ms on the cheaper unit (TASK-959), never left
        # absent. No model was touched, so there is nothing to report a real
        # device for.
        return GuardEntailmentResponse(
            scores=[], model_version=model_name, inference_ms=0, device="cpu"
        )

    pairs = [(pair.document, pair.claim) for pair in request.pairs]
    device: DeviceLabel = "cpu"
    try:
        async with _acquire_scorer(model_name, request.model_path, request.calibration) as scorer:
            # See `guard_pii` — read once, before inference. Fakes/stubs in
            # tests carry no `.device` — fall back to the cheaper unit.
            device = getattr(scorer, "device", "cpu")
            async with inference_bound:
                started = time.perf_counter()
                scores = await _maybe_await(scorer.score_pairs(pairs))
                inference_ms = round((time.perf_counter() - started) * 1000)
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
        scores=[float(score) for score in scores],
        model_version=model_name,
        inference_ms=inference_ms,
        device=device,
    )


async def _maybe_await(value: Any) -> Any:
    """Accept both sync and async runtimes behind the same seam."""
    if hasattr(value, "__await__"):
        return await value
    return value
