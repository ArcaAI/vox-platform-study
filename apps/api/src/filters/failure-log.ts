import type { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

import { REQUEST_ID_RESPONSE_HEADER, REQUEST_STARTED_AT } from '../request-id';

/**
 * The ONE failure line per failed request.
 *
 * Every component upstream of the terminal filter — guards, `ExceptionInterceptor`,
 * the validation pipe — used to log its own line and then throw, so a single
 * failed request produced two or three lines at inconsistent levels ("Request
 * failed" at `error` for every 404). Now those components ATTACH what they know
 * to the exception they throw, and the filter that writes the response writes
 * the line — once, at the level the status decides.
 *
 * The attachment key is a GLOBAL-registry symbol so code outside this app
 * (`UnifiedAuthGuard` in `@arcaai/applications`) can attach context without
 * importing this module: `Symbol.for('hope.failureLogContext')` is the same
 * symbol in every module. Non-enumerable, so it never reaches a serialized body.
 */
export const FAILURE_LOG_CONTEXT = Symbol.for('hope.failureLogContext');

const FAILURE_LOGGED = Symbol.for('hope.failureLogged');

export type FailureLogLevel = 'debug' | 'warn' | 'error';

export interface FailureLogContext {
  /** Overrides the status-derived level (e.g. an expected expired-JWT 401 stays `debug`). */
  level?: FailureLogLevel;
  /** The error to log in place of the thrown one — the ORIGINAL, when the thrown one is a mapped HttpException. */
  error?: unknown;
  /** Name of the original error, when `error` is deliberately withheld (Prisma: its message carries the query). */
  errorName?: string;
  [field: string]: unknown;
}

/** Merge `ctx` into the exception's failure-log context and return the exception. */
export function attachFailureLogContext<T>(target: T, ctx: FailureLogContext): T {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return target;
  const previous = readFailureLogContext(target) ?? {};
  Object.defineProperty(target, FAILURE_LOG_CONTEXT, {
    value: { ...previous, ...ctx },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

export function readFailureLogContext(target: unknown): FailureLogContext | undefined {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
  return (target as Record<symbol, FailureLogContext | undefined>)[FAILURE_LOG_CONTEXT];
}

/** 5xx → error; every 4xx → warn. */
export function levelForStatus(status: number): FailureLogLevel {
  return status >= 500 ? 'error' : 'warn';
}

type RequestLike = {
  method?: string;
  route?: { path?: unknown };
  [key: string | symbol]: unknown;
};

/**
 * The route TEMPLATE (`/api/v1/admin/departments/:id`), never the concrete URL:
 * the URL carries the query string and raw ids. A request no route matched has
 * no template, and is reported as such rather than by its raw path.
 */
export function routeOf(request: unknown): string {
  const path = (request as RequestLike | undefined)?.route?.path;
  return typeof path === 'string' && path.length > 0 ? path : '<unmatched>';
}

function clsValue(key: string): unknown {
  try {
    const cls = ClsServiceManager.getClsService();
    if (!cls.isActive()) return undefined;
    return cls.get(key);
  } catch {
    return undefined;
  }
}

/** The request id: CLS first, the request alias second. Never invented. */
export function requestIdOf(request: unknown): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    if (cls.isActive()) {
      const id = cls.getId();
      if (id) return id;
    }
  } catch {
    // CLS unavailable — fall through to the alias.
  }
  const alias = (request as RequestLike | undefined)?.['requestId'];
  return typeof alias === 'string' ? alias : undefined;
}

function errorNameOf(err: unknown): string | undefined {
  if (err instanceof Error) return err.name && err.name !== 'Error' ? err.name : err.constructor?.name || err.name;
  if (err && typeof err === 'object') return (err as { constructor?: { name?: string } }).constructor?.name;
  return typeof err;
}

export interface RequestFailure {
  /** The HTTP request (express). Typed loosely: only `method`, `route` and two symbol slots are read. */
  request: unknown;
  status: number;
  code: string | undefined;
  exception: unknown;
}

/**
 * Write the single failure line for this request. Idempotent per request.
 *
 * Fields: `requestId`, `method`, `route`, `status`, `code`, `errorName`,
 * `durationMs`, `tenantId`, `userId`, `credentialClass`, plus whatever the
 * throwing component attached. `error` (the Error object — the logger formats
 * name/message/stack/cause) rides every `error`-level line; a 4xx line carries
 * the message only, since its stack is noise.
 */
export function logRequestFailure(logger: Pick<Logger, 'error' | 'warn' | 'debug'>, failure: RequestFailure): void {
  const { status, code, exception } = failure;
  const request = failure.request as RequestLike | undefined;
  if (request && request[FAILURE_LOGGED]) return;
  if (request) request[FAILURE_LOGGED] = true;

  const { level: levelOverride, error: attachedError, errorName: attachedName, ...extra } = readFailureLogContext(exception) ?? {};
  const level = levelOverride ?? levelForStatus(status);
  const subject = attachedError ?? exception;

  const startedAt = request?.[REQUEST_STARTED_AT];
  const userFromCls = clsValue('user') as { id?: string } | undefined;

  const fields: Record<string, unknown> = {
    message: 'Request failed',
    requestId: requestIdOf(request),
    method: request?.method,
    route: routeOf(request),
    status,
    code,
    errorName: attachedName ?? errorNameOf(subject),
    ...(typeof startedAt === 'number' ? { durationMs: Date.now() - startedAt } : {}),
    tenantId: clsValue('tenantId'),
    userId: clsValue('userId') ?? userFromCls?.id,
    credentialClass: clsValue('credentialClass'),
    ...extra,
  };

  if (level === 'error') {
    // Withheld only when a component deliberately named the error instead of
    // passing it (a Prisma error's message embeds the generated query).
    if (attachedName === undefined || attachedError !== undefined) fields['error'] = subject;
  } else if (subject instanceof Error && subject.message && fields['errorMessage'] === undefined && attachedName === undefined) {
    fields['errorMessage'] = subject.message;
  }

  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }

  logger[level](fields);
}

type ResponseLike = {
  headersSent?: boolean;
  status: (code: number) => { json: (body: unknown) => unknown };
  getHeader?: (name: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
};

/**
 * Write an error body, keeping the `X-Request-Id` header in step with the
 * body's `correlationId`. A response whose headers already left (a failed SSE
 * stream) cannot take a body; the failure line is still written by the caller.
 */
export function writeErrorBody(response: ResponseLike, status: number, body: Record<string, unknown>): void {
  if (response.headersSent) return;
  const correlationId = body['correlationId'];
  if (typeof correlationId === 'string' && typeof response.setHeader === 'function') {
    const existing = typeof response.getHeader === 'function' ? response.getHeader(REQUEST_ID_RESPONSE_HEADER) : undefined;
    if (existing === undefined) response.setHeader(REQUEST_ID_RESPONSE_HEADER, correlationId);
  }
  response.status(status).json(body);
}
