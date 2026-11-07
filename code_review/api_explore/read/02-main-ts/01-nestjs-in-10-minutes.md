# NestJS in 10 Minutes — the vocabulary you need

**Audience:** you know basic JavaScript (functions, classes, imports, `async`/`await`) but have never used NestJS.
**Goal:** after this page, every term in [02-API-BOOT-AND-REQUEST-PIPELINE.md](../02-API-BOOT-AND-REQUEST-PIPELINE.md) has a plain-English meaning.

You do **not** need to memorise this. Skim it once, then use it as a lookup while reading the code.

---

## 1. What NestJS is

NestJS is a **framework that runs your TypeScript classes for you**.

You write plain classes and decorate them with `@Module()`, `@Controller()`, `@Injectable()`. Nest reads those decorators, builds a graph of objects, decides what depends on what, creates them in the right order, and calls them when an HTTP request arrives.

In plain JavaScript you would write this yourself:

```js
const users = new UserService(new Database());
const app = express();
app.get('/users', (req, res) => users.list(req, res));
```

In NestJS the same thing is expressed as metadata:

```ts
@Module({ providers: [UserService, Database], controllers: [UserController] })
export class UserModule {}
```

Nest does the `new` calls. That mechanism is called **Dependency Injection (DI)**.

---

## 2. The building blocks

| Term | Plain English | In this repo |
|---|---|---|
| **Module** | A box that groups related classes. Every Nest app has a root module. | `app.module.ts` (`AppModule`) |
| **Controller** | A class whose methods handle HTTP routes. | `src/modules/*/**.controller.ts` |
| **Provider / Service** | Any class Nest can create and inject. Usually business logic. | `@arcaai/applications` services |
| **Dependency Injection** | Nest passes constructor arguments for you instead of you calling `new`. | Everywhere |
| **Guard** | A bouncer that runs *before* the handler and returns `true`/`false` (allow/deny). | `UnifiedAuthGuard`, `PatientConsentGuard` |
| **Interceptor** | Code that wraps the handler: runs before and after, can transform the result. | `ETagInterceptor`, `MetricsInterceptor` |
| **Pipe** | Transforms or validates an incoming value. | `ValidationPipe` (`createGlobalValidationPipe`) |
| **Filter** | Catches exceptions and decides what response body to send. | `AllExceptionsFilter` |
| **Middleware** | Raw Express function `(req, res, next)` that runs before Nest routing. | `httpResponseMetricsMiddleware` |
| **Decorator** | A `@something` annotation that attaches metadata to a class/method/parameter. | `@Module`, `@Controller`, `@Public` |
| **Dynamic module** | A module configured at runtime with a static method like `.forRoot()`. | `ConfigModule.forRoot()`, `ClsModule.forRoot()` |

---

## 3. What happens to one HTTP request

This is the single most important diagram to remember. Order matters, and this repo depends on it.

```
request
  │
  ├─ Middleware            (Express level — no Nest context yet)
  │
  ├─ Guard 1  ─┐
  ├─ Guard 2   │  first "false" / thrown error stops the request here
  ├─ Guard 3  ─┘
  │
  ├─ Interceptor (before)
  │
  ├─ Pipe  (validate / transform the input)
  │
  ├─ Controller method  →  Service  →  Repository  →  Database
  │
  ├─ Interceptor (after)   (can rewrite the response)
  │
  └─ response
```

If **anything** throws, the exception skips the rest and lands on a **filter**, which writes the error response.

Two consequences that surprise newcomers:

1. **Guards run before interceptors.** So a 401 from a guard never reaches `MetricsInterceptor`. This repo adds an Express-level middleware to count those responses.
2. **Filters are chosen last-registered-first.** That is why the filter array looks "backwards" in `global-filters.ts`.

---

## 4. What `APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER` mean

Nest gives you two ways to register something globally:

| Way | Example | DI works? |
|---|---|---|
| `app.useGlobalGuards(new MyGuard())` | manual `new` | ❌ no constructor injection |
| `{ provide: APP_GUARD, useClass: MyGuard }` | inside a module's `providers` | ✅ yes |

This repo always uses the `APP_*` tokens because its guards need injected services (repositories, Redis, settings). That is why `app.module.ts` has arrays named `guards`, `interceptors`, and `filters` instead of calling `app.useGlobal*()`.

---

## 5. Decorators and `reflect-metadata`

TypeScript decorators are just functions. To make them work at runtime, two things must be enabled:

```jsonc
// tsconfig.json
"experimentalDecorators": true,
"emitDecoratorMetadata": true
```

and the app must import `reflect-metadata` once at startup. Nest does this for you.

`emitDecoratorMetadata` is what lets Nest see constructor parameter types and know what to inject. Without it, DI cannot resolve `constructor(private readonly secrets: SecretsService)`.

---

## 6. What is "NestJS default" vs "this project"

This distinction caused most of the confusion in the parent document, so keep it handy.

| Thing | Default NestJS? | Notes |
|---|---|---|
| `main.ts` with `NestFactory.create()` | ✅ template | Every Nest app has one |
| `app.module.ts` root module | ✅ template | Every Nest app has one |
| Modules, controllers, providers, DI | ✅ core | — |
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | ✅ core install | The framework itself |
| `@nestjs/swagger`, `@nestjs/schedule`, `@nestjs/event-emitter`, `@nestjs/throttler`, `@nestjs/terminus`, `@nestjs/bullmq` | ⚙️ official but **opt-in** | You install them only if you need them |
| `nestjs-cls`, `express-session`, `uuidv7`, `zod` | 🧩 community / general libraries | Not part of Nest |
| `@arcaai/applications`, `@arcaai/domains`, `@arcaai/database` | 🏠 **this project** | Local workspace packages |
| `./bootstrap`, `./config`, `./guards`, `./cors.config.ts`, … | 🏠 **this project** | Files inside `apps/api/src` |
| The 24-step boot order, the audits, OCC/ETags, the CORS registry | 🏠 **this project** | Nothing to do with Nest defaults |

**Rule of thumb:** if the specifier starts with `@nestjs/`, it is a framework package. If it starts with `@arcaai/`, it is this project's own code. If it starts with `./` or `../`, it is a file in this repo. If it is a bare word (`express-session`, `uuidv7`), it is a general npm library.

---

## 7. Where to go next

| If you want… | Read |
|---|---|
| Every `@nestjs/*` package explained | [02-framework-packages.md](./02-framework-packages.md) |
| Non-Nest libraries (`express-session`, `zod`, OTel…) | [03-third-party-libraries.md](./03-third-party-libraries.md) |
| What `@arcaai/*` packages are | [04-arcaai-workspace-packages.md](./04-arcaai-workspace-packages.md) |
| What the `./…` imports are | [05-local-app-code.md](./05-local-app-code.md) |
| A table of every import in `main.ts` / `app.module.ts` | [06-import-reference.md](./06-import-reference.md) |
