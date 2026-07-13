import { describe, expect, it, vi } from 'vitest';
import { decryptSecretField, encryptSecretField, parseKeyVersionFromCiphertext, type TransitCrypto } from '../secret-field.util';

// Fake Vault Transit: ciphertext `vault:v<n>:<base64(plaintext)>`, reversible.
// Mirrors the stub used by tenant-tts-config.service.test.ts so the canonical
// util and its first caller share one contract.
function fakeTransit(keyVersion = 1): TransitCrypto {
  return {
    encrypt: vi.fn(async (buf: Buffer) => `vault:v${keyVersion}:${buf.toString('base64')}`),
    decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':')[2], 'base64')),
  };
}

describe('parseKeyVersionFromCiphertext', () => {
  it('extracts the key version N from a well-formed vault:vN:<b64> ciphertext', () => {
    expect(parseKeyVersionFromCiphertext('vault:v1:abc')).toBe(1);
    expect(parseKeyVersionFromCiphertext('vault:v7:abc')).toBe(7);
    expect(parseKeyVersionFromCiphertext('vault:v12:abc')).toBe(12);
  });

  it('falls back to 1 (bootstrap key) on any malformed shape', () => {
    expect(parseKeyVersionFromCiphertext('')).toBe(1);
    expect(parseKeyVersionFromCiphertext('nope')).toBe(1);
    expect(parseKeyVersionFromCiphertext('a:b')).toBe(1); // < 3 parts
    expect(parseKeyVersionFromCiphertext('vault:x:abc')).toBe(1); // no 'v' prefix
    expect(parseKeyVersionFromCiphertext('vault:v:abc')).toBe(1); // 'v' but no number
    expect(parseKeyVersionFromCiphertext('vault:v0:abc')).toBe(1); // 0 is not > 0
  });
});

describe('encryptSecretField', () => {
  it('encrypts plaintext into { ciphertext: Bytes, keyVersion }', async () => {
    const secrets = fakeTransit(3);
    const { ciphertext, keyVersion } = await encryptSecretField(secrets, 'super-secret');

    expect(secrets.encrypt).toHaveBeenCalledOnce();
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    // stored bytes are the UTF-8 transit string
    expect(ciphertext.toString('utf8')).toMatch(/^vault:v3:/);
    expect(keyVersion).toBe(3);
    // plaintext never appears verbatim in the stored bytes
    expect(ciphertext.toString('utf8')).not.toContain('super-secret');
  });

  it('forwards an optional key name to the provider', async () => {
    const secrets = fakeTransit(1);
    await encryptSecretField(secrets, 'k', 'hope-phi');
    expect(secrets.encrypt).toHaveBeenCalledWith(expect.any(Buffer), 'hope-phi');
  });
});

describe('decryptSecretField', () => {
  it('decrypts a stored ciphertext-bytes column back to plaintext', async () => {
    const secrets = fakeTransit(1);
    const stored = Buffer.from(`vault:v1:${Buffer.from('THE-KEY').toString('base64')}`, 'utf8');
    await expect(decryptSecretField(secrets, stored)).resolves.toBe('THE-KEY');
    expect(secrets.decrypt).toHaveBeenCalledOnce();
  });
});

describe('round-trip', () => {
  it('encrypt then decrypt returns the original plaintext', async () => {
    const secrets = fakeTransit(2);
    const { ciphertext } = await encryptSecretField(secrets, 'consultation-key-abc');
    await expect(decryptSecretField(secrets, ciphertext)).resolves.toBe('consultation-key-abc');
  });
});
