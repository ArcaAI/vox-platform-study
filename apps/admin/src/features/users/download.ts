/**
 * Trigger a client-side file download for a generated text payload (CSV export).
 * Mirrors the audit-log page's local helper; lives here so the Users surface owns
 * its own copy without importing a sibling route.
 */
export function downloadTextFile(filename: string, contents: string, mime = 'text/csv;charset=utf-8;'): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** `users-2026-06-30.csv`-style timestamped filename. */
export function timestampedCsvName(prefix: string): string {
  return timestampedExportName(prefix, 'csv');
}

/** `users-2026-06-30.<ext>`-style timestamped filename (any extension). */
export function timestampedExportName(prefix: string, ext: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/**
 * Trigger a client-side download for a server-generated {@link Blob} (the SDK
 * `exportUsers` returns xlsx/pdf/csv as a Blob). Same anchor-click mechanism as
 * {@link downloadTextFile} but keeps the server's content-type.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Map an export format to its file extension for the download filename. */
export function exportExtension(format: 'csv' | 'xlsx' | 'pdf'): string {
  return format === 'xlsx' ? 'xlsx' : format;
}
