/**
 * TestAppModule.
 *
 * Boots the real `AppModule` for the full-route walker without
 * actually contacting Redis / BullMQ workers / Vault / OIDC / Postgres.
 * The synthetic-module test in `auth-coverage.spec.ts` validates
 * the `APP_GUARD` contract; this module is the third leg that walks
 * the production route tree end-to-end.
 *
 * Why `Test.createTestingModule({ imports: [AppModule] }).compile()`
 * hangs in CI (and any environment without a live infra stack):
 *
 *   1. `BullModule.forRootAsync` reads `IConfigService.getRedisConfig()`
 *      and `BullModule.registerQueue` instantiates a `Queue` per name.
 *      Each Queue spawns an ioredis client with `lazyConnect: false`,
 *      which retries indefinitely against unreachable Redis.
 *   2. Every `@Processor()` class is collected by `BullExplorer` at
 *      `onModuleInit` and a `Worker` is created — each Worker is yet
 *      another ioredis client.
 *   3. `AuthServiceModule.OPENID_CLIENT` factory calls
 *      `Issuer.discover(OIDC_DISCOVERY_URL)`; on a misconfigured env
 *      the factory short-circuits, but a partially-set URL hangs on
 *      the network round-trip.
 *   4. `AppSettingsService.onModuleInit()` issues
 *      `globalSettingRepository.findAll()` (Prisma) which awaits the
 *      DB pool.
 *   5. `RedisCacheService.onModuleInit()` actively dials Redis and
 *      awaits a `ready` event with a 5 s timeout.
 *
 * ## Override surface (KEEP IN SYNC with `AppModule`'s imports list)
 *
 * `createTestAppBuilder()` applies `.overrideProvider(...)` for every
 * token below. If `AppModule` adds a NEW infrastructure import that
 * talks to an external service at boot time, you MUST add the
 * corresponding override here — otherwise the route walker either
 * hangs at `app.init()` or, worse, silently skips controllers whose
 * module failed to boot.
 *
 * - `'BULLMQ_EXTRA_OPTIONS'` → `{ manualRegistration: true }`
 *     Tells `@nestjs/bullmq`'s `BullRegistrar.onModuleInit()` to skip
 *     worker registration. No `Worker` instances are created → no
 *     ioredis clients spawned from `@Processor()` decorators.
 *
 * - `'BULLMQ_CONFIG(default)'` → dead lazy-connect config
 *     Replaces `RedisServiceModule.register(...)`'s
 *     `BullModule.forRootAsync` shared config. Falls back to lazy
 *     connection options so any Queue construction that slips through
 *     doesn't actively retry
 *     (`BullModule.forRoot({ connection: { host: 'localhost', port: 0 } })`).
 *
 * - `getQueueToken(JobQueue.X)` → stub Queue (every queue in
 *   `JobQueue`)
 *     Replaces every `BullModule.registerQueue` provider so
 *     `@InjectQueue` consumers see a `Queue`-shaped object that does
 *     nothing on `add()` but resolves at DI time.
 *
 * - `IRedisService` → `{ addJob: async () => undefined }`
 *     Replaces the only consumed method on the `RedisServiceModule`
 *     surface. Consumers like `BaseService.queueSysEvent` no-op.
 *
 * - `IRedisCacheService` → no-op
 *     Replaces `RedisCacheService` whose `onModuleInit` calls
 *     `connect()` → ioredis with `lazyConnect: false`. The stub has
 *     no init hooks → no Redis traffic.
 *
 * - `IAppSettingsService` → defaults-only stub
 *     Replaces `AppSettingsService` whose `onModuleInit` does
 *     `globalSettingRepository.findAll()` (Prisma). The stub returns
 *     the caller-supplied default for `getValueWithDefault`, the
 *     pattern most consumers use.
 *
 * - `'OPENID_CLIENT'` → `null`
 *     `AuthServiceModule`'s OIDC factory normally returns `null` when
 *     `OIDC_DISCOVERY_URL` is unset, but we hard-pin the override so a
 *     stray env var doesn't surface a partially-initialized client.
 *
 * - `SecretsService` → in-memory stub with synthetic JWT secret
 *     `JwtStrategy` refuses to boot if
 *     `SecretsService.getSecretSync('JWT_SECRET_KEY')` returns the
 *     literal placeholder. The stub returns a test-only secret so the
 *     strategy constructor passes — the secret is NEVER exposed via
 *     issued tokens because the route walker hits routes with NO
 *     Authorization header (every authenticated route → 401 before
 *     the secret would be used).
 *
 * - `IServiceHealthMonitoringService` → no-op
 *     The real implementation's `onModuleInit` calls
 *     `await new Redis({ retryStrategy: () => 100..3000 }).connect()`
 *     which retries forever when Redis is unreachable — `compile()`
 *     never returns. Override removes the `OnModuleInit` hook so the
 *     test boot completes deterministically.
 *
 * - `'CORE_DATABASE_SERVICE'` → no-op
 *     `CoreDatabaseService.onModuleInit()` calls `prisma.$connect()`
 *     against the configured `DATABASE_URL` (port 5433 in `.env.test`).
 *     When the test database isn't running the connect blocks until
 *     Prisma's default `connect_timeout` (which can be tens of seconds
 *     in some adapter configurations). The stub provides only the
 *     `client`/`baseClient` getter shape that repositories touch at
 *     module load — the route walker never executes a query because
 *     every authenticated route 401s before the handler runs.
 *
 * ## Failure mode if drift is undetected
 *
 * If you add a new `imports` entry to `AppModule` that introduces its
 * own `OnModuleInit` doing live I/O AND you don't add an override
 * here, the route walker either hangs at `app.init()` or fails partway
 * through with a confusing error. The `test-app-module.spec.ts` sanity
 * test asserts boot completes in <5 s — that's the CI guard against
 * this fragility.
 */

