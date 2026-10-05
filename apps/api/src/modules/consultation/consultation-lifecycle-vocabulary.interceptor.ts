import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { HOPE_LIFECYCLE_HEADER, projectLegacyConsultationStatus, wantsLifecycleVocabulary } from '@arcaai/applications';
import { ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';

const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set(Object.values(ConsultationStatus));
const PROCESSING_VALUES: ReadonlySet<string> = new Set(Object.values(ConsultationProcessing));

/** How deep the walk looks for consultation-shaped objects (paginated lists, chains, wrappers). */
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  // DTO class instances are fine; Dates, Buffers, Maps and the like are not walked.
  return !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Map) && !(value instanceof Set) && proto !== null;
}

/**
 * The lifecycle pair an object carries, if it is a consultation (`lifecycle: {status, processing}`)
 * or a capture state (`consultationId` + `status` + `processing` at the top level).
 */
function lifecyclePairOf(value: Record<string, unknown>): { status: string; processing: string; fromCapture: boolean } | null {
  const lifecycle = value.lifecycle;
  if (isPlainObject(lifecycle) && typeof lifecycle.status === 'string' && LIFECYCLE_STATUSES.has(lifecycle.status)) {
    const processing = typeof lifecycle.processing === 'string' && PROCESSING_VALUES.has(lifecycle.processing) ? lifecycle.processing : 'IDLE';
    return { status: lifecycle.status, processing, fromCapture: false };
  }
  if (
    typeof value.consultationId === 'string' &&
    typeof value.status === 'string' &&
    LIFECYCLE_STATUSES.has(value.status) &&
    typeof value.processing === 'string' &&
    PROCESSING_VALUES.has(value.processing)
  ) {
    return { status: value.status, processing: value.processing, fromCapture: true };
  }
  return null;
}

function project(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const next = project(entry, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!isPlainObject(value)) return value;

  let out: Record<string, unknown> | null = null;
  const pair = lifecyclePairOf(value);
  if (pair && typeof value.status === 'string') {
    out = {
      ...value,
      status: projectLegacyConsultationStatus(pair.status as never, pair.processing as never),
      ...(pair.fromCapture ? { lifecycle: { status: pair.status, processing: pair.processing } } : {}),
    };
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'lifecycle' || child === null || typeof child !== 'object') continue;
    const next = project(child, depth + 1);
    if (next !== child) {
      out ??= { ...value };
      out[key] = next;
    }
  }
  return out ?? value;
}

/**
 * Project every consultation `status` in a response body onto the previous twelve-value
 * vocabulary. The real value stays under `lifecycle: { status, processing }` (added to a capture
 * state, which has no such field of its own). Objects that are not consultation-shaped — a job, a
 * governing run — keep their own `status`. Pure: the input is never mutated.
 */
export function projectLifecycleVocabulary(body: unknown): unknown {
  return project(body, 0);
}

/**
 * Older clients (ALaaS 4.1) read the twelve-value status. A request carrying
 * `X-Hope-Lifecycle: 2` (the SDK 5 clients) gets the seven-value vocabulary as is; every other
 * request gets `status` projected. Scoped to the business-plane consultation controllers.
 */
@Injectable()
export class ConsultationLifecycleVocabularyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const response = http.getResponse<{ vary?: (field: string) => unknown }>();
    // The body differs by this header, so caches must key on it.
    response?.vary?.(HOPE_LIFECYCLE_HEADER);
    if (wantsLifecycleVocabulary(request?.headers?.[HOPE_LIFECYCLE_HEADER])) {
      return next.handle();
    }
    return next.handle().pipe(map((body) => projectLifecycleVocabulary(body)));
  }
}
