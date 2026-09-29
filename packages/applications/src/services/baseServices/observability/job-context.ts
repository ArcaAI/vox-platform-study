/**
 * Trace + request-id propagation across BullMQ.
 *
 * Producer side: {@link attachJobTrace} stamps the reserved `_trace` key onto
 * job data. Consumer side: {@link runJobInContext} restores the OTel context,
 * opens a fresh CLS scope whose id is the originating request id, and logs a
 * failed job exactly once before rethrowing (retry semantics are untouched).
 *
 * `_trace` shape: `{ traceparent?, tracestate?, requestId? }`. Absent keys are
 * omitted. A caller-supplied `_trace` is never overwritten.
 */
import { Logger } from '@nestjs/common';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { trace } from '@opentelemetry/api';
import { TRACEPARENT_HEADER, TRACESTATE_HEADER, TraceCarrier, injectTraceCarrier, withTraceContext } from './trace-propagation';

export const JOB_TRACE_KEY = '_trace';

export interface JobTrace {
  traceparent?: string;
  tracestate?: string;
  requestId?: string;
}

/** The subset of a BullMQ `Job` this module reads. */
export interface JobLike {
  id?: string | number;
  queueName?: string;
  attemptsMade?: number;
  data?: unknown;
}

const logger = new Logger('JobContext');

/** The current request id (the CLS id), or `undefined` outside a CLS scope. */
export function currentRequestId(): string | undefined {
  try {
    const id = ClsServiceManager.getClsService().getId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The active span's trace id (32 hex), or `undefined` when there is none. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && trace.isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

/** Build the `_trace` value from the active context; `undefined` when nothing is known. */
export function buildJobTrace(): JobTrace | undefined {
  const carrier = injectTraceCarrier();
  const out: JobTrace = {};
  if (carrier[TRACEPARENT_HEADER]) out.traceparent = carrier[TRACEPARENT_HEADER];
  if (carrier[TRACESTATE_HEADER]) out.tracestate = carrier[TRACESTATE_HEADER];
  const requestId = currentRequestId();
  if (requestId) out.requestId = requestId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Return `data` with `_trace` attached (a new object; `data` is not mutated). Non-objects and pre-set `_trace` pass through. */
export function attachJobTrace<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (JOB_TRACE_KEY in (data as Record<string, unknown>)) return data;
  const jobTrace = buildJobTrace();
  return jobTrace ? ({ ...data, [JOB_TRACE_KEY]: jobTrace } as T) : data;
}

function readJobTrace(job: JobLike): JobTrace | undefined {
  const data = job.data;
  if (!data || typeof data !== 'object') return undefined;
  const raw = (data as Record<string, unknown>)[JOB_TRACE_KEY];
  return raw && typeof raw === 'object' ? (raw as JobTrace) : undefined;
}

/**
 * Run a job body inside the restored trace context and a fresh CLS scope whose
 * id is the originating request id (`job:<id>` when the producer had none).
 * `fn` is expected to bind tenant/user itself, as processors already do.
 * Pass `undefined` for `cls` when the processor has no CLS handle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- processors type their CLS store differently
export function runJobInContext<T>(cls: ClsService<any> | undefined, job: JobLike, fn: () => Promise<T>): Promise<T> {
  const jobTrace = readJobTrace(job);
  const carrier: TraceCarrier = {};
  if (jobTrace?.traceparent) carrier[TRACEPARENT_HEADER] = jobTrace.traceparent;
  if (jobTrace?.tracestate) carrier[TRACESTATE_HEADER] = jobTrace.tracestate;

  const body = async (): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      logger.error({
        message: 'Job failed',
        queue: job.queueName,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        errorName: error instanceof Error ? error.name : typeof error,
        error,
      });
      throw error;
    }
  };

  const scoped = (): Promise<T> => {
    if (!cls) return body();
    return cls.run(async () => {
      // nestjs-cls has no `setId`; the request id is the store's CLS_ID slot (what `getId()` reads).
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, jobTrace?.requestId ?? `job:${job.id ?? 'unknown'}`);
      return body();
    });
  };

  return withTraceContext(carrier, scoped);
}
