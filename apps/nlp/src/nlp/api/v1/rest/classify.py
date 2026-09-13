from fastapi import APIRouter, Depends, HTTPException, Request

from nlp.api.tenant import TENANT_HEADER, assert_tenant_matches_header
from nlp.core.concurrency import ResizableSemaphore
from nlp.core.logging import get_logger
from nlp.dependencies import (
    get_external_text_client,
    get_inference_bound,
    get_peer_call_bound,
    pinned_text_classifier,
    pinned_token_classifier,
)
from nlp.schemas.classification import (
    IntentClassificationRequest,
    IntentClassificationResponse,
    MultiLabelClassificationRequest,
    MultiLabelClassificationResponse,
    TextClassificationRequest,
    TextClassificationResponse,
    TokenClassificationRequest,
    TokenClassificationResponse,
    TopicClassificationRequest,
    TopicClassificationResponse,
)
from nlp.services.external_text_client import ExternalTextClient, ExternalTextUnavailableError
from nlp.services.gliner_token_classifier import ExtractorLabelsUnavailable
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP REST Classify"])


def _require_tenant(tenant_id: str | None, task: str, header_tenant: str | None) -> None:
    """refuse tenant-scoped work that arrives with no tenant.

    `X-Tenant-Id` is MANDATORY on every internal request carrying tenant-scoped
    work (owner directive 2026-08-16); on this surface the gateway injects it into
    the request BODY rather than a header (`apps/nlp` reads no inbound tenant
    header anywhere). Either way the rule is the same: an absent tenant is a defect
    in the CALLER, not something this service should paper over by delegating to
    `text` with no tenant — which would resolve the platform default provider and
    mis-attribute the spend, silently.

    428 (not 400) mirrors the gateway's `RequiresIfMatch` convention: a mandatory
    request precondition is missing. A header that CONTRADICTS the body is a
    different failure and is refused first, with 400.
    """
    assert_tenant_matches_header(tenant_id, header_tenant)
    if not (tenant_id or "").strip():
        logger.error(f"nlp.tenant_header.missing task={task}")
        raise HTTPException(
            status_code=428,
            detail=(
                "tenant_id is required for tenant-scoped classification . "
                "The gateway must inject it; declare 'tenantless:<reason>' for "
                "genuinely tenant-less internal work."
            ),
        )


