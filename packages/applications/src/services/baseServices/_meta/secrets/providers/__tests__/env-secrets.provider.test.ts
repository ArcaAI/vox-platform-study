import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvSecretsProvider } from '../env-secrets.provider';

describe('EnvSecretsProvider', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns value from process.env', async () => {
    process.env.MY_SECRET = 'shh';
    const provider = new EnvSecretsProvider();
    await expect(provider.getSecret('MY_SECRET')).resolves.toBe('shh');
  });

  it('throws on missing when required=true (default)', async () => {
    const provider = new EnvSecretsProvider();
    delete process.env.NONEXISTENT_AT_RED;
    await expect(provider.getSecret('NONEXISTENT_AT_RED')).rejects.toThrow(/NONEXISTENT_AT_RED/);
  });

  it('returns undefined on missing when required=false (via getSecretOptional)', async () => {
    const provider = new EnvSecretsProvider();
    delete process.env.NONEXISTENT_AT_RED;
    await expect(provider.getSecretOptional('NONEXISTENT_AT_RED')).resolves.toBeUndefined();
  });

  it('bulk-fetches multiple keys', async () => {
    process.env.A_BULK = '1';
    process.env.B_BULK = '2';
    const provider = new EnvSecretsProvider();
    const out = await provider.getSecrets(['A_BULK', 'B_BULK']);
    expect(out).toEqual({ A_BULK: '1', B_BULK: '2' });
  });

  it('health returns ok:true with provider=env', async () => {
    const provider = new EnvSecretsProvider();
    const h = await provider.health();
    expect(h.ok).toBe(true);
    expect(h.provider).toBe('env');
  });

  it('getSecretJson parses JSON-encoded env values', async () => {
    process.env.JSON_KEY = JSON.stringify({ a: 1, b: 'x' });
    const provider = new EnvSecretsProvider();
    await expect(provider.getSecretJson('JSON_KEY')).resolves.toEqual({ a: 1, b: 'x' });
  });

  it('getSecretJson throws on malformed JSON', async () => {
    process.env.BAD_JSON = 'not-json';
    const provider = new EnvSecretsProvider();
    await expect(provider.getSecretJson('BAD_JSON')).rejects.toThrow(/not valid JSON/);
  });

  it('rotateSecret rejects (env provider has no rotation)', async () => {
    const provider = new EnvSecretsProvider();
    await expect(provider.rotateSecret('K')).rejects.toThrow(/restart pod/);
  });
});
