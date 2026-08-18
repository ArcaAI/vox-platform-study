from fastapi import APIRouter, Depends, HTTPException

from nlp.core.concurrency import ResizableSemaphore
from nlp.core.logging import get_logger
from nlp.dependencies import (
    get_external_text_client,
    get_inference_bound,
    pinned_text_classifier,
    pinned_token_classifier,
)
from nlp.schemas.classification import (
    IntentClassificationRequest,
    IntentClassificationResponse,
    TextClassificationRequest,
    TextClassificationResponse,
    TokenClassificationRequest,
    TokenClassificationResponse,
    TopicClassificationRequest,
    TopicClassificationResponse,
)
from nlp.services.external_text_client import ExternalTextClient, ExternalTextUnavailableError
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP REST Classify"])


def _require_tenant(tenant_id: str | None, task: str) -> None:
    """TASK-737 — refuse tenant-scoped work that arrives with no tenant.

    `X-Tenant-Id` is MANDATORY on every internal request carrying tenant-scoped
    work (owner directive 2026-08-16); on this surface the gateway injects it into
    the request BODY rather than a header (`apps/nlp` reads no inbound tenant
    header anywhere). Either way the rule is the same: an absent tenant is a defect
    in the CALLER, not something this service should paper over by delegating to
    `text` with no tenant — which would resolve the platform default provider and
    mis-attribute the spend, silently.

    428 (not 400) mirrors the gateway's `RequiresIfMatch` convention: a mandatory
    request precondition is missing.
    """
    if not (tenant_id or "").strip():
        logger.error(f"nlp.tenant_header.missing task={task}")
        raise HTTPException(
            status_code=428,
            detail=(
                "tenant_id is required for tenant-scoped classification (TASK-737). "
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


@router.post("/topic", response_model=TopicClassificationResponse)
async def classify_topic(
    request: TopicClassificationRequest,
    external_text_client: ExternalTextClient | None = Depends(get_external_text_client),
    # Bounds apps/nlp's own concurrent-call budget to `text`, the same
    # semaphore local model inference uses. This reuses `inference_bound`
    # verbatim rather than a dedicated peer-call semaphore — an OPEN
    # question this ticket flags rather than resolves (README §6): a
    # sustained burst of topic/intent calls could starve local
    # classification's inference slots, or vice versa.
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> TopicClassificationResponse:
    """
    Classify text into one of a tenant's configured topics.

    OPEN-taxonomy delegation to `text` (TASK-729): the topic list is
    gateway-injected from `TenantNlpTaskInstructions` — a missing/empty list
    fails closed with HTTP 503, mirroring `/classify/text`'s missing-model_name
    posture (there is no meaningful "classify into no topics" default).
    """
    if not request.instructions:
        raise HTTPException(status_code=503, detail="Topic instructions not configured for this tenant")
    if external_text_client is None:
        raise HTTPException(status_code=503, detail="Topic classification is not available")

    # TASK-737 — the gateway MUST inject `tenant_id`; topic/intent delegation is
    # per-tenant work (the instruction list is the tenant's own taxonomy), so an
    # absent tenant is a CALLER defect and is refused rather than silently
    # delegated to `text` with no tenant.
    _require_tenant(request.tenant_id, "topic")
    prompt = _build_topic_prompt(request.text, request.instructions)
    try:
        async with inference_bound:
            label = await external_text_client.generate_label(
                prompt, tenant_id=str(request.tenant_id)
            )
        return TopicClassificationResponse(predicted_topic=label, available_topics=request.instructions)
    except ExternalTextUnavailableError as e:
        logger.error(f"Topic classification upstream (text) unavailable: {str(e)}")
        raise HTTPException(status_code=503, detail="Topic classification is not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Topic classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Topic classification failed") from e


@router.post("/intent", response_model=IntentClassificationResponse)
async def classify_intent(
    request: IntentClassificationRequest,
    external_text_client: ExternalTextClient | None = Depends(get_external_text_client),
    inference_bound: ResizableSemaphore = Depends(get_inference_bound),
) -> IntentClassificationResponse:
    """
    Classify text into one of a tenant's configured intents.

    OPEN-taxonomy delegation to `text` (TASK-729): the intent list is
    gateway-injected from `TenantNlpTaskInstructions` — a missing/empty list
    fails closed with HTTP 503, mirroring `/classify/text`'s missing-model_name
    posture.
    """
    if not request.instructions:
        raise HTTPException(status_code=503, detail="Intent instructions not configured for this tenant")
    if external_text_client is None:
        raise HTTPException(status_code=503, detail="Intent classification is not available")

    _require_tenant(request.tenant_id, "intent")  # TASK-737 — see /topic above.
    prompt = _build_intent_prompt(request.text, request.instructions)
    try:
        async with inference_bound:
            label = await external_text_client.generate_label(
                prompt, tenant_id=str(request.tenant_id)
            )
        return IntentClassificationResponse(predicted_intent=label, available_intents=request.instructions)
    except ExternalTextUnavailableError as e:
        logger.error(f"Intent classification upstream (text) unavailable: {str(e)}")
        raise HTTPException(status_code=503, detail="Intent classification is not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Intent classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Intent classification failed") from e
