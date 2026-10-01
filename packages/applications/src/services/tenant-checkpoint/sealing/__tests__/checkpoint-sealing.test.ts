import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { InMemorySecretsProvider } from '../../../baseServices/_meta/secrets/providers/in-memory-secrets.provider';
import { SecretsService } from '../../../baseServices/_meta/secrets/SecretsService';
import { CHECKPOINT_SIGN_KEY, CHECKPOINT_WRAP_KEY } from '../../contracts';
import { CheckpointSealing } from '../checkpoint-sealing';

/** A SecretsService stand-in that records every call (Vault-shaped). */
function stubSecrets() {
  const calls: { op: string; args: unknown[] }[] = [];
  const stub = {
    calls,
    supportsTransit: () => true,
    supportsSigning: () => true,
    encrypt: vi.fn(async (pt: Buffer, key?: string) => {
      calls.push({ op: 'encrypt', args: [pt, key] });
      return `vault:v1:${Buffer.from(pt).toString('base64')}`;
    }),
    decrypt: vi.fn(async (ct: string, key?: string) => {
      calls.push({ op: 'decrypt', args: [ct, key] });
      return Buffer.from(ct.replace(/^vault:v1:/, ''), 'base64');
    }),
    sign: vi.fn(async (key: string, data: Buffer) => {
      calls.push({ op: 'sign', args: [key, data] });
      return 'vault:v1:c2ln';
    }),
    // Vault picks the key version from the `vault:vN:` prefix; the stub accepts any version.
    verify: vi.fn(async (key: string, data: Buffer, sig: string) => {
      calls.push({ op: 'verify', args: [key, data, sig] });
      return /^vault:v\d+:c2ln$/.test(sig);
    }),
    /** Transit key versions; `latest` moves on rotation. */
    versions: { latest: 1, keys: { 1: 'MCowBQYDK2VwAyEAPUBLICKEY' } as Record<number, string> },
    publicKey: vi.fn(async (key: string, version?: number) => {
      calls.push({ op: 'publicKey', args: [key, version] });
      return stub.versions.keys[version ?? stub.versions.latest];
    }),
  };
  return stub;
}

const sealingWith = (s: ReturnType<typeof stubSecrets>) => new CheckpointSealing(s as unknown as SecretsService);

