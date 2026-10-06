/**
 * TASK-1047 FC-2 — the package's own SHA-256. `@arcaai/workflow-contract` is imported by browser
 * code (admin-console client components), so the digest cannot reach for `node:crypto`; this pins
 * the pure implementation to the known answers and to Node's own digest.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../sha256';

const node = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 known answers', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the UTF-8 bytes of multi-byte and astral text', () => {
    for (const text of ['é', 'ക്ലിനിക്', '😀 note', 'a\u0000b', '\n\n']) expect(sha256Hex(text)).toBe(node(text));
  });

  it('agrees with node:crypto at every padding boundary', () => {
    for (let length = 0; length < 200; length += 1) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(node(text));
    }
    const long = 'The quick brown fox — ✓ '.repeat(500);
    expect(sha256Hex(long)).toBe(node(long));
  });

  it('is lower-case hex of 64 characters', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
