/**
 * Lightweight, dependency-free text extraction for uploaded lab/exam files
 * (TASK-342 GAP #5).
 *
 * Only trivially text-extractable uploads are handled in-browser via the File
 * API: plain text, CSV/TSV, Markdown, and small JSON. Binary / scanned formats
 * (PDF, images, Office docs) return `null` — heavy OCR (scanned PDFs / photos)
 * is a documented follow-up PR. Callers fall back to the "Lab/exam result:
 * <name>" filename label when this returns `null`, so nothing regresses.
 */

/** Cap the extracted text we thread into the summary/prompt (keeps payload + token cost bounded). */
export const MAX_EXTRACTED_CHARS = 20_000;

const TEXT_EXTENSIONS = ['txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'json', 'log'];

function hasTextExtension(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.includes(ext);
}

function isTextMimeType(type: string): boolean {
  if (!type) return false;
  return type.startsWith('text/') || type === 'application/json' || type === 'application/csv';
}

/** True when the file is trivially text-extractable in-browser (no OCR/parse dependency). */
export function isTextExtractable(file: File): boolean {
  return isTextMimeType(file.type) || hasTextExtension(file.name);
}

/**
 * Returns the file's text contents for trivially text-extractable uploads, else
 * `null`. Never throws — extraction failures degrade gracefully to the label.
 */
export async function extractTextFromFile(file: File): Promise<string | null> {
  if (!isTextExtractable(file)) return null;
  try {
    const raw = await file.text();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_EXTRACTED_CHARS ? trimmed.slice(0, MAX_EXTRACTED_CHARS) : trimmed;
  } catch {
    return null;
  }
}
