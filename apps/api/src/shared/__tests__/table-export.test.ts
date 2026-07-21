/**
 * Shared, column-driven table export.
 *
 * Factored out of `UserExportService` so both the Users export and
 * the Audit-log export share ONE csv/xlsx/pdf renderer (no duplication). These
 * tests pin the generic contract: byte-stable CSV (RFC-4180 escaping, `\n`
 * joins, header from column labels), a real `.xlsx` (PK zip) and `.pdf` (%PDF)
 * buffer, and correct content-type/filename derivation per format.
 */
import { describe, it, expect } from 'vitest';
import { buildTableExport, toCsvText, type TableColumn } from '../table-export';

interface Row {
  name: string;
  city: string;
  id: string;
}

const columns: TableColumn<Row>[] = [
  { key: 'name', header: 'Name', width: 20 },
  { key: 'city', header: 'City', width: 20 },
  { key: 'id', header: 'ID', width: 30 },
];

const rows: Row[] = [
  { name: 'Ann', city: 'Ha Noi, VN', id: 'r-1' },
  { name: 'Bo "B"', city: '', id: 'r-2' },
];

describe('table-export (TASK-390 #25 shared util)', () => {
  it('toCsvText: header from labels, one line per row, RFC-4180 escaping, \\n joins', () => {
    const csv = toCsvText(columns, rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Name,City,ID');
    expect(lines[1]).toBe('Ann,"Ha Noi, VN",r-1');
    expect(lines[2]).toBe('"Bo ""B""",,r-2');
    expect(lines).toHaveLength(3);
  });

  it('build csv: text/csv content-type + <base>.csv filename', async () => {
    const file = await buildTableExport('csv', { columns, rows, baseName: 'things' });
    expect(file.contentType).toContain('text/csv');
    expect(file.filename).toBe('things.csv');
    expect(file.buffer.toString('utf-8').split('\n')[0]).toBe('Name,City,ID');
  });

  it('build xlsx: spreadsheet content-type, <base>.xlsx, PK zip signature', async () => {
    const file = await buildTableExport('xlsx', { columns, rows, baseName: 'things', sheetName: 'Things' });
    expect(file.contentType).toContain('spreadsheetml');
    expect(file.filename).toBe('things.xlsx');
    expect(file.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('build pdf: application/pdf, <base>.pdf, %PDF header', async () => {
    const file = await buildTableExport('pdf', { columns, rows, baseName: 'things', title: 'Things export' });
    expect(file.contentType).toBe('application/pdf');
    expect(file.filename).toBe('things.pdf');
    expect(file.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('empty rows still produce a header-only CSV', async () => {
    const file = await buildTableExport('csv', { columns, rows: [], baseName: 'things' });
    expect(file.buffer.toString('utf-8')).toBe('Name,City,ID');
  });
});
