// Phase 2C Task 2.17 (TASK-302 Stream B) - SecretsModule factory test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsModule, SECRETS_PROVIDER_INSTANCE } from '../secrets.module';
import { SecretsService } from '../SecretsService';
import { EnvSecretsProvider } from '../providers/env-secrets.provider';
import { VaultSecretsProvider } from '../providers/vault-secrets.provider';
import { AwsSecretsManagerProvider } from '../providers/aws-secrets-manager.provider';
import { AzureKeyVaultProvider } from '../providers/azure-keyvault.provider';
import { InMemorySecretsProvider } from '../providers/in-memory-secrets.provider';

describe('SecretsModule', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SECRETS_PROVIDER;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    delete process.env.VAULT_WRAPPED_SECRET_ID;
    delete process.env.VAULT_ROLE_ID_FILE;
    delete process.env.VAULT_SECRET_ID_FILE;
    delete process.env.VAULT_WRAPPED_SECRET_ID_FILE;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to EnvSecretsProvider when SECRETS_PROVIDER is unset', async () => {
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(EnvSecretsProvider);
  });

  it('selects EnvSecretsProvider when SECRETS_PROVIDER=env', async () => {
    process.env.SECRETS_PROVIDER = 'env';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(EnvSecretsProvider);
  });

  it('selects VaultSecretsProvider when SECRETS_PROVIDER=vault and required env present', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_ROLE_ID = 'rid';
    process.env.VAULT_SECRET_ID = 'sid';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(VaultSecretsProvider);
  });

  it('throws when SECRETS_PROVIDER=vault but VAULT_ADDR missing', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.VAULT_ROLE_ID = 'rid';
    process.env.VAULT_SECRET_ID = 'sid';
    await expect(
      Test.createTestingModule({ imports: [SecretsModule.forRoot()] }).compile(),
    ).rejects.toThrow(/VAULT_ADDR/);
  });

  // TASK-312 B.10 — read-from-file AppRole creds. Production (systemd-creds /
  // k8s Secret mounts) provides role_id + a one-shot wrapped secret_id as files
  // so no secret material is ever inlined in .env.production. The provider
  // constructor throws if role_id / secret_id are unresolved, so a successful
  // VaultSecretsProvider instance proves the files were read.
  describe('VAULT_*_FILE read-from-file credentials (B.10)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hope-vault-creds-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('resolves VAULT_ROLE_ID_FILE + VAULT_WRAPPED_SECRET_ID_FILE (no inline creds)', async () => {
      const roleFile = join(dir, 'role_id');
      const wrapFile = join(dir, 'wrapped_secret_id');
      // Trailing newline must be trimmed (k8s/systemd mounts often add one).
      writeFileSync(roleFile, 'rid-from-file\n');
      writeFileSync(wrapFile, 'wrapped-from-file\n');
      process.env.SECRETS_PROVIDER = 'vault';
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_ROLE_ID_FILE = roleFile;
      process.env.VAULT_WRAPPED_SECRET_ID_FILE = wrapFile;

      const mod = await Test.createTestingModule({
        imports: [SecretsModule.forRoot()],
      }).compile();
      expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(VaultSecretsProvider);
    });

    it('prefers a directly-set VAULT_ROLE_ID over VAULT_ROLE_ID_FILE', async () => {
      const roleFile = join(dir, 'role_id');
      writeFileSync(roleFile, 'rid-from-file\n');
      process.env.SECRETS_PROVIDER = 'vault';
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_ROLE_ID = 'rid-inline';
      process.env.VAULT_ROLE_ID_FILE = roleFile;
      process.env.VAULT_SECRET_ID = 'sid-inline';

      const mod = await Test.createTestingModule({
        imports: [SecretsModule.forRoot()],
      }).compile();
      const provider = mod.get(SECRETS_PROVIDER_INSTANCE);
      expect(provider).toBeInstanceOf(VaultSecretsProvider);
      // Prove the inline value actually won — not just that construction
      // succeeded (the file value 'rid-from-file' would also build a valid
      // provider, so the type check alone can't distinguish the two).
      expect((provider as unknown as { config: { roleId: string } }).config.roleId).toBe(
        'rid-inline',
      );
    });

    it('throws a clear error when VAULT_ROLE_ID_FILE points at a missing file', async () => {
      process.env.SECRETS_PROVIDER = 'vault';
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_ROLE_ID_FILE = join(dir, 'does-not-exist');
      process.env.VAULT_SECRET_ID = 'sid';

      await expect(
        Test.createTestingModule({ imports: [SecretsModule.forRoot()] }).compile(),
      ).rejects.toThrow(/VAULT_ROLE_ID_FILE/);
    });
  });

  it('selects AwsSecretsManagerProvider when SECRETS_PROVIDER=aws', async () => {
    process.env.SECRETS_PROVIDER = 'aws';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(AwsSecretsManagerProvider);
  });

  it('selects AzureKeyVaultProvider when SECRETS_PROVIDER=azure', async () => {
    process.env.SECRETS_PROVIDER = 'azure';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(AzureKeyVaultProvider);
  });

  it('selects InMemorySecretsProvider when SECRETS_PROVIDER=in-memory', async () => {
    process.env.SECRETS_PROVIDER = 'in-memory';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(InMemorySecretsProvider);
  });

  it('falls back to env on unknown SECRETS_PROVIDER value (with WARN)', async () => {
    process.env.SECRETS_PROVIDER = 'martian';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBeInstanceOf(EnvSecretsProvider);
  });

  it('exposes SecretsService as a singleton', async () => {
    process.env.SECRETS_PROVIDER = 'env';
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot()],
    }).compile();
    const s1 = mod.get(SecretsService);
    const s2 = mod.get(SecretsService);
    expect(s1).toBeInstanceOf(SecretsService);
    expect(s1).toBe(s2);
  });

  it('honors providerOverride for tests', async () => {
    const override = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'test' });
    const mod = await Test.createTestingModule({
      imports: [SecretsModule.forRoot({ providerOverride: override })],
    }).compile();
    expect(mod.get(SECRETS_PROVIDER_INSTANCE)).toBe(override);
    const svc = mod.get(SecretsService);
    await expect(svc.getSecret('JWT_SECRET_KEY')).resolves.toBe('test');
  });

  // TASK-307 W2.1 follow-up — fixes the boot-ordering bug where
  // JwtStrategy.getSecretSync('JWT_SECRET_KEY') ran in the strategy
  // constructor against an empty cache because main.ts only called
  // `secretsService.boot({warmupKeys: [...]})` AFTER
  // `NestFactory.create(AppModule)` had already wired every provider.
  //
  // Fix: when `warmupKeys` is provided to SecretsModule.forRoot(), the
  // SecretsService provider is an async useFactory that awaits boot()
  // before becoming injectable. NestJS awaits async factories before
  // instantiating dependent providers, so any consumer (JwtStrategy,
  // GatewayJwtStrategy, AuthController, OPENID_CLIENT, etc.) reading
  // the cache via `getSecretSync` observes a warm cache.
  describe('warmupKeys → cache is warm before SecretsService is injectable', () => {
    it('populates the cache so getSecretSync returns the value immediately after compile()', async () => {
      const override = new InMemorySecretsProvider({
        JWT_SECRET_KEY: 'warmed-jwt-secret',
        SESSION_SECRET_KEY: 'warmed-session-secret',
      });
      const mod = await Test.createTestingModule({
        imports: [
          SecretsModule.forRoot({
            providerOverride: override,
            warmupKeys: ['JWT_SECRET_KEY', 'SESSION_SECRET_KEY'],
          }),
        ],
      }).compile();
      const svc = mod.get(SecretsService);
      expect(svc.getSecretSync('JWT_SECRET_KEY')).toBe('warmed-jwt-secret');
      expect(svc.getSecretSync('SESSION_SECRET_KEY')).toBe('warmed-session-secret');
    });

    it('tolerates a partial warmup miss (matches SecretsService.boot Promise.allSettled semantics)', async () => {
      const override = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'present' });
      const mod = await Test.createTestingModule({
        imports: [
          SecretsModule.forRoot({
            providerOverride: override,
            // ABSENT_KEY is not seeded; boot()'s Promise.allSettled
            // swallows the rejection and logs a WARN. The present key
            // must still land in the cache.
            warmupKeys: ['JWT_SECRET_KEY', 'ABSENT_KEY'],
          }),
        ],
      }).compile();
      const svc = mod.get(SecretsService);
      expect(svc.getSecretSync('JWT_SECRET_KEY')).toBe('present');
      expect(svc.getSecretSync('ABSENT_KEY')).toBeUndefined();
    });

    it('skips boot entirely when warmupKeys is unset (preserves existing test behaviour for Vault provider-type checks)', async () => {
      // If we always called boot(), Vault provider tests that only
      // check the provider type would unexpectedly perform AppRole
      // login against an unreachable Vault server. The opt-in via
      // `warmupKeys` keeps those tests working without modification.
      const override = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'value' });
      const mod = await Test.createTestingModule({
        imports: [SecretsModule.forRoot({ providerOverride: override })],
      }).compile();
      const svc = mod.get(SecretsService);
      // Without warmup, sync read misses (provider was never asked).
      expect(svc.getSecretSync('JWT_SECRET_KEY')).toBeUndefined();
      // Async read still works as before via cache miss → provider fetch.
      await expect(svc.getSecret('JWT_SECRET_KEY')).resolves.toBe('value');
    });
  });
});
