/**
 * Correlation the logger can find on its own: the active OpenTelemetry span
 * and the per-request CLS context.
 *
 * Every read is best-effort. Outside a request there is no CLS context, with
 * tracing off there is no span, and neither may ever turn a log call into a
 * throw — absent means the key is simply omitted from the line.
 */

import { isSpanContextValid, trace } from '@opentelemetry/api';
import { ClsServiceManager } from 'nestjs-cls';

export interface AmbientContext {
  traceId?: string;
  spanId?: string;
  requestId?: string;
  tenantId?: string;
  userId?: string;
  credentialClass?: string;
}

/** CLS keys the gateway sets per request (the CLS id itself is the request id). */
const CLS_KEYS = ['tenantId', 'userId', 'credentialClass'] as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readAmbientContext(): AmbientContext {
  const ambient: AmbientContext = {};

  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    // A no-op or non-recording tracer yields an all-zero context; emitting
    // that would link the line to a trace that does not exist.
    if (spanContext && isSpanContextValid(spanContext)) {
      ambient.traceId = spanContext.traceId;
      ambient.spanId = spanContext.spanId;
    }
  } catch {
    // swallow-ok: no active span or tracing unavailable; the trace keys stay absent (the logger cannot log about itself)
  }

  try {
    const cls = ClsServiceManager.getClsService();
    if (cls.isActive()) {
      ambient.requestId = nonEmptyString(cls.getId());
      for (const key of CLS_KEYS) {
        const value = nonEmptyString(cls.get(key));
        if (value) ambient[key] = value;
      }
    }
  } catch {
    // swallow-ok: outside a request CLS throws; the context keys stay absent (the logger cannot log about itself)
  }

  return ambient;
}
