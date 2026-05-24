// Phase 2C Task 2.17 (TASK-302 Stream B) - SecretsModule factory test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
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
});
