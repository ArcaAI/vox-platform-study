/**
 * Streaming projection of `COPY … TO STDOUT (FORMAT csv, HEADER)` output.
 *
 * The first record is the header (column names). The filter keeps only the fields whose column
 * the caller accepts — a column the checkpoint has but the live table dropped is removed on the
 * fly — and re-emits header + records unchanged otherwise (quoted fields stay quoted, so NULL vs
 * empty string survives). It also counts data records, which the reconciler compares with the
 * manifest.
 *
 * Only ',', '"' and '\n' are structural, all ASCII, so byte-level parsing is safe on UTF-8.
 * A quoted field toggles on every '"' — `""` inside quotes toggles off and on again.
 */
import { Transform, type TransformCallback } from 'node:stream';

const COMMA = 0x2c;
const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

function decodeField(raw: Buffer): string {
  const s = raw.toString('utf8');
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
}

export class CsvColumnFilter extends Transform {
  /** Data records seen (header excluded). */
  rows = 0;
  private header: string[] | null = null;
  private keep: boolean[] = [];
  private inQuotes = false;
  private field: Buffer[] = [];
  private record: Buffer[] = [];
  private fieldIndex = 0;
  private resolveHeader!: (cols: string[]) => void;
  private rejectHeader!: (e: Error) => void;
  /** The kept column names, in checkpoint order — resolves once the header has been read. */
  readonly kept: Promise<string[]>;

  constructor(private readonly accept: (column: string) => boolean) {
    super();
    this.kept = new Promise<string[]>((resolve, reject) => {
      this.resolveHeader = resolve;
      this.rejectHeader = reject;
    });
    this.kept.catch(() => undefined);
  }

  /** The checkpoint's full column list (available after the header). */
  columns(): string[] {
    if (!this.header) throw new Error('csv header not read yet');
    return this.header;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b === QUOTE) this.inQuotes = !this.inQuotes;
        else if (!this.inQuotes && (b === COMMA || b === LF)) {
          this.field.push(chunk.subarray(start, i));
          this.endField();
          if (b === LF) this.endRecord();
          start = i + 1;
        }
      }
      if (start < chunk.length) this.field.push(Buffer.from(chunk.subarray(start)));
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (this.inQuotes) throw new Error('checkpoint CSV ends inside a quoted field');
      if (this.field.length || this.record.length || this.fieldIndex > 0) {
        this.endField();
        this.endRecord();
      }
      if (!this.header) {
        const e = new Error('checkpoint CSV has no header');
        this.rejectHeader(e);
        throw e;
      }
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  private endField(): void {
    let raw = Buffer.concat(this.field);
    this.field = [];
    if (raw.length && raw[raw.length - 1] === CR) raw = raw.subarray(0, raw.length - 1);
    if (!this.header || this.keep[this.fieldIndex]) this.record.push(raw);
    this.fieldIndex++;
  }

  private endRecord(): void {
    const fields = this.record;
    const count = this.fieldIndex;
    this.record = [];
    this.fieldIndex = 0;
    if (!this.header) {
      this.header = fields.map(decodeField);
      this.keep = this.header.map((c) => this.accept(c));
      const kept = this.header.filter((_, i) => this.keep[i]);
      this.resolveHeader(kept);
      this.push(Buffer.from(`${kept.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')}\n`, 'utf8'));
      return;
    }
    if (count !== this.header.length) throw new Error(`checkpoint CSV record has ${count} fields, header has ${this.header.length}`);
    this.rows++;
    const out: Buffer[] = [];
    fields.forEach((f, i) => {
      if (i > 0) out.push(Buffer.from(','));
      out.push(f);
    });
    out.push(Buffer.from('\n'));
    this.push(Buffer.concat(out));
  }
}

/**
 * Whole-text CSV parse (COPY csv output) into records of fields. An unquoted empty field — COPY's
 * NULL — is `null`; a quoted empty field is `''`. For small tables only (it buffers).
 */
export function parseCsvRecords(text: string): (string | null)[][] {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ',' || ch === '\n') {
      record.push(field === '' && !quoted ? null : field);
      field = '';
      quoted = false;
      if (ch === '\n') {
        records.push(record);
        record = [];
      }
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || quoted || record.length) {
    record.push(field === '' && !quoted ? null : field);
    records.push(record);
  }
  return records;
}
