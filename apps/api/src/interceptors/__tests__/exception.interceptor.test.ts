/**
 * Unit tests for ExceptionInterceptor's OCC -> 412 mapping
 * (TASK-302 Stream D Phase C, task C.5).
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

import { ExceptionInterceptor } from '../exception.interceptor';
import { OptimisticConcurrencyException, BaseException } from '@arcaai/exceptions';

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
