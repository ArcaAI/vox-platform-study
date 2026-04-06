from fastapi import APIRouter, Depends, HTTPException

from nlp.core.logging import get_logger
from nlp.dependencies import get_text_classifier, get_token_classifier
from nlp.schemas.classification import (
    TextClassificationRequest,
    TextClassificationResponse,
    TokenClassificationRequest,
    TokenClassificationResponse,
)
from nlp.services.text_classifier import TextClassifier
from nlp.services.token_classifier import TokenClassifier

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP REST Classify"])

@router.post("/text", response_model=TextClassificationResponse)
async def classify_text(
    request: TextClassificationRequest,
    service: TextClassifier = Depends(get_text_classifier),
) -> TextClassificationResponse:
    """
    Classify medical text into document categories

    Uses text classification model to categorize medical documents
    (clinical notes, discharge summaries, lab reports, etc.)
    """
    try:
        # Check if service is initialized
        if not service.is_initialized:
            raise HTTPException(status_code=503, detail="Text classification model not available")

        result = await service.process(request)

        logger.info(f"Text classified with confidence {result.confidence:.3f}")
        return result

    except Exception as e:
        logger.error(f"Text classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Text classification failed") from e


@router.post("/tokens", response_model=TokenClassificationResponse)
async def classify_tokens(
    request: TokenClassificationRequest,
    service: TokenClassifier = Depends(get_token_classifier),
) -> TokenClassificationResponse:
    """
    Classify tokens and extract medical entities

    Uses token classification model to identify and extract medical entities
    with BIO tagging and confidence scores.
    """
    try:
        if not service.is_initialized:
            raise HTTPException(status_code=503, detail="Token classification model not available")

        result = await service.process(request)

        logger.info(f"Token classification extracted {len(result.entities)} entities")

        return result

    except Exception as e:
        logger.error(f"Token classification failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Token classification failed") from e
