import { describe, expect, it } from 'vitest';
import {
  API_KEY_ENCODING,
  DEFAULT_GENERATED_SECRET_POLICY,
  MAX_SECRET_BYTES,
  MIN_SECRET_BYTES,
  SECRET_POLICY_SETTING_KEYS,
  generateSecretString,
  resolveGeneratedSecretPolicy,
} from '../secret-policy';

function reader(values: Record<string, unknown>) {
  return {
    getValueWithDefault<T>(key: string, defaultValue: T): T {
      return (key in values ? (values[key] as T) : defaultValue) as T;
    },
  };
}

describe('resolveGeneratedSecretPolicy', () => {
  it('falls back to the pre-policy defaults when nothing is stored', () => {
    expect(resolveGeneratedSecretPolicy(reader({}))).toEqual(DEFAULT_GENERATED_SECRET_POLICY);
  });

  it('PREFERS the stored policy over the hardcoded default', () => {
    const policy = resolveGeneratedSecretPolicy(
      reader({ [SECRET_POLICY_SETTING_KEYS.byteLength]: 48, [SECRET_POLICY_SETTING_KEYS.encoding]: 'base64url' }),
    );
    expect(policy).toEqual({ byteLength: 48, encoding: 'base64url' });
  });

  it('coerces string-valued GlobalSetting rows', () => {
    expect(resolveGeneratedSecretPolicy(reader({ [SECRET_POLICY_SETTING_KEYS.byteLength]: '40' })).byteLength).toBe(40);
  });

  it('clamps to the floor and the ceiling rather than issuing a weak secret', () => {
    expect(resolveGeneratedSecretPolicy(reader({ [SECRET_POLICY_SETTING_KEYS.byteLength]: 4 })).byteLength).toBe(MIN_SECRET_BYTES);
    expect(resolveGeneratedSecretPolicy(reader({ [SECRET_POLICY_SETTING_KEYS.byteLength]: 4096 })).byteLength).toBe(MAX_SECRET_BYTES);
  });

  it('ignores an unparsable length or an unknown encoding', () => {
    const policy = resolveGeneratedSecretPolicy(
      reader({ [SECRET_POLICY_SETTING_KEYS.byteLength]: 'twelve', [SECRET_POLICY_SETTING_KEYS.encoding]: 'rot13' }),
    );
    expect(policy).toEqual(DEFAULT_GENERATED_SECRET_POLICY);
  });
});

describe('generateSecretString', () => {
  it('emits the default 64 hex characters', () => {
    expect(generateSecretString(DEFAULT_GENERATED_SECRET_POLICY)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honours a longer configured length', () => {
    expect(generateSecretString({ byteLength: 48, encoding: 'hex' })).toMatch(/^[a-f0-9]{96}$/);
  });

  it('honours the base64url alphabet', () => {
    const secret = generateSecretString({ byteLength: 32, encoding: 'base64url' });
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeLessThan(64);
  });

  it('lets the API-key path pin hex while keeping the configured length', () => {
    expect(generateSecretString({ byteLength: 40, encoding: 'base64url' }, API_KEY_ENCODING)).toMatch(/^[a-f0-9]{80}$/);
  });

  it('never repeats', () => {
    expect(generateSecretString(DEFAULT_GENERATED_SECRET_POLICY)).not.toBe(generateSecretString(DEFAULT_GENERATED_SECRET_POLICY));
  });
});
