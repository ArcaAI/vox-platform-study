/**
 * Lightweight text extraction for uploaded lab/exam files (TASK-342 GAP #5 +
 * TASK-344 Workstream A1).
 *
 * In-browser extraction tiers (bytes never leave the client):
 *  - Trivially text-extractable uploads (txt / csv / tsv / md / json / log) via
 *    the File API.
 *  - Digital / searchable PDFs (a real text layer) via `pdfjs-dist` — TASK-344
 *    A1. Only the text layer is read; no rendering, no OCR.
 *
 * Image-only / scanned PDFs, photos (JPG/PNG), and Office docs return `null` —
 * server-side OCR (TASK-344 Workstream A2, RapidOCR/PyMuPDF in apps/nlp) picks
 * those up via the same `metadata.extractedText` seam. Callers fall back to the
 * "Lab/exam result: <name>" filename label when this returns `null`, so nothing
 * regresses. Never throws — extraction failures degrade gracefully to the label.
 */

/** Cap the extracted text we thread into the summary/prompt (keeps payload + token cost bounded). */
export const MAX_EXTRACTED_CHARS = 20_000;

const TEXT_EXTENSIONS = ['txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'json', 'log'];

function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function hasTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.includes(fileExtension(name));
}

function isTextMimeType(type: string): boolean {
  if (!type) return false;
  return type.startsWith('text/') || type === 'application/json' || type === 'application/csv';
}

/** True when the file is trivially text-extractable in-browser (no OCR/parse dependency). */
export function isTextExtractable(file: File): boolean {
  return isTextMimeType(file.type) || hasTextExtension(file.name);
}

/** True when the file is a PDF (by MIME type or `.pdf` extension). */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || fileExtension(file.name) === 'pdf';
}

/** Trim + cap helper shared by every extraction tier. */
function normalize(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_EXTRACTED_CHARS ? trimmed.slice(0, MAX_EXTRACTED_CHARS) : trimmed;
}

/**
 * Extract a digital PDF's text layer. Returns `null` for image-only / scanned
 * PDFs (no text layer → server-side OCR handles them) and for any parse failure
 * (corrupt input never throws). Stops early once the cap is reached so a huge
 * PDF doesn't walk every page.
 */
async function extractPdfText(file: File): Promise<string | null> {
  try {
    // Lazy imports (INSIDE this function on purpose): pdfjs touches `DOMMatrix`,
    // which jsdom lacks, so merely importing this module must not pull pdfjs in
    // (it would crash unit tests at import time). Dynamic import also keeps pdfjs
    // out of the main bundle until a PDF is actually parsed. Vite bundles the
    // worker as a hashed asset and `?url` yields its served URL, so the build
    // ships a correct, same-origin worker (no CDN / no eval).
    const pdfjsLib = await import('pdfjs-dist');
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : ''))
        .join(' ');
      text += `${pageText}\n`;
      if (text.length >= MAX_EXTRACTED_CHARS) break;
    }
    return normalize(text);
  } catch {
    return null;
  }
}

/**
 * Returns the file's text contents for extractable uploads (plain text + digital
 * PDFs), else `null`. Never throws.
 */
export async function extractTextFromFile(file: File): Promise<string | null> {
  if (isTextExtractable(file)) {
    try {
      const raw = await file.text();
      return normalize(raw);
    } catch {
      return null;
    }
  }

  // TASK-344 A1 — digital PDFs (text layer). Image-only / scanned PDFs yield no
  // text here and fall through to `null` for server-side OCR (A2).
  if (isPdf(file)) {
    return extractPdfText(file);
  }

  // Images, Office docs, and other binaries → server-side OCR (A2).
  return null;
}
