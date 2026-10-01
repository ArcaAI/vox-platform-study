// VaultSecretsProvider Transit sign / verify / public key — mocked node-vault client, no network.
import { describe, expect, it, vi } from 'vitest';

import { VaultProviderConfig, VaultSecretsProvider } from '../vault-secrets.provider';

function cfg(): VaultProviderConfig {
  return {
    addr: 'http://vault:8200',
    roleId: 'rid',
    secretId: 'sid',
    kvMount: 'secret',
    kvPrefix: 'hope',
    transitMount: 'transit',
    transitKey: 'hope-globalsetting',
  };
}

function provider(client: Record<string, unknown>) {
  const p = new VaultSecretsProvider(cfg());
  (p as unknown as { client: unknown }).client = {
    approleLogin: vi.fn().mockResolvedValue({ auth: { client_token: 't', lease_duration: 1, renewable: false } }),
    ...client,
  };
  return p;
}

describe('VaultSecretsProvider transit signing', () => {
  it('sign writes base64 input to transit/sign/<key> and returns the vault signature', async () => {
    const write = vi.fn().mockResolvedValue({ data: { signature: 'vault:v1:c2ln' } });
    const p = provider({ write });
    await p.boot();
    const sig = await p.sign('hope-checkpoint-sign', Buffer.from('digest'));
    expect(write).toHaveBeenCalledWith('transit/sign/hope-checkpoint-sign', { input: Buffer.from('digest').toString('base64') });
    expect(sig).toBe('vault:v1:c2ln');
  });

  it('sign throws on an empty signature', async () => {
    const p = provider({ write: vi.fn().mockResolvedValue({ data: {} }) });
    await p.boot();
    await expect(p.sign('hope-checkpoint-sign', Buffer.from('d'))).rejects.toThrow(/empty signature/);
  });

  it('verify writes input + signature to transit/verify/<key> and returns data.valid', async () => {
    const write = vi.fn().mockResolvedValueOnce({ data: { valid: true } }).mockResolvedValueOnce({ data: { valid: false } });
    const p = provider({ write });
    await p.boot();
    expect(await p.verify('hope-checkpoint-sign', Buffer.from('digest'), 'vault:v1:c2ln')).toBe(true);
    expect(write).toHaveBeenCalledWith('transit/verify/hope-checkpoint-sign', {
      input: Buffer.from('digest').toString('base64'),
      signature: 'vault:v1:c2ln',
    });
    expect(await p.verify('hope-checkpoint-sign', Buffer.from('digest'), 'vault:v1:bad')).toBe(false);
  });

  it('verify treats a malformed-signature 400 as "not valid", not as an outage', async () => {
    const err = Object.assign(new Error('invalid signature'), { response: { statusCode: 400 } });
    const p = provider({ write: vi.fn().mockRejectedValue(err) });
    await p.boot();
    expect(await p.verify('hope-checkpoint-sign', Buffer.from('d'), 'garbage')).toBe(false);
  });

  it('verify propagates a non-400 failure', async () => {
    const err = Object.assign(new Error('sealed'), { response: { statusCode: 503 } });
    const p = provider({ write: vi.fn().mockRejectedValue(err) });
    await p.boot();
    await expect(p.verify('hope-checkpoint-sign', Buffer.from('d'), 'vault:v1:x')).rejects.toThrow(/sealed/);
  });

  it('publicKey reads transit/keys/<key> and returns the latest version public key', async () => {
    const read = vi.fn().mockResolvedValue({
      data: { latest_version: 2, keys: { '1': { public_key: 'OLD' }, '2': { public_key: 'NEW' } } },
    });
    const p = provider({ read });
    await p.boot();
    expect(await p.publicKey('hope-checkpoint-sign')).toBe('NEW');
    expect(read).toHaveBeenCalledWith('transit/keys/hope-checkpoint-sign');
  });

  it('publicKey(key, version) returns that version, not the latest', async () => {
    const read = vi.fn().mockResolvedValue({
      data: { latest_version: 2, keys: { '1': { public_key: 'OLD' }, '2': { public_key: 'NEW' } } },
    });
    const p = provider({ read });
    await p.boot();
    expect(await p.publicKey('hope-checkpoint-sign', 1)).toBe('OLD');
  });

  it('publicKey returns null when the requested version is absent (trimmed) or has no public key', async () => {
    const read = vi.fn().mockResolvedValue({ data: { latest_version: 3, min_available_version: 2, keys: { '2': { public_key: 'B' }, '3': 1700000000 } } });
    const p = provider({ read });
    await p.boot();
    expect(await p.publicKey('hope-checkpoint-sign', 1)).toBeNull();
    expect(await p.publicKey('hope-checkpoint-sign')).toBeNull();
  });
});
