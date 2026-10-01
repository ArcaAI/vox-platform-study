/**
 * `.hcp` reader. Authenticates every segment BEFORE any of its plaintext is released, so a caller
 * never sees a byte the data key did not vouch for. Structural problems after the header —
 * truncation, reordering, a flipped bit, trailing garbage, an entry stream that does not end
 * exactly at the last segment — are all `CORRUPT_SEGMENT`.
 *
 * The reader checks the trailer's digest against the bytes it read (integrity) but NOT the
 * signature (authenticity) — that is the verification gate's job (`./verify.ts`), and the offline
 * opener's when it is given the public key.
 */
import { createDecipheriv, createHash, type Hash } from 'node:crypto';
import { Readable } from 'node:stream';

import { CheckpointError, type CheckpointArchiveReader, type CheckpointHeader, type CheckpointManifest } from '../contracts';
import { ByteReader } from './byte-reader';
import {
  DIGEST_BYTES,
  END_TAG,
  ENTRY_TAG,
  MAGIC_BYTES,
  MANIFEST_ENTRY,
  MAX_CIPHER_BYTES,
  MAX_HEADER_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_SEGMENTS,
  MIN_CIPHER_BYTES,
  parseHeaderJson,
  segmentNonce,
  TAG_BYTES,
  TRAILER_MAGIC,
} from './format';

const corrupt = (msg: string, detail?: Record<string, unknown>) => new CheckpointError('CORRUPT_SEGMENT', msg, detail);

/** Parses HEADER from the reader; returns the parsed header and its exact bytes. */
export async function readHeaderFrom(src: ByteReader): Promise<{ header: CheckpointHeader; headerBytes: Buffer }> {
  const magic = await src.read(MAGIC_BYTES.length);
  if (!magic || !magic.equals(MAGIC_BYTES)) throw new CheckpointError('UNSUPPORTED_FORMAT', 'Not a HOPE checkpoint file');
  const lenBuf = await src.read(4);
  if (!lenBuf) throw new CheckpointError('UNSUPPORTED_FORMAT', 'Checkpoint header is truncated');
  const len = lenBuf.readUInt32BE(0);
  if (len === 0 || len > MAX_HEADER_BYTES) throw new CheckpointError('UNSUPPORTED_FORMAT', 'Checkpoint header length is out of range');
  const json = await src.read(len);
  if (!json) throw new CheckpointError('UNSUPPORTED_FORMAT', 'Checkpoint header is truncated');
  const header = parseHeaderJson(json);
  return { header, headerBytes: Buffer.concat([magic, lenBuf, json]) };
}

export async function readHeader(source: Readable): Promise<{ header: CheckpointHeader; rest: Readable }> {
  const src = new ByteReader(source);
  const { header } = await readHeaderFrom(src);
  return { header, rest: src.remainder() };
}

export interface TrailerInfo {
  digest: Buffer;
  signature: string;
}

/** Reads TRAILER (magic already peeked, not consumed) and asserts end of stream. */
export async function readTrailerFrom(src: ByteReader, onCorrupt: (msg: string) => Error): Promise<TrailerInfo> {
  const magic = await src.read(TRAILER_MAGIC.length);
  if (!magic || !magic.equals(TRAILER_MAGIC)) throw onCorrupt('Checkpoint trailer is missing');
  const digest = await src.read(DIGEST_BYTES);
  const sigLenBuf = digest ? await src.read(2) : null;
  if (!digest || !sigLenBuf) throw onCorrupt('Checkpoint trailer is truncated');
  const sigLen = sigLenBuf.readUInt16BE(0);
  const sig = sigLen > 0 ? await src.read(sigLen) : null;
  if (!sig) throw onCorrupt('Checkpoint trailer signature is missing');
  if (!(await src.atEnd())) throw onCorrupt('Unexpected bytes after the checkpoint trailer');
  return { digest, signature: sig.toString('utf8') };
}

/** Decrypting plaintext source over the segment stream. */
class SegmentPlaintext {
  private index = 0;
  private plain: Buffer = Buffer.alloc(0);
  private off = 0;
  private sawLast = false;
  private readonly hash: Hash = createHash('sha256');

  constructor(
    private readonly src: ByteReader,
    private readonly key: Buffer,
    private readonly noncePrefix: Buffer,
    private readonly headerBytes: Buffer,
  ) {
    this.hash.update(headerBytes);
  }

