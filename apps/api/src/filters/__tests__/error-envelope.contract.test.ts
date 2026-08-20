/**
 * REST review H-2 — the ONE error envelope contract.
 *
 * Before this ticket the gateway emitted four mutually incompatible error
 * bodies, so no client could write a single error handler:
 *
 *   1. class-validator failures  → `{statusCode, message, error, subErrors, correlationId}` — no `code`
 *   2. `DataNotFoundExceptionFilter` → `{statusCode, message}` — no `code`, no `correlationId`
 *   3. domain exceptions (`toJSON()`) → `{code, message, metadata, correlationId}` — NO `statusCode`
 *   4. sanitised Prisma failures → `{statusCode, error, correlationId}` — no `code`, no `message`
 *
 * This suite pins ONE representative error of each class to the unified
 * envelope `{statusCode, code, message, correlationId}` — additively: every
 * field each shape emitted before must still be present under its own name.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ArgumentInvalidException, DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { PrismaClientKnownRequestError } from '@arcaai/database';
import { ArgumentsHost, BadRequestException, CallHandler, ExecutionContext, ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ExceptionInterceptor } from '../../interceptors/exception.interceptor';
import { DataNotFoundExceptionFilter } from '../data-not-found.filter';
import { HttpExceptionEnvelopeFilter } from '../http-exception-envelope.filter';
import { containsTopology } from '../downstream-error';

const CORRELATION_ID = '018f67d0-323e-7635-8804-962b005ace10';

function makeInterceptor(): ExceptionInterceptor {
  const cls = {
    getId: () => CORRELATION_ID,
    get: () => undefined,
  } as unknown as ClsService<any>;
  return new ExceptionInterceptor(cls);
}

function makeExecutionContext(): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'PATCH', url: '/api/v1/admin/departments/d-1' }),
      getResponse: () => ({ setHeader: vi.fn(), getHeader: () => undefined }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** Run one thrown error through `ExceptionInterceptor` and return the response body it produced. */
async function bodyFor(err: unknown): Promise<Record<string, unknown>> {
  const interceptor = makeInterceptor();
  const next: CallHandler = { handle: () => throwError(() => err) };
  try {
    await firstValueFrom(interceptor.intercept(makeExecutionContext(), next));
  } catch (caught) {
    const response = caught instanceof HttpException ? caught.getResponse() : (caught as any)?.response;
    return (typeof response === 'object' ? response : { message: response }) as Record<string, unknown>;
  }
  throw new Error('expected the interceptor to rethrow');
}

/** The four envelope keys every gateway error body must carry. */
function expectUnifiedEnvelope(body: Record<string, unknown>, expected: { statusCode: number; code: string }): void {
  expect(typeof body['statusCode']).toBe('number');
  expect(body['statusCode']).toBe(expected.statusCode);
  expect(typeof body['code']).toBe('string');
  expect(body['code']).toBe(expected.code);
  expect(typeof body['message']).toBe('string');
  expect((body['message'] as string).length).toBeGreaterThan(0);
  expect(typeof body['correlationId']).toBe('string');
}

