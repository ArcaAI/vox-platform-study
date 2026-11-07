# `02-main-ts/` — companion notes for the boot & pipeline document

The parent document [02-API-BOOT-AND-REQUEST-PIPELINE.md](../02-API-BOOT-AND-REQUEST-PIPELINE.md) describes **what happens**. This folder explains **what the imports are** — the libraries and project packages that make those steps possible.

It is split into small files on purpose. Read only the one you need.

---

## Read in this order

| # | File | Answers |
|---|---|---|
| 01 | [01-nestjs-in-10-minutes.md](./01-nestjs-in-10-minutes.md) | What is a module/guard/interceptor/filter? What does Nest do for me? |
| 02 | [02-framework-packages.md](./02-framework-packages.md) | What is each `@nestjs/*` package, and which are optional? |
| 03 | [03-third-party-libraries.md](./03-third-party-libraries.md) | What are `express-session`, `uuidv7`, `zod`, OpenTelemetry, …? |
| 04 | [04-arcaai-workspace-packages.md](./04-arcaai-workspace-packages.md) | What are `@arcaai/applications` / `domains` / `database`? |
| 05 | [05-local-app-code.md](./05-local-app-code.md) | What are the `./bootstrap`, `./config`, `./guards` files? |
| 06 | [06-import-reference.md](./06-import-reference.md) | One-line lookup for every import in `main.ts` / `app.module.ts` |
| 07 | [07-visual-boot-flow.md](./07-visual-boot-flow.md) | **Diagram:** the 7 boot phases and every step of `main.ts`, with file references |
| 08 | [08-visual-request-pipeline.md](./08-visual-request-pipeline.md) | **Diagram:** what `app.module.ts` builds, the 8 guards, hooks, filters, feature anatomy |
| 09 | [09-visual-import-map.md](./09-visual-import-map.md) | **Diagram:** where every import comes from and what it does |

### If you prefer pictures

Read **07 → 08 → 09** first. Each diagram cites the file and the boot step, so you can jump to the prose only when a box is unclear. Then use **01–06** as the glossary.

---

## The four kinds of import (memorise this)

Every `import` in the gateway is one of these:

| Specifier looks like | Kind | Where it lives | Example |
|---|---|---|---|
| `@nestjs/...` | Framework package | `node_modules` | `@nestjs/core` |
| `@arcaai/...` | **This project's** package | `project-hope/packages/` | `@arcaai/applications` |
| `./...` or `../...` | **This project's** file | `apps/api/src/` | `./bootstrap/occ-coverage-audit` |
| bare word (`zod`, `uuidv7`) | General npm library | `node_modules` | `express-session` |

If you remember only one thing: **`@arcaai/*` is not a third-party library.** It is the company's own code in the same repo.

---

## What NestJS gives you vs what this project built

This is the distinction that the parent document assumed.

| Concern | NestJS default | Built by this project |
|---|---|---|
| App bootstrap | `main.ts` + `NestFactory.create(AppModule)` | the **24-step ordered** boot sequence, crash handlers, env validation, boot audits |
| Modules / controllers / DI | ✅ | feature modules and their wiring |
| Guards / interceptors / filters / pipes | ✅ primitives | the specific auth, consent, OCC, tenant-lock, metrics implementations |
| Env loading | `@nestjs/config` (optional) | custom `loadEnv()` + zod `apiEnv()` + `ConfigModule` wrapper |
| Validation | `ValidationPipe` | `createGlobalValidationPipe()` with structured violations |
| Auth | `@nestjs/jwt` + `@nestjs/passport` | `UnifiedAuthGuard` with three credential classes + CASL |
| Rate limiting | `@nestjs/throttler` | four tiers + tenant/API-key-aware `TieredThrottlerGuard` |
| API docs | `@nestjs/swagger` | `createHopeOpenApiDocument()` + drift gates |
| Data access | nothing built in | `@arcaai/database` → `@arcaai/domains` |
| Business logic | nothing built in | `@arcaai/applications` |
| WebSockets | `@nestjs/websockets` / `platform-ws` | STT + workflow gateways |
| Observability | nothing built in | OpenTelemetry + Prometheus + PHI guards |
| Shutdown | `app.enableShutdownHooks()` | `GracefulShutdownService` + ordered cleanup callbacks |

**Beginner warning:** a Nest tutorial will show about 30 lines of `main.ts`. This project's `main.ts` is 499 lines because most of it is security and operability policy, not framework boilerplate.

---

## Parent document → this folder

| Section in the parent | Explained here |
|---|---|
| Part A boot steps (imports) | 02, 03, 04, 05 |
| Part A boot steps (**visual**) | **07-visual-boot-flow.md** |
| Part A `apiEnv()` / `loadEnv()` | 03 (zod, dotenv), 04 (`loadEnv`) |
| Part A `WsAdapter`, `SwaggerModule` | 02 |
| Part A `express-session`, `uuidv7` | 03 |
| Part A OpenTelemetry | 03 |
| Part B guards / interceptors / filters | 01 (concepts), 04 (`UnifiedAuthGuard`) |
| Part B module graph (**visual**) | **08-visual-request-pipeline.md** |
| Part B `APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER` | 01, 06 |
| Part B `ClsModule` / `ClsGuard` | 02 (`nestjs-cls`), 04 |
| Part C audits | 05 (`./bootstrap`) |
| Part B module imports | 04, 06 |
| Where every import comes from (**visual**) | **09-visual-import-map.md** |

---

## Conventions

- Versions are from `apps/api/package.json` at HEAD `8cb2e5e8e`.
- "Core / official / community / general" describes **who maintains it**, not importance.
- Nothing in this folder was copied from upstream docs; each claim is checkable in the repo.
- If a file is described as "custom", it means the project wrote it — do not look for it in `node_modules`.
