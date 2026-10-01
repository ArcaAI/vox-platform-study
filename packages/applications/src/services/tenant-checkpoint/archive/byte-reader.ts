import { Readable } from 'node:stream';

/** Pull-based exact-length reads over a Readable (one consumer, sequential calls only). */
export class ByteReader {
  private readonly it: AsyncIterator<unknown>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private eof = false;
  /** Total bytes handed out by read()/skip(). */
  consumed = 0;

  constructor(private readonly source: Readable) {
    this.it = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.eof) {
      const r = await this.it.next();
      if (r.done) {
        this.eof = true;
        break;
      }
      const v = r.value;
      const b = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v) : Buffer.from(v as Uint8Array);
      if (b.length === 0) continue;
      this.chunks.push(b);
      this.buffered += b.length;
    }
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    let out: Buffer;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      out = Buffer.allocUnsafe(n);
      let off = 0;
      while (off < n) {
        const c = this.chunks[0];
        const k = Math.min(c.length, n - off);
        c.copy(out, off, 0, k);
        off += k;
        if (k === c.length) this.chunks.shift();
        else this.chunks[0] = c.subarray(k);
      }
    }
    this.buffered -= n;
    this.consumed += n;
    return out;
  }

  /** Exactly `n` bytes, or `null` when the stream ends first (the partial bytes are lost). */
  async read(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.buffered < n) return null;
    return this.take(n);
  }

  /** Up to `n` bytes without consuming them; shorter only at end of stream. */
  async peek(n: number): Promise<Buffer> {
    await this.fill(n);
    const k = Math.min(n, this.buffered);
    if (k === 0) return Buffer.alloc(0);
    const out = this.take(k);
    this.chunks.unshift(out);
    this.buffered += k;
    this.consumed -= k;
    return out;
  }

  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.buffered === 0;
  }

  /** Everything not yet read, as a stream. */
  remainder(): Readable {
    return Readable.from(this.drain(), { objectMode: false });
  }

  private async *drain(): AsyncGenerator<Buffer> {
    while (this.chunks.length) {
      const c = this.chunks.shift()!;
      this.buffered -= c.length;
      yield c;
    }
    if (this.eof) return;
    for (;;) {
      const r = await this.it.next();
      if (r.done) return;
      yield r.value;
    }
  }

  destroy(error?: Error): void {
    this.source.destroy(error);
  }
}
