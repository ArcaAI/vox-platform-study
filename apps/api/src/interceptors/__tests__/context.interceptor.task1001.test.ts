import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ContextInterceptor } from '../context.interceptor';

/**
 * TASK-1001 S-8 — `ContextInterceptor` used to log "Request completed" once
 * PER EMITTED VALUE (inside `tap.next`) instead of once per request. That is
 * invisible on an ordinary single-emission JSON response, but a long-lived
 * `@Sse()` stream (e.g. the live-summary channel) emits one value per frame
 * over its whole lifetime, so a single connection produced dozens of
 * "Request completed" log lines with a growing `durationMs` — corrupting any
 * log-based count of requests/connections.
 *
 * These tests pin the fix directly against RxJS emission shape, independent
 * of any real SSE transport: a multi-emission Observable (standing in for a
 * streaming response) must still log the completion line exactly once, and a
 * single-emission Observable (an ordinary response) must be unaffected.
 */
describe('ContextInterceptor — S-8 single completion log', () => {
  // `any`-typed to match the sibling `context.interceptor.test.ts` suite's
  // convention: the tests reach into the private `logger` field by bracket
  // access, which TypeScript's private-member check would otherwise reject.
  let interceptor: any;
  let mockClsService: any;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function createMockContext(): ExecutionContext {
    const request: Record<string, unknown> = {
      url: '/api/v1/consultations/abc/live-summary/stream',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
      body: {},
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
  }

  /** Emits `count` values asynchronously (one per microtask tick), then completes — standing in for an SSE stream's frames. */
  function createStreamingHandler(count: number): CallHandler {
    return {
      handle: () =>
        new Observable<string>((subscriber) => {
          let emitted = 0;
          const emitNext = () => {
            if (emitted >= count) {
              subscriber.complete();
              return;
            }
            emitted += 1;
            subscriber.next(`frame-${emitted}`);
            // Simulate frames arriving over time (heartbeats, section patches)
            // rather than all synchronously — matches how a real SSE relay behaves.
            queueMicrotask(emitNext);
          };
          emitNext();
        }),
    };
  }

  function createSingleEmissionHandler(): CallHandler {
    return {
      handle: () =>
        new Observable<string>((subscriber) => {
          subscriber.next('response-value');
          subscriber.complete();
        }),
    };
  }

  /** Subscribes to completion (collects every emitted value, resolves on complete). */
  function drain<T>(obs$: Observable<T>): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const values: T[] = [];
      obs$.subscribe({
        next: (v) => values.push(v),
        error: reject,
        complete: () => resolve(values),
      });
    });
  }

  function completionLogCalls() {
    return logSpy.mock.calls.filter((call) => (call[0] as { message?: string })?.message === 'Request completed');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      getId: vi.fn().mockReturnValue('test-request-id'),
    };
    interceptor = new ContextInterceptor(mockClsService);
    logSpy = vi.spyOn(interceptor['logger'], 'log');
  });

  it('logs "Request completed" exactly ONCE for a multi-emission (streaming) observable', async () => {
    const context = createMockContext();
    const handler = createStreamingHandler(5); // 5 "frames", like 5 SSE events on one connection

    const values = await drain(interceptor.intercept(context, handler));

    expect(values).toHaveLength(5); // every frame still reaches the subscriber unchanged
    expect(completionLogCalls()).toHaveLength(1);
  });

  it('still logs "Request completed" exactly ONCE for an ordinary single-emission observable', async () => {
    const context = createMockContext();
    const handler = createSingleEmissionHandler();

    const values = await drain(interceptor.intercept(context, handler));

    expect(values).toEqual(['response-value']);
    expect(completionLogCalls()).toHaveLength(1);
  });

  it('logs the completion line only after the LAST frame, with the total elapsed duration', async () => {
    const context = createMockContext();
    const handler = createStreamingHandler(3);

    await drain(interceptor.intercept(context, handler));

    const calls = completionLogCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does NOT log "Request completed" for a request that errors (its failure line is the filter\'s)', async () => {
    const context = createMockContext();
    const handler: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          subscriber.next('frame-1');
          subscriber.error(new Error('boom'));
        }),
    };

    await expect(drain(interceptor.intercept(context, handler))).rejects.toThrow('boom');

    // An errored request producing zero "Request completed" entries is
    // exactly the `hasErrored` guard; its single failure line is written by
    // the terminal exception filter, not by this interceptor.
    expect(completionLogCalls()).toHaveLength(0);
  });

  it('logs "Request completed" exactly once even when the subscriber unsubscribes before the stream would naturally complete (e.g. an SSE client disconnecting)', async () => {
    const context = createMockContext();
    let unsubscribed = false;
    const handler: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          subscriber.next('frame-1');
          return () => {
            unsubscribed = true;
          };
        }),
    };

    const subscription = interceptor.intercept(context, handler).subscribe();
    subscription.unsubscribe();

    expect(unsubscribed).toBe(true);
    expect(completionLogCalls()).toHaveLength(1);
  });
});
