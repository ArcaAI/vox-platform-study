/**
 * Unit tests for `DataNotFoundExceptionFilter`.
 *
 * `DataNotFoundException` is thrown by `Repository<T>.findById` and
 * similar fetch paths whenever a row is absent. Its native message
 * (`"[DB] User with ID user-123 could not be found."`) echoes both
 * the Prisma model name AND the row id back to the HTTP response,
 * which leaks tenant-catalogue / row-existence signal to any
 * authenticated user (a HIPAA §164.312(a)(1) information-disclosure
 * concern that mirrors the W5.1.3 / W5.2 / W5.3 "no existence leak"
 * pattern at the service layer).
 *
 * The filter MUST return a generic `{ statusCode: 404, message:
 * "Resource not found" }` body in production. Per the user-locked
 * decision in §10 Q2 of the plan README, the filter is SCOPED ONLY to
 * `DataNotFoundException` — the W5.1.3 / W5.2 / W5.3 service-layer
 * guards already throw `NotFoundException('Resource not found')`
 * directly with the right message and do NOT need filter wrapping.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { DataNotFoundExceptionFilter } from '../data-not-found.filter';

describe('DataNotFoundExceptionFilter (TASK-306 P3.3 / AC-12 — audit M-8)', () => {
  let filter: DataNotFoundExceptionFilter;
  let statusSpy: ReturnType<typeof vi.fn>;
  let jsonSpy: ReturnType<typeof vi.fn>;

  function makeArgumentsHost(): ArgumentsHost {
    statusSpy = vi.fn().mockReturnThis();
    jsonSpy = vi.fn().mockReturnThis();
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/v1/users/user-123',
          requestId: 'req-1',
        }),
        getResponse: () => ({
          status: statusSpy,
          json: jsonSpy,
        }),
      }),
    } as unknown as ArgumentsHost;
  }

  beforeEach(() => {
    filter = new DataNotFoundExceptionFilter();
  });

  it('maps DataNotFoundException to HTTP 404', () => {
    const exception = new DataNotFoundException('User', 'user-123');

    filter.catch(exception, makeArgumentsHost());

    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('returns the generic message "Resource not found" — no model name echo', () => {
    const exception = new DataNotFoundException('User', 'user-123');

    filter.catch(exception, makeArgumentsHost());

    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Resource not found',
      }),
    );
  });

  it('does not echo the model name or row id in the response body', () => {
    const exception = new DataNotFoundException('User', 'user-sensitive-id');

    filter.catch(exception, makeArgumentsHost());

    const body = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('User');
    expect(serialized).not.toContain('user-sensitive-id');
    expect(serialized).not.toContain('modelName');
    // Native DataNotFoundException.message is "[DB] User with ID ... could not be found."
    expect(serialized).not.toContain('[DB]');
    expect(serialized).not.toContain('could not be found');
  });

  it('preserves the response shape used elsewhere in the API (statusCode + message)', () => {
    const exception = new DataNotFoundException('ApiKey', 'apikey-1');

    filter.catch(exception, makeArgumentsHost());

    const body = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ statusCode: 404, message: 'Resource not found' });
    // No nested `meta` / `metadata` / `modelName` keys leaking the row id.
    expect(body).not.toHaveProperty('meta');
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('modelName');
  });
});
