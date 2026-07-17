from fastapi import APIRouter, Depends, HTTPException

from nlp.core.logging import get_logger
from nlp.dependencies import get_medical_suggester, get_medical_suggester_for
from nlp.schemas.diagnosis import DiagnosisSuggestionRequest, DiagnosisSuggestionResponse
from nlp.services.medical_suggester import MedicalSuggester

logger = get_logger(__name__)

router = APIRouter(prefix="/diagnosis", tags=["NLP REST Diagnosis"])


@router.post("/suggestions", response_model=DiagnosisSuggestionResponse)
async def get_diagnosis_suggestions(
    request: DiagnosisSuggestionRequest, service: MedicalSuggester = Depends(get_medical_suggester)
) -> DiagnosisSuggestionResponse:
    # TASK-506 — optional override of ONLY the suggester's classification model
    # (its internal NER stays the default token classifier); load failure → 503.
    if request.model_name:
        try:
            service = await get_medical_suggester_for(request.model_name)
        except Exception as e:
            logger.error(f"Medical suggester model load failed: {str(e)}")
            raise HTTPException(status_code=503, detail="Medical suggester service not available") from e

    try:
        if not service.is_initialized:
            raise HTTPException(status_code=503, detail="Medical suggester service not available")

        response = await service.suggest(request)

        logger.info(f"Diagnosis suggestions: {response}")

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Medical suggester error: {str(e)}")
        raise HTTPException(status_code=500, detail="Medical suggester error") from e
