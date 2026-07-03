/**
 * TASK-391 #25 (AU2) — audit-log export format metadata + filename helper.
 *
 * TASK-390 added `GET /admin/audit-logs/export?format=csv|xlsx|pdf` (StreamableFile)
 * and the SDK `useAuditLog().exportFile(format, filters)`. The console offers all
 * three formats from one Export menu, honouring the active filters.
 *
 * The `AuditExportFormat` union mirrors the SDK's (which is not re-exported from
 * the `@arcaai/vox` barrel); a local literal union stays structurally assignable
 * to `exportFile(format, …)` so no SDK file is touched.
 */

export type AuditExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface AuditExportOption {
  format: AuditExportFormat;
  /** Menu label. */
  label: string;
  /** File extension (no leading dot). */
  extension: string;
  /** Blob MIME type for the download. */
  mime: string;
}

export const AUDIT_EXPORT_FORMATS: readonly AuditExportOption[] = [
  { format: 'csv', label: 'CSV (.csv)', extension: 'csv', mime: 'text/csv;charset=utf-8;' },
  {
    format: 'xlsx',
    label: 'Excel (.xlsx)',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  { format: 'pdf', label: 'PDF (.pdf)', extension: 'pdf', mime: 'application/pdf' },
] as const;

/** Download filename, e.g. `audit-logs-2026-07-01.xlsx` (date defaults to today, UTC). */
export function auditExportFilename(format: AuditExportFormat, date: Date = new Date()): string {
  const option = AUDIT_EXPORT_FORMATS.find((o) => o.format === format);
  const extension = option?.extension ?? format;
  const stamp = date.toISOString().slice(0, 10);
  return `audit-logs-${stamp}.${extension}`;
}
