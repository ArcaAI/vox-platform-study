// TASK-558 lane J (J2) — plan §9.2 L8: "every fallback is observable".
//
// A resolved secret must be able to say WHICH TIER supplied it. Before this,
// `getSecret('JWT_SECRET_KEY')` returned a string and nothing distinguished
// "read from Vault kv-v2" from "read out of the process environment" — so a
// deployment whose `SECRETS_PROVIDER` silently stayed `env` looked, from every
// log line and every health check, exactly like a correctly Vault-backed one.
//
// The contract pinned here:
//   * `getResolutionSource(key)` reports the provider that supplied the value.
//   * `SECRETS_PROVIDER=env` in a NON-development runtime logs ONE warning per
//     key — the env tier is the sanctioned dev/CI path, and a fallback in a
//     deployed process is exactly what L8 wants surfaced.
//   * That warning names the key and the tier and NEVER the value.
//   * Local development stays silent: env is the intended provider there, not a
//     fallback, and 12 boot warnings would train everyone to ignore them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { SecretsService } from '../SecretsService';
import { EnvSecretsProvider } from '../providers/env-secrets.provider';
import { InMemorySecretsProvider } from '../providers/in-memory-secrets.provider';

const SECRET_VALUE = 'super-secret-material-that-must-never-be-logged';

describe('SecretsService resolution source (plan §9.2 L8)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.LANE_J_PROBE_SECRET = SECRET_VALUE;
  });

  afterEach(() => {
    warn.mockRestore();
    delete process.env.LANE_J_PROBE_SECRET;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('reports the provider that supplied a value', async () => {
    const svc = new SecretsService(new EnvSecretsProvider());
    expect(svc.getResolutionSource('LANE_J_PROBE_SECRET')).toBeUndefined();

    await svc.getSecret('LANE_J_PROBE_SECRET');

    expect(svc.getResolutionSource('LANE_J_PROBE_SECRET')).toBe('env');
  });

  it('warns ONCE per key when the env tier supplies a secret in a deployed runtime', async () => {
    process.env.NODE_ENV = 'production';
    const svc = new SecretsService(new EnvSecretsProvider());

    await svc.getSecret('LANE_J_PROBE_SECRET');
    await svc.getSecret('LANE_J_PROBE_SECRET', { refresh: true });

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('LANE_J_PROBE_SECRET'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('env');
  });

  it('never puts the secret value in the warning', async () => {
    process.env.NODE_ENV = 'production';
    const svc = new SecretsService(new EnvSecretsProvider());

    await svc.getSecret('LANE_J_PROBE_SECRET');

    expect(warn.mock.calls.map((c) => JSON.stringify(c)).join('\n')).not.toContain(SECRET_VALUE);
  });

  it('stays silent in local development — env is the intended provider there, not a fallback', async () => {
    process.env.NODE_ENV = 'development';
    const svc = new SecretsService(new EnvSecretsProvider());

    await svc.getSecret('LANE_J_PROBE_SECRET');

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('LANE_J_PROBE_SECRET'))).toHaveLength(0);
    expect(svc.getResolutionSource('LANE_J_PROBE_SECRET')).toBe('env');
  });

  it('does not warn when a non-env provider supplies the value', async () => {
    process.env.NODE_ENV = 'production';
    const provider = new InMemorySecretsProvider();
    await provider.setSecret('LANE_J_PROBE_SECRET', SECRET_VALUE);
    const svc = new SecretsService(provider);

    await svc.getSecret('LANE_J_PROBE_SECRET');

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('LANE_J_PROBE_SECRET'))).toHaveLength(0);
    expect(svc.getResolutionSource('LANE_J_PROBE_SECRET')).toBe('in-memory');
  });

  it('records the source for bulk reads too', async () => {
    const svc = new SecretsService(new EnvSecretsProvider());

    await svc.getSecrets(['LANE_J_PROBE_SECRET']);

    expect(svc.getResolutionSource('LANE_J_PROBE_SECRET')).toBe('env');
  });
});
