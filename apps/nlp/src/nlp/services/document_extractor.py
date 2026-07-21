"""Document text extraction.

Route, don't OCR everything (2026 best practice): cheaply read a PDF's text layer
with PyMuPDF, and run OCR (RapidOCR — PaddleOCR models on ONNX Runtime, CPU-only)
ONLY on pages/images that genuinely lack a text layer. OCR-ing digital PDFs is
slow and pointless.

RapidOCR is lazy-loaded on first OCR use, so importing this module — and the unit
tests that mock `_ocr_image` — never download ONNX models. Extraction never
raises to the caller: any failure degrades to an empty result so the upload is
never blocked (the caller keeps the filename-label fallback).
"""

from __future__ import annotations

from typing import Any

from nlp.core.logging import get_logger

logger = get_logger(__name__)

# Mirror the client-side seam cap (`lib/extract-text.ts` MAX_EXTRACTED_CHARS) so
# the live-summary + harness prompt stay token-bounded regardless of source.
MAX_EXTRACTED_CHARS = 20_000

# A page with fewer than this many text-layer characters is treated as
# image-only/scanned and routed to OCR.
MIN_TEXT_LAYER_CHARS = 1

_PDF_CONTENT_TYPES = {"application/pdf"}
_PDF_EXTENSIONS = {"pdf"}
_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/tiff", "image/bmp"}
_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "tiff", "tif", "bmp"}


class ExtractionResult:
    """Plain result holder for {@link DocumentExtractor.extract}."""

    def __init__(self, text: str, page_count: int, ocr_used: bool) -> None:
        self.text = text
        self.page_count = page_count
        self.ocr_used = ocr_used


class DocumentExtractor:
    """Extracts text from PDFs (PyMuPDF text layer + RapidOCR fallback) and images
    (RapidOCR). Stateless apart from the lazily-instantiated OCR engine."""

    # The endpoint mirrors the other NLP services' readiness contract; this
    # extractor has no model to preload so it is always "initialized".
    is_initialized: bool = True

    def __init__(self) -> None:
        self._ocr_engine: Any | None = None

    def extract(self, content: bytes, filename: str | None = None, content_type: str | None = None) -> ExtractionResult:
        """Extract text from raw bytes. Never raises — returns an empty result on
        unsupported types or any parse/OCR failure (graceful degradation)."""
        kind = self._classify(filename, content_type, content)
        try:
            if kind == "pdf":
                return self._extract_pdf(content)
            if kind == "image":
                text = self._cap(self._ocr_image(content))
                return ExtractionResult(text, 1, bool(text))
        except Exception as exc:  # noqa: BLE001 — fail-soft: never block the upload
            logger.warning(f"Document extraction failed (kind={kind}): {exc}")
            return ExtractionResult("", 0, False)

        logger.info(f"Unsupported document type for extraction (filename={filename!r}, content_type={content_type!r})")
        return ExtractionResult("", 0, False)

    def _classify(self, filename: str | None, content_type: str | None, content: bytes) -> str:
        ct = (content_type or "").lower().split(";", 1)[0].strip()
        ext = ""
        if filename and "." in filename:
            ext = filename.rsplit(".", 1)[-1].lower()
        if ct in _PDF_CONTENT_TYPES or ext in _PDF_EXTENSIONS or content[:5] == b"%PDF-":
            return "pdf"
        if ct in _IMAGE_CONTENT_TYPES or ext in _IMAGE_EXTENSIONS:
            return "image"
        return "unsupported"

    def _extract_pdf(self, content: bytes) -> ExtractionResult:
        import fitz  # PyMuPDF — light import, deferred so the module loads without it

        texts: list[str] = []
        ocr_used = False
        with fitz.open(stream=content, filetype="pdf") as doc:
            page_count: int = doc.page_count
            for page in doc:
                page_text = page.get_text().strip()
                if len(page_text) >= MIN_TEXT_LAYER_CHARS:
                    texts.append(page_text)
                else:
                    # No text layer on this page → render + OCR (route, don't OCR everything).
                    pix = page.get_pixmap(dpi=200)
                    ocr_text = self._ocr_image(pix.tobytes("png")).strip()
                    if ocr_text:
                        texts.append(ocr_text)
                        ocr_used = True
                if sum(len(t) for t in texts) >= MAX_EXTRACTED_CHARS:
                    break
        return ExtractionResult(self._cap("\n".join(texts)), page_count, ocr_used)

    def _ocr_image(self, image_bytes: bytes) -> str:
        """Run OCR on raw image bytes. Patched in unit tests so models never load."""
        engine = self._get_ocr_engine()
        result, _ = engine(image_bytes)
        if not result:
            return ""
        return "\n".join(str(line[1]) for line in result)

    def _get_ocr_engine(self) -> Any:
        if self._ocr_engine is None:
            from rapidocr_onnxruntime import RapidOCR  # heavy (ONNX models) — lazy

            self._ocr_engine = RapidOCR()
        return self._ocr_engine

    @staticmethod
    def _cap(text: str) -> str:
        text = text.strip()
        return text[:MAX_EXTRACTED_CHARS] if len(text) > MAX_EXTRACTED_CHARS else text
