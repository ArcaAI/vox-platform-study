/**
 * UUIDv7 generation for idempotency keys (RFC 9562). Uses only
 * `globalThis.crypto.getRandomValues` — no `node:crypto` import, matching
 * the zero-runtime-dependency, WinterTC-portable constraint on this package.
 *
 * HOPE's async summary/pre-summary routes take `idempotencyKey` as a BODY
 * field on `GenerateSummaryRequest`/`GeneratePreSummaryRequest` (not a
 * header) — see `docs/implementation/TASK-632-HOPE-Node-SDK/README.md`.
 * This module only generates the value; the resources layer is
 * responsible for placing it in the request body.
 */

const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX_TABLE[b];
  return out;
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** Injectable seams for {@link generateUuidV7} — tests only; omit both in normal use. */
export interface GenerateUuidV7Options {
  /** Returns the current time in Unix epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Returns `length` cryptographically random bytes. Defaults to `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
}

/**
 * Generate a UUIDv7 string: a 48-bit big-endian millisecond timestamp
 * (bytes 0-5) + a `0111` version nibble + 12 random bits (`rand_a`) + a `10`
 * variant + 62 random bits (`rand_b`). Because the timestamp occupies the
 * leading bits, ids generated at increasing timestamps sort lexicographically
 * in generation order — the property that makes UUIDv7 useful as a
 * database-friendly, still-unique idempotency key (unlike UUIDv4, which sorts
 * randomly).
 */
export function generateUuidV7(options: GenerateUuidV7Options = {}): string {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  const ts = now();
  const bytes = new Uint8Array(16);

  // 48-bit big-endian Unix ms timestamp.
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // 74 bits of randomness: rand_a (12 bits) + rand_b (62 bits) = 10 bytes.
  const rand = randomBytes(10);

  bytes[6] = 0x70 | (rand[0]! & 0x0f); // version 0111, high nibble of rand_a
  bytes[7] = rand[1]!; // low byte of rand_a
  bytes[8] = 0x80 | (rand[2]! & 0x3f); // variant 10, top 6 bits of rand_b
  bytes[9] = rand[3]!;
  bytes[10] = rand[4]!;
  bytes[11] = rand[5]!;
  bytes[12] = rand[6]!;
  bytes[13] = rand[7]!;
  bytes[14] = rand[8]!;
  bytes[15] = rand[9]!;

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