@router.post("/text", response_model=TextClassificationResponse)
async def classify_text(
    request: TextClassificationRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> TextClassificationResponse:
    """
    Classify medical text into document categories

    Uses text classification model to categorize medical documents
    (clinical notes, discharge summaries, lab reports, etc.)
    """
    # model_name (gateway-injected AiModel.sourceUri) is required;
    # a missing/unloadable model fails closed with HTTP 503.
    if not request.model_name:
        raise HTTPException(status_code=503, detail="Text classification model not available")

    try:
        async with pinned_text_classifier(request.model_name, request.model_path) as service:
            if not service.is_initialized:
                raise HTTPException(
                    status_code=503, detail="Text classification model not available"
                )

            # Bound concurrent inference. The semaphore wraps
            # only the model call, NOT the pin: waiting for capacity must not hold
            # the model-cache pin longer than necessary.
            async with inference_bound:
                result = await service.process(request)
            logger.info(f"Text classified with confidence {result.confidence:.3f}")
            return result
    except ModelUnavailableError as e:
        logger.error(f"Text classification model load failed: {str(e)}")
        raise HTTPException(
            status_code=503, detail="Text classification model not available"
        ) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Text classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Text classification failed") from e


@router.post("/text/multi-label", response_model=MultiLabelClassificationResponse)
async def classify_text_multi_label(
    request: MultiLabelClassificationRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> MultiLabelClassificationResponse:
    """
    Classify text against every label the model exposes, independently.

    Owner decision (2026-08-20, : `nlp.toxicity` is MULTI-LABEL
    toxic + threat + insult may all apply to the same utterance at once, so
    this route returns a per-label score for EVERY label plus the labels that
    clear `cls_threshold` (zero, one, or several), rather than one
    mutually-exclusive winner. Uses the SAME `pinned_text_classifier`/model
    cache as `/classify/text` — the model IS the taxonomy; nothing is
    invented here.
    """
    # model_name (gateway-injected AiModel.sourceUri) is required;
    # a missing/unloadable model fails closed with HTTP 503, mirroring
    # /classify/text's posture exactly.
    if not request.model_name:
        raise HTTPException(status_code=503, detail="Text classification model not available")

    try:
        async with pinned_text_classifier(request.model_name, request.model_path) as service:
            if not service.is_initialized:
                raise HTTPException(
                    status_code=503, detail="Text classification model not available"
                )

            async with inference_bound:
                result = await service.process_multi_label(request)
            logger.info(
                f"Multi-label classification produced {len(result.predicted_labels)} "
                f"label(s) at/above threshold {result.threshold:.2f}"
            )
            return result
    except ModelUnavailableError as e:
        logger.error(f"Multi-label classification model load failed: {str(e)}")
        raise HTTPException(
            status_code=503, detail="Text classification model not available"
        ) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Multi-label classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Multi-label classification failed") from e


@router.post("/tokens", response_model=TokenClassificationResponse)
async def classify_tokens(
    request: TokenClassificationRequest,
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> TokenClassificationResponse:
    """
    Classify tokens and extract medical entities

    Uses token classification model to identify and extract medical entities
    with BIO tagging and confidence scores.
    """
    # model_name (gateway-injected AiModel.sourceUri) is required;
    # a missing/unloadable model fails closed with HTTP 503.
    if not request.model_name:
        raise HTTPException(status_code=503, detail="Token classification model not available")

    try:
        async with pinned_token_classifier(request.model_name, request.model_path) as service:
            if not service.is_initialized:
                raise HTTPException(
                    status_code=503, detail="Token classification model not available"
                )

            # Bound concurrent inference.
            async with inference_bound:
                result = await service.process(request)
            logger.info(f"Token classification extracted {len(result.entities)} entities")
            return result
    except ExtractorLabelsUnavailable as e:
        # F14 — the MODEL loaded; the caller-resolved taxonomy it needs did not
        # arrive. Unserviceable, so 503 like every other fail-closed selection
        # gap on this router (`/guard/pii`, `/classify/topic`) — and the cause
        # stays legible instead of surfacing as a 500.
        logger.error(f"Token classification taxonomy unavailable: {str(e)}")
        raise HTTPException(
            status_code=503, detail="Token classification labels not configured for this model"
        ) from e
    except ModelUnavailableError as e:
        logger.error(f"Token classification model load failed: {str(e)}")
        raise HTTPException(
            status_code=503, detail="Token classification model not available"
        ) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Token classification failed") from e


def _build_topic_prompt(text: str, topics: list[str]) -> str:
    topic_list = ", ".join(topics)
    return (
        f"Classify the following text into exactly ONE of these topics: {topic_list}.\n"
        "Respond with ONLY the topic label, exactly as given, and nothing else.\n\n"
        f"Text: {text}"
    )


def _build_intent_prompt(text: str, intents: list[str]) -> str:
    intent_list = ", ".join(intents)
    return (
        f"Classify the following text into exactly ONE of these intents: {intent_list}.\n"
        "Respond with ONLY the intent label, exactly as given, and nothing else.\n\n"
        f"Text: {text}"
    )


# TASK-957 F-7b — `response_model_exclude_none` so `llm_usage` /
# `llm_guardrail_usage` are OMITTED rather than sent as `null` when text reported none
# (the TASK-959 §10.2 wire convention). Safe on these two responses specifically: no other
# field on either of them is nullable, so nothing else changes shape.
@router.post("/topic", response_model=TopicClassificationResponse, response_model_exclude_none=True)
async def classify_topic(
    request: TopicClassificationRequest,
    http_request: Request,
    external_text_client: ExternalTextClient | None = Depends(get_external_text_client),
    # Owner decision (2026-08-20,: a DEDICATED peer-call
    # semaphore, never `inference_bound`. That bound protects local GPU/CPU
    # inference slots; this one protects apps/nlp's own outbound
    # concurrency/connection budget to `text` — two different resources, so a
    # sustained burst of topic/intent calls can no longer starve local
    # classification (or vice versa).
    peer_call_bound: ResizableSemaphore = Depends(get_peer_call_bound),
) -> TopicClassificationResponse:
    """
    Classify text into one of a tenant's configured topics.

    OPEN-taxonomy delegation to `text` : the topic list is
    gateway-injected from `TenantNlpTaskInstructions` — a missing/empty list
    fails closed with HTTP 503, mirroring `/classify/text`'s missing-model_name
    posture (there is no meaningful "classify into no topics" default).
    """
    if not request.instructions:
        raise HTTPException(
            status_code=503, detail="Topic instructions not configured for this tenant"
        )
    if external_text_client is None:
        raise HTTPException(status_code=503, detail="Topic classification is not available")

    # the gateway MUST inject `tenant_id`; topic/intent delegation is
    # per-tenant work (the instruction list is the tenant's own taxonomy), so an
    # absent tenant is a CALLER defect and is refused rather than silently
    # delegated to `text` with no tenant.
    _require_tenant(request.tenant_id, "topic", http_request.headers.get(TENANT_HEADER))
    prompt = _build_topic_prompt(request.text, request.instructions)
    try:
        async with peer_call_bound:
            # TASK-957 F-7b — the delegated generation's OWN cost rides back with its label.
            # This route runs no local model, so that one LLM call (plus the guardrail call it
            # triggered) IS the cost of a topic classification, and it reached nobody before.
            generated = await external_text_client.generate_label_with_usage(
                prompt, tenant_id=str(request.tenant_id)
            )
        return TopicClassificationResponse(
            predicted_topic=generated.label,
            available_topics=request.instructions,
            llm_usage=generated.usage_detail,
            llm_guardrail_usage=generated.guardrail_usage,
        )
    except ExternalTextUnavailableError as e:
        logger.error(f"Topic classification upstream (text) unavailable: {str(e)}")
        raise HTTPException(status_code=503, detail="Topic classification is not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Topic classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Topic classification failed") from e


# See /topic above for why `response_model_exclude_none` is set.
@router.post(
    "/intent", response_model=IntentClassificationResponse, response_model_exclude_none=True
)
async def classify_intent(
    request: IntentClassificationRequest,
    http_request: Request,
    external_text_client: ExternalTextClient | None = Depends(get_external_text_client),
    # See /topic above — a DEDICATED peer-call semaphore, never `inference_bound`.
    peer_call_bound: ResizableSemaphore = Depends(get_peer_call_bound),
) -> IntentClassificationResponse:
    """
    Classify text into one of a tenant's configured intents.

    OPEN-taxonomy delegation to `text` : the intent list is
    gateway-injected from `TenantNlpTaskInstructions` — a missing/empty list
    fails closed with HTTP 503, mirroring `/classify/text`'s missing-model_name
    posture.
    """
    if not request.instructions:
        raise HTTPException(
            status_code=503, detail="Intent instructions not configured for this tenant"
        )
    if external_text_client is None:
        raise HTTPException(status_code=503, detail="Intent classification is not available")

    # see /topic above.
    _require_tenant(request.tenant_id, "intent", http_request.headers.get(TENANT_HEADER))
    prompt = _build_intent_prompt(request.text, request.instructions)
    try:
        async with peer_call_bound:
            # See /topic above — the delegated generation's own cost rides back with its label.
            generated = await external_text_client.generate_label_with_usage(
                prompt, tenant_id=str(request.tenant_id)
            )
        return IntentClassificationResponse(
            predicted_intent=generated.label,
            available_intents=request.instructions,
            llm_usage=generated.usage_detail,
            llm_guardrail_usage=generated.guardrail_usage,
        )
    except ExternalTextUnavailableError as e:
        logger.error(f"Intent classification upstream (text) unavailable: {str(e)}")
        raise HTTPException(status_code=503, detail="Intent classification is not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Intent classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Intent classification failed") from e
