# Redis Services — BullMQ job queue and a general-purpose cache

Two independent, separately-registered Redis modules under `@arcaai/applications`: `RedisServiceModule`
(BullMQ job queues, injectable as `IRedisService`) and `RedisCacheModule` (a plain get/set/del cache,
injectable as `IRedisCacheService`). Both read connection config from `IConfigService`.

## Layout

| Path | What it holds |
|---|---|
| `IRedisService.ts` | `IRedisService.addJob<T>({ queueName, jobType, data, options })` — the BullMQ job-enqueue surface |
| `redis.service.ts` / `redis.service.module.ts` | `RedisServiceModule.register(queueNames: string[])` — registers a `BullModule` queue per name and wires the connection |
| `redis-cache.service.ts` / `redis-cache.module.ts` | `IRedisCacheService` (`get`/`set`/`setex`/`del`, multi-key variants) — `RedisCacheModule.register()`, `@Global()` |
| `redis-config.exception.ts` | `RedisConfigurationException` — thrown when Redis config is missing/invalid |

## How it works

### Job queue (`RedisServiceModule`)

`RedisServiceModule.register(queueNames)` registers a `BullModule.registerQueue({ name })` per queue
and configures `BullModule.forRootAsync` from `IConfigService`. It throws `RedisConfigurationException`
via `configService.isRedisConfigured()` before attempting a connection if `REDIS_HOST`/`REDIS_PORT`
are missing or invalid (port must be 1-65535). Default job options: 3 attempts, exponential backoff
(1000ms initial delay), keep 100 completed / 200 failed jobs.

```typescript
import { RedisServiceModule } from '@arcaai/applications';
import { JobQueue } from '@arcaai/domains';

@Module({
  imports: [RedisServiceModule.register([JobQueue.AuditLog, JobQueue.SendEmail])],
})
export class AppModule {}
```

### Cache (`RedisCacheModule`)

`RedisCacheModule.register()` is `@Global()` and independent of the BullMQ connection above — it
exists so caching operations don't compete with, or get torn down alongside, job-queue Redis state.
Inject `IRedisCacheService` for `get`/`set`/`setex`/`del` and multi-key variants.

### Configuration

Job-queue connection settings come from `IConfigService`, not read directly from `process.env` in
this module: `REDIS_HOST` (default `localhost`), `REDIS_PORT` (default `6379`), `REDIS_PASS`
(optional). The cache connection is independent: `RedisCacheModule.registerAsync({ useFactory })`
supplies `{ host, port, password? }` via the `REDIS_CACHE_CONFIG` DI token instead of reading env
directly, so a consumer can source it from `IConfigService`, Vault, or elsewhere.

## Related

- [`_meta` README](../_meta/README.md) — `ConfigService` / `IConfigService`
- [`@arcaai/applications` README](../../../../README.md) — `SysEventService` and other BullMQ consumers
