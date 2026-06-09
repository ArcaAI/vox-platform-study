/**
 * extractTextFromFile tests (TASK-342 GAP #5).
 *
 * Lightweight, dependency-free extraction: trivially text-extractable uploads
 * (txt / csv / md / json) yield their contents; binary / scanned formats yield
 * `null` so the caller falls back to the filename label (heavy OCR deferred).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { extractTextFromFile, isTextExtractable, MAX_EXTRACTED_CHARS } from '../extract-text';

function makeFile(name: string, content: string, type = ''): File {
  return new File([content], name, { type });
}

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

  it('returns null for binary / scanned formats (heavy OCR is a deferred follow-up)', async () => {
    expect(await extractTextFromFile(makeFile('scan.pdf', '%PDF-1.7 binary', 'application/pdf'))).toBeNull();
    expect(await extractTextFromFile(makeFile('xray.png', 'PNGblob', 'image/png'))).toBeNull();
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
