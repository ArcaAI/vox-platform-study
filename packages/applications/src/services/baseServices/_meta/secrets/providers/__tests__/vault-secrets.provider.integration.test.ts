// VaultSecretsProvider integration test.
//
// Gated by INTEG_VAULT=1; without it `describe.skipIf` short-circuits the
// suite so default `pnpm test` runs (and CI's unit job) stay hermetic. To
// exercise locally:
//
//   docker compose -f infrastructure/docker/docker-compose.dev.yml \
//     --profile vault up -d
//   INTEG_VAULT=1 pnpm --filter @arcaai/applications test \
//     -- vault-secrets.provider.integration
//
// We talk to the dev container's `vault` CLI via `docker exec hope-vault`
// so the test runner does NOT require a host-installed Vault binary.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { VaultSecretsProvider } from '../vault-secrets.provider';

const enabled = !!process.env.INTEG_VAULT;
const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://localhost:8200';
const ROOT_TOKEN = process.env.VAULT_DEV_ROOT_TOKEN ?? 'root';
const CONTAINER = process.env.VAULT_CONTAINER ?? 'hope-vault';

function vaultExec(args: string): string {
  const cmd = `docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=${ROOT_TOKEN} ${CONTAINER} sh -c 'vault ${args}'`;
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function mintWrappedSecretId(): string {
  const wrapJson = vaultExec('write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id');
  const parsed = JSON.parse(wrapJson) as { wrap_info?: { token?: string } };
  const token = parsed.wrap_info?.token ?? '';
  if (!token) {
    throw new Error(`Could not extract wrap_info.token from: ${wrapJson}`);
  }
  return token;
}

describe.skipIf(!enabled)('VaultSecretsProvider (integration)', () => {
  let roleId: string;

  beforeAll(() => {
    roleId = vaultExec('read -field=role_id auth/approle/role/hope-app/role-id');
  });

  it('boots, AppRole-logs in, and reads a seeded kv-v2 secret', async () => {
    const p = new VaultSecretsProvider({
      addr: VAULT_ADDR,
      roleId,
      wrappedSecretId: mintWrappedSecretId(),
      kvMount: 'secret',
      kvPrefix: 'hope',
      transitMount: 'transit',
      transitKey: 'hope-globalsetting',
    });
    await p.boot();
    const v = await p.getSecret('JWT_SECRET_KEY');
    expect(v).toBe('dev-jwt-secret-not-for-prod');
  });

  it('round-trips transit encrypt/decrypt', async () => {
    // Idempotent create: rerun is safe; CLI returns rc=0 on existing keys.
    try {
      vaultExec('write -f transit/keys/hope-globalsetting');
    } catch {
      // ignore - key likely already exists.
    }
    const p = new VaultSecretsProvider({
      addr: VAULT_ADDR,
      roleId,
      wrappedSecretId: mintWrappedSecretId(),
      kvMount: 'secret',
      kvPrefix: 'hope',
      transitMount: 'transit',
      transitKey: 'hope-globalsetting',
    });
    await p.boot();
    const ct = await p.encrypt(Buffer.from('payload'));
    expect(ct).toMatch(/^vault:v\d+:/);
    const pt = await p.decrypt(ct);
    expect(pt.toString('utf8')).toBe('payload');
  });

  it('reports healthy when Vault is unsealed and initialized', async () => {
    const p = new VaultSecretsProvider({
      addr: VAULT_ADDR,
      roleId,
      wrappedSecretId: mintWrappedSecretId(),
      kvMount: 'secret',
      kvPrefix: 'hope',
      transitMount: 'transit',
      transitKey: 'hope-globalsetting',
    });
    await p.boot();
    const h = await p.health();
    expect(h).toMatchObject({ ok: true, provider: 'vault' });
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // Transit rotation round-trip.
  //
  // Verifies the production-critical invariant: after rotating the
  // hope-globalsetting Transit key, ciphertexts produced with the
  // PREVIOUS key version still decrypt successfully. This is the
  // single most important assurance for the rotation worker
  // because if min_decryption_version drops historical versions, every
  // encrypted GlobalSetting row goes dark.
  //
  // The test produces a v_N ciphertext, rotates the key, produces a
  // v_(N+1) ciphertext, then decrypts both. Asserts:
  //   - the second ciphertext's version is strictly greater
  //   - both ciphertexts decrypt to their original plaintext
  it('historical ciphertexts decrypt after transit key rotation', async () => {
    const p = new VaultSecretsProvider({
      addr: VAULT_ADDR,
      roleId,
      wrappedSecretId: mintWrappedSecretId(),
      kvMount: 'secret',
      kvPrefix: 'hope',
      transitMount: 'transit',
      transitKey: 'hope-globalsetting',
    });
    await p.boot();

    const ct1 = await p.encrypt(Buffer.from('payload-pre-rotate'));
    const versionBefore = parseInt(ct1.split(':')[1].slice(1), 10);

    vaultExec('write -f transit/keys/hope-globalsetting/rotate');

    const ct2 = await p.encrypt(Buffer.from('payload-post-rotate'));
    const versionAfter = parseInt(ct2.split(':')[1].slice(1), 10);

    expect(versionAfter).toBeGreaterThan(versionBefore);

    expect((await p.decrypt(ct1)).toString('utf8')).toBe('payload-pre-rotate');
    expect((await p.decrypt(ct2)).toString('utf8')).toBe('payload-post-rotate');
  });
});
