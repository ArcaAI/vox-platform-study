import { NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

/** Minimal logger surface (Nest `Logger` and `ILoggingService` both satisfy it). */
/** A legitimate "the row is not there" answer: the repository's or a service's 404. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof DataNotFoundException || error instanceof NotFoundException;
}

export interface SwallowLogger {
  warn(message: unknown, ...rest: unknown[]): unknown;
  error(message: unknown, ...rest: unknown[]): unknown;
}

export interface SwallowContext {
  logger: SwallowLogger;
  /** What was being attempted, as a stable sentence. */
  message: string;
  /** Ids in scope (never request bodies). */
  meta?: Record<string, unknown>;
}

/**
 * `.catch()` handler for a lookup where "the row is not there" is a legitimate answer.
 * A `DataNotFoundException` yields `fallback`; every other failure (a database or network
 * outage) is logged once and rethrown, so it can no longer masquerade as "not found".
 */
export function fallbackOnNotFound<F>(fallback: F, ctx: SwallowContext): (error: unknown) => F {
  return (error: unknown): F => {
    if (isNotFoundError(error)) return fallback;
    ctx.logger.error({ message: ctx.message, error, ...ctx.meta });
    throw error;
  };
}

/**
 * `.catch()` handler for a documented best-effort read: not-found yields `fallback` silently,
 * any other failure is logged at `warn` and ALSO yields `fallback` (the caller degrades).
 */
export function warnAndFallback<F>(fallback: F, ctx: SwallowContext): (error: unknown) => F {
  return (error: unknown): F => {
    if (isNotFoundError(error)) return fallback;
    ctx.logger.warn({ message: ctx.message, error, ...ctx.meta });
    return fallback;
  };
}
