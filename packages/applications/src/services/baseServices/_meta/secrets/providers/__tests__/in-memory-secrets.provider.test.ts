import { describe, it, expect } from 'vitest';
import { InMemorySecretsProvider } from '../in-memory-secrets.provider';

describe('InMemorySecretsProvider', () => {
  it('returns seeded values', async () => {
    const provider = new InMemorySecretsProvider({ FOO: 'bar' });
    await expect(provider.getSecret('FOO')).resolves.toBe('bar');
  });

  it('supports setSecret + rotateSecret with new value', async () => {
    const provider = new InMemorySecretsProvider({});
    await provider.setSecret('K', 'v1');
    expect(await provider.getSecret('K')).toBe('v1');
    await provider.rotateSecret('K', 'v2');
    expect(await provider.getSecret('K')).toBe('v2');
  });

  it('throws on missing required (default)', async () => {
    const provider = new InMemorySecretsProvider({});
    await expect(provider.getSecret('NOPE')).rejects.toThrow();
  });

  it('returns empty string when required=false on missing', async () => {
    const provider = new InMemorySecretsProvider({});
    await expect(provider.getSecret('NOPE', { required: false })).resolves.toBe('');
  });

  it('bulk-fetches multiple keys', async () => {
    const provider = new InMemorySecretsProvider({ A: '1', B: '2' });
    await expect(provider.getSecrets(['A', 'B', 'C'])).resolves.toEqual({ A: '1', B: '2' });
  });

  it('health returns ok:true with provider=in-memory', async () => {
    const provider = new InMemorySecretsProvider({});
    await expect(provider.health()).resolves.toMatchObject({ ok: true, provider: 'in-memory' });
  });

  it('getSecretJson parses JSON-encoded values', async () => {
    const provider = new InMemorySecretsProvider({ J: JSON.stringify({ x: 7 }) });
    await expect(provider.getSecretJson('J')).resolves.toEqual({ x: 7 });
  });
});
