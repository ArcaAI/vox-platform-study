import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { readFileSync } from 'node:fs';
import { setPhiReadSecrets } from '@arcaai/domains';
import { SecretsService, SECRETS_SERVICE_OPTIONS } from './SecretsService';
import { SecretsHealthIndicator } from './secrets.health';
import { SecretsInvalidationSubscriber } from './secrets-invalidation.subscriber';
import { RedisSubscriberService } from '../../../stt/realtime/redisSubscriber.service';
import { ISecretsProvider, SECRETS_PROVIDER_TOKEN, SecretsProviderName } from './ISecretsProvider';
import { EnvSecretsProvider } from './providers/env-secrets.provider';
import { VaultSecretsProvider } from './providers/vault-secrets.provider';
import { AwsSecretsManagerProvider } from './providers/aws-secrets-manager.provider';
import { AzureKeyVaultProvider } from './providers/azure-keyvault.provider';
import { InMemorySecretsProvider } from './providers/in-memory-secrets.provider';

/**
 * Token under which the concrete ISecretsProvider instance is registered.
 * Exposed alongside SECRETS_PROVIDER_TOKEN so callers that want the raw
 * provider (e.g. an envelope helper that needs encrypt/decrypt)
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
  /**
   * Re-warm cadence (seconds) for the warmup set, forwarded to SecretsService.
   * Unset/<=0 derives `max(30, floor(defaultTtlSec / 2))`.
   */
  reWarmIntervalSec?: number;
  /**
   * Keys to warm during DI construction. When non-empty, the
   * `SecretsService` provider becomes an async useFactory that
   * `await`s `SecretsService.boot({warmupKeys})` BEFORE the service
   * is injectable. NestJS awaits async factories before instantiating
   * dependent providers, so consumers that read the cache
   * synchronously in their constructor (e.g. `JwtStrategy`,
   * the `OPENID_CLIENT` factory) observe a
   * warm cache — closes the boot-order gap left by the previous
   * design where `secretsService.boot()` ran in `main.ts` AFTER
   * `NestFactory.create(AppModule)` had already wired the strategy.
   *
   * Unset / empty → no boot is performed (preserves the
   * provider-type-only tests that don't have a live Vault).
   */
  warmupKeys?: string[];
}

const VALID_NAMES: ReadonlyArray<SecretsProviderName> = ['env', 'vault', 'aws', 'azure', 'in-memory'];

function pickProviderName(logger: Logger): SecretsProviderName {
  const raw = (process.env.SECRETS_PROVIDER ?? '').toLowerCase().trim();
  if (raw === '') return 'env';
  if ((VALID_NAMES as readonly string[]).includes(raw)) {
    return raw as SecretsProviderName;
  }
  logger.warn(`SECRETS_PROVIDER='${raw}' is not recognised. Falling back to 'env'. Valid: ${VALID_NAMES.join(', ')}`);
  return 'env';
}

function requireEnv(envKey: string): string {
  const v = process.env[envKey];
  if (!v) {
    throw new Error(`SecretsModule: ${envKey} is required when SECRETS_PROVIDER=vault`);
  }
  return v;
}

/**
 * Resolve a value from `${envKey}` OR, if that is unset/empty,
 * from the file named by `${envKey}_FILE`. The file form is how production
 * (systemd-creds / k8s Secret mounts) delivers AppRole credentials without
 * inlining secret material in `.env.production`. The file is read once at
 * module boot; a trailing newline (common in mounted secrets) is trimmed.
 */
function readEnvOrFile(envKey: string): string | undefined {
  const direct = process.env[envKey];
  if (direct !== undefined && direct !== '') return direct;
  const filePath = process.env[`${envKey}_FILE`];
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`SecretsModule: ${envKey}_FILE=${filePath} could not be read: ${(err as Error).message}`);
    }
  }
  return undefined;
}