describe('CheckpointSealing', () => {
  it('generateDataKey returns 32 random bytes wrapped under the hope-checkpoint Transit key', async () => {
    const s = stubSecrets();
    const sealing = sealingWith(s);
    const a = await sealing.generateDataKey();
    const b = await sealing.generateDataKey();
    expect(a.plaintext).toHaveLength(32);
    expect(a.plaintext.equals(b.plaintext)).toBe(false);
    expect(s.encrypt).toHaveBeenCalledWith(a.plaintext, CHECKPOINT_WRAP_KEY);
    expect(a.platformWrapped).toMatch(/^vault:v1:/);
    expect((await sealing.unwrapPlatform(a.platformWrapped)).equals(a.plaintext)).toBe(true);
    expect(s.decrypt).toHaveBeenCalledWith(a.platformWrapped, CHECKPOINT_WRAP_KEY);
  });

  it('unwrapPlatform refuses a wrap that does not hold a 32-byte key', async () => {
    const sealing = sealingWith(stubSecrets());
    await expect(sealing.unwrapPlatform(`vault:v1:${Buffer.alloc(16).toString('base64')}`)).rejects.toThrow(/32 bytes/);
  });

  it('wrapWithPassphrase → unwrapWithPassphrase round-trips with Argon2id m=65536 t=3 p=1', async () => {
    const sealing = sealingWith(stubSecrets());
    const key = Buffer.alloc(32, 7);
    const wrap = await sealing.wrapWithPassphrase(key, 'correct horse battery staple');
    expect(wrap).toMatchObject({ kdf: 'argon2id', m: 65536, t: 3, p: 1 });
    expect(Buffer.from(wrap.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(wrap.nonce, 'base64')).toHaveLength(12);
    expect((await sealing.unwrapWithPassphrase(wrap, 'correct horse battery staple')).equals(key)).toBe(true);
  });

  it('a wrong passphrase rejects with PASSPHRASE_INVALID', async () => {
    const sealing = sealingWith(stubSecrets());
    const wrap = await sealing.wrapWithPassphrase(Buffer.alloc(32, 1), 'right');
    await expect(sealing.unwrapWithPassphrase(wrap, 'wrong')).rejects.toMatchObject({ reason: 'PASSPHRASE_INVALID' });
  });

  it('a wrap asking for absurd Argon2 cost is refused before any work', async () => {
    const sealing = sealingWith(stubSecrets());
    const wrap = await sealing.wrapWithPassphrase(Buffer.alloc(32, 1), 'right');
    await expect(sealing.unwrapWithPassphrase({ ...wrap, m: 64 * 1024 * 1024 }, 'right')).rejects.toMatchObject({ reason: 'UNSUPPORTED_FORMAT' });
  });

  it('sign / verify go through the hope-checkpoint-sign Transit key', async () => {
    const s = stubSecrets();
    const sealing = sealingWith(s);
    const digest = Buffer.alloc(32, 9);
    expect(await sealing.sign(digest)).toBe('vault:v1:c2ln');
    expect(s.sign).toHaveBeenCalledWith(CHECKPOINT_SIGN_KEY, digest);
    expect(await sealing.verify(digest, 'vault:v1:c2ln')).toBe(true);
    expect(await sealing.verify(digest, 'vault:v1:other')).toBe(false);
    expect(s.verify).toHaveBeenCalledWith(CHECKPOINT_SIGN_KEY, digest, 'vault:v1:c2ln');
  });

  it('deploymentId() is the hex sha256 of the hope-checkpoint-sign public key, memoised', async () => {
    const s = stubSecrets();
    const sealing = sealingWith(s);
    const expected = createHash('sha256').update('MCowBQYDK2VwAyEAPUBLICKEY', 'utf8').digest('hex');
    expect(await sealing.deploymentId()).toBe(expected);
    expect(await sealing.deploymentId()).toBe(expected);
    expect(s.publicKey).toHaveBeenCalledTimes(1);
    expect(s.publicKey).toHaveBeenCalledWith(CHECKPOINT_SIGN_KEY, 1);
  });

  it('a Transit key rotation never changes deploymentId; signatures of the new version still verify', async () => {
    const s = stubSecrets();
    const before = await sealingWith(s).deploymentId();
    s.versions.keys[2] = 'MCowBQYDK2VwAyEAROTATEDKEY';
    s.versions.latest = 2;
    const after = await sealingWith(s).deploymentId(); // fresh instance — no memo involved
    expect(after).toBe(before);
    expect(await sealingWith(s).verify(Buffer.alloc(32, 9), 'vault:v2:c2ln')).toBe(true);
    expect(s.verify).toHaveBeenLastCalledWith(CHECKPOINT_SIGN_KEY, Buffer.alloc(32, 9), 'vault:v2:c2ln');
  });

  it('SecretsService.publicKey: a trimmed version → SEALING_UNAVAILABLE naming the version', async () => {
    const provider = Object.assign(new InMemorySecretsProvider(), {
      sign: vi.fn(),
      verify: vi.fn(),
      publicKey: vi.fn(async () => null),
    });
    const secrets = new SecretsService(provider);
    const err = await secrets.publicKey(CHECKPOINT_SIGN_KEY, 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    expect((err as Error).message).toMatch(/hope-checkpoint-sign.*version 1/);
    expect(provider.publicKey).toHaveBeenCalledWith(CHECKPOINT_SIGN_KEY, 1);
  });

  it('deploymentId() does not memoise a failure', async () => {
    const s = stubSecrets();
    s.publicKey.mockRejectedValueOnce(new Error('vault down'));
    const sealing = sealingWith(s);
    await expect(sealing.deploymentId()).rejects.toThrow(/vault down/);
    await expect(sealing.deploymentId()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('a non-Vault provider → SEALING_UNAVAILABLE (fail closed)', async () => {
    const secrets = new SecretsService(new InMemorySecretsProvider());
    expect(secrets.supportsSigning()).toBe(false);
    const sealing = new CheckpointSealing(secrets);
    await expect(sealing.generateDataKey()).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(sealing.unwrapPlatform('vault:v1:x')).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(sealing.sign(Buffer.alloc(32))).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(sealing.verify(Buffer.alloc(32), 'vault:v1:x')).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(sealing.deploymentId()).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(secrets.sign(CHECKPOINT_SIGN_KEY, Buffer.alloc(32))).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(secrets.verify(CHECKPOINT_SIGN_KEY, Buffer.alloc(32), 'vault:v1:x')).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
    await expect(secrets.publicKey(CHECKPOINT_SIGN_KEY)).rejects.toMatchObject({ reason: 'SEALING_UNAVAILABLE' });
  });
});
