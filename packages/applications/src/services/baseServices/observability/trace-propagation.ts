/**
 * W3C trace-context propagation across async boundaries (TASK-636 OBS-16).
 *
 * WHY THIS EXISTS
 * Before this module, `traceparent` appeared in exactly ONE place server-side:
 * the CORS allow-list (`apps/api/src/cors.headers.ts`). HTTP hops were
 * continued by `@opentelemetry/instrumentation-http`, but every NON-HTTP hop —
 * Redis Streams (STT audio/control/result), the SSE relay, the WebSocket
 * gateway — severed the trace. `hope-api` therefore emitted spans that never
 * left the gateway.
 *
 * WHAT IT DOES
 * Turns an OTel `Context` into a flat `Record<string, string>` carrier that
 * survives any string-keyed transport (Redis Stream fields, SSE fields, JSON
 * frames), and back again. It is a thin, typed wrapper over the GLOBAL
 * propagator (`propagation.inject` / `propagation.extract`) — the W3C
 * traceparent format is never parsed by hand here.
 *
 * DESIGN CONSTRAINTS (all load-bearing)
 *
 *   - **Context, never payload.** Only `traceparent` / `tracestate` cross this
 *     seam. No span attributes, no transcripts, no audio, no request bodies —
 *     the streams these carriers ride on are PHI-bearing (see
 *     `../logging/redactor.ts`). A trace id is an internal identifier, in the
 *     same class as the ids that redactor deliberately PRESERVES.
 *
 *   - **Free when tracing is off (TASK-411).** With no global propagator
 *     registered — the state of any process that never starts the OTel SDK —
 *     `propagation.inject` is a no-op and {@link injectTraceCarrier} returns
 *     `{}`. Callers then add zero fields to their write. With a propagator
 *     registered but no valid span in context, the W3C propagator itself
 *     returns early. So the "disabled" cost is one function call that writes
 *     nothing, on both counts.
 *
 *   - **Never a new failure mode.** Nothing here throws: an absent, malformed
 *     or partially-written carrier yields `undefined` and the caller simply
 *     starts a fresh trace, exactly as it did before this module existed. A
 *     broken trace is an observability defect; a broken audio stream is a
 *     clinical one.
 */
import { Context, context, propagation, trace } from '@opentelemetry/api';

/** W3C Trace Context header names — the only keys this seam ever writes. */
export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/**
 * The exact set of keys allowed onto (and off) a carrier. An allow-list rather
 * than "whatever the propagator wrote" so that swapping in a propagator that
 * carries extra baggage can never smuggle a payload field onto a PHI-bearing
 * Redis stream.
 */
const CARRIER_KEYS: readonly string[] = Object.freeze([TRACEPARENT_HEADER, TRACESTATE_HEADER]);

/** Flat string map — the shape every transport in this repo can carry. */
export type TraceCarrier = Record<string, string>;

/**
 * Serialise a context into a flat carrier.
 *
 * @param ctx Context to serialise (default: the active context).
 * @returns `{}` when tracing is disabled or there is no valid span — callers
 *          should treat an empty carrier as "add nothing to the message".
 */
export function injectTraceCarrier(ctx: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  try {
    propagation.inject(ctx, carrier);
  } catch {
    // A propagator must never break the data path it is riding on.
    return {};
  }
  // Defensive projection: only the two W3C keys survive.
  const projected: TraceCarrier = {};
  for (const key of CARRIER_KEYS) {
    const value = carrier[key];
    if (typeof value === 'string' && value.length > 0) projected[key] = value;
  }
  return projected;
}

/**
 * Deserialise a carrier back into a context whose active span is the REMOTE
 * parent.
 *
 * @returns `undefined` when the carrier holds no usable parent — deliberately
 *          NOT the active context, so callers can distinguish "continue this
 *          trace" from "there was nothing to continue".
 */
export function extractTraceCarrier(carrier: TraceCarrier | undefined | null): Context | undefined {
  if (!carrier || typeof carrier !== 'object') return undefined;
  const traceparent = carrier[TRACEPARENT_HEADER];
  if (typeof traceparent !== 'string' || traceparent.length === 0) return undefined;
  try {
    const extracted = propagation.extract(context.active(), carrier);
    return hasTraceContext(extracted) ? extracted : undefined;
  } catch {
    return undefined;
  }
}

/** True when `ctx` carries a span context that is valid enough to parent from. */
export function hasTraceContext(ctx: Context = context.active()): boolean {
  const spanContext = trace.getSpanContext(ctx);
  return !!spanContext && trace.isSpanContextValid(spanContext);
}

/**
 * Run `fn` with the carrier's remote parent installed as the active context.
 *
 * When the carrier holds no parent the callback still runs, unwrapped — this
 * is a propagation helper, not a gate.
 */
export function withTraceContext<T>(carrier: TraceCarrier | undefined | null, fn: () => T): T {
  const extracted = extractTraceCarrier(carrier);
  if (!extracted) return fn();
  return context.with(extracted, fn);
}

/**
 * Build a carrier from ioredis's flat `[key, value, key, value, ...]` stream
 * reply, taking ONLY the trace headers.
 *
 * Callers already parse these arrays into a payload object; this exists so the
 * trace headers can be lifted out without that payload object (which carries
 * transcript text) ever being handed to a propagator.
 */
export function traceCarrierFromFields(fields: readonly string[] | undefined | null): TraceCarrier {
  const carrier: TraceCarrier = {};
  if (!fields) return carrier;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    if (CARRIER_KEYS.includes(key)) carrier[key] = fields[i + 1];
  }
  return carrier;
}

/**
 * Flatten a carrier into the alternating `key, value, ...` argument list an
 * ioredis `XADD` takes. Empty carrier → empty list, so the call site stays a
 * plain spread with no branching.
 */
export function traceCarrierToArgs(carrier: TraceCarrier): string[] {
  const args: string[] = [];
  for (const key of CARRIER_KEYS) {
    const value = carrier[key];
    if (typeof value === 'string' && value.length > 0) args.push(key, value);
  }
  return args;
}
