/**
 * extractTextFromFile tests (TASK-342 GAP #5 + TASK-344 Workstream A1).
 *
 * Lightweight, dependency-free extraction: trivially text-extractable uploads
 * (txt / csv / md / json) yield their contents. TASK-344 A1 adds in-browser
 * PDF *text-layer* extraction via `pdfjs-dist` (mocked here for determinism — no
 * real worker). Image-only / scanned PDFs and images still yield `null` so the
 * caller falls back to the filename label (server-side OCR — A2 — handles them).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractTextFromFile, isTextExtractable, MAX_EXTRACTED_CHARS } from '../extract-text';

// ---------------------------------------------------------------------------
// pdfjs-dist mock — deterministic, no real worker / no real PDF parsing.
// Each test sets `pdfMock.pages` (array of pages, each an array of token
// strings) or `pdfMock.shouldThrow` to drive the branch under test.
// ---------------------------------------------------------------------------
const pdfMock = vi.hoisted(() => ({
  pages: [] as string[][],
  shouldThrow: false,
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mock.js' }));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => {
    pdfMock.getDocument(...args);
    return {
      promise: pdfMock.shouldThrow
        ? Promise.reject(new Error('corrupt pdf'))
        : Promise.resolve({
            numPages: pdfMock.pages.length,
            getPage: (n: number) =>
              Promise.resolve({
                getTextContent: () => Promise.resolve({ items: pdfMock.pages[n - 1].map((str) => ({ str })) }),
              }),
          }),
    };
  },
}));

function makeFile(name: string, content: string, type = ''): File {
  return new File([content], name, { type });
}

function makePdf(name = 'lab.pdf', type = 'application/pdf'): File {
  return new File(['%PDF-1.7 fake'], name, { type });
}

// Reset pdfjs mock state before every test so suites stay isolated.
beforeEach(() => {
  pdfMock.pages = [];
  pdfMock.shouldThrow = false;
  vi.clearAllMocks();
});

describe('extractTextFromFile (TASK-342 GAP #5)', () => {
  it('reads plain-text / csv / md / json file contents as text', async () => {
    expect(await extractTextFromFile(makeFile('cbc.txt', 'WBC 11.2 x10^9/L (high)'))).toBe('WBC 11.2 x10^9/L (high)');
    expect(await extractTextFromFile(makeFile('panel.csv', 'test,value\nWBC,11.2'))).toContain('WBC,11.2');
    expect(await extractTextFromFile(makeFile('note.md', '# Result\nWBC high'))).toContain('WBC high');
    expect(await extractTextFromFile(makeFile('result.json', '{"wbc":11.2}'))).toContain('"wbc":11.2');
  });

  it('detects text-extractable files by mime type even without a known extension', async () => {
    expect(isTextExtractable(makeFile('report', 'hello world', 'text/plain'))).toBe(true);
    expect(await extractTextFromFile(makeFile('report', 'hello world', 'text/plain'))).toBe('hello world');
  });

  it('returns null for image formats (server-side OCR — A2 — handles them)', async () => {
    expect(await extractTextFromFile(makeFile('xray.png', 'PNGblob', 'image/png'))).toBeNull();
    expect(await extractTextFromFile(makeFile('photo.jpg', 'JPEGblob', 'image/jpeg'))).toBeNull();
    expect(isTextExtractable(makeFile('scan.pdf', '', 'application/pdf'))).toBe(false);
  });

  it('returns null for an empty / whitespace-only text file', async () => {
    expect(await extractTextFromFile(makeFile('empty.txt', '   \n  '))).toBeNull();
  });

  it('caps very large extracted text', async () => {
    const huge = 'A'.repeat(MAX_EXTRACTED_CHARS + 5000);
    const out = await extractTextFromFile(makeFile('big.txt', huge));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(MAX_EXTRACTED_CHARS);
  });
});

describe('extractTextFromFile — PDF text layer (TASK-344 A1)', () => {
  it('extracts text from a digital (text-layer) PDF', async () => {
    pdfMock.pages = [
      ['WBC', '11.2', 'x10^9/L', '(high)'],
      ['Hemoglobin', '9.8'],
    ];
    const out = await extractTextFromFile(makePdf());
    expect(out).toContain('WBC 11.2');
    expect(out).toContain('Hemoglobin 9.8');
    expect(pdfMock.getDocument).toHaveBeenCalledTimes(1);
  });

  it('detects a PDF by extension even when the mime type is missing', async () => {
    pdfMock.pages = [['Glucose', '110', 'mg/dL']];
    const out = await extractTextFromFile(makePdf('result.pdf', ''));
    expect(out).toContain('Glucose 110 mg/dL');
  });

  it('returns null for an image-only / no-text-layer PDF (A2 OCR handles it)', async () => {
    pdfMock.pages = [[], []]; // pages exist but carry no text tokens
    expect(await extractTextFromFile(makePdf('scan.pdf'))).toBeNull();
  });

  it('never throws on a corrupt PDF — degrades to null', async () => {
    pdfMock.shouldThrow = true;
    await expect(extractTextFromFile(makePdf('corrupt.pdf'))).resolves.toBeNull();
  });

  it('caps extracted PDF text at MAX_EXTRACTED_CHARS', async () => {
    // One page with far more than 20k chars worth of tokens.
    pdfMock.pages = [Array.from({ length: 6000 }, () => 'AAAA')];
    const out = await extractTextFromFile(makePdf('big.pdf'));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(MAX_EXTRACTED_CHARS);
  });
});
