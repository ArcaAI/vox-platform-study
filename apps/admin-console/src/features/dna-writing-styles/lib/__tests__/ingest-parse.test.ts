/** TASK-1034 — client-side parsing + validation of DNA ingest files (JSON / CSV / TXT). */

import { describe, expect, it } from 'vitest';
import { DNA_INGEST_LIMITS, parseCsv, parseIngestFile, validateIngestRows } from '../ingest-parse';

function file(name: string, content: string, lastModified = Date.parse('2026-09-01T09:30:00.000Z')): File {
  return new File([content], name, { lastModified });
}

describe('parseCsv', () => {
  it('handles quoted fields, escaped quotes, commas and multi-line text', () => {
    const rows = parseCsv('text,writtenAt\n"Line one\nline two, with ""quote""",2026-09-01T09:30:00.000Z\r\nplain,2026-09-02T09:30:00.000Z\n');
    expect(rows).toEqual([
      ['text', 'writtenAt'],
      ['Line one\nline two, with "quote"', '2026-09-01T09:30:00.000Z'],
      ['plain', '2026-09-02T09:30:00.000Z'],
    ]);
  });
});

describe('parseIngestFile', () => {
  it('JSON: accepts a bare array', async () => {
    const result = await parseIngestFile(
      file('a.json', JSON.stringify([{ text: 'Note A', writtenAt: '2026-09-01T09:30:00.000Z', kind: 'CASE_NOTE' }])),
    );
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([{ text: 'Note A', writtenAt: '2026-09-01T09:30:00.000Z', kind: 'CASE_NOTE', source: 'a.json' }]);
  });

  it('JSON: accepts an {items:[…]} envelope and keeps sourceRef', async () => {
    const result = await parseIngestFile(
      file('b.json', JSON.stringify({ items: [{ text: 'X', writtenAt: '2026-09-01T09:30:00.000Z', sourceRef: 'emr-1' }] })),
    );
    expect(result.rows[0]).toMatchObject({ text: 'X', sourceRef: 'emr-1' });
  });

  it('JSON: reports a file-level error for invalid JSON or a wrong shape', async () => {
    expect((await parseIngestFile(file('c.json', '{nope'))).error).toMatch(/not valid JSON/);
    expect((await parseIngestFile(file('d.json', '{"x":1}'))).error).toMatch(/array/);
  });

  it('CSV: maps the header columns (order-independent, optional kind/sourceRef)', async () => {
    const result = await parseIngestFile(file('e.csv', 'writtenAt,text,kind\n2026-09-01T09:30:00.000Z,"Hello, world",WORK_NOTE\n'));
    expect(result.rows).toEqual([{ text: 'Hello, world', writtenAt: '2026-09-01T09:30:00.000Z', kind: 'WORK_NOTE', source: 'e.csv' }]);
  });

  it('CSV: a header without text/writtenAt is a file error', async () => {
    expect((await parseIngestFile(file('f.csv', 'a,b\n1,2\n'))).error).toMatch(/text.*writtenAt/);
  });

  it('TXT: the whole file is one note dated by lastModified, sourceRef = file name', async () => {
    const result = await parseIngestFile(file('note.txt', 'Patient seen.\nPlan: rest.\n'));
    expect(result.rows).toEqual([
      { text: 'Patient seen.\nPlan: rest.', writtenAt: '2026-09-01T09:30:00.000Z', sourceRef: 'note.txt', source: 'note.txt' },
    ]);
  });

  it('rejects unsupported extensions', async () => {
    expect((await parseIngestFile(file('x.pdf', 'z'))).error).toMatch(/Unsupported/);
  });
});

describe('validateIngestRows', () => {
  const ok = { text: 'ok', writtenAt: '2026-09-01T09:30:00.000Z', source: 'a' };

  it('flags empty text, bad dates, unknown kind and over-long text per row', () => {
    const result = validateIngestRows([
      ok,
      { ...ok, text: '  ' },
      { ...ok, writtenAt: 'yesterday' },
      { ...ok, kind: 'LETTER' },
      { ...ok, text: 'x'.repeat(DNA_INGEST_LIMITS.maxItemChars + 1) },
    ]);
    expect(result.rowErrors[0]).toEqual([]);
    expect(result.rowErrors[1][0]).toMatch(/empty/);
    expect(result.rowErrors[2][0]).toMatch(/ISO-8601/);
    expect(result.rowErrors[3][0]).toMatch(/kind/);
    expect(result.rowErrors[4][0]).toMatch(/20,000|20000/);
    expect(result.valid).toBe(false);
  });

  it('flags the batch limits (item count and total characters)', () => {
    const many = Array.from({ length: DNA_INGEST_LIMITS.maxItems + 1 }, () => ok);
    expect(validateIngestRows(many).batchErrors[0]).toMatch(/200/);
    const big = Array.from({ length: 21 }, () => ({ ...ok, text: 'y'.repeat(20_000) }));
    expect(validateIngestRows(big).batchErrors.some((e) => /400,000|400000/.test(e))).toBe(true);
  });

  it('an empty batch is invalid; a clean batch is valid', () => {
    expect(validateIngestRows([]).valid).toBe(false);
    expect(validateIngestRows([ok]).valid).toBe(true);
  });
});
