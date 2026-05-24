/**
 * Unit tests for ExceptionInterceptor's OCC -> 412 mapping
 * (TASK-302 Stream D Phase C, task C.5) and the
 * `optimistic_lock_conflict_total` Prometheus counter wiring
 * (Phase E.6).
 *
 * The Phase C Playwright e2e (`apps/api/tests/e2e/optimistic-locking.spec.ts`)
 * is the on-API guarantee. These unit tests pin the contract without
 * requiring a live Postgres + API server, so the mapping is locked down
 * even if the e2e suite is skipped.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CallHandler, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { Counter } from 'prom-client';

import { ExceptionInterceptor } from '../exception.interceptor';
import { OptimisticConcurrencyException, BaseException } from '@arcaai/exceptions';
import { optimisticLockConflictTotal } from '../../observability/metrics';

describe('ExceptionInterceptor — OptimisticConcurrencyException -> 412 (TASK-302 Stream D Phase C C.5)', () => {
  let interceptor: ExceptionInterceptor;

  beforeEach(() => {
    const cls: any = {
      getId: () => 'test-correlation-id',
      get: () => undefined,
    };
    interceptor = new ExceptionInterceptor(cls);
  });

  function createMockContext(overrides: { method?: string; url?: string } = {}): ExecutionContext {
    const request = {
      method: overrides.method ?? 'PATCH',
      url: overrides.url ?? '/api/v1/tenant/me/config',
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }

  it('maps OptimisticConcurrencyException to HttpException(PRECONDITION_FAILED)', async () => {
    const occ = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
      expectedVersion: 7,
      currentVersion: 9,
    });

    const result$ = interceptor.intercept(createMockContext(), createErrorHandler(occ));

    await expect(firstValueFrom(result$)).rejects.toBeInstanceOf(HttpException);

    let caught: HttpException | undefined;
    try {
      await firstValueFrom(result$);
    } catch (e) {
      caught = e as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught?.getStatus()).toBe(HttpStatus.PRECONDITION_FAILED); // 412
  });

  it('preserves the OCC body shape so clients can read expectedVersion + currentVersion', async () => {
    const occ = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
      expectedVersion: 7,
      currentVersion: 9,
    });

    let caught: HttpException | undefined;
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(occ)));
    } catch (e) {
      caught = e as HttpException;
    }
    const body = caught?.getResponse() as {
      code: string;
      metadata?: { expectedVersion: number; currentVersion: number };
    };
    expect(body.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
    expect(body.metadata).toEqual({ expectedVersion: 7, currentVersion: 9 });
  });

  it('logs at debug level (OCC is a normal client-driven outcome, not an error)', async () => {
    const occ = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
      expectedVersion: 7,
      currentVersion: 9,
    });
    const debugSpy = vi.spyOn((interceptor as any).logger, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn((interceptor as any).logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn((interceptor as any).logger, 'error').mockImplementation(() => undefined);

    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(occ)));
    } catch {
      /* expected */
    }

    expect(debugSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still maps a generic BaseException to 500 (verifies the OCC branch is correctly ordered before the generic branch)', async () => {
    // Build a minimal subclass to prove the generic branch still runs for
    // non-OCC application exceptions.
    class GenericException extends BaseException {
      code = 'TEST.GENERIC';
    }
    const generic = new GenericException('generic failure');
    let caught: HttpException | undefined;
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(generic)));
    } catch (e) {
      caught = e as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught?.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR); // 500 — the generic branch still works
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TASK-302 Stream D Phase E.6 — `optimistic_lock_conflict_total`
//
// Every 412 must increment a Prometheus counter labelled by model + route so
// operators can spot a noisy client (chatty UI, bug in SDK ETag capture) and
// alert at > 0.5% of PATCHes. We pin the wiring with unit tests here so the
// counter cannot silently regress.
// ───────────────────────────────────────────────────────────────────────────
describe('ExceptionInterceptor — optimistic_lock_conflict_total counter (TASK-302 Stream D Phase E.6)', () => {
  let interceptor: ExceptionInterceptor;

  async function counterValue(model: string, route: string): Promise<number> {
    const value = await (optimisticLockConflictTotal as Counter<'model' | 'route'>).get();
    const match = value.values.find(
      (v) => v.labels?.['model'] === model && v.labels?.['route'] === route,
    );
    return match?.value ?? 0;
  }

  beforeEach(() => {
    const cls: any = {
      getId: () => 'test-correlation-id',
      get: () => undefined,
    };
    interceptor = new ExceptionInterceptor(cls);
    // Reset *only* the counter we're asserting on; leaving the global
    // prom-client `register` alone keeps other tests' metrics intact.
    (optimisticLockConflictTotal as Counter<'model' | 'route'>).reset();
  });

  function createMockContext(overrides: { method?: string; url?: string; routePath?: string } = {}): ExecutionContext {
    const request: any = {
      method: overrides.method ?? 'PATCH',
      url: overrides.url ?? '/api/v1/tenant/me/config',
    };
    if (overrides.routePath !== undefined) {
      request.route = { path: overrides.routePath };
    }
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }

  it('increments the counter with model + route labels on each OCC -> 412 mapping', async () => {
    const occ = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
      expectedVersion: 7,
      currentVersion: 9,
    });

    const beforeValue = await counterValue('GlobalSetting', 'PATCH /api/v1/global-settings/:id');
    expect(beforeValue).toBe(0);

    try {
      await firstValueFrom(
        interceptor.intercept(
          createMockContext({ method: 'PATCH', routePath: '/api/v1/global-settings/:id' }),
          createErrorHandler(occ),
        ),
      );
    } catch {
      /* expected — interceptor rethrows as 412 */
    }

    const afterValue = await counterValue('GlobalSetting', 'PATCH /api/v1/global-settings/:id');
    expect(afterValue).toBe(1);
  });

  it('uses request.route.path when available so cardinality stays bounded (templated route, not raw URL)', async () => {
    const occ = new OptimisticConcurrencyException('Tenant', 'tenant-42', {
      expectedVersion: 1,
      currentVersion: 2,
    });

    // Hit the same templated route twice with two different raw URLs.
    // Cardinality MUST stay at one series — we label by templated path, not
    // by raw URL.
    await firstValueFrom(
      interceptor.intercept(
        createMockContext({ method: 'PATCH', url: '/api/v1/tenants/tenant-42', routePath: '/api/v1/tenants/:id' }),
        createErrorHandler(occ),
      ),
    ).catch(() => undefined);
    await firstValueFrom(
      interceptor.intercept(
        createMockContext({ method: 'PATCH', url: '/api/v1/tenants/other-id', routePath: '/api/v1/tenants/:id' }),
        createErrorHandler(occ),
      ),
    ).catch(() => undefined);

    expect(await counterValue('Tenant', 'PATCH /api/v1/tenants/:id')).toBe(2);
    // No raw-URL labels leaked through.
    expect(await counterValue('Tenant', 'PATCH /api/v1/tenants/tenant-42')).toBe(0);
    expect(await counterValue('Tenant', 'PATCH /api/v1/tenants/other-id')).toBe(0);
  });

  it('strips query strings from the URL fallback when no templated route is set', async () => {
    const occ = new OptimisticConcurrencyException('PromptTemplate', 'tpl-1', {
      expectedVersion: 3,
      currentVersion: 4,
    });

    await firstValueFrom(
      interceptor.intercept(
        // No routePath -> we fall back to URL. URL has a query string —
        // it MUST be stripped or cardinality explodes.
        createMockContext({ method: 'PATCH', url: '/api/v1/prompt-templates/tpl-1?force=true' }),
        createErrorHandler(occ),
      ),
    ).catch(() => undefined);

    expect(await counterValue('PromptTemplate', 'PATCH /api/v1/prompt-templates/tpl-1')).toBe(1);
    expect(await counterValue('PromptTemplate', 'PATCH /api/v1/prompt-templates/tpl-1?force=true')).toBe(0);
  });

  it('uses the exception\'s `model` field (not message parsing) so renames of the OCC message do not break the metric', async () => {
    const occ = new OptimisticConcurrencyException('Webhook', 'wh-1', {
      expectedVersion: 1,
      currentVersion: 2,
    });

    // The interceptor MUST read `err.model`, not parse the message string.
    // Force-mutating the message proves the metric still gets the right
    // model label.
    (occ as { message: string }).message = 'munged — should not affect labels';

    await firstValueFrom(
      interceptor.intercept(
        createMockContext({ method: 'PATCH', routePath: '/api/v1/webhooks/:id' }),
        createErrorHandler(occ),
      ),
    ).catch(() => undefined);

    expect(await counterValue('Webhook', 'PATCH /api/v1/webhooks/:id')).toBe(1);
  });

  it('does NOT increment the counter for non-OCC errors', async () => {
    class GenericException extends BaseException {
      code = 'TEST.GENERIC';
    }
    const generic = new GenericException('not an OCC');

    await firstValueFrom(
      interceptor.intercept(
        createMockContext({ method: 'PATCH', routePath: '/api/v1/global-settings/:id' }),
        createErrorHandler(generic),
      ),
    ).catch(() => undefined);

    // No model label exists yet → no series at all.
    const value = await (optimisticLockConflictTotal as Counter<'model' | 'route'>).get();
    expect(value.values.length).toBe(0);
  });
});
