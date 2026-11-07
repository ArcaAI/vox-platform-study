# Third-party libraries (not Nest, not this project)

**Audience:** new to NestJS.
**Scope:** libraries imported directly or indirectly by `main.ts` / `app.module.ts`, plus a few you will meet immediately after.

These are ordinary npm packages. Nest does not provide them; the project chose them.

---

## 1. Used directly in `main.ts`

### `express-session` — v1.19.0

Express middleware that gives each browser a signed session cookie.

```ts
import session = require('express-session'); // CommonJS interop, see the comment at main.ts:37
```

- **Used at:** `main.ts:187`.
- **Why:** the gateway stores a small amount of server-side session state and issues an `HttpOnly` cookie in production (`secure: true`).
- **Where the secret comes from:** `SecretsService.getSecret('SESSION_SECRET_KEY')`, **not** an env var read directly. That is why the line is `await`ed before `app.use(session(...))`.
- **Beginner note:** `import session = require('express-session')` is TypeScript's syntax for importing a CommonJS module. It is not an ESM default import. The code comment explains this.

### `uuidv7` — v1.2.1

Generates UUID version 7: a UUID whose first bits are a timestamp, so values sort by creation time.

- **Used at:** `src/request-id.ts`, imported into `app.module.ts` through `CLS_MODULE_OPTIONS`.
- **Why:** the request id must be unique **and** roughly chronological so logs and traces can be ordered cheaply.
- **Contract:** one id per request. An inbound `x-request-id` is reused only if it is a safe token; otherwise a fresh uuidv7 is minted. That same value becomes `X-Request-Id`, the error body's `correlationId`, and the id forwarded on internal hops.

### `dotenv` — via `@arcaai/applications`

Not imported in `main.ts` directly. It is the engine behind `loadEnv()`.

- **Why:** reads `.env.<environment>` into `process.env`.
- **Project rule:** host environment wins; the file never overwrites an existing variable. No file is read when `CI=true` or `NODE_ENV=production`.

### `zod` — v4.5.4

Runtime schema validation for JavaScript/TypeScript values.

- **Used at:** `src/config/env.schema.ts` + `env.descriptors.ts`, called by `apiEnv()` in `main.ts:82`.
- **Why:** TypeScript types disappear at runtime. `zod` checks the actual env values at boot and reports every problem in one error instead of failing later with `undefined`.
- **Beginner note:** this is the difference between "the compiler thinks `PORT` is a number" and "the process refuses to start because `PORT` is the string `'abc'`".

---

## 2. Used directly in observability (`instrumentation.ts`)

These make the gateway emit traces, logs, and metrics.

| Package | Purpose |
|---|---|
| `@opentelemetry/api` | the global API used to create spans and read the active trace |
| `@opentelemetry/sdk-node` | the Node.js SDK that starts tracing |
| `@opentelemetry/auto-instrumentations-node` | automatic spans for HTTP, Express, `pg`, Redis, etc. |
| `@opentelemetry/exporter-trace-otlp-grpc` | ships spans to an OTLP collector over gRPC |
| `@opentelemetry/exporter-logs-otlp-grpc` | ships logs to the same collector |
| `@opentelemetry/sdk-logs` | log pipeline (`BatchLogRecordProcessor`) |
| `@opentelemetry/resources` | describes the service (`service.name`, version) |
| `@opentelemetry/semantic-conventions` | standard attribute names (`ATTR_SERVICE_NAME`, …) |
| `@prisma/instrumentation` | adds spans around Prisma queries |

- **Loaded how:** `node --import ./dist/instrumentation.js dist/main.js`. It must run **before** the app so it can patch libraries as they load.
- **Why the split:** `instrumentation.ts` starts the SDK as an import side effect, which makes it untestable. `instrumentation.flags.ts` is pure (`env in → decision out`) and is what the tests check.
- **PHI rule:** production refuses to boot unless GenAI content capture is OFF (`assertGenaiContentCaptureDisabled`), so prompts/responses are not exported as telemetry.

