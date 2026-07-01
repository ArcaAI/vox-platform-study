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
    return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}
