/**
 * TASK-636 OBS-16 — the browser SDK must emit a traceparent the SERVER accepts.
 *
 * `AgenticClient` derives the trace id from the logger's correlation id:
 *
 *   correlationId.replace(/-/g, '').slice(0, 32).padStart(32, '0')
 *
 * That is fine for the default correlation id (`crypto.randomUUID()`, pure hex
 * + dashes). But `SDKLogger.setCorrelationId()` is PUBLIC — a host app that
 * threads its own request id through it (`'req-9f3a'`, `'order_12'`, an
 * opaque token) produces a "trace id" containing non-hex characters.
 *
 * A W3C propagator REJECTS such a traceparent and silently starts a brand new
 * trace server-side. Nothing errors, nothing logs — the browser hop just
 * quietly vanishes from every trace. That is the exact failure mode OBS-16
 * exists to close, sitting one hop upstream of the Redis/SSE/WebSocket work.
 *
 * `toW3CTraceId` is the guard: derive from the correlation id when that yields
 * a VALID id, otherwise fall back to a freshly generated one. Correlation is
 * still available via the `X-Correlation-ID` header the client already sends,
 * so nothing is lost — an invalid id was never correlating anything anyway.
 */
import { describe, expect, it } from 'vitest';
import { toW3CTraceId } from '../utils';

/** The same validity rule a W3C propagator applies. */
const VALID_TRACE_ID = /^[0-9a-f]{32}$/;

describe('TASK-636 OBS-16 — toW3CTraceId', () => {
  it('derives a valid trace id from a UUID correlation id (the default path)', () => {
    const traceId = toW3CTraceId('4bf92f35-77b3-4da6-a3ce-929d0e0e4736');
    expect(traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('is stable — the same correlation id always yields the same trace id', () => {
    const id = '4bf92f35-77b3-4da6-a3ce-929d0e0e4736';
    expect(toW3CTraceId(id)).toBe(toW3CTraceId(id));
  });

  it('accepts an already-bare 32-char hex correlation id', () => {
    expect(toW3CTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  describe('falls back to a generated id rather than emitting an invalid traceparent', () => {
    for (const correlationId of ['req-9f3a-zz', 'order_12', 'ABCDEF', 'not hex at all', '你好', '']) {
      it(`for ${JSON.stringify(correlationId)}`, () => {
        const traceId = toW3CTraceId(correlationId);
        expect(traceId).toMatch(VALID_TRACE_ID);
        // A generated id, not a mangled derivation of the input.
        expect(traceId).not.toContain('req');
      });
    }
  });

  it('never returns the all-zero trace id, which W3C defines as invalid', () => {
    // `padStart` on a short correlation id used to be able to approach this.
    expect(toW3CTraceId('0')).not.toBe('0'.repeat(32));
    expect(toW3CTraceId('00000000-0000-0000-0000-000000000000')).not.toBe('0'.repeat(32));
  });

  it('lower-cases hex — W3C traceparent is case-sensitive and lowercase-only', () => {
    const traceId = toW3CTraceId('4BF92F35-77B3-4DA6-A3CE-929D0E0E4736');
    expect(traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('always produces something a W3C propagator will parse', () => {
    for (const input of ['x', undefined, 'a'.repeat(200), '----', '4bf92f35-77b3-4da6-a3ce-929d0e0e4736']) {
      expect(toW3CTraceId(input as string)).toMatch(VALID_TRACE_ID);
    }
  });
});
