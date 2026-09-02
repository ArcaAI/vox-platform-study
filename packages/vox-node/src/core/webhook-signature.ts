/**
 * Verification for the `X-Hope-Webhook-Signature` header HOPE sends on every
 * outbound webhook delivery.
 *
 * ## The wire contract (read from the signing side, not guessed)
 *
 * `packages/applications/src/services/webhook/webhook-delivery.processor.ts`:
 *
 * ```ts
 * const body = JSON.stringify(payload);
 * const signature = createHmac('sha256', rawSecret).update(body).digest('hex');
 * headers: { 'X-Hope-Webhook-Signature': `sha256=${signature}` }
 * ```
 *
 * Two consequences a receiver must respect:
 *
 * 1. **Verify the RAW body.** The digest covers the exact bytes on the wire.
 *    `JSON.parse` then `JSON.stringify` will reorder/reformat and break the
 *    signature. In Express, reach for `express.raw({ type: 'application/json' })`
 *    (or `express.json({ verify })`) on the webhook route; in Fastify, a
 *    `preValidation` raw-body hook.
 * 2. **The secret is the RAW secret**, the value returned once when the webhook
 *    was created or its secret rotated — HOPE stores only a hash of it and
 *    cannot show it again.
 *
 * ## Why a hand-rolled HMAC and not `crypto.subtle`
 *
 * `crypto.subtle.sign` is async, which would force `await` on every receiver;
 * `node:crypto` is not importable here (this package is WinterTC-portable —
 * Node, Bun, Deno and edge runtimes — with ZERO runtime dependencies). A
 * compact FIPS 180-4 SHA-256 plus RFC 2104 HMAC keeps the check synchronous
 * and dependency-free, and it is verified in
 * `__tests__/webhook-signature.test.ts` against BOTH the published RFC 4231
 * vectors and `node:crypto.createHmac` across every SHA-256 padding boundary.
 *
 * If a future maintainer prefers the platform primitive, the swap is local to
 * this file — but it changes the public signature to `Promise<boolean>`.
 */

/** The header the delivery processor sends the signature in. Compare case-insensitively: HTTP header names are not case-sensitive, and Node lower-cases them on `req.headers`. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Hope-Webhook-Signature';

/** SHA-256 digest length in bytes; the header must carry exactly twice this in hex. */
const DIGEST_BYTES = 32;

/** SHA-256 operates on 64-byte blocks; HMAC pads or pre-hashes the key to this width. */
const BLOCK_BYTES = 64;

/** FIPS 180-4 §4.2.2 — the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** FIPS 180-4 §5.3.3 — the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
// prettier-ignore
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** FIPS 180-4 §6.2 — SHA-256 over `message`, returning the 32-byte digest. */
function sha256(message: Uint8Array): Uint8Array {
  // Padding (§5.1.1): the message, a single 1 bit, zeroes, then the 64-bit
  // big-endian bit length — padded so the total is a multiple of 64 bytes.
  // The 0x80 terminator (1 byte) and the length field (8 bytes) must both fit,
  // so round `length + 9` UP to a block multiple. Note the rounding must not
  // add a spare block when `length + 9` is already an exact multiple of 64
  // (length ≡ 55 mod 64) — that produces a different, wrong digest.
  const bitLength = message.length * 8;
  const paddedLength = ((message.length + 9 + (BLOCK_BYTES - 1)) >>> 6) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(message);
  block[message.length] = 0x80;

  // The length field is 64 bits. A JS number is exact to 2^53, so write the
  // low 32 bits directly and derive the high 32 by division rather than by a
  // `>>>` shift (which would truncate to 32 bits and mis-hash inputs ≥ 512 MB).
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += BLOCK_BYTES) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const digest = new Uint8Array(DIGEST_BYTES);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i += 1) digestView.setUint32(i * 4, h[i]!, false);
  return digest;
}

/** RFC 2104 — HMAC-SHA256(key, message). */
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  // A key longer than the block is replaced by its own digest; a shorter one
  // is zero-padded up to the block width.
  const blockKey = new Uint8Array(BLOCK_BYTES);
  blockKey.set(key.length > BLOCK_BYTES ? sha256(key) : key);

  const inner = new Uint8Array(BLOCK_BYTES + message.length);
  const outer = new Uint8Array(BLOCK_BYTES + DIGEST_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i += 1) {
    inner[i] = blockKey[i]! ^ 0x36;
    outer[i] = blockKey[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK_BYTES);
  outer.set(sha256(inner), BLOCK_BYTES);
  return sha256(outer);
}

/**
 * Compare two equal-length byte arrays without an early return, so the time
 * taken does not reveal how many leading bytes matched. Length is compared
 * separately and non-secretly: the expected digest is always 32 bytes, and a
 * wrong-length header is rejected before this is reached.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parse `sha256=<64 hex chars>` into its 32 digest bytes, or `null` if the
 * header is anything else. Deliberately strict: only the one scheme HOPE
 * emits, only a full-length digest, and no comma-separated signature lists.
 */
function parseSignatureHeader(header: string): Uint8Array | null {
  const trimmed = header.trim();
  const separator = trimmed.indexOf('=');
  if (separator === -1) return null;

  if (trimmed.slice(0, separator).toLowerCase() !== 'sha256') return null;

  const hex = trimmed.slice(separator + 1).toLowerCase();
  if (!HEX_PATTERN.test(hex)) return null;

  const bytes = new Uint8Array(DIGEST_BYTES);
  for (let i = 0; i < DIGEST_BYTES; i += 1) bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/**
 * Verify the `X-Hope-Webhook-Signature` header on an inbound HOPE webhook.
 *
 * Returns `true` only when `signatureHeader` is a well-formed `sha256=<hex>`
 * digest that matches an HMAC-SHA256 of `rawBody` under `secret`. Every other
 * outcome — a malformed header, a wrong or empty secret, a body that was
 * re-serialized, a non-string argument — returns `false`. It never throws, so
 * a receiver can branch on it directly.
 *
 * @param rawBody - The request body EXACTLY as received, before any JSON parse.
 * @param signatureHeader - The raw `X-Hope-Webhook-Signature` value, `sha256=<hex>`.
 * @param secret - The webhook's raw secret, shown once at creation/rotation.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '@arcaai/vox-node';
 *
 * app.post('/hooks/hope', express.raw({ type: 'application/json' }), (req, res) => {
 *   const signature = req.header(WEBHOOK_SIGNATURE_HEADER) ?? '';
 *   if (!verifyWebhookSignature(req.body, signature, process.env.HOPE_WEBHOOK_SECRET!)) {
 *     return res.status(401).end();
 *   }
 *   const event = JSON.parse(req.body.toString('utf8'));
 *   // event: { eventType, resourceType, resourceId, tenantId, occurredAt, fetchUrl }
 *   res.status(204).end();
 * });
 * ```
 */
export function verifyWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string, secret: string): boolean {
  if (typeof signatureHeader !== 'string') return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) return false;

  const provided = parseSignatureHeader(signatureHeader);
  if (provided === null) return false;

  const expected = hmacSha256(toBytes(secret), toBytes(rawBody));
  return timingSafeEqual(expected, provided);
}
