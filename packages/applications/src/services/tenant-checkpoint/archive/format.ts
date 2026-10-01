/**
 * `.hcp` byte-layout facts shared by the writer, the reader and the verification gate.
 *
 *   file    := HEADER BODY TRAILER
 *   HEADER  := "HOPECKPT" ‖ u32be headerLen ‖ headerJson
 *   BODY    := SEGMENT*        SEGMENT := u32be cipherLen ‖ AES-256-GCM(ciphertext ‖ 16-byte tag)
 *              nonce_i = noncePrefix(7) ‖ u32be(i) ‖ lastFlag(1)
 *              AAD(segment 0) = HEADER bytes, AAD(segment i>0) = empty
 *   TRAILER := "HCPTRAIL" ‖ sha256(HEADER ‖ BODY) ‖ u16be sigLen ‖ signature
 *
 * A segment length prefix is ≤ 0x00010010, so its first byte is always 0x00 — a frame can never
 * be mistaken for the trailer magic ('H' = 0x48).
 */
import { CHECKPOINT_FORMAT_VERSION, CHECKPOINT_MAGIC, CHECKPOINT_SEGMENT_BYTES, CheckpointError, type CheckpointHeader } from '../contracts';

export const MAGIC_BYTES = Buffer.from(CHECKPOINT_MAGIC, 'ascii');
export const TRAILER_MAGIC = Buffer.from('HCPTRAIL', 'ascii');
export const NONCE_PREFIX_BYTES = 7;
export const TAG_BYTES = 16;
export const DIGEST_BYTES = 32;
export const MAX_HEADER_BYTES = 1024 * 1024;
/** A segment carries at least one plaintext byte (the writer never emits an empty one). */
export const MIN_CIPHER_BYTES = 1 + TAG_BYTES;
export const MAX_CIPHER_BYTES = CHECKPOINT_SEGMENT_BYTES + TAG_BYTES;
export const MAX_SEGMENTS = 0xffffffff;
export const MANIFEST_ENTRY = 'manifest.json';
export const ENTRY_TAG = 0x01;
export const END_TAG = 0x00;
/** Largest single CHUNK frame the writer emits; readers accept any u32. */
export const MAX_WRITE_CHUNK = 1024 * 1024;
/** The manifest is read into memory; refuse anything larger. */
export const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

export function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export function u16(n: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(n, 0);
  return b;
}

export function segmentNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (prefix.length !== NONCE_PREFIX_BYTES) throw new Error('nonce prefix must be 7 bytes');
  if (!Number.isInteger(index) || index < 0 || index > MAX_SEGMENTS) throw new Error('segment counter overflow');
  const n = Buffer.allocUnsafe(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  n[11] = last ? 0x01 : 0x00;
  return n;
}

/** The exact HEADER bytes (magic ‖ length ‖ json) — these are both hashed and segment 0's AAD. */
export function encodeHeader(header: CheckpointHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) throw new Error('checkpoint header too large');
  return Buffer.concat([MAGIC_BYTES, u32(json.length), json]);
}

const unsupported = (msg: string) => new CheckpointError('UNSUPPORTED_FORMAT', msg);

/** Structural validation of a parsed header; anything off is UNSUPPORTED_FORMAT. */
export function parseHeaderJson(json: Buffer): CheckpointHeader {
  let h: unknown;
  try {
    h = JSON.parse(json.toString('utf8'));
  } catch {
    throw unsupported('Checkpoint header is not valid JSON');
  }
  const o = h as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw unsupported('Checkpoint header is not an object');
  if (o.magic !== CHECKPOINT_MAGIC) throw unsupported('Checkpoint header magic mismatch');
  if (o.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new CheckpointError('UNSUPPORTED_FORMAT', `Unsupported checkpoint format version ${String(o.formatVersion)}`, {
      formatVersion: o.formatVersion as never,
    });
  }
  for (const k of ['checkpointId', 'tenantId', 'tenantKey', 'sourceDeploymentId', 'createdAt', 'schemaFingerprint', 'noncePrefix'] as const) {
    if (typeof o[k] !== 'string') throw unsupported(`Checkpoint header field ${k} is missing`);
  }
  if (typeof o.includesMedia !== 'boolean') throw unsupported('Checkpoint header field includesMedia is missing');
  const keys = o.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== 'object' || typeof keys.platform !== 'string') throw unsupported('Checkpoint header keys are missing');
  if (keys.passphrase !== undefined && (typeof keys.passphrase !== 'object' || keys.passphrase === null)) {
    throw unsupported('Checkpoint header passphrase wrap is malformed');
  }
  if (Buffer.from(o.noncePrefix as string, 'base64').length !== NONCE_PREFIX_BYTES) throw unsupported('Checkpoint nonce prefix is malformed');
  return o as unknown as CheckpointHeader;
}