---

## 3. Used indirectly, but you will see them immediately

### `express` — 5.2.1 (transitive)

Comes with `@nestjs/platform-express`. Not a direct dependency in `apps/api/package.json`, which is why `npm ls express` is the way to check the version. It is the thing behind `req`, `res`, `next`, `app.use()`, and `app.getHttpAdapter().getInstance()`.

### `class-validator` — 0.15.1 and `class-transformer` — 0.5.1

Validate and transform DTO objects using decorators such as `@IsString()`, `@IsUUID()`, `@Type()`.

- **Used via:** `createGlobalValidationPipe()` (`src/filters/validation-violations.ts`), registered at `main.ts:206`.
- **Why:** rejects unknown keys (`forbidNonWhitelisted`) and wrong types at the HTTP boundary before any service runs.

### `rxjs` — 7.8.2

Reactive streams. Nest interceptor methods return `Observable<T>`.

- **Used via:** every interceptor in `src/interceptors/`.
- **Why:** interceptors can `map`, `tap`, `catchError`, and time a handler without changing its signature.

### `reflect-metadata` — 0.2.2

Polyfill that stores decorator metadata at runtime. Nest needs it for DI.

- **Used via:** loaded once at startup (Nest imports it). You will rarely import it yourself.

### `ioredis` — 6.0.0

Redis client.

- **Used via:** `RedisServiceModule`, throttler storage, BullMQ connection, CLS/tenant caches.
- **Why:** rate limits, queues, caches, and locks need a shared store across pods.

### `bullmq` — 6.3.4

Redis-backed job queue engine (the runtime under `@nestjs/bullmq`).

- **Used via:** `RedisServiceModule.register(JobQueue values)` in `app.module.ts`.
- **Why:** asynchronous work that must survive a pod restart.

### `helmet` — 8.3.0 and `compression` — 8.1.0

Express security headers and gzip/brotli compression.

- **Note:** `main.ts` sets its security headers manually (lines 295–311) rather than calling `helmet`, so do not assume `helmet` runs at boot. It is available and used elsewhere or reserved.

### `http-proxy-middleware` — 4.2.0

Express proxy middleware.

- **Used via:** proxy controllers (mostly streaming/text), not `main.ts`.
- **Why:** forward requests to Python services while preserving headers and streaming semantics.

### `exceljs`, `pdfkit`, `pdf-parse`

Document generation/parsing (Excel exports, PDF reports, PDF text extraction). They are not part of boot; you meet them in feature modules.

---

## 4. What is *not* a library

`@arcaai/applications`, `@arcaai/domains`, and `@arcaai/database` look like npm packages but are **local folders** in this monorepo. They are covered in [04-arcaai-workspace-packages.md](./04-arcaai-workspace-packages.md).

The `./…` imports (`./bootstrap`, `./config`, `./guards`, …) are files in `apps/api/src`. They are covered in [05-local-app-code.md](./05-local-app-code.md).

---

## 5. How to tell what a package does without reading its docs

1. Look at the **specifier**:
   - `@nestjs/x` → framework integration.
   - `@arcaai/x` → this project.
   - `./x` or `../x` → a file here.
   - `x` → general npm library.
2. Look at the **imported symbol**:
   - A `Module` or `*Module` → DI wiring.
   - A `*Guard`, `*Interceptor`, `*Filter`, `*Pipe` → request lifecycle hook.
   - A `Service` → business logic.
   - A token in `ALL_CAPS` (e.g. `JWT_AUTH_GUARD`) → DI injection token, not a class.
3. Look at **where it is called** in `main.ts`:
   - before `NestFactory.create` → boot-time configuration.
   - after → runtime HTTP/WS behaviour.

Next: [04-arcaai-workspace-packages.md](./04-arcaai-workspace-packages.md).
