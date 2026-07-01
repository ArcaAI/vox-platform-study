import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * TASK-390 #25 (AU2) — shared, column-driven table export (csv | xlsx | pdf).
 *
 * Factored out of TASK-388's `UserExportService` so the Users export and the
 * Audit-log export share ONE renderer instead of each carrying its own
 * `exceljs`/`pdfkit` plumbing. Callers describe their columns + rows (rows are
 * plain records keyed by `column.key`) and pick a format; this module owns the
 * library choice, escaping, and content-type/filename derivation.
 *
 * Library choice (inherited FLAG from TASK-388): `exceljs` for `.xlsx` and
 * `pdfkit` for `.pdf` — both pure-JS, no native build step, no headless
 * browser; `pdfkit` ships the standard Helvetica font so no vendored TTFs.
 */
export type TableExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface TableColumn<T = Record<string, unknown>> {
  key: keyof T & string;
  header: string;
  /** Column width (chars) for the xlsx sheet; ignored by csv. */
  width?: number;
}

export interface TableExportFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export interface TableExportOptions<T = Record<string, unknown>> {
  columns: TableColumn<T>[];
  rows: T[];
  /** File stem — the extension is appended per format (e.g. `users` -> `users.xlsx`). */
  baseName: string;
  /** PDF heading; defaults to `baseName`. */
  title?: string;
  /** xlsx worksheet name; defaults to `Sheet1`. */
  sheetName?: string;
}

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** RFC-4180: quote a cell containing a comma, quote, CR or LF (doubling embedded quotes). */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise rows to CSV text: a header row of column labels, then one line per
 * row (cells read by `column.key`), joined by `\n`. Pure + dependency-free.
 */
export function toCsvText<T>(columns: TableColumn<T>[], rows: T[]): string {
  const header = columns.map((c) => csvCell(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell((row as Record<string, unknown>)[c.key])).join(','));
  return [header, ...lines].join('\n');
}

export async function toXlsxBuffer<T>(columns: TableColumn<T>[], rows: T[], sheetName = 'Sheet1'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    sheet.addRow(row as Record<string, unknown>);
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

export function toPdfBuffer<T>(columns: TableColumn<T>[], rows: T[], title: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).fillColor('#111').text(title);
    doc
      .moveDown(0.3)
      .fontSize(9)
      .fillColor('#666')
      .text(`Generated ${new Date().toISOString()} · ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    doc.moveDown(0.8);

    doc.fontSize(9).fillColor('#111');
    doc.text(columns.map((c) => c.header).join('  |  '));
    doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3);

    doc.fillColor('#333');
    for (const row of rows) {
      doc.text(columns.map((c) => String((row as Record<string, unknown>)[c.key] ?? '')).join('  |  '));
    }

    doc.end();
  });
}

/**
 * Build a downloadable table export in the requested format, returning the
 * bytes plus the matching content-type and `<baseName>.<ext>` filename.
 */
export async function buildTableExport<T>(format: TableExportFormat, options: TableExportOptions<T>): Promise<TableExportFile> {
  const { columns, rows, baseName, title, sheetName } = options;
  switch (format) {
    case 'xlsx':
      return { buffer: await toXlsxBuffer(columns, rows, sheetName), contentType: XLSX_CONTENT_TYPE, filename: `${baseName}.xlsx` };
    case 'pdf':
      return { buffer: await toPdfBuffer(columns, rows, title ?? baseName), contentType: 'application/pdf', filename: `${baseName}.pdf` };
    case 'csv':
    default:
      return { buffer: Buffer.from(toCsvText(columns, rows), 'utf-8'), contentType: 'text/csv; charset=utf-8', filename: `${baseName}.csv` };
  }
}
