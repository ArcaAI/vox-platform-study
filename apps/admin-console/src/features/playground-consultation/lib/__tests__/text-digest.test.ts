/**
 * the SHA-256 gate required by contract.
 *
 * `corrections.textSha256` pins the exact text the proposals' byte offsets were computed
 * against. Applying a proposal to text with a different digest would splice the replacement
 * over the wrong characters, so the digest must be checked before any correction is applied.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../text-digest';

describe('sha256Hex', () => {
  it('produces the canonical SHA-256 hex digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('digests the empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes the UTF-8 bytes, so non-ASCII clinical text is stable', async () => {
    // 64 lowercase hex characters, and identical across calls.
    const first = await sha256Hex('Temp 37.5° — SpO₂ 96%');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('Temp 37.5° — SpO₂ 96%')).toBe(first);
  });

  it('differs for a one-character change', async () => {
    expect(await sha256Hex('metformin 500mg')).not.toBe(await sha256Hex('metformin 50mg'));
  });
});
