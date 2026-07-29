/**
 * Unit tests for ExceptionInterceptor's OCC -> 412 mapping and the
 * `optimistic_lock_conflict_total` Prometheus counter wiring.
 *
 * The Playwright e2e (`apps/api/tests/e2e/optimistic-locking.spec.ts`)
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
import {
  ArgumentInvalidException,
  DataNotFoundException,
  OptimisticConcurrencyException,
  BaseException,
  QuotaExceededException,
} from '@arcaai/exceptions';
import { PrismaClientKnownRequestError } from '@arcaai/database';
import { optimisticLockConflictTotal } from '../../observability/metrics';

describe('ExceptionInterceptor — OptimisticConcurrencyException -> 412', () => {
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

  /*
   * `DataNotFoundException` MUST pass through this interceptor UNWRAPPED so
   * the global `DataNotFoundExceptionFilter` (registered as `APP_FILTER` in
   * `app.module.ts`) catches the ORIGINAL exception and maps it to a
   * generic `404 { message: "Resource not found" }`. If the interceptor
   * wraps it as a generic `HttpException(err.toJSON(), 500)` instead, the
   * filter never sees the `DataNotFoundException` (it sees an
   * HttpException) and the model name + row id leak to the response body.
   *
   * This branch is structurally analogous to the OCC pre-empt branch
   * above and MUST stay ordered before the generic `BaseException`
   * branch.
   */
  describe('DataNotFoundException pass-through (audit)', () => {
    it('rethrows the ORIGINAL DataNotFoundException (not an HttpException)', async () => {
      const dnf = new DataNotFoundException('User', 'user-sensitive-id');

      let caught: unknown;
      try {
        await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(dnf)));
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(DataNotFoundException);
      expect(caught).not.toBeInstanceOf(HttpException);
      // The exception MUST be the same reference so the global filter
      // can decode the original model + id for server-side logging.
      expect(caught).toBe(dnf);
    });

    it('does NOT wrap as 500 via the generic BaseException branch', async () => {
      // Sanity-pin: DataNotFoundException IS a BaseException at runtime;
      // without the pass-through branch the generic branch below would
      // wrap it as HttpException(500). Verify the order is correct.
      const dnf = new DataNotFoundException('ApiKey', 'apikey-1');

      let caught: unknown;
      try {
        await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(dnf)));
      } catch (e) {
        caught = e;
      }

      expect(caught).not.toBeInstanceOf(HttpException);
      // No mutation to the original message — the global filter is the
      // one that strips model + id from the response.
      expect((caught as DataNotFoundException).message).toContain('ApiKey');
      expect((caught as DataNotFoundException).message).toContain('apikey-1');
    });

    it('logs at debug level (a 404 read is not an error condition)', async () => {
      const dnf = new DataNotFoundException('Tenant', 'tenant-42');
      const debugSpy = vi.spyOn((interceptor as any).logger, 'debug').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn((interceptor as any).logger, 'warn').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn((interceptor as any).logger, 'error').mockImplementation(() => undefined);

      try {
        await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(dnf)));
      } catch {
        /* expected */
      }

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'DataNotFoundException — passing through to global filter',
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// QuotaExceededException → 409 / 429 / 413 / 403.
//
// QuotaExceededException extends BaseException, so without a dedicated branch
// (ordered BEFORE the generic BaseException → 500 branch) an entitlements
// quota block would surface as a 500. These pin the capability→status contract
// the SDK + admin console rely on, and preserve the `code` + `metadata` body.
// ───────────────────────────────────────────────────────────────────────────
describe('ExceptionInterceptor — QuotaExceededException → precise client status', () => {
  let interceptor: ExceptionInterceptor;

  beforeEach(() => {
    const cls: any = { getId: () => 'corr-q', get: () => undefined };
    interceptor = new ExceptionInterceptor(cls);
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', url: '/api/v1/users' }), getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }
  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }
  async function catchHttp(err: unknown): Promise<HttpException> {
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('expected interceptor to throw');
  }

  it('maps a QUANTITY capability (maxUsers) to 409 Conflict', async () => {
    const caught = await catchHttp(new QuotaExceededException('limit', { capability: 'maxUsers', limit: 5, used: 5, requested: 1, tenantId: 't-1' }));
    expect(caught.getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('maps a METER capability (monthlyConsultations) to 429 Too Many Requests', async () => {
    const caught = await catchHttp(
      new QuotaExceededException('limit', { capability: 'monthlyConsultations', limit: 500, used: 500, requested: 1, tenantId: 't-1' }),
    );
    expect(caught.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('maps the storage capability to 413 Payload Too Large', async () => {
    const caught = await catchHttp(
      new QuotaExceededException('limit', { capability: 'storageQuotaBytes', limit: 100, used: 100, requested: 1, tenantId: 't-1' }),
    );
    expect(caught.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  });

  // A simultaneous-session cap is retry-later (429), not a permanent
  // conflict (409).
  it('maps the concurrency capability (maxConcurrentSessions) to 429 Too Many Requests', async () => {
    const caught = await catchHttp(
      new QuotaExceededException('at capacity', { capability: 'maxConcurrentSessions', limit: 5, used: 5, requested: 1, tenantId: 't-1' }),
    );
    expect(caught.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('preserves the code + metadata in the response body', async () => {
    const caught = await catchHttp(
      new QuotaExceededException('limit', { capability: 'maxApiKeys', limit: 2, used: 2, requested: 1, tenantId: 't-1' }),
    );
    const body = caught.getResponse() as { code: string; metadata?: { capability: string } };
    expect(body.code).toBe('DOMAIN.QUOTA_EXCEEDED');
    expect(body.metadata?.capability).toBe('maxApiKeys');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `optimistic_lock_conflict_total` counter
//
// Every 412 must increment a Prometheus counter labelled by model + route so
// operators can spot a noisy client (chatty UI, bug in SDK ETag capture) and
// alert at > 0.5% of PATCHes. We pin the wiring with unit tests here so the
// counter cannot silently regress.
// ───────────────────────────────────────────────────────────────────────────
describe('ExceptionInterceptor — optimistic_lock_conflict_total counter', () => {
  let interceptor: ExceptionInterceptor;

  async function counterValue(model: string, route: string): Promise<number> {
    const value = await (optimisticLockConflictTotal as Counter<'model' | 'route'>).get();
    const match = value.values.find((v) => v.labels?.['model'] === model && v.labels?.['route'] === route);
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
        interceptor.intercept(createMockContext({ method: 'PATCH', routePath: '/api/v1/global-settings/:id' }), createErrorHandler(occ)),
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

  it("uses the exception's `model` field (not message parsing) so renames of the OCC message do not break the metric", async () => {
    const occ = new OptimisticConcurrencyException('Webhook', 'wh-1', {
      expectedVersion: 1,
      currentVersion: 2,
    });

    // The interceptor MUST read `err.model`, not parse the message string.
    // Force-mutating the message proves the metric still gets the right
    // model label.
    (occ as { message: string }).message = 'munged — should not affect labels';

    await firstValueFrom(
      interceptor.intercept(createMockContext({ method: 'PATCH', routePath: '/api/v1/webhooks/:id' }), createErrorHandler(occ)),
    ).catch(() => undefined);

    expect(await counterValue('Webhook', 'PATCH /api/v1/webhooks/:id')).toBe(1);
  });

  it('does NOT increment the counter for non-OCC errors', async () => {
    class GenericException extends BaseException {
      code = 'TEST.GENERIC';
    }
    const generic = new GenericException('not an OCC');

    await firstValueFrom(
      interceptor.intercept(createMockContext({ method: 'PATCH', routePath: '/api/v1/global-settings/:id' }), createErrorHandler(generic)),
    ).catch(() => undefined);

    // No model label exists yet → no series at all.
    const value = await (optimisticLockConflictTotal as Counter<'model' | 'route'>).get();
    expect(value.values.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Prisma error meta & raw-message strip.
//
// The PrismaClientKnownRequestError branch MUST NOT pass `err.meta` or
// `err.message` straight to the client response body — they leak column
// names, constraint names, and (depending on the Prisma version) row id
// values. The server-side log MUST keep the full detail; only the public
// body needs sanitising.
// ───────────────────────────────────────────────────────────────────────────
describe('Prisma error sanitisation (audit)', () => {
  let interceptor: ExceptionInterceptor;

  beforeEach(() => {
    const cls: any = {
      getId: () => 'corr-1',
      get: () => undefined,
    };
    interceptor = new ExceptionInterceptor(cls);
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/api/v1/users' }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }
  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }

  function makePrismaError(opts: { code: string; meta: Record<string, unknown>; message: string }): PrismaClientKnownRequestError {
    const err = Object.assign(new Error(opts.message), {
      code: opts.code,
      meta: opts.meta,
      clientVersion: '0.0.0-test',
    });
    Object.setPrototypeOf(err, PrismaClientKnownRequestError.prototype);
    return err as unknown as PrismaClientKnownRequestError;
  }

  it('client body for a PrismaClientKnownRequestError contains NO err.meta (no column / constraint / id leaks)', async () => {
    const err = makePrismaError({
      code: 'P2002',
      meta: {
        modelName: 'User',
        target: ['email_confidential_field'],
        constraint: 'unique_user_email_constraint_x',
      },
      message: 'Unique constraint failed on the fields: (`email_confidential_field`)',
    });

    let caught: HttpException | undefined;
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch (e) {
      caught = e as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    const body = caught!.getResponse() as Record<string, unknown>;

    expect(body).not.toHaveProperty('meta');
    expect(JSON.stringify(body)).not.toContain('email_confidential_field');
    expect(JSON.stringify(body)).not.toContain('unique_user_email_constraint_x');
    expect(JSON.stringify(body)).not.toContain('modelName');
  });

  it('client body for a PrismaClientKnownRequestError does NOT echo err.message raw text', async () => {
    const err = makePrismaError({
      code: 'P2002',
      meta: { target: ['email'] },
      message: 'Unique constraint failed on the fields: (`email`) — internal hint xyz',
    });

    let caught: HttpException | undefined;
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch (e) {
      caught = e as HttpException;
    }
    const body = caught!.getResponse() as Record<string, unknown>;

    expect(JSON.stringify(body)).not.toContain('internal hint xyz');
    expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
  });

  it('client body shape is {statusCode, error, correlationId} only (no message, no meta)', async () => {
    // P2002 maps to 409 with the proper error label.
    const err = makePrismaError({
      code: 'P2002',
      meta: { target: ['email'] },
      message: 'leaky message',
    });

    let caught: HttpException | undefined;
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch (e) {
      caught = e as HttpException;
    }
    const body = caught!.getResponse() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['correlationId', 'error', 'statusCode'].sort());
    expect(body.statusCode).toBe(HttpStatus.CONFLICT);
    expect(body.error).toBe('Unique constraint violation');
    expect(body.correlationId).toBe('corr-1');
  });

  it('server-side log STILL carries the full err.meta + err.message + errorCode (observability preserved)', async () => {
    const err = makePrismaError({
      code: 'P2002',
      meta: { modelName: 'User', target: ['email'] },
      message: 'Unique constraint failed on (`email`)',
    });
    const errorSpy = vi.spyOn((interceptor as any).logger, 'error').mockImplementation(() => undefined);

    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch {
      /* expected */
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Prisma database error',
        errorCode: 'P2002',
        errorMeta: expect.objectContaining({ modelName: 'User', target: ['email'] }),
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Prisma error code → HTTP status mapping.
//
// The `PrismaClientExceptionFilter` has the proper code-to-status branches
// but never runs, because the interceptor runs first and converts the error
// before any filter sees it. The code-to-status mapping lives in the
// interceptor (the single registered handler) so clients see the
// classification matching RFC semantics:
//   P2002 (unique constraint)        → 409 Conflict
//   P2025 (record not found)         → 404 Not Found
//   P2003 (foreign key constraint)   → 400 Bad Request
//   P2014 (required relation)        → 400 Bad Request
//   <other / unknown code>           → 400 Bad Request (legacy default)
//
// Sanitisation is preserved: the public body stays
// `{ statusCode, error, correlationId }` with no `err.meta` / raw message
// leak. Server-side log retains the full Prisma detail for SRE debugging.
// ───────────────────────────────────────────────────────────────────────────
describe('Prisma error code → HTTP status mapping', () => {
  let interceptor: ExceptionInterceptor;

  beforeEach(() => {
    const cls: any = {
      getId: () => 'corr-ac1',
      get: () => undefined,
    };
    interceptor = new ExceptionInterceptor(cls);
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/api/v1/users' }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }
  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }
  function makePrismaError(opts: { code: string; meta: Record<string, unknown>; message: string }): PrismaClientKnownRequestError {
    const err = Object.assign(new Error(opts.message), {
      code: opts.code,
      meta: opts.meta,
      clientVersion: '0.0.0-test',
    });
    Object.setPrototypeOf(err, PrismaClientKnownRequestError.prototype);
    return err as unknown as PrismaClientKnownRequestError;
  }

  async function catchHttp(err: unknown): Promise<HttpException> {
    try {
      await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err)));
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('expected interceptor to throw');
  }

  it('maps P2002 (unique constraint) to 409 Conflict + "Unique constraint violation"', async () => {
    const caught = await catchHttp(makePrismaError({ code: 'P2002', meta: { target: ['email'] }, message: 'm' }));
    expect(caught.getStatus()).toBe(HttpStatus.CONFLICT);
    const body = caught.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.CONFLICT);
    expect(body.error).toBe('Unique constraint violation');
    expect(body.correlationId).toBe('corr-ac1');
  });

  it('maps P2025 (record not found) to 404 Not Found + "Not found"', async () => {
    const caught = await catchHttp(makePrismaError({ code: 'P2025', meta: { cause: 'x' }, message: 'm' }));
    expect(caught.getStatus()).toBe(HttpStatus.NOT_FOUND);
    const body = caught.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(body.error).toBe('Not found');
  });

  it('maps P2003 (foreign key) to 400 Bad Request + "Foreign key constraint violation"', async () => {
    const caught = await catchHttp(makePrismaError({ code: 'P2003', meta: { field_name: 'fk' }, message: 'm' }));
    expect(caught.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const body = caught.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error).toBe('Foreign key constraint violation');
  });

  it('maps P2014 (required relation) to 400 Bad Request + "Required relation violation"', async () => {
    const caught = await catchHttp(makePrismaError({ code: 'P2014', meta: { relation_name: 'rel' }, message: 'm' }));
    expect(caught.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const body = caught.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error).toBe('Required relation violation');
  });

  it('falls back to 400 Bad Request for any other Prisma error code (legacy default preserved)', async () => {
    const caught = await catchHttp(makePrismaError({ code: 'P9999', meta: {}, message: 'm' }));
    expect(caught.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const body = caught.getResponse() as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error).toBe('Bad Request');
  });

  it('does NOT leak err.meta or err.message text in the response body for any mapped code', async () => {
    const cases = [
      { code: 'P2002', meta: { target: ['secret_field'] }, message: 'secret unique fail' },
      { code: 'P2025', meta: { cause: 'secret cause' }, message: 'secret not found' },
      { code: 'P2003', meta: { field_name: 'secret_fk' }, message: 'secret fk fail' },
      { code: 'P2014', meta: { relation_name: 'secret_rel' }, message: 'secret rel fail' },
    ];
    for (const c of cases) {
      const caught = await catchHttp(makePrismaError(c));
      const body = JSON.stringify(caught.getResponse());
      expect(body).not.toContain('secret');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ArgumentInvalidException -> 400 Bad Request.
//
// Services signal invalid input with `ArgumentInvalidException` (rule-04 house
// pattern: unwritable registry tiers, descriptor type mismatches, no-op
// updates, bad slugs, …). It extends BaseException; without a dedicated
// branch it falls into the generic BaseException branch and surfaces as a
// 500 "Internal server error" — observed live on
// `PUT /admin/settings/registry/:key`.
// ───────────────────────────────────────────────────────────────────────────
describe('ArgumentInvalidException -> 400', () => {
  let interceptor: ExceptionInterceptor;

  beforeEach(() => {
    const cls: any = {
      getId: () => 'corr-g4',
      get: () => undefined,
    };
    interceptor = new ExceptionInterceptor(cls);
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'PUT', url: '/api/v1/admin/settings/registry/rate-limit.enabled' }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function createErrorHandler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }

  it('maps ArgumentInvalidException to HttpException(BAD_REQUEST) with the toJSON body', async () => {
    const err = new ArgumentInvalidException("Setting 'rate-limit.enabled' expects a boolean (got string).");

    let caught: unknown;
    await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(err))).catch((e) => {
      caught = e;
    });

    expect(caught).toBeInstanceOf(HttpException);
    const http = caught as HttpException;
    expect(http.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const body = http.getResponse() as { code?: string; message?: string };
    expect(body.code).toBe('GENERIC.ARGUMENT_INVALID');
    expect(body.message).toContain('expects a boolean');
  });

  it('still maps a plain (non-ArgumentInvalid) BaseException to 500', async () => {
    class GenericException extends BaseException {
      code = 'TEST.GENERIC';
    }
    let caught: unknown;
    await firstValueFrom(interceptor.intercept(createMockContext(), createErrorHandler(new GenericException('boom')))).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
