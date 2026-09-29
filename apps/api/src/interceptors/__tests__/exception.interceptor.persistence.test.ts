/**
 * Persistence exceptions raised by non-repository code keep the HTTP contract
 * their raw-Prisma equivalents get, instead of falling into the generic
 * `BaseException` → 500 branch:
 *
 *   DataConflictException        → 409, the P2002 body
 *   DatabaseConnectionException  → 503 + Retry-After, a generic body
 *   QueryFailedException         → the status/body its Prisma cause code maps to
 *                                  (unmapped/no code → 400 PERSISTENCE.QUERY_INVALID)
 *
 * And a domain 500 body never carries `cause` or `stack`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for framework types */
import { PrismaClientKnownRequestError } from '@arcaai/database';
import { BaseException, DatabaseConnectionException, DataConflictException, QueryFailedException } from '@arcaai/exceptions';
import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { readFailureLogContext } from '../../filters/failure-log';
import { ExceptionInterceptor } from '../exception.interceptor';

function run(err: unknown): Promise<{ caught: any; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/x' }),
      getResponse: () => ({ setHeader: vi.fn((k: string, v: string) => (headers[k] = v)), getHeader: (k: string) => headers[k] }),
    }),
  } as unknown as ExecutionContext;
  const interceptor = new ExceptionInterceptor({ getId: () => 'corr-p', get: () => undefined } as any);
  const next: CallHandler = { handle: () => throwError(() => err) };
  return firstValueFrom(interceptor.intercept(context, next)).then(
    () => {
      throw new Error('expected a throw');
    },
    (caught) => ({ caught, headers }),
  );
}

function prismaError(code: string): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError(
    '\nInvalid `prisma.user.create()` invocation\n\n→ secret query\n\nUnique constraint failed on the fields: (`email`)',
    {
      code,
      clientVersion: '7.0.0',
      meta: { modelName: 'User', target: ['email'] },
    },
  );
}

async function bodyOf(err: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string>; caught: any }> {
  const { caught, headers } = await run(err);
  expect(caught).toBeInstanceOf(HttpException);
  return { status: caught.getStatus(), body: caught.getResponse(), headers, caught };
}

describe('ExceptionInterceptor — persistence exceptions', () => {
  it('DataConflictException → the same 409 body as a raw P2002', async () => {
    const raw = await bodyOf(prismaError('P2002'));
    const wrapped = await bodyOf(new DataConflictException('Data conflict occurred in the database.', prismaError('P2002')));
    expect(wrapped.status).toBe(409);
    expect(wrapped.body).toEqual(raw.body);
    expect(readFailureLogContext(wrapped.caught)).toMatchObject({ prismaCode: 'P2002', modelName: 'User', errorName: 'DataConflictException' });
    expect(JSON.stringify(readFailureLogContext(wrapped.caught))).not.toContain('secret query');
  });

  it('DatabaseConnectionException → 503 with Retry-After and a generic body', async () => {
    const { status, body, headers } = await bodyOf(new DatabaseConnectionException());
    expect(status).toBe(503);
    expect(headers['Retry-After']).toBeDefined();
    expect(body).toEqual({
      statusCode: 503,
      code: 'PERSISTENCE.DATABASE_CONNECTION_FAILED',
      message: 'Service temporarily unavailable',
      correlationId: 'corr-p',
    });
  });

  it('QueryFailedException → the status/body its Prisma cause maps to', async () => {
    const raw = await bodyOf(prismaError('P2003'));
    const wrapped = await bodyOf(new QueryFailedException('Database query failed to execute.', prismaError('P2003')));
    expect(wrapped.status).toBe(raw.status);
    expect(wrapped.body).toEqual(raw.body);
  });

  it('QueryFailedException without a Prisma cause → the default 400 PERSISTENCE.QUERY_INVALID, logged at error', async () => {
    const wrapped = await bodyOf(new QueryFailedException());
    expect(wrapped.status).toBe(400);
    expect(wrapped.body.code).toBe('PERSISTENCE.QUERY_INVALID');
    expect(readFailureLogContext(wrapped.caught)?.level).toBe('error');
  });
});

describe('ExceptionInterceptor — generic domain 500', () => {
  class OpaqueException extends BaseException {
    code = 'TEST.OPAQUE';
  }

  it('body carries neither cause nor stack; the original error rides the failure line', async () => {
    const original = new OpaqueException('opaque', new Error('root'));
    const { status, body, caught } = await bodyOf(original);
    expect(status).toBe(500);
    expect(body).not.toHaveProperty('cause');
    expect(body).not.toHaveProperty('stack');
    expect(readFailureLogContext(caught)?.error).toBe(original);
  });
});
