import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { SecretsService, SECRETS_SERVICE_OPTIONS } from './SecretsService';
import { SecretsHealthIndicator } from './secrets.health';
import {
  ISecretsProvider,
  SECRETS_PROVIDER_TOKEN,
  SecretsProviderName,
} from './ISecretsProvider';
import { EnvSecretsProvider } from './providers/env-secrets.provider';
import { VaultSecretsProvider } from './providers/vault-secrets.provider';
import { AwsSecretsManagerProvider } from './providers/aws-secrets-manager.provider';
import { AzureKeyVaultProvider } from './providers/azure-keyvault.provider';
import { InMemorySecretsProvider } from './providers/in-memory-secrets.provider';

/**
 * Token under which the concrete ISecretsProvider instance is registered.
 * Exposed alongside SECRETS_PROVIDER_TOKEN so callers that want the raw
 * provider (e.g. Phase 4's envelope helper that needs encrypt/decrypt)
 * can inject it without relying on the more permissive interface token.
 */
export const SECRETS_PROVIDER_INSTANCE = Symbol.for('SECRETS_PROVIDER_INSTANCE');

export interface SecretsModuleOptions {
  /** Override the env-derived provider; useful for tests. */
  providerOverride?: ISecretsProvider;
  /** Default cache TTL in seconds (forwarded to SecretsService). */
  defaultTtlSec?: number;
  /** LRU max entries. */
  lruMax?: number;
}

const VALID_NAMES: ReadonlyArray<SecretsProviderName> = [
  'env',
  'vault',
  'aws',
  'azure',
  'in-memory',
];

function pickProviderName(logger: Logger): SecretsProviderName {
  const raw = (process.env.SECRETS_PROVIDER ?? '').toLowerCase().trim();
  if (raw === '') return 'env';
  if ((VALID_NAMES as readonly string[]).includes(raw)) {
    return raw as SecretsProviderName;
  }
  logger.warn(
    `SECRETS_PROVIDER='${raw}' is not recognised. Falling back to 'env'. Valid: ${VALID_NAMES.join(', ')}`,
  );
  return 'env';
}

function requireEnv(envKey: string): string {
  const v = process.env[envKey];
  if (!v) {
    throw new Error(
      `SecretsModule: ${envKey} is required when SECRETS_PROVIDER=vault`,
    );
  }
  return v;
}

function createProvider(name: SecretsProviderName): ISecretsProvider {
  switch (name) {
    case 'vault':
      return new VaultSecretsProvider({
        addr: requireEnv('VAULT_ADDR'),
        roleId: requireEnv('VAULT_ROLE_ID'),
        wrappedSecretId: process.env.VAULT_WRAPPED_SECRET_ID,
        secretId: process.env.VAULT_SECRET_ID,
        namespace: process.env.VAULT_NAMESPACE,
        kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
        kvPrefix: process.env.VAULT_KV_PREFIX ?? 'hope',
        transitMount: process.env.VAULT_TRANSIT_MOUNT ?? 'transit',
        transitKey: process.env.VAULT_TRANSIT_KEY ?? 'hope-globalsetting',
        requestTimeoutMs: Number(process.env.VAULT_REQUEST_TIMEOUT_MS ?? 5000),
      });
    case 'aws':
      return new AwsSecretsManagerProvider();
    case 'azure':
      return new AzureKeyVaultProvider();
    case 'in-memory':
      return new InMemorySecretsProvider();
    default:
      return new EnvSecretsProvider();
  }
}

/**
 * SecretsModule (TASK-302 Stream B). `@Global()` so consumers across the
 * monorepo can inject SecretsService without re-importing.
 *
 * forRoot() selects the provider at module-instantiation time based on:
 *   - explicit options.providerOverride (used by tests), else
 *   - SECRETS_PROVIDER env var (one of env / vault / aws / azure / in-memory)
 *
 * The SECRETS_SERVICE_OPTIONS token is also bound so SecretsService can
 * inject its defaultTtlSec/lruMax without an explicit constructor arg.
 */
@Global()
@Module({})
export class SecretsModule {
  static forRoot(options: SecretsModuleOptions = {}): DynamicModule {
    return {
      module: SecretsModule,
      // TerminusModule exposes the HealthIndicator base class machinery
      // SecretsHealthIndicator relies on.
      imports: [TerminusModule],
      providers: [
        {
          provide: SECRETS_SERVICE_OPTIONS,
          useValue: {
            defaultTtlSec: options.defaultTtlSec,
            lruMax: options.lruMax,
          },
        },
        {
          provide: SECRETS_PROVIDER_INSTANCE,
          useFactory: () => {
            if (options.providerOverride) return options.providerOverride;
            const logger = new Logger(SecretsModule.name);
            return createProvider(pickProviderName(logger));
          },
        },
        {
          provide: SECRETS_PROVIDER_TOKEN,
          useExisting: SECRETS_PROVIDER_INSTANCE,
        },
        SecretsService,
        SecretsHealthIndicator,
      ],
      exports: [
        SECRETS_PROVIDER_INSTANCE,
        SECRETS_PROVIDER_TOKEN,
        SecretsService,
        SecretsHealthIndicator,
      ],
    };
  }
}
