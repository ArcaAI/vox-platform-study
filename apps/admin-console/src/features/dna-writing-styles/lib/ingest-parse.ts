/**
 * TASK-1034 — client-side parsing of DNA writing-sample ingest files.
 *
 * Formats (owner OD-8: JSON, CSV and plain text):
 *  - `.json` — an array of `{ text, writtenAt, kind?, sourceRef? }`, or `{ items: [...] }`.
 *  - `.csv`  — header row naming `text` and `writtenAt` (any order, case-insensitive), optional
 *              `kind` / `sourceRef`; RFC 4180 quoting ("" escapes, commas and newlines inside quotes).
 *  - `.txt`  — the whole file is ONE note; `writtenAt` = the file's lastModified, `sourceRef` = its name.
 *
 * The limits mirror `DNA_INGEST_LIMITS` / `DNA_WRITING_SAMPLE_KINDS` in
 * `packages/applications/src/services/dna-writing-style/dto/ingest-dna-writing-samples.request.ts`
 * (the console cannot import server packages). The server stays authoritative.
 */

export const DNA_INGEST_LIMITS = {
  maxItems: 200,
  maxItemChars: 20_000,
  maxTotalChars: 400_000,
} as const;

export const DNA_WRITING_SAMPLE_KINDS = ['CASE_NOTE', 'WORK_NOTE', 'OTHER'] as const;
export type DnaWritingSampleKind = (typeof DNA_WRITING_SAMPLE_KINDS)[number];

/** One parsed row. `kind` is kept as the raw string so validation can flag an unknown value. */
export interface IngestRow {
  text: string;
  writtenAt: string;
  kind?: string;
  sourceRef?: string;
  /** File the row came from (preview only; never sent). */
  source: string;
}

export interface ParsedIngestFile {
  fileName: string;
  rows: IngestRow[];
  /** File-level failure (unreadable, wrong shape); `rows` is empty when set. */
  error?: string;
}

/** RFC 4180-style CSV tokenizer. Returns rows of raw cells; blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = input.replace(/^﻿/, '');

  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function fromObject(value: unknown, source: string): IngestRow {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const row: IngestRow = {
    text: typeof record.text === 'string' ? record.text : '',
    writtenAt: typeof record.writtenAt === 'string' ? record.writtenAt : '',
    source,
  };
  const kind = optionalString(record.kind);
  const sourceRef = optionalString(record.sourceRef);
  if (kind) row.kind = kind;
  if (sourceRef) row.sourceRef = sourceRef;
  return row;
}

function parseJsonRows(content: string, fileName: string): ParsedIngestFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { fileName, rows: [], error: `${fileName} is not valid JSON.` };
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!items) return { fileName, rows: [], error: `${fileName} must hold an array of samples or an {"items": [...]} object.` };
  return { fileName, rows: items.map((item) => fromObject(item, fileName)) };
}

function parseCsvRows(content: string, fileName: string): ParsedIngestFile {
  const [header, ...body] = parseCsv(content);
  const columns = (header ?? []).map((name) => name.trim().toLowerCase());
  const textIndex = columns.indexOf('text');
  const writtenAtIndex = columns.indexOf('writtenat');
  if (textIndex < 0 || writtenAtIndex < 0) {
    return { fileName, rows: [], error: `${fileName} needs a header row with "text" and "writtenAt" columns.` };
  }
  const kindIndex = columns.indexOf('kind');
  const sourceRefIndex = columns.indexOf('sourceref');
  const rows = body.map((cells) =>
    fromObject(
      {
        text: cells[textIndex] ?? '',
        writtenAt: (cells[writtenAtIndex] ?? '').trim(),
        kind: kindIndex >= 0 ? cells[kindIndex] : undefined,
        sourceRef: sourceRefIndex >= 0 ? cells[sourceRefIndex] : undefined,
      },
      fileName,
    ),
  );
  return { fileName, rows };
}

async function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export async function parseIngestFile(file: File): Promise<ParsedIngestFile> {
  const name = file.name;
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (!['json', 'csv', 'txt'].includes(extension)) {
    return { fileName: name, rows: [], error: `Unsupported file type: ${name} (use .json, .csv or .txt).` };
  }
  let content: string;
  try {
    content = await readText(file);
  } catch {
    return { fileName: name, rows: [], error: `Could not read ${name}.` };
  }
  if (extension === 'json') return parseJsonRows(content, name);
  if (extension === 'csv') return parseCsvRows(content, name);
  return {
    fileName: name,
    rows: [{ text: content.trim(), writtenAt: new Date(file.lastModified).toISOString(), sourceRef: name, source: name }],
  };
}

/** Strict ISO-8601 date-time with a `T` separator that `Date.parse` understands (mirrors the DTO). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isIsoDateTime(value: string): boolean {
  return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

const fmt = (value: number) => value.toLocaleString('en-US');

export interface IngestValidation {
  /** One list per row (same index); empty = row is valid. */
  rowErrors: string[][];
  batchErrors: string[];
  totalChars: number;
  valid: boolean;
}

export function validateIngestRows(rows: IngestRow[]): IngestValidation {
  const rowErrors = rows.map((row) => {
    const errors: string[] = [];
    if (row.text.trim() === '') errors.push('Text is empty.');
    if (row.text.length > DNA_INGEST_LIMITS.maxItemChars) errors.push(`Text exceeds ${fmt(DNA_INGEST_LIMITS.maxItemChars)} characters.`);
    if (!isIsoDateTime(row.writtenAt)) errors.push('writtenAt must be an ISO-8601 date-time (e.g. 2026-09-01T09:30:00Z).');
    if (row.kind !== undefined && !(DNA_WRITING_SAMPLE_KINDS as readonly string[]).includes(row.kind)) {
      errors.push(`Unknown kind "${row.kind}" (use ${DNA_WRITING_SAMPLE_KINDS.join(', ')}).`);
    }
    return errors;
  });
  const totalChars = rows.reduce((sum, row) => sum + row.text.length, 0);
  const batchErrors: string[] = [];
  if (rows.length === 0) batchErrors.push('Add at least one sample.');
  if (rows.length > DNA_INGEST_LIMITS.maxItems) batchErrors.push(`At most ${DNA_INGEST_LIMITS.maxItems} samples per batch (${rows.length} found).`);
  if (totalChars > DNA_INGEST_LIMITS.maxTotalChars) {
    batchErrors.push(`At most ${fmt(DNA_INGEST_LIMITS.maxTotalChars)} characters in total (${fmt(totalChars)} found).`);
  }
  const valid = batchErrors.length === 0 && rowErrors.every((errors) => errors.length === 0);
  return { rowErrors, batchErrors, totalChars, valid };
}
