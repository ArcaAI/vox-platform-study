/**
 * `TenantOwnedResourceSseGuard` unit tests — pre-stream check + mid-stream
 * RESOURCE-OWNERSHIP re-check.
 *
 * A `CanActivate` guard admits an `@Sse()` stream exactly ONCE, so without a
 * re-check the ownership assertion never runs again for the stream's whole
 * lifetime (PHI on `live-summary`). The guard must re-run the SAME resource-ownership check
 * periodically and terminate the response when it reports 404 — i.e. when the
 * resource was soft-DELETED or re-tenanted mid-stream. (Identity-side
 * revocation — JWT/session invalidation, user disable, role downgrade — is NOT
 * detectable here: the CLS caller context is frozen for the stream's async
 * lifetime, and a session-revocation signal is an explicit ticket non-goal.)
 * Only the interceptor's own `NotFoundException` terminates: a TRANSIENT
 * re-check failure (DB timeout, pool exhaustion) must never cut a valid PHI
 * stream. A terminated client's EventSource reconnect faces the pre-stream
 * check again and gets its 404.
 */
import { NotFoundException } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_OWNERSHIP_RECHECK_INTERVAL_MS, TenantOwnedResourceSseGuard } from '../tenant-owned-resource-sse.guard';
import { TENANT_OWNED_RESOURCE_KEY } from '../tenant-owned-resource.decorator';

const OWNED_OPTS = { modelName: 'Consultation', paramName: 'id' };

type MockResponse = {
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
  closeHandlers: Array<() => void>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') res.closeHandlers.push(cb);
    }),
    writableEnded: false,
    closeHandlers: [],
  };
  return res;
};

const handler = function streamLiveSummary() {};
class TestController {}

const createContext = (res: MockResponse, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ url: '/api/v1/consultations/c-1/live-summary/stream', params: { id: 'c-1' } }),
    }),
  }) as unknown as ExecutionContext;

/**
 * Reflector stub: `get(SSE_METADATA, handler)` drives the SSE branch;
 * `getAllAndOverride(TENANT_OWNED_RESOURCE_KEY, ...)` exposes the decorator
 * options the re-check scheduling reads.
 */
const createReflector = ({ sse, owned }: { sse: boolean; owned: boolean }) => ({
  get: vi.fn((key: unknown) => (key === SSE_METADATA && sse ? true : undefined)),
  getAllAndOverride: vi.fn((key: unknown) => (key === TENANT_OWNED_RESOURCE_KEY && owned ? OWNED_OPTS : undefined)),
});

const createInterceptor = () => ({ assertAccess: vi.fn().mockResolvedValue(undefined) });

describe('TenantOwnedResourceSseGuard — pre-stream check (TASK-309)', () => {
  it('passes through non-http contexts without asserting', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);

    await expect(guard.canActivate(createContext(createResponse(), 'ws'))).resolves.toBe(true);
    expect(interceptor.assertAccess).not.toHaveBeenCalled();
  });

  it('passes through non-SSE handlers without asserting (interceptor owns them)', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: false, owned: true }) as never, interceptor as never);

    await expect(guard.canActivate(createContext(createResponse()))).resolves.toBe(true);
    expect(interceptor.assertAccess).not.toHaveBeenCalled();
  });

  it('runs the ownership assertion BEFORE an SSE stream opens and propagates its 404', async () => {
    const interceptor = createInterceptor();
    interceptor.assertAccess.mockRejectedValue(new NotFoundException('Resource not found'));
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);

    await expect(guard.canActivate(createContext(createResponse()))).rejects.toBeInstanceOf(NotFoundException);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(1);
  });
});

describe('TenantOwnedResourceSseGuard — mid-stream ownership re-check (TASK-460 C4-03)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-asserts ownership periodically while the stream is open', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);
    const res = createResponse();

    await guard.canActivate(createContext(res));
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(1); // admission

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(3);
    expect(res.end).not.toHaveBeenCalled(); // valid stream is never killed
  });

  it('STOPS the stream when the resource is soft-deleted / re-tenanted mid-stream (ownership 404)', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);
    const res = createResponse();

    await guard.canActivate(createContext(res)); // admitted while access was valid

    // Simulate the resource being soft-deleted / re-tenanted: the SAME
    // assertion now reports its ownership-failure 404.
    interceptor.assertAccess.mockRejectedValue(new NotFoundException('Resource not found'));

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(res.end).toHaveBeenCalledTimes(1); // stream terminated

    // Loop torn down: no further re-checks after termination.
    const callsAfterTermination = interceptor.assertAccess.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS * 3);
    expect(interceptor.assertAccess.mock.calls.length).toBe(callsAfterTermination);
  });

  // Regression guard: a bare catch would treat TRANSIENT infrastructure
  // failures (Prisma pool exhaustion, DB timeout, deadlock, Redis blip) exactly
  // like an ownership 404 and cut valid multi-hour PHI streams. Only the
  // interceptor's own NotFoundException may terminate; anything else logs and
  // lets the next interval re-check.
  it('does NOT end the stream on a transient re-check error — keeps re-checking', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);
    const res = createResponse();

    await guard.canActivate(createContext(res));

    // Transient infrastructure failure — NOT an ownership 404.
    interceptor.assertAccess.mockRejectedValueOnce(new Error('Timed out fetching a new connection from the connection pool'));

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(res.end).not.toHaveBeenCalled(); // stream survives the blip

    // Loop still alive: the next tick re-checks (healthy again) …
    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(3); // admission + 2 re-checks
    expect(res.end).not.toHaveBeenCalled();

    // … and a REAL ownership 404 afterwards still terminates.
    interceptor.assertAccess.mockRejectedValue(new NotFoundException('Resource not found'));
    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('clears the re-check loop when the client closes the stream', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: true }) as never, interceptor as never);
    const res = createResponse();

    await guard.canActivate(createContext(res));
    for (const close of res.closeHandlers) close(); // client disconnects

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS * 3);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(1); // admission only
    expect(res.end).not.toHaveBeenCalled();
  });

  it('schedules NO re-check for SSE handlers without @TenantOwnedResource (assertAccess no-ops)', async () => {
    const interceptor = createInterceptor();
    const guard = new TenantOwnedResourceSseGuard(createReflector({ sse: true, owned: false }) as never, interceptor as never);
    const res = createResponse();

    await guard.canActivate(createContext(res));

    await vi.advanceTimersByTimeAsync(SSE_OWNERSHIP_RECHECK_INTERVAL_MS * 3);
    expect(interceptor.assertAccess).toHaveBeenCalledTimes(1); // admission only — nothing to re-check
  });
});