import { Module, type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConnectionOptions } from 'bullmq';

import { IAppSettingsService, IRedisCacheService, IRedisService, IServiceHealthMonitoringService, SecretsService } from '@arcaai/applications';
import { JobQueue } from '@arcaai/domains';
import { AppModule } from '../../src/app.module';

// Side-effect import — applies @Public() to third-party controllers
// (Prometheus, etc.). Matches `apps/api/src/main.ts` and the
// `auth-coverage.spec.ts` static walker so the runtime walker sees the
// same surface.
import '../../src/bootstrap/third-party-public-routes';

/**
 * Thin re-export of `AppModule`. The override surface is applied via
 * `createTestAppBuilder()` because NestJS lacks an `overrideModule`
 * API — provider overrides are the only knob for replacing
 * sub-module DI without rebuilding the entire module graph.
 */
@Module({ imports: [AppModule] })
export class TestAppModule {}

/**
 * Dead lazy-connect connection options. ioredis won't actively dial
 * because `lazyConnect: true`; if some Queue/Worker that slipped
 * through tries to connect anyway, `retryStrategy: () => null` halts
 * the reconnect loop after the first ECONNREFUSED, keeping the test
 * output free of retry spam.
 */
const DEAD_CONNECTION: ConnectionOptions = {
  host: 'localhost',
  port: 0,
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
};

function createStubQueue(name: string): Record<string, unknown> {
  return {
    name,
    opts: { connection: DEAD_CONNECTION },
    add: async () => undefined,
    addBulk: async () => [],
    close: async () => undefined,
    waitUntilReady: async () => undefined,
    getJobCounts: async () => ({}),
    getJob: async () => null,
    removeJob: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    obliterate: async () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
}

const STUB_REDIS_SERVICE = {
  addJob: async () => undefined,
};

const STUB_REDIS_CACHE_SERVICE = {
  get: async () => null,
  set: async () => undefined,
  setex: async () => undefined,
  del: async () => undefined,
  delMany: async () => undefined,
  keys: async () => [],
  scan: async () => [],
  exists: async () => false,
  publish: async () => undefined,
  lpush: async () => 0,
  rpush: async () => 0,
  hset: async () => undefined,
  incr: async () => 0,
  expire: async () => false,
  isConnected: () => false,
};

/**
 * Synthetic secret material — never used to sign / verify production
 * tokens. The full-route walker hits routes without an Authorization
 * header so the secret is read only by `JwtStrategy`'s constructor
 * gate and never reaches a signing / verification call.
 */
const TEST_ONLY_JWT_SECRET = 'task-309-test-app-module-jwt-secret-not-for-production';
const TEST_ONLY_API_KEY_PEPPER = 'task-309-test-app-module-api-key-pepper-not-for-production';
const TEST_ONLY_TEXT_SERVICE_TOKEN = 'task-309-test-app-module-text-token-not-for-production';

const SYNTHETIC_SECRETS: Record<string, string> = {
  JWT_SECRET_KEY: TEST_ONLY_JWT_SECRET,
  API_KEY_PEPPER: TEST_ONLY_API_KEY_PEPPER,
  TEXT_SERVICE_TOKEN: TEST_ONLY_TEXT_SERVICE_TOKEN,
  OIDC_CLIENT_SECRET: 'task-309-test-oidc-client-secret-not-for-production',
};

const STUB_SECRETS_SERVICE = {
  getSecret: async (key: string) => SYNTHETIC_SECRETS[key] ?? '',
  getSecretSync: (key: string): string | undefined => SYNTHETIC_SECRETS[key],
  getSecretOptional: async (key: string) => SYNTHETIC_SECRETS[key],
  getSecretJson: async () => ({}),
  getSecrets: async (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      if (SYNTHETIC_SECRETS[k] !== undefined) out[k] = SYNTHETIC_SECRETS[k];
    }
    return out;
  },
  boot: async () => undefined,
  invalidate: () => undefined,
  invalidateAll: () => undefined,
  attachRedisSubscriber: () => undefined,
  setLeaseRenewer: () => undefined,
  clearLeaseRenewer: () => undefined,
  health: async () => ({ ok: true, provider: 'in-memory', degraded: false }),
  encrypt: async () => {
    throw new Error('SecretsService.encrypt() not available in TestAppModule stub');
  },
  decrypt: async () => {
    throw new Error('SecretsService.decrypt() not available in TestAppModule stub');
  },
  requestDbCredential: async () => {
    throw new Error('SecretsService.requestDbCredential() not available in TestAppModule stub');
  },
};

