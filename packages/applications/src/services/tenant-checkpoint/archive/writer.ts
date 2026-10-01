/**
 * `.hcp` writer — framed entry stream → 64 KiB plaintext segments → AES-256-GCM → sink, with a
 * signed trailer. Byte layout: `./format.ts`.
 *
 * Nonce uniqueness rests on two independent facts: every archive gets a fresh random data key
 * (the caller's job — `ICheckpointSealing.generateDataKey`) AND a fresh random 7-byte nonce
 * prefix (generated here, never accepted from the caller); within one archive the 32-bit counter
 * is strictly increasing. The last-segment flag lives inside the nonce, so truncation at a segment
 * boundary fails authentication instead of looking like a shorter archive.
 */
import { createCipheriv, createHash, randomBytes, type Hash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import {
  CHECKPOINT_FORMAT_VERSION,
  CHECKPOINT_MAGIC,
  CHECKPOINT_SEGMENT_BYTES,
  type CheckpointArchiveWriter,
  type CheckpointHeader,
  type CheckpointManifest,
  type ICheckpointSealing,
} from '../contracts';
import {
  DIGEST_BYTES,
  encodeHeader,
  END_TAG,
  ENTRY_TAG,
  MANIFEST_ENTRY,
  MAX_SEGMENTS,
  MAX_WRITE_CHUNK,
  NONCE_PREFIX_BYTES,
  segmentNonce,
  TRAILER_MAGIC,
  u16,
  u32,
} from './format';

export interface CreateArchiveWriterArgs {
  header: Omit<CheckpointHeader, 'magic' | 'formatVersion' | 'noncePrefix'>;
  dataKey: Buffer;
  sink: Writable;
  sealing: Pick<ICheckpointSealing, 'sign'>;
}

function writeToSink(sink: Writable, buf: Buffer): Promise<void> {
  if (sink.destroyed || sink.writableEnded) return Promise.reject(new Error('checkpoint sink is closed'));
  if (sink.write(buf)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sink.off('drain', onDrain);
      sink.off('error', onError);
      sink.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('checkpoint sink closed before drain'));
    };
    sink.on('drain', onDrain);
    sink.on('error', onError);
    sink.on('close', onClose);
  });
}

export function createArchiveWriter(args: CreateArchiveWriterArgs): CheckpointArchiveWriter {
  const { dataKey, sink, sealing } = args;
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('checkpoint data key must be 32 bytes');

  const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  const header: CheckpointHeader = {
    ...args.header,
    magic: CHECKPOINT_MAGIC,
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    noncePrefix: noncePrefix.toString('base64'),
  };
  const headerBytes = encodeHeader(header);
  const digest: Hash = createHash('sha256');

  let state: 'open' | 'busy' | 'finished' | 'failed' = 'open';
  let headerWritten = false;
  let sizeBytes = 0;
  let segmentIndex = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  async function emit(buf: Buffer): Promise<void> {
    sizeBytes += buf.length;
    await writeToSink(sink, buf);
  }

  async function ensureHeader(): Promise<void> {
    if (headerWritten) return;
    headerWritten = true;
    digest.update(headerBytes);
    await emit(headerBytes);
  }

  async function sealSegment(plain: Buffer, last: boolean): Promise<void> {
    if (segmentIndex > MAX_SEGMENTS) throw new Error('checkpoint archive exceeds the segment counter');
    const cipher = createCipheriv('aes-256-gcm', dataKey, segmentNonce(noncePrefix, segmentIndex, last));
    if (segmentIndex === 0) cipher.setAAD(headerBytes);
    const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    segmentIndex++;
    const frame = Buffer.concat([u32(ct.length), ct]);
    digest.update(frame);
    await emit(frame);
  }

  function takePending(n: number): Buffer {
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    pending = rest.length ? [rest] : [];
    pendingBytes = rest.length;
    return out;
  }

  /** Strictly-greater keeps at least one byte back, so the final (last-flagged) segment is never empty. */
  async function pushPlain(buf: Buffer): Promise<void> {
    if (buf.length === 0) return;
    pending.push(buf);
    pendingBytes += buf.length;
    while (pendingBytes > CHECKPOINT_SEGMENT_BYTES) {
      await sealSegment(takePending(CHECKPOINT_SEGMENT_BYTES), false);
    }
  }

  async function writeEntryInternal(name: string, body: Readable | Buffer): Promise<{ sha256: string; bytes: number }> {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length === 0 || nameBytes.length > 0xffff || name.includes('\0')) throw new Error(`invalid checkpoint entry name '${name}'`);
    await ensureHeader();
    await pushPlain(Buffer.concat([Buffer.from([ENTRY_TAG]), u16(nameBytes.length), nameBytes]));
    const h = createHash('sha256');
    let bytes = 0;
    const writeChunk = async (chunk: Buffer) => {
      for (let off = 0; off < chunk.length; off += MAX_WRITE_CHUNK) {
        const part = chunk.subarray(off, Math.min(chunk.length, off + MAX_WRITE_CHUNK));
        h.update(part);
        bytes += part.length;
        await pushPlain(u32(part.length));
        await pushPlain(part);
      }
    };
    if (Buffer.isBuffer(body)) {
      await writeChunk(body);
    } else {
      for await (const c of body) {
        const chunk = Buffer.isBuffer(c) ? c : typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c as Uint8Array);
        if (chunk.length) await writeChunk(chunk);
      }
    }
    await pushPlain(u32(0));
    return { sha256: h.digest('hex'), bytes };
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (state !== 'open') throw new Error(`checkpoint archive writer is ${state}`);
    state = 'busy';
    try {
      const r = await fn();
      if (state === 'busy') state = 'open';
      return r;
    } catch (e) {
      state = 'failed';
      throw e;
    }
  }

  return {
    writeEntry(name, body) {
      return guarded(() => {
        if (name === MANIFEST_ENTRY) throw new Error(`'${MANIFEST_ENTRY}' is reserved for finish()`);
        return writeEntryInternal(name, body);
      });
    },

    finish(manifest: CheckpointManifest) {
      return guarded(async () => {
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        const manifestDigestHex = createHash('sha256').update(manifestBytes).digest('hex');
        await writeEntryInternal(MANIFEST_ENTRY, manifestBytes);
        await pushPlain(Buffer.from([END_TAG]));
        await sealSegment(takePending(pendingBytes), true);
        const d = digest.digest();
        if (d.length !== DIGEST_BYTES) throw new Error('unexpected digest length');
        const signature = Buffer.from(await sealing.sign(d), 'utf8');
        if (signature.length === 0 || signature.length > 0xffff) throw new Error('checkpoint signature has an invalid length');
        await emit(Buffer.concat([TRAILER_MAGIC, d, u16(signature.length), signature]));
        sink.end();
        await finished(sink, { readable: false });
        state = 'finished';
        return { sizeBytes, digestHex: d.toString('hex'), manifestDigestHex };
      });
    },

    async abort(error: Error) {
      state = 'failed';
      pending = [];
      pendingBytes = 0;
      if (!sink.destroyed) sink.destroy(error);
    },
  };
}
