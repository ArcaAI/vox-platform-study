# Framework packages (`@nestjs/*` and `nestjs-cls`)

**Audience:** new to NestJS.
**Scope:** only the packages that appear in `main.ts`, `app.module.ts`, or are directly reached from them. Versions are from `apps/api/package.json`.

Three groups:

1. **Core** — installed by every Nest app.
2. **Official integrations** — made by the Nest team, but you install them only if needed.
3. **Community** — `nestjs-cls` is not made by the Nest team.

---

## 1. Core packages

### `@nestjs/common` — v11.2.3

The toolbox of decorators, exceptions, pipes, and types.

| What you import | What it is | Where it is used |
|---|---|---|
| `Module`, `Global` | decorators that define a module | `app.module.ts` |
| `LogLevel` | TypeScript type for logger levels (`'error'`, `'warn'`, `'log'`, …) | `main.ts:getLogLevels` |
| `CanActivate` | interface a guard implements | all guards |
| `NestInterceptor` | interface an interceptor implements | all interceptors |
| `ExceptionFilter`, `Catch`, `HttpException` | exception handling | `src/filters/` |
| `ValidationPipe` | validates DTOs | via `createGlobalValidationPipe` |

The two files in this document import only `Module`, `Global`, and `LogLevel` directly. The rest are used by the guards, interceptors, and filters they register.

### `@nestjs/core` — v11.2.3

The engine: dependency injection, the application container, and the global hook tokens.

| What you import | What it is | Where |
|---|---|---|
| `NestFactory` | creates the app from the root module | `main.ts:116` |
| `APP_GUARD` | token that registers a guard globally **with DI** | `app.module.ts` |
| `APP_INTERCEPTOR` | same for interceptors | `app.module.ts` |
| `APP_FILTER` | same for exception filters | `app.module.ts` |

`NestFactory.create(AppModule)` is the line that actually builds every object graph. Until it returns, no controller exists.

### `@nestjs/platform-express` — v11.2.3

The default HTTP adapter. It wraps **Express 5** and is what makes `app.use(...)`, `req`, `res`, and `next` work.

It is not imported directly in `main.ts`, but it is the reason this code is valid:

```ts
app.use(httpResponseMetricsMiddleware()); // Express middleware
app.getHttpAdapter().getInstance().set('etag', false); // the Express instance
```

If a tutorial says "NestJS uses Express under the hood", this is the package.

---

## 2. Official integrations

These are published by the Nest team but are **not** part of the core install. Each solves one problem.

### `@nestjs/platform-ws` — v11.2.3

Adapter for raw WebSockets using the `ws` library (not Socket.IO).

- **Used at:** `main.ts:153` — `app.useWebSocketAdapter(new WsAdapter(app))`.
- **Why:** the gateway serves live STT transcription and workflow streams. Raw `ws` is lighter and speaks the protocol the Python clients expect; Socket.IO would add its own handshake and framing.

### `@nestjs/swagger` — v11.4.7

Generates an OpenAPI 3 document from decorators and serves Swagger UI.

- **Used at:** `main.ts:164` — `SwaggerModule.setup('api/v1/docs', app, createHopeOpenApiDocument(app))`.
- **Why:** `/api/v1/docs` is the interactive API reference in non-production. The same builder also produces the committed `openapi.json`.
- **Beginner note:** the decorators (`@ApiProperty`, `@ApiTags`) are in the controllers/DTOs, not in `main.ts`.

### `@nestjs/config` — v4.0.4

Normally provides `.env` loading and a `ConfigService`.

- **Important:** this repo does **not** use it in `main.ts`/`app.module.ts`.
- The `ConfigModule` imported in `app.module.ts` comes from `@arcaai/applications`, not from `@nestjs/config`. It is a **custom wrapper** that loads config through the project's own `loadEnv()`.
- Why the project replaced it: one env-loading implementation shared by the API, Prisma CLI, and tests, with `NODE_ENV`-based file selection and host-env precedence.

The package is still a dependency because other parts of the workspace may use it, but do not assume `ConfigModule` means the Nest one.

### `@nestjs/schedule` — v6.1.3

Cron jobs, intervals, and timeouts (`@Cron`, `@Interval`, `@Timeout`), backed by the `cron` package.

