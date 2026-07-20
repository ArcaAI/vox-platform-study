from fastapi import APIRouter, HTTPException

from nlp.core.logging import get_logger
from nlp.dependencies import pinned_medical_suggester
from nlp.schemas.diagnosis import DiagnosisSuggestionRequest, DiagnosisSuggestionResponse
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/diagnosis", tags=["NLP REST Diagnosis"])


@router.post("/suggestions", response_model=DiagnosisSuggestionResponse)
async def get_diagnosis_suggestions(request: DiagnosisSuggestionRequest) -> DiagnosisSuggestionResponse:
    # model_name (gateway-injected AiModel.sourceUri) is required and
    # selects ONLY the suggester's disease-classification model (its internal
    # NER stays the default token classifier). Missing/unloadable → 503.
    if not request.model_name:
        raise HTTPException(status_code=503, detail="Medical suggester service not available")

    try:
        async with pinned_medical_suggester(request.model_name) as service:
            if not service.is_initialized:
                raise HTTPException(status_code=503, detail="Medical suggester service not available")

            response = await service.suggest(request)
            logger.info(f"Diagnosis suggestions: {response}")
            return response
    except ModelUnavailableError as e:
        logger.error(f"Medical suggester model load failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Medical suggester service not available") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Medical suggester error: {str(e)}")
        raise HTTPException(status_code=500, detail="Medical suggester error") from e
