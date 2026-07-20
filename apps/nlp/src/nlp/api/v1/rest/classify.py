from fastapi import APIRouter, HTTPException

from nlp.core.logging import get_logger
from nlp.dependencies import pinned_text_classifier, pinned_token_classifier
from nlp.schemas.classification import (
    TextClassificationRequest,
    TextClassificationResponse,
    TokenClassificationRequest,
    TokenClassificationResponse,
)
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP REST Classify"])

@router.post("/text", response_model=TextClassificationResponse)
async def classify_text(request: TextClassificationRequest) -> TextClassificationResponse:
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
        async with pinned_text_classifier(request.model_name) as service:
            if not service.is_initialized:
                raise HTTPException(status_code=503, detail="Text classification model not available")

            result = await service.process(request)
            logger.info(f"Text classified with confidence {result.confidence:.3f}")
            return result
    except ModelUnavailableError as e:
        logger.error(f"Text classification model load failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Text classification model not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Text classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Text classification failed") from e


@router.post("/tokens", response_model=TokenClassificationResponse)
async def classify_tokens(request: TokenClassificationRequest) -> TokenClassificationResponse:
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
        async with pinned_token_classifier(request.model_name) as service:
            if not service.is_initialized:
                raise HTTPException(status_code=503, detail="Token classification model not available")

            result = await service.process(request)
            logger.info(f"Token classification extracted {len(result.entities)} entities")
            return result
    except ModelUnavailableError as e:
        logger.error(f"Token classification model load failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Token classification model not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Token classification failed") from e
