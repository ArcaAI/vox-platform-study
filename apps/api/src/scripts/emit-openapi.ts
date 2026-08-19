/**
 * TASK-773 Phase B1 — emit the gateway's OpenAPI document to disk, offline.
 *
 * `SwaggerModule.createDocument(app, config)` only needs an application
 * CONTEXT (the DI container + route metadata `nest-cli.json`'s
 * `@nestjs/swagger` compiler plugin already baked into the compiled
 * controllers/DTOs) — it does not need a listening HTTP server. This script
 * therefore builds the Nest application with `NestFactory.create()` and
 * NEVER calls `.listen()`, so no port is bound and no request is ever
 * served.
 *
 * Fidelity requirement: this must run against the SAME compiled output
 * `pnpm api:build` produces (`nest build`), not a plain `ts-node`/`tsx`
 * execution of the TypeScript sources. `nest-cli.json` registers the
 * `@nestjs/swagger` plugin (`introspectComments`, implicit `@ApiProperty`
 * inference from TS types, implicit response-type inference), which only
 * runs through Nest's own compiler (`nest build` / `nest start`) — `ts-node`
 * does not know about `nest-cli.json` and would silently under-report type
 * coverage relative to what `/api/v1/docs` actually serves in every real
 * environment (dev and prod alike). Run `pnpm api:build` first (the
 * `api:openapi` root script does this for you).
 *
 * Global prefix + exclude list, and the Swagger `DocumentBuilder` config,
 * are imported from the exact modules `main.ts` uses
 * (`global-prefix.config.ts`, `swagger.config.ts`) so the emitted document
 * cannot drift from the routes the running gateway serves.
 *
 * No database, Redis, or Vault reachability is required: NestFactory.create()
 * instantiates providers (constructors + factory providers) but does NOT run
 * `onModuleInit`/`onApplicationBootstrap` lifecycle hooks — those only fire
 * on `app.init()`/`app.listen()`, neither of which this script calls. Two
 * things nonetheless need placeholder (not live) values, both supplied by
 * the `api:openapi` root script rather than a real `.env` file:
 *
 *   - `BullModule.forRootAsync`'s factory (`RedisServiceModule.register`)
 *     throws SYNCHRONOUSLY during `NestFactory.create()` if
 *     `REDIS_HOST`/`REDIS_PORT` are unset (it only checks presence, not
 *     reachability). BullMQ's underlying ioredis client then dials in the
 *     background; it never has to succeed — the bounded `Promise.race`
 *     around `app.close()` below moves on even if it never connects.
 *   - `JwtStrategy`'s constructor refuses to build (throws) if
 *     `JWT_SECRET_KEY` is empty or the literal shared dev placeholder — any
 *     other non-empty string satisfies it without being a real secret.
 *
 * `DATABASE_URL`/`DIRECT_URL` similarly only need to be well-formed —
 * `CoreDatabaseService` constructs a `PrismaClient` at DI time, which does
 * not connect eagerly. A LIVE-only side effect exists regardless of what's
 * running: `AppSettingsService`'s constructor fires off an unawaited cache
 * warm-up query ("Initialize cache immediately but don't wait for it"),
 * which loses its race against this script's `writeFileSync` every time
 * and surfaces later as a harmless, already-losing DB error on stderr. It
 * cannot be avoided without editing application code, which is out of
 * scope here — it never affects the emitted document or the exit code.
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../app.module';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from '../global-prefix.config';
import { buildSwaggerConfig } from '../swagger.config';

const OUTPUT_PATH = resolve(__dirname, '..', '..', 'openapi.json');

/** Recursively sort object keys so the emitted JSON diffs meaningfully. */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

async function main(): Promise<void> {
  // `abortOnError: false` is load-bearing: NestFactory.create()'s DEFAULT
  // behaviour on a bootstrap error is to log it (via the internal logger —
  // silenced by `logger: false` above) and call `process.exit(1)` itself,
  // bypassing this function's `try`/`catch` entirely and the `main().catch()`
  // below. Without this flag every failure looks like a silent, unexplained
  // exit code 1. Setting it false makes `create()` reject the promise
  // instead, so the real error reaches `main().catch()` and gets printed.
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  try {
    app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS);

    const config = buildSwaggerConfig().build();
    const document = SwaggerModule.createDocument(app, config);

    writeFileSync(OUTPUT_PATH, JSON.stringify(sortKeysDeep(document), null, 2) + '\n', 'utf8');

    const pathCount = Object.keys(document.paths ?? {}).length;
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`[emit-openapi] wrote ${pathCount} paths to ${OUTPUT_PATH}`);
  } finally {
    // The document is already on disk at this point. `app.close()` is a
    // best-effort courtesy to release DB/Redis handles cleanly — bounded so
    // an unreachable Redis's reconnect backoff (observed ~10s end-to-end
    // with nothing reachable) can never make this script hang or blow a CI
    // timeout. `process.exit()` right after `main()` resolves/rejects tears
    // down anything still open regardless.
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.error('[emit-openapi] failed:', error);
    process.exit(1);
  });
