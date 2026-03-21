from fastapi import APIRouter, Depends, HTTPException

from nlp.core.logging import get_logger
from nlp.schemas.correction import TextCorrectionRequest, TextCorrectionResponse
from nlp.services.text_corrector import TextCorrector
from nlp.dependencies import get_text_corrector

logger = get_logger(__name__)

router = APIRouter(prefix="/correct", tags=["NLP REST Correct"])


@router.post("/text", response_model=TextCorrectionResponse)
async def correct_text(
    request: TextCorrectionRequest,
    service: TextCorrector = Depends(get_text_corrector),
) -> TextCorrectionResponse:
    try:
        if not service.is_initialized:
            raise HTTPException(status_code=503, detail="Spelling correction service not available")

        response = await service.correct(request=request)

        logger.info(f"Correction completed for language {request.language.value}")

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Correction failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Correction failed")
