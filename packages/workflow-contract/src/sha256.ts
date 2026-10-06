/**
 * TASK-1047 FC-2 — `sha256Hex(text)`: SHA-256 (FIPS 180-4) of the UTF-8 bytes of `text`, as
 * lower-case hex.
 *
 * Pure TypeScript and synchronous on purpose. This package is imported by browser code (the
 * admin console's client components reach it through the barrel), so `node:crypto` would break
 * those bundles, and WebCrypto's `subtle.digest` is asynchronous — `composeMessages` is not. The
 * Python mirror uses `hashlib.sha256(text.encode("utf-8"))`; the known answers and the
 * cross-language fixture hold the two together.
 *
 * A lone UTF-16 surrogate (not valid Unicode; unreachable from a well-formed string) is encoded as
 * U+FFFD, exactly as `TextEncoder` does.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The UTF-8 bytes of `text` (lone surrogates → U+FFFD). */
function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of the UTF-8 bytes of `text`, lower-case hex. */
export function sha256Hex(text: string): string {
  const bytes = utf8(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length; the high word is the bits above 2^32 (a string is far below 2^53).
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const j = offset + t * 4;
      w[t] = ((bytes[j] as number) << 24) | ((bytes[j + 1] as number) << 16) | ((bytes[j + 2] as number) << 8) | (bytes[j + 3] as number);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
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
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}
