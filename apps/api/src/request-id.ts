import type { ClsModuleOptions, ClsService } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';

/**
 * The gateway request id — the ONE id a request is known by.
 *
 * Contract: one value per request, `cls.getId()`. Source is the inbound
 * `x-request-id` when it is a safe token, otherwise a fresh uuidv7. It is set
 * ONLY here, by the CLS middleware; everything else reads `cls.getId()`
 * (`request.requestId` is an alias assigned from it in `setupRequestContext`).
 * The same value is the error body's `correlationId`, the `X-Request-Id`
 * response header, and the id forwarded on every internal hop.
 */

/** Incoming header name. Node lowercases every incoming header name. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Response header carrying the request id, on EVERY response (guard rejections included). */
export const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id';

/**
 * What a caller-supplied id must look like to be adopted. Anything else —
 * whitespace, a newline (log injection), a slash, an over-long value — is
 * replaced rather than trusted: the id lands in every log line and header.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Request property holding the wall-clock start, for `durationMs` on the failure line. */
export const REQUEST_STARTED_AT = Symbol.for('hope.requestStartedAt');

export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}

/** The CLS `idGenerator`: the caller's `x-request-id` when safe, else a new uuidv7. */
export function resolveRequestId(req: { headers?: Record<string, unknown> } | undefined): string {
  const raw = req?.headers?.[REQUEST_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isSafeRequestId(candidate) ? candidate : uuidv7();
}

/**
 * The CLS middleware `setup` hook. Runs before any guard, so the alias, the
 * CLS `correlationId` key (read by `BaseService` for sys-events) and the
 * response header are in place even when a guard rejects the request.
 */
export function setupRequestContext(
  cls: Pick<ClsService, 'getId' | 'set'>,
  req: Record<string | symbol, unknown>,
  res: { setHeader?: (name: string, value: string) => unknown },
): void {
  const id = cls.getId();
  req['requestId'] = id;
  req[REQUEST_STARTED_AT] = Date.now();
  cls.set('correlationId', id);
  if (typeof res?.setHeader === 'function' && id) {
    res.setHeader(REQUEST_ID_RESPONSE_HEADER, id);
  }
}

export const CLS_MODULE_OPTIONS: ClsModuleOptions = {
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: resolveRequestId,
    setup: setupRequestContext,
  },
};
