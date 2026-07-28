/**
 * Mock for @opentelemetry/api
 */

export const context = {
  active: () => ({}),
  with: (_ctx: any, fn: () => any) => fn(),
};

export const trace = {
  getTracer: () => ({
    startSpan: () => ({
      end: () => {},
      setAttribute: () => {},
      setAttributes: () => {},
      addEvent: () => {},
      recordException: () => {},
      setStatus: () => {},
      isRecording: () => true,
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: 0,
      }),
    }),
  }),
  getSpanContext: () => undefined,
  getActiveSpan: () => undefined,
  setSpan: (ctx: any) => ctx,
};

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
};

export default { context, trace, SpanStatusCode, SpanKind };
