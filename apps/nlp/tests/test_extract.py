"""Tests for the document extraction endpoint.

The OCR engine is mocked — tests NEVER download RapidOCR models. PyMuPDF runs for
real on a digitally-generated (text-layer) PDF to prove the no-OCR fast path, and
on a text-less page to prove the "route to OCR" branch.
"""

from unittest.mock import patch

import fitz  # PyMuPDF — generate real PDF fixtures in-memory

from nlp.services.document_extractor import DocumentExtractor

API = "/api/v1/extract"


def _digital_pdf(text: str = "WBC 11.2 x10^9/L high\nHemoglobin 9.8 g/dL") -> bytes:
    """A digital PDF with a real text layer."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    data: bytes = doc.tobytes()
    doc.close()
    return data


def _textless_pdf() -> bytes:
    """A scanned-style page: a PDF page with NO text layer (forces the OCR branch)."""
    doc = fitz.open()
    doc.new_page()
    data: bytes = doc.tobytes()
    doc.close()
    return data


def test_digital_pdf_uses_text_layer_no_ocr(client):
    pdf = _digital_pdf()
    with patch.object(DocumentExtractor, "_ocr_image", return_value="SHOULD-NOT-RUN") as ocr:
        resp = client.post(API, files={"file": ("lab.pdf", pdf, "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert "WBC 11.2" in body["text"]
    assert body["ocrUsed"] is False
    assert body["pageCount"] == 1
    ocr.assert_not_called()


def test_textless_pdf_routes_to_ocr(client):
    pdf = _textless_pdf()
    with patch.object(DocumentExtractor, "_ocr_image", return_value="SCANNED LAB RESULT 5.4"):
        resp = client.post(API, files={"file": ("scan.pdf", pdf, "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert "SCANNED LAB RESULT 5.4" in body["text"]
    assert body["ocrUsed"] is True
    assert body["pageCount"] == 1


def test_image_routes_to_ocr(client):
    with patch.object(DocumentExtractor, "_ocr_image", return_value="GLUCOSE 110 mg/dL"):
        resp = client.post(API, files={"file": ("xray.png", b"\x89PNG\r\n\x1a\n", "image/png")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == "GLUCOSE 110 mg/dL"
    assert body["ocrUsed"] is True
    assert body["pageCount"] == 1


def test_unsupported_type_returns_empty_200(client):
    resp = client.post(
        API,
        files={
            "file": (
                "notes.docx",
                b"PKblob",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == ""
    assert body["ocrUsed"] is False
    assert body["pageCount"] == 0


def test_corrupt_pdf_never_5xx(client):
    resp = client.post(API, files={"file": ("broken.pdf", b"%PDF-1.7 not really a pdf", "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == ""
    assert body["ocrUsed"] is False


def test_empty_text_layer_pdf_with_empty_ocr_is_graceful(client):
    """A text-less page where OCR also yields nothing → empty text, still 200."""
    pdf = _textless_pdf()
    with patch.object(DocumentExtractor, "_ocr_image", return_value=""):
        resp = client.post(API, files={"file": ("blank.pdf", pdf, "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == ""
    assert body["ocrUsed"] is False
