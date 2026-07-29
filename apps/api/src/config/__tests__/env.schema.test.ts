/**
 * Fail-fast environment schema for the API gateway (TASK-558 lane D, plan §9.1
 * D1 / §9.2 L2-L3).
 *
 * The schema is BUILT FROM the settings-registry descriptors — never a
 * hand-copied key list — so a descriptor added in
 * `packages/applications/src/services/settings-registry/descriptors/**` is
 * validated here automatically. These tests lock that contract:
 *
 *   1. every declared descriptor is validated (name parity, via toEnvVarName)
 *   2. a missing REQUIRED var fails, and the error names EVERY problem at once
 *   3. declared defaults come from the descriptor, and host env outranks them
 *   4. typed vars (number / boolean) reject malformed values
 *   5. the Vault credential set is conditionally required on SECRETS_PROVIDER
 */

import { BOOTSTRAP_ENV_SETTINGS, toEnvVarName } from '@arcaai/applications';
import { describe, expect, it } from 'vitest';
import { API_ENV_DESCRIPTORS, parseApiEnv } from '../env.schema';

/** Minimum environment that must parse cleanly. */
const MINIMAL = { DATABASE_URL: 'postgres://u:p@localhost:5432/hope' } as const;

describe('API_ENV_DESCRIPTORS — the declared surface', () => {
  it('carries every bootstrap-floor descriptor except the Vault provisioning password', () => {
    const declared = new Set(API_ENV_DESCRIPTORS.map((d) => toEnvVarName(d.key)));
    const missing = BOOTSTRAP_ENV_SETTINGS.map((d) => toEnvVarName(d.key)).filter((name) => !declared.has(name));
    // VAULT_DB_ADMIN_PASS is consumed at Vault PROVISIONING time by shell
    // scripts + compose, never by this process (zero TS readers).
    expect(missing).toEqual(['VAULT_DB_ADMIN_PASS']);
  });

  it('declares no duplicate env-var names', () => {
    const names = API_ENV_DESCRIPTORS.map((d) => toEnvVarName(d.key));
    expect(new Set(names).size).toBe(names.length);
  });

  it('derives SCREAMING_SNAKE names mechanically (no hand-copied keys)', () => {
    for (const d of API_ENV_DESCRIPTORS) {
      expect(toEnvVarName(d.key), d.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('parseApiEnv — fail fast, report everything', () => {
  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseApiEnv({})).toThrowError(/DATABASE_URL/);
  });

  it('reports EVERY problem in one throw, not just the first', () => {
    let message = '';
    try {
      parseApiEnv({ PORT: 'not-a-port', PRISMA_PG_MAX: 'nope', RATE_LIMIT_ENABLED: 'yes-please' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/PRISMA_PG_MAX/);
    expect(message).toMatch(/RATE_LIMIT_ENABLED/);
  });

  it('accepts the minimal environment', () => {
    expect(() => parseApiEnv({ ...MINIMAL })).not.toThrow();
  });
});

describe('parseApiEnv — descriptor defaults and precedence', () => {
  it('applies the descriptor default when the var is absent', () => {
    const env = parseApiEnv({ ...MINIMAL });
    expect(env.PORT).toBe(8868);
    expect(env.PRISMA_PG_MAX).toBe(5);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.VAULT_KV_MOUNT).toBe('secret');
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });

  it('lets a host value outrank the descriptor default', () => {
    const env = parseApiEnv({ ...MINIMAL, PORT: '9999', LOG_LEVEL: 'debug', RATE_LIMIT_ENABLED: 'false' });
    expect(env.PORT).toBe(9999);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.RATE_LIMIT_ENABLED).toBe(false);
  });

  it('treats an empty string as absent so a blank line in .env.dev keeps the default', () => {
    const env = parseApiEnv({ ...MINIMAL, PORT: '', VAULT_KV_PREFIX: '' });
    expect(env.PORT).toBe(8868);
    expect(env.VAULT_KV_PREFIX).toBe('hope');
  });
});

describe('parseApiEnv — typed values', () => {
  it('rejects a non-numeric number var', () => {
    expect(() => parseApiEnv({ ...MINIMAL, SHUTDOWN_TIMEOUT_MS: 'soon' })).toThrowError(/SHUTDOWN_TIMEOUT_MS/);
  });

  it('rejects a port outside 1-65535', () => {
    expect(() => parseApiEnv({ ...MINIMAL, PORT: '70000' })).toThrowError(/PORT/);
  });

  it('rejects a boolean var that is not true/false', () => {
    expect(() => parseApiEnv({ ...MINIMAL, API_KEY_ALLOW_QUERY_PARAM: '1' })).toThrowError(/API_KEY_ALLOW_QUERY_PARAM/);
  });

  it('rejects a malformed URL var', () => {
    expect(() => parseApiEnv({ ...MINIMAL, SMR_URL: 'localhost:8862' })).toThrowError(/SMR_URL/);
  });
});

describe('parseApiEnv — Vault credentials are conditionally required', () => {
  it('does not require Vault credentials under the env secrets provider', () => {
    expect(() => parseApiEnv({ ...MINIMAL, SECRETS_PROVIDER: 'env' })).not.toThrow();
  });

  it('requires role_id and one of the two secret_id forms under SECRETS_PROVIDER=vault', () => {
    let message = '';
    try {
      parseApiEnv({ ...MINIMAL, SECRETS_PROVIDER: 'vault' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/VAULT_ROLE_ID/);
    expect(message).toMatch(/VAULT_SECRET_ID/);
    expect(message).toMatch(/VAULT_WRAPPED_SECRET_ID/);
  });

  it('accepts either the raw or the response-wrapped secret_id', () => {
    const base = { ...MINIMAL, SECRETS_PROVIDER: 'vault', VAULT_ROLE_ID: 'role-uuid' };
    expect(() => parseApiEnv({ ...base, VAULT_SECRET_ID: 'raw-secret' })).not.toThrow();
    expect(() => parseApiEnv({ ...base, VAULT_WRAPPED_SECRET_ID: 'wrapped-token' })).not.toThrow();
  });
});
