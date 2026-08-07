import { describe, expect, it } from 'vitest';

import { generateUuidV7 } from '../idempotency';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuidV7 — format', () => {
  it('matches the UUIDv7 shape: version nibble 7, variant nibble in 8-b', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateUuidV7()).toMatch(UUID_V7_RE);
    }
  });

  it('always sets the version nibble to 7 regardless of random input', () => {
    const allZero = () => new Uint8Array(10);
    const allOnes = () => new Uint8Array(10).fill(0xff);
    expect(generateUuidV7({ now: () => 0, randomBytes: allZero })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(generateUuidV7({ now: () => 0, randomBytes: allOnes })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('always sets the variant nibble to the 10xx pattern (8-b) regardless of random input', () => {
    const allZero = () => new Uint8Array(10);
    const allOnes = () => new Uint8Array(10).fill(0xff);
    const idZero = generateUuidV7({ now: () => 0, randomBytes: allZero });
    const idOnes = generateUuidV7({ now: () => 0, randomBytes: allOnes });
    expect(idZero.split('-')[3]?.[0]).toBe('8'); // 0x80 | 0x00 → nibble 8
    expect(idOnes.split('-')[3]?.[0]).toBe('b'); // 0x80 | 0x3f → nibble b
  });

  it('produces distinct ids across many calls (no collisions in a real-crypto sample)', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateUuidV7()));
    expect(ids.size).toBe(500);
  });

  it('correctly embeds the 48-bit millisecond timestamp in the leading bits', () => {
    // A known timestamp round-trips out of the first 12 hex chars (48 bits).
    const ts = 0x0198a1b2c3d4; // an arbitrary, in-range 48-bit value
    const id = generateUuidV7({ now: () => ts, randomBytes: () => new Uint8Array(10) });
    const leadingHex = id.replace(/-/g, '').slice(0, 12);
    expect(Number.parseInt(leadingHex, 16)).toBe(ts);
  });
});

describe('generateUuidV7 — monotonicity', () => {
  it('sorts lexicographically increasing when the clock advances between calls', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const id1 = generateUuidV7({ now });
    clock += 1;
    const id2 = generateUuidV7({ now });
    clock += 1000;
    const id3 = generateUuidV7({ now });

    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });

  it('real (non-injected) calls made in sequence never have a decreasing timestamp prefix', () => {
    const timestampOf = (id: string): number => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    const ids = Array.from({ length: 200 }, () => generateUuidV7());
    for (let i = 1; i < ids.length; i++) {
      expect(timestampOf(ids[i]!)).toBeGreaterThanOrEqual(timestampOf(ids[i - 1]!));
    }
  });
});