  private async nextSegment(): Promise<void> {
    if (this.sawLast) throw corrupt('Entry stream runs past the last segment');
    const lenBuf = await this.src.read(4);
    if (!lenBuf) throw corrupt('Checkpoint body is truncated');
    if (lenBuf.equals(TRAILER_MAGIC.subarray(0, 4))) throw corrupt('Checkpoint body ends without a last segment');
    const len = lenBuf.readUInt32BE(0);
    if (len < MIN_CIPHER_BYTES || len > MAX_CIPHER_BYTES) throw corrupt('Segment length is out of range', { segment: this.index });
    const ct = await this.src.read(len);
    if (!ct) throw corrupt('Checkpoint body is truncated', { segment: this.index });
    const next = await this.src.peek(TRAILER_MAGIC.length);
    if (next.length === 0) throw corrupt('Checkpoint trailer is missing');
    const last = next.equals(TRAILER_MAGIC);
    if (this.index > MAX_SEGMENTS) throw corrupt('Segment counter overflow');
    let plain: Buffer;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, segmentNonce(this.noncePrefix, this.index, last));
      if (this.index === 0) d.setAAD(this.headerBytes);
      d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
      plain = Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()]);
    } catch {
      throw corrupt('Segment failed authentication', { segment: this.index });
    }
    this.hash.update(lenBuf);
    this.hash.update(ct);
    this.index++;
    this.plain = plain;
    this.off = 0;
    this.sawLast = last;
  }

  private failure: Error | null = null;

  async read(n: number): Promise<Buffer> {
    if (this.failure) throw this.failure;
    try {
      return await this.readInner(n);
    } catch (e) {
      this.failure = e as Error;
      throw e;
    }
  }

  private async readInner(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      if (this.off >= this.plain.length) await this.nextSegment();
      const k = Math.min(need, this.plain.length - this.off);
      parts.push(this.plain.subarray(this.off, this.off + k));
      this.off += k;
      need -= k;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  /** After END: the plaintext must be exhausted exactly at the last segment, then the trailer. */
  async finish(): Promise<TrailerInfo> {
    if (this.off !== this.plain.length || !this.sawLast) throw corrupt('Data after the end of the entry stream');
    const t = await readTrailerFrom(this.src, corrupt);
    const computed = this.hash.digest();
    if (!computed.equals(t.digest)) throw corrupt('Checkpoint digest does not match its trailer');
    return t;
  }
}

class EntryBody extends Readable {
  done = false;
  private draining = false;
  pending: Promise<void> | null = null;

  constructor(private readonly plain: SegmentPlaintext) {
    super();
  }

  override _read(): void {
    if (this.done || this.draining || this.pending) return;
    this.pending = this.pull();
  }

  /** Reads one CHUNK frame; returns null at the entry's terminator. */
  async readFrame(): Promise<Buffer | null> {
    const len = (await this.plain.read(4)).readUInt32BE(0);
    if (len === 0) {
      this.done = true;
      return null;
    }
    return Buffer.from(await this.plain.read(len));
  }

  private async pull(): Promise<void> {
    let chunk: Buffer | null;
    try {
      chunk = await this.readFrame();
    } catch (e) {
      this.pending = null;
      this.destroy(e as Error);
      return;
    }
    this.pending = null;
    if (!this.destroyed) this.push(chunk);
  }

  /** Skip whatever the consumer did not read. */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.pending) await this.pending;
    while (!this.done) await this.readFrame();
  }
}

export interface OpenedArchive extends CheckpointArchiveReader {
  readonly headerBytes: Buffer;
  /** sha256(HEADER ‖ BODY) as read — available once entries() has completed. */
  digest(): Buffer;
  signature(): string;
}

export async function openArchiveInternal(source: Readable, dataKey: Buffer): Promise<OpenedArchive> {
  const src = new ByteReader(source);
  const { header, headerBytes } = await readHeaderFrom(src);
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('checkpoint data key must be 32 bytes');
  const plain = new SegmentPlaintext(src, dataKey, Buffer.from(header.noncePrefix, 'base64'), headerBytes);
  let manifest: CheckpointManifest | null = null;
  let trailer: TrailerInfo | null = null;
  let started = false;

  async function* entries(): AsyncGenerator<{ name: string; body: Readable }> {
    if (started) throw new Error('entries() can only be iterated once');
    started = true;
    let current: EntryBody | null = null;
    try {
      for (;;) {
        if (current) {
          await current.drain();
          current = null;
        }
        const tag = (await plain.read(1))[0];
        if (tag === END_TAG) throw corrupt('Entry stream ended without a manifest');
        if (tag !== ENTRY_TAG) throw corrupt('Unknown entry tag');
        const nameLen = (await plain.read(2)).readUInt16BE(0);
        if (nameLen === 0) throw corrupt('Empty entry name');
        const name = (await plain.read(nameLen)).toString('utf8');
        const body = new EntryBody(plain);
        if (name === MANIFEST_ENTRY) {
          const parts: Buffer[] = [];
          let size = 0;
          for (let f = await body.readFrame(); f; f = await body.readFrame()) {
            size += f.length;
            if (size > MAX_MANIFEST_BYTES) throw corrupt('Checkpoint manifest is too large');
            parts.push(f);
          }
          const endTag = (await plain.read(1))[0];
          if (endTag !== END_TAG) throw corrupt('Entries follow the manifest');
          trailer = await plain.finish();
          try {
            manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as CheckpointManifest;
          } catch {
            throw corrupt('Checkpoint manifest is not valid JSON');
          }
          if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.tables)) throw corrupt('Checkpoint manifest is malformed');
          return;
        }
        current = body;
        yield { name, body };
      }
    } catch (e) {
      current?.destroy();
      src.destroy();
      throw e;
    }
  }

  return {
    header,
    headerBytes,
    entries,
    manifest() {
      if (!manifest) throw new Error('manifest() is available once entries() has completed');
      return manifest;
    },
    digest() {
      if (!trailer) throw new Error('archive not fully read');
      return trailer.digest;
    },
    signature() {
      if (!trailer) throw new Error('archive not fully read');
      return trailer.signature;
    },
  };
}

export function openArchive(source: Readable, dataKey: Buffer): Promise<CheckpointArchiveReader> {
  return openArchiveInternal(source, dataKey);
}
