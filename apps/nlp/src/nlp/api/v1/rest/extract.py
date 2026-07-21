from fastapi import APIRouter, Depends, File, UploadFile

from nlp.core.logging import get_logger
from nlp.dependencies import get_document_extractor
from nlp.schemas.extraction import ExtractionResponse
from nlp.services.document_extractor import DocumentExtractor

logger = get_logger(__name__)

router = APIRouter(tags=["NLP REST Extract"])


@router.post("/extract", response_model=ExtractionResponse)
async def extract_document(
    file: UploadFile = File(...),
    service: DocumentExtractor = Depends(get_document_extractor),
) -> ExtractionResponse:
    """Extract text from an uploaded lab/exam document.

    Routes PDFs through PyMuPDF (text layer) + RapidOCR (scanned pages) and images
    through RapidOCR. Always returns HTTP 200 — unsupported/empty/corrupt inputs
    yield an empty extraction so the upload is never blocked and the caller keeps
    its filename-label fallback (graceful degradation, never 5xx).
    """
    try:
        content = await file.read()
        result = service.extract(content, filename=file.filename, content_type=file.content_type)
        return ExtractionResponse(text=result.text, page_count=result.page_count, ocr_used=result.ocr_used)
    except Exception as exc:  # noqa: BLE001 — fail-soft: never 5xx on extraction
        logger.error(f"Document extraction endpoint error: {exc}")
        return ExtractionResponse(text="", page_count=0, ocr_used=False)
