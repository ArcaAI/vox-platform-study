import { Transform, type TransformCallback } from 'node:stream';

const QUOTE = 0x22;
const NEWLINE = 0x0a;

/**
 * Counts CSV records (RFC 4180, as Postgres `COPY … (FORMAT csv)` writes them) in a byte stream
 * it passes through unchanged. A newline inside a quoted field does not end a record; a doubled
 * quote (`""`) toggles the quote state twice and so needs no special case. State carries across
 * chunk boundaries.
 */
export class CsvRecordCounter extends Transform {
  private inQuotes = false;
  private newlines = 0;
  private lastByte = -1;

  /** Records seen so far, including the header record. */
  get records(): number {
    return this.newlines + (this.lastByte !== -1 && this.lastByte !== NEWLINE ? 1 : 0);
  }

  /** Data records: every record except the header. */
  get rows(): number {
    return Math.max(0, this.records - 1);
  }

  scan(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.inQuotes) {
        const q = chunk.indexOf(QUOTE, i);
        if (q === -1) break;
        this.inQuotes = false;
        i = q + 1;
      } else {
        const q = chunk.indexOf(QUOTE, i);
        const n = chunk.indexOf(NEWLINE, i);
        if (n !== -1 && (q === -1 || n < q)) {
          this.newlines++;
          i = n + 1;
        } else if (q !== -1) {
          this.inQuotes = true;
          i = q + 1;
        } else break;
      }
    }
    if (chunk.length) this.lastByte = chunk[chunk.length - 1];
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.scan(chunk);
    cb(null, chunk);
  }
}

/** Records (header included) in a complete CSV buffer. */
export function countCsvRecords(buf: Buffer): number {
  const c = new CsvRecordCounter();
  c.scan(buf);
  return c.records;
}
