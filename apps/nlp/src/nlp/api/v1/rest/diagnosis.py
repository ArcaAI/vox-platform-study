from fastapi import APIRouter, Depends, HTTPException

from nlp.core.logging import get_logger
from nlp.dependencies import get_medical_suggester
from nlp.schemas.diagnosis import DiagnosisSuggestionRequest, DiagnosisSuggestionResponse
from nlp.services.medical_suggester import MedicalSuggester

logger = get_logger(__name__)

router = APIRouter(prefix="/diagnosis", tags=["NLP REST Diagnosis"])


@router.post("/suggestions", response_model=DiagnosisSuggestionResponse)
async def get_diagnosis_suggestions(
    request: DiagnosisSuggestionRequest, service: MedicalSuggester = Depends(get_medical_suggester)
) -> DiagnosisSuggestionResponse:
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
