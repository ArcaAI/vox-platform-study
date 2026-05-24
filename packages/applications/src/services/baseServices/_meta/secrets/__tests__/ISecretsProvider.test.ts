import { describe, it, expect } from 'vitest';
import { ISecretsProvider, SECRETS_PROVIDER_TOKEN } from '../ISecretsProvider';

describe('ISecretsProvider', () => {
  it('exposes a DI token symbol', () => {
    expect(SECRETS_PROVIDER_TOKEN.toString()).toContain('ISecretsProvider');
  });

  it('describes the contract via TS structural typing', () => {
    const sample: ISecretsProvider = {
      getSecret: async () => 'x',
      getSecretOptional: async () => undefined,
      getSecretJson: async () => ({} as unknown as never),
      getSecrets: async () => ({}),
      rotateSecret: async () => {},
      health: async () => ({ ok: true, latencyMs: 0, provider: 'test' }),
    };
    expect(typeof sample.getSecret).toBe('function');
  });
});
