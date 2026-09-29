/**
 * `logWsFailure` — the one shape a WebSocket gateway failure is logged in.
 *
 * A WS failure has no HTTP request, no exception filter and no CLS request id,
 * so each gateway used to log its own ad-hoc line (`error: err.message`, no
 * stack, no tenant, no way for the client to quote it). The helper writes one
 * line with the session's identity and the Error itself, and returns the
 * correlation id the gateway puts on the client's `error` frame.
 */
import { describe, expect, it, vi } from 'vitest';

import { logWsFailure, wsClientIp } from '../ws-failure-log';

const logger = () => ({ error: vi.fn(), warn: vi.fn() });

describe('logWsFailure', () => {
  it('logs one error line with the session identity and the Error, and returns its correlation id', () => {
    const l = logger();
    const err = new TypeError('socket write failed');

    const correlationId = logWsFailure(
      l,
      {
        message: 'ws.frame_failed',
        sessionId: 's-1',
        tenantId: 't-1',
        userId: 'u-1',
        clientIp: '10.0.0.9',
        origin: 'https://app.example',
        closeCode: 1011,
      },
      err,
    );

    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);
    expect(l.error).toHaveBeenCalledTimes(1);
    expect(l.error.mock.calls[0][0]).toMatchObject({
      message: 'ws.frame_failed',
      correlationId,
      sessionId: 's-1',
      tenantId: 't-1',
      userId: 'u-1',
      clientIp: '10.0.0.9',
      origin: 'https://app.example',
      closeCode: 1011,
      errorName: 'TypeError',
      error: err,
    });
  });

  it('honours an explicit level and an existing correlation id', () => {
    const l = logger();
    const correlationId = logWsFailure(l, { message: 'ws.read_failed', correlationId: 'given-id', level: 'warn' }, new Error('x'));
    expect(correlationId).toBe('given-id');
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.error).not.toHaveBeenCalled();
  });

  it('wraps a non-Error thrown value', () => {
    const l = logger();
    logWsFailure(l, { message: 'ws.x' }, 'plain string');
    expect(l.error.mock.calls[0][0]).toMatchObject({ errorName: 'Error' });
    expect((l.error.mock.calls[0][0] as { error: Error }).error.message).toBe('plain string');
  });

  it('omits absent identity fields instead of logging undefined', () => {
    const l = logger();
    logWsFailure(l, { message: 'ws.x', sessionId: 's-2' }, new Error('x'));
    expect(l.error.mock.calls[0][0]).not.toHaveProperty('tenantId');
    expect(l.error.mock.calls[0][0]).not.toHaveProperty('origin');
  });
});

describe('wsClientIp', () => {
  it('falls back to the socket peer when no trusted proxy is configured', () => {
    expect(wsClientIp({ socket: { remoteAddress: '192.0.2.4' }, headers: {} } as never)).toBe('192.0.2.4');
  });
});