describe('H-2 — unified error envelope', () => {
  it('shape 1 — class-validator failure carries the envelope AND keeps `error` + `subErrors`', async () => {
    const raw = new BadRequestException({ statusCode: 400, message: ['name must be a string'], error: 'Bad Request' });
    const body = await bodyFor(raw);

    expectUnifiedEnvelope(body, { statusCode: 400, code: 'VALIDATION.FAILED' });
    // Additive: nothing the old shape emitted was renamed or dropped.
    expect(body['message']).toBe('Validation error');
    expect(body['error']).toBe('Bad Request');
    expect(body['subErrors']).toEqual(['name must be a string']);
    // `details` is the envelope's generic slot — a duplicate of `subErrors`, never a rename.
    expect(body['details']).toEqual(['name must be a string']);
  });

  it('shape 2 — DataNotFoundExceptionFilter carries the envelope and still hides the model + row id', () => {
    const jsonSpy = vi.fn().mockReturnThis();
    const statusSpy = vi.fn().mockReturnValue({ json: jsonSpy });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/v1/admin/users/u-404', requestId: CORRELATION_ID }),
        getResponse: () => ({ status: statusSpy }),
      }),
    } as unknown as ArgumentsHost;

    // `DataNotFoundException(entity, entityId)` builds the message itself —
    // `[DB] User with ID user-123 could not be found.` — which is precisely the
    // detail the filter must NOT leak to the client.
    new DataNotFoundExceptionFilter().catch(new DataNotFoundException('User', 'user-123'), host);

    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expectUnifiedEnvelope(body, { statusCode: 404, code: 'HTTP.NOT_FOUND' });
    // Security posture unchanged: generic message, no model name, no row id.
    expect(body['message']).toBe('Resource not found');
    expect(JSON.stringify(body)).not.toContain('user-123');
    expect(JSON.stringify(body)).not.toContain('User');
  });

  it('shape 3 — a domain exception (412 OCC) now carries `statusCode` and keeps `code` + `metadata`', async () => {
    const body = await bodyFor(new OptimisticConcurrencyException('Department', 'd-1', { expectedVersion: 3, currentVersion: 4 }));

    expectUnifiedEnvelope(body, { statusCode: 412, code: 'PERSISTENCE.CONCURRENCY_CONFLICT' });
    expect(body['metadata']).toMatchObject({ expectedVersion: 3, currentVersion: 4 });
  });

  it('shape 3b — another domain class (400 ArgumentInvalid) uses the same envelope', async () => {
    const body = await bodyFor(new ArgumentInvalidException('tier is not writable'));

    expectUnifiedEnvelope(body, { statusCode: 400, code: 'GENERIC.ARGUMENT_INVALID' });
  });

  it('shape 4 — a sanitised Prisma failure carries the envelope and still leaks nothing', async () => {
    const prismaError = new PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
      code: 'P2002',
      clientVersion: '7.8.0',
      meta: { target: ['email'], modelName: 'User' },
    });
    const body = await bodyFor(prismaError);

    expectUnifiedEnvelope(body, { statusCode: 409, code: 'PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION' });
    expect(body['error']).toBe('Unique constraint violation');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('P2002');
    expect(containsTopology(serialized)).toBe(false);
  });

  it('a plain HttpException (no domain code) still gets a status-derived `code`', async () => {
    const body = await bodyFor(new HttpException({ statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' }, 403));

    expectUnifiedEnvelope(body, { statusCode: 403, code: 'HTTP.FORBIDDEN' });
  });
});

/**
 * Shape 5 — GUARD-thrown errors, the highest-volume error class on the gateway.
 *
 * Guards run BEFORE interceptors, so none of these ever reach
 * `ExceptionInterceptor`; they land in the filter chain, where
 * `HttpExceptionEnvelopeFilter` normalizes them. Before it, all four shipped
 * the bare Nest body `{message, error, statusCode}` — no `code`, no
 * `correlationId` — so a client switching on `body.code` broke on every 401.
 *
 * The four cases mirror the live probes on :8968: unauthenticated 401,
 * invalid-API-key 401, missing-ability 403, and `@ForbidApiKey` 403.
 */
describe('H-2 — guard-thrown errors (UnifiedAuthGuard & friends)', () => {
  const filter = new HttpExceptionEnvelopeFilter({ getId: () => CORRELATION_ID } as unknown as any);

  function catchThrough(exception: HttpException): Record<string, unknown> {
    const jsonSpy = vi.fn().mockReturnThis();
    const statusSpy = vi.fn().mockReturnValue({ json: jsonSpy });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/v1/auth/me' }),
        getResponse: () => ({ status: statusSpy }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);
    expect(statusSpy).toHaveBeenCalledWith(exception.getStatus());
    return jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  const guardCases: Array<{ label: string; exception: HttpException; statusCode: number; code: string; message: string; error: string }> = [
    {
      label: 'no credential',
      exception: new UnauthorizedException('Authentication required. Provide a Bearer token or an API key.'),
      statusCode: 401,
      code: 'HTTP.UNAUTHORIZED',
      message: 'Authentication required. Provide a Bearer token or an API key.',
      error: 'Unauthorized',
    },
    {
      label: 'invalid API key',
      exception: new UnauthorizedException('Invalid API key'),
      statusCode: 401,
      code: 'HTTP.UNAUTHORIZED',
      message: 'Invalid API key',
      error: 'Unauthorized',
    },
    {
      label: 'missing ability',
      exception: new ForbiddenException('Requires at least one of: manage:User, read:AdminUserDirectory'),
      statusCode: 403,
      code: 'HTTP.FORBIDDEN',
      message: 'Requires at least one of: manage:User, read:AdminUserDirectory',
      error: 'Forbidden',
    },
    {
      label: '@ForbidApiKey route reached with an API key',
      exception: new ForbiddenException('This route does not accept API-key authentication'),
      statusCode: 403,
      code: 'HTTP.FORBIDDEN',
      message: 'This route does not accept API-key authentication',
      error: 'Forbidden',
    },
  ];

  for (const c of guardCases) {
    it(`${c.statusCode} (${c.label}) carries the envelope and keeps its message + error verbatim`, () => {
      const body = catchThrough(c.exception);

      expectUnifiedEnvelope(body, { statusCode: c.statusCode, code: c.code });
      // Purely additive: the guard's own wording is never rewritten.
      expect(body['message']).toBe(c.message);
      expect(body['error']).toBe(c.error);
    });
  }

  it('a string-bodied HttpException is lifted into the envelope rather than shipped bare', () => {
    const body = catchThrough(new HttpException('Upstream refused the request', 502));

    expectUnifiedEnvelope(body, { statusCode: 502, code: 'HTTP.BAD_GATEWAY' });
    expect(body['message']).toBe('Upstream refused the request');
  });

  it('never overwrites a body that already carries a domain `code` (interceptor-built bodies pass through)', () => {
    const body = catchThrough(
      new HttpException({ statusCode: 412, code: 'PERSISTENCE.CONCURRENCY_CONFLICT', message: 'conflict', correlationId: 'other-id' }, 412),
    );

    expect(body['code']).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
    expect(body['correlationId']).toBe('other-id');
  });
});
