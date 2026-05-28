/**
 * TestAppModule sanity test — TASK-309 AC-4.
 *
 * Closes the W7.A.19 follow-up deferred from TASK-307 W4b. The helper
 * in `apps/api/tests/helpers/test-app-module.ts` re-exports `AppModule`
 * with a documented override surface so the full route tree can boot
 * inside an integration test without contacting Postgres/Redis/Vault/OIDC.
 *
 * This sanity test asserts the harness can `app.init()` + `app.close()`
 * in under 5 seconds — the contract the AC-5 walker relies on.
 *
 * ## Current status (TASK-309 partial — see README §1.5)
 *
 * The helper covers the W4b-documented blocker surface
 * (BullMQ + RedisServiceModule + OIDC + AppSettings) plus several more
 * surfaces uncovered during AC-4 (SecretsService JWT-secret gate,
 * `ServiceHealthMonitoringService` infinite-retry on Redis,
 * `CoreDatabaseService.$connect`). Even with those overrides applied
 * `compile()` still does not return — all per-module
 * `InstanceLoader … dependencies initialized` logs are emitted, but the
 * compile promise never resolves. See README §5 (Change History,
 * 2026-05-28: AC-4 / AC-5 blocker post-mortem) for the trace evidence
 * and the next-step plan (introduce a stub `IConfigService` whose
 * `isRedisConfigured() === false` shadows every transitive ioredis
 * consumer, instead of stubbing each consumer one-by-one).
 *
 * The test is intentionally LEFT IN the suite and asserts the under-5s
 * contract. It will FAIL until the remaining surface is identified —
 * that failure is the gate the README's verification step calls for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/test-app-module';

describe('TASK-309 AC-4 — TestAppModule sanity', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('boots and shuts down in under 5 seconds without external I/O', { timeout: 30000 }, async () => {
    const started = Date.now();
    app = await createTestApp();
    const bootMs = Date.now() - started;
    expect(app).toBeDefined();
    expect(app!.getHttpServer()).toBeDefined();
    expect(
      bootMs,
      `TestAppModule boot took ${bootMs}ms (>5000ms means an external dep is leaking; see helper TSDoc for the override surface)`,
    ).toBeLessThan(5000);
  });
});
