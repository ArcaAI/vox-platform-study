import { describe, expect, it } from 'vitest';
import { AUDIT_EXPORT_FORMATS, auditExportFilename } from '../audit-export';

describe('AUDIT_EXPORT_FORMATS (TASK-391 #25)', () => {
  it('offers exactly CSV, Excel and PDF', () => {
    expect(AUDIT_EXPORT_FORMATS.map((o) => o.format)).toEqual(['csv', 'xlsx', 'pdf']);
  });

  it('carries the correct extension + MIME per format', () => {
    const byFormat = Object.fromEntries(AUDIT_EXPORT_FORMATS.map((o) => [o.format, o]));
    expect(byFormat.csv.extension).toBe('csv');
    expect(byFormat.xlsx.extension).toBe('xlsx');
    expect(byFormat.xlsx.mime).toContain('spreadsheetml');
    expect(byFormat.pdf.mime).toBe('application/pdf');
  });
});

describe('auditExportFilename (TASK-391 #25)', () => {
  it('builds a dated filename with the right extension', () => {
    const date = new Date('2026-07-01T09:30:00Z');
    expect(auditExportFilename('csv', date)).toBe('audit-logs-2026-07-01.csv');
    expect(auditExportFilename('xlsx', date)).toBe('audit-logs-2026-07-01.xlsx');
    expect(auditExportFilename('pdf', date)).toBe('audit-logs-2026-07-01.pdf');
  });

  it('defaults to a YYYY-MM-DD stamped name for today', () => {
    expect(auditExportFilename('csv')).toMatch(/^audit-logs-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