- **Used at:** `app.module.ts` — `ScheduleModule.forRoot()`.
- **Used by:** background services such as audit retention, tenant storage purge, consultation timeout sweep, STT job reaper.
- **Why:** these jobs live in-process with the gateway, so they can reuse the same DI graph and repositories.

### `@nestjs/event-emitter` — v3.1.0

In-process publish/subscribe (`EventEmitter2` under the hood).

- **Used at:** `app.module.ts` — `EventEmitterModule.forRoot()`.
- **Why:** audit logging, notifications, and domain events are emitted inside the same process. No Kafka/broker is required for these.

### `@nestjs/throttler` — v6.5.0

Rate limiting.

- **Used via:** `apps/api/src/modules/throttle/` (the `ThrottleConfigModule` imported in `app.module.ts`).
- **Why:** four named tiers — `default` (100 req/60s), `strict` (10), `heavy` (20), `relaxed` (300). Only `default` applies everywhere; the rest are opt-in per route.
- **Where the guard comes from:** `TieredThrottlerGuard` extends this package's guard and adds tenant/API-key-aware limits.

### `@nestjs/terminus` — v11.1.1

Health-check primitives (`HealthCheckService`, `HttpHealthIndicator`, …).

- **Used via:** `src/modules/health/`.
- **Why:** `/api/v1/health` and `/api/v1/admin/health/services` need a standard shape for liveness/readiness and downstream service checks.

### `@nestjs/jwt` — v11.0.2 and `@nestjs/passport` — v11.0.5

JWT signing/verification and Passport strategy integration.

- **Not used in `main.ts`.** Reached through `@arcaai/applications` authorization code (`JwtAuthGuard`, `JwtStrategy`).
- **Why:** the gateway supports JWT, API keys, and service accounts. These two packages cover the JWT branch.

### `@nestjs/bullmq` — v11.0.5 and `bullmq` — v6.3.4

Redis-backed job queues.

- **Not used in `main.ts`.** Reached through service modules and `RedisServiceModule.register(JobQueue values)`.
- **Why:** transcription batches, model downloads, checkpoint export/restore, usage-ledger draining, and other asynchronous work.

### `@nestjs/axios` — v4.0.1

Nest wrapper around Axios (`HttpService`).

- **Not used in `main.ts`.** Used by gateway proxies and AI inference clients.
- **Why:** consistent HTTP client with DI and testing support when calling Python services.

---

## 3. Community package

### `nestjs-cls` — v6.3.0

Request-scoped storage built on Node's `AsyncLocalStorage`.

- **Used at:** `app.module.ts` — `ClsModule.forRoot(CLS_MODULE_OPTIONS)` and `ClsGuard`.
- **Why:** it stores the per-request context (request id, tenant id, user id) so deeply nested services can read it **without passing it through every function argument**.
- **Beginner note:** this is not a Nest core feature. It is a well-known community package. The project's `CLS_MODULE_OPTIONS` lives in `src/request-id.ts`.
- **Why it matters for security:** tenant isolation and audit logging depend on this context being correct.

---

## 4. Quick decision table

| Package | Core / official / community | Used in these two files? | One-line purpose |
|---|---|---|---|
| `@nestjs/common` | core | ✅ | decorators, exceptions, pipes |
| `@nestjs/core` | core | ✅ | DI container, `NestFactory`, `APP_*` tokens |
| `@nestjs/platform-express` | core | indirectly | Express HTTP adapter |
| `@nestjs/platform-ws` | official | ✅ | raw WebSocket adapter |
| `@nestjs/swagger` | official | ✅ | OpenAPI + Swagger UI |
| `@nestjs/config` | official | ❌ (custom `ConfigModule` instead) | env/config |
| `@nestjs/schedule` | official | ✅ | cron/interval jobs |
| `@nestjs/event-emitter` | official | ✅ | in-process events |
| `@nestjs/throttler` | official | via `modules/throttle` | rate limiting |
| `@nestjs/terminus` | official | via `modules/health` | health checks |
| `@nestjs/jwt` / `@nestjs/passport` | official | ❌ (inside `@arcaai/applications`) | JWT auth |
| `@nestjs/bullmq` / `bullmq` | official / library | ❌ (inside service modules) | Redis job queues |
| `@nestjs/axios` | official | ❌ | HTTP client |
| `nestjs-cls` | community | ✅ | per-request context storage |

Next: [03-third-party-libraries.md](./03-third-party-libraries.md).