const STUB_SERVICE_HEALTH_MONITORING_SERVICE = {
  getUptime: async () => ({ services: [], allHealthy: true }),
  getServiceUptime: async () => null,
  getHeartbeatHistory: async () => [],
  getSessionCounts: async () => ({ services: [], totalActive: 0 }),
};

/**
 * Stub PrismaClient — repositories touch it at module load to copy
 * the model-delegate handle (e.g. `this.user = this.prisma.user`).
 * The walker never executes a real query (every authed route 401s
 * before the handler), but the property access must not throw, so
 * the stub is a `Proxy` that returns no-op no-args methods for every
 * key the repository code reaches for.
 */
const PRISMA_NOOP_CLIENT = new Proxy(
  {},
  {
    get: () => {
      return new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error('TestAppModule PrismaClient stub: query attempted but no DB available');
          },
        },
      );
    },
  },
);

const STUB_CORE_DATABASE_SERVICE = {
  client: PRISMA_NOOP_CLIENT,
  baseClient: PRISMA_NOOP_CLIENT,
  query: async () => {
    throw new Error('TestAppModule CoreDatabaseService stub: query attempted but no DB available');
  },
  queryRaw: async () => {
    throw new Error('TestAppModule CoreDatabaseService stub: queryRaw attempted but no DB available');
  },
};

const STUB_APP_SETTINGS_SERVICE = {
  getFromCache: () => undefined,
  getValueFromCache: () => null,
  getValueWithDefault: <T>(_key: string, defaultValue: T): T => defaultValue,
  hasSetting: () => false,
  getAllKeys: () => [],
  getCacheStats: () => ({
    lastRefresh: new Date(0),
    refreshCount: 0,
    errorCount: 0,
    settingsCount: 0,
    isInitialized: true,
  }),
  cacheAppSettings: async () => undefined,
  updateCacheAppSettings: () => undefined,
  refreshCache: async () => undefined,
  stopCacheRefresh: () => undefined,
  validateSettingValue: () => true,
};

/**
 * Build a NestJS testing harness around `TestAppModule` with every
 * override from the surface documented above applied. Callers receive
 * a fluent `TestingModuleBuilder` and are responsible for
 * `.compile()` / `createNestApplication()` / `init()` so additional
 * test-specific overrides can compose on top.
 */
export function createTestAppBuilder(): TestingModuleBuilder {
  let builder = Test.createTestingModule({
    imports: [TestAppModule],
  })
    // @nestjs/bullmq: skip worker + queue-event registration so no
    // `@Processor()` class wires up a BullMQ Worker (each Worker
    // creates an ioredis client at construction).
    .overrideProvider('BULLMQ_EXTRA_OPTIONS')
    .useValue({ manualRegistration: true })
    // @nestjs/bullmq shared default config. Replaces the result of
    // `RedisServiceModule.register(...)`'s `BullModule.forRootAsync`
    // useFactory — so the factory's `IConfigService` dependency is
    // never injected and `RedisConfigurationException` is never thrown.
    .overrideProvider('BULLMQ_CONFIG(default)')
    .useValue({ connection: DEAD_CONNECTION })
    .overrideProvider(IRedisService)
    .useValue(STUB_REDIS_SERVICE)
    .overrideProvider(IRedisCacheService)
    .useValue(STUB_REDIS_CACHE_SERVICE)
    .overrideProvider(IAppSettingsService)
    .useValue(STUB_APP_SETTINGS_SERVICE)
    .overrideProvider('OPENID_CLIENT')
    .useValue(null)
    .overrideProvider(SecretsService)
    .useValue(STUB_SECRETS_SERVICE)
    .overrideProvider(IServiceHealthMonitoringService)
    .useValue(STUB_SERVICE_HEALTH_MONITORING_SERVICE)
    .overrideProvider('CORE_DATABASE_SERVICE')
    .useValue(STUB_CORE_DATABASE_SERVICE);

  for (const queueName of Object.values(JobQueue)) {
    builder = builder.overrideProvider(getQueueToken(queueName)).useValue(createStubQueue(queueName));
  }

  return builder;
}

/**
 * Convenience helper: builds, compiles, and inits the harness with no
 * extra logger output. Returns the live `INestApplication`.
 *
 * Boot is expected to complete in under 5 s — the
 * `test-app-module.spec.ts` sanity test pins this contract.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await createTestAppBuilder().compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}