function requireEnvOrFile(envKey: string): string {
  const v = readEnvOrFile(envKey);
  if (!v) {
    throw new Error(`SecretsModule: ${envKey} (or ${envKey}_FILE) is required when SECRETS_PROVIDER=vault`);
  }
  return v;
}

function createProvider(name: SecretsProviderName): ISecretsProvider {
  switch (name) {
    case 'vault':
      return new VaultSecretsProvider({
        addr: requireEnv('VAULT_ADDR'),
        roleId: requireEnvOrFile('VAULT_ROLE_ID'),
        wrappedSecretId: readEnvOrFile('VAULT_WRAPPED_SECRET_ID'),
        secretId: readEnvOrFile('VAULT_SECRET_ID'),
        namespace: process.env.VAULT_NAMESPACE,
        kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
        kvPrefix: process.env.VAULT_KV_PREFIX ?? 'hope',
        transitMount: process.env.VAULT_TRANSIT_MOUNT ?? 'transit',
        transitKey: process.env.VAULT_TRANSIT_KEY ?? 'hope-globalsetting',
        // Dedicated PHI Transit key.
        // Defaults to 'hope-phi' so clinical field encryption works even if
        // VAULT_TRANSIT_KEY_PHI is never set (env files are owned elsewhere).
        transitKeyPhi: process.env.VAULT_TRANSIT_KEY_PHI ?? 'hope-phi',
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
 * SecretsModule. `@Global()` so consumers across the
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
            reWarmIntervalSec: options.reWarmIntervalSec,
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
        {
          provide: SecretsService,
          useFactory: async (
            provider: ISecretsProvider,
            svcOptions: { defaultTtlSec?: number; lruMax?: number; reWarmIntervalSec?: number },
          ): Promise<SecretsService> => {
            const svc = new SecretsService(provider, svcOptions);
            // Boot only when the caller actually asked for warmup. For
            // Vault provider in production, the warmup list also drives
            // the AppRole login (provider.boot()). For test modules that
            // just check provider wiring, skipping boot keeps them from
            // dialling a non-existent Vault.
            if (options.warmupKeys && options.warmupKeys.length > 0) {
              await svc.boot({ warmupKeys: options.warmupKeys });
            }
            // Activate repository decrypt-on-read for the
            // dropped plaintext PHI columns. Gated on the provider actually
            // being transit-capable (only the Vault provider implements
            // `decrypt`); env/in-memory/aws/azure leave it unwired so reads
            // stay a zero-overhead no-op and need no Vault. Process-wide, set
            // once per process when SecretsService is constructed (it is a
            // @Global singleton, instantiated before any request-time read).
            if (typeof (provider as unknown as { decrypt?: unknown }).decrypt === 'function') {
              setPhiReadSecrets(svc);
            }
            return svc;
          },
          inject: [SECRETS_PROVIDER_TOKEN, SECRETS_SERVICE_OPTIONS],
        },
        SecretsHealthIndicator,
        // TASK-944 — the LISTENING end of `arca:secrets:invalidate`.
        //
        // The channel had publishers (`SettingsRegistryWriteService`, the rotation
        // worker, the scheduled-rotation processor) and a consumer method on
        // `SecretsService`, but nothing ever called that method: `PUBSUB NUMSUB` on the
        // live cluster reported 0 subscribers, so a rotation only ever propagated on
        // the TTL re-warm while the operator runbook said otherwise.
        //
        // A DEDICATED `RedisSubscriberService` instance, exactly as
        // `AppSettingsModule` does for `app-settings:invalidate`: Redis forbids other
        // commands on a connection in SUBSCRIBE mode, so a subscriber cannot be shared
        // with the cache client. It reads its connection from the @Global ConfigModule
        // and disables itself (logging why) when Redis is not configured, which is what
        // keeps this module bootable in the provider-type-only tests.
        RedisSubscriberService,
        SecretsInvalidationSubscriber,
      ],
      exports: [SECRETS_PROVIDER_INSTANCE, SECRETS_PROVIDER_TOKEN, SecretsService, SecretsHealthIndicator],
    };
  }
}
