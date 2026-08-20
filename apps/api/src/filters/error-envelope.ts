/**
 * The ONE error envelope every gateway error body conforms to.
 *
 *     { statusCode, code, message, correlationId, details?, metadata? }
 *
 * Background (REST review H-2). The gateway used to emit four mutually
 * incompatible bodies: class-validator failures carried
 * `{statusCode, message, error, subErrors, correlationId}` but no `code`;
 * `DataNotFoundExceptionFilter` emitted `{statusCode, message}` with neither
 * `code` nor `correlationId`; every domain exception serialized through
 * `BaseException.toJSON()` carried `{code, message, metadata, correlationId}`
 * but NO `statusCode`; and sanitised Prisma failures carried
 * `{statusCode, error, correlationId}` with neither `code` nor `message`.
 * A client keying off `body.code` broke on 404s; one keying off
 * `body.statusCode` broke on every 412 OCC conflict — exactly the error most
 * likely to need programmatic handling.
 *
 * The fix is deliberately ADDITIVE. Every field that was emitted before keeps
 * its name and meaning (`error`, `subErrors`, `metadata`, `stack`, `cause` all
 * survive untouched); the only change is that the missing `code` / `statusCode`
 * / `message` are filled in. No existing consumer loses a field it reads today.
 *
 * Deliberately NOT RFC 9457 `application/problem+json`: that would change the
 * media type and rename `message`/`error` to `detail`/`title`, which IS
 * breaking, and buys little for a first-party API with two generated SDKs.
 */

/** Machine-readable code for a class-validator (DTO) rejection. */
export const VALIDATION_ERROR_CODE = 'VALIDATION.FAILED';

/**
 * Status → stable machine-readable code, for bodies that have no richer
 * domain code of their own (plain `HttpException`s, the generic 404, …).
 * Domain exceptions keep their own `code` (`PERSISTENCE.CONCURRENCY_CONFLICT`,
 * `DOMAIN.CONSENT_DENIED`, …) — this is only the fallback.
 */
const HTTP_CODE_BY_STATUS: Record<number, string> = {
  400: 'HTTP.BAD_REQUEST',
  401: 'HTTP.UNAUTHORIZED',
  402: 'HTTP.PAYMENT_REQUIRED',
  403: 'HTTP.FORBIDDEN',
  404: 'HTTP.NOT_FOUND',
  405: 'HTTP.METHOD_NOT_ALLOWED',
  406: 'HTTP.NOT_ACCEPTABLE',
  408: 'HTTP.REQUEST_TIMEOUT',
  409: 'HTTP.CONFLICT',
  410: 'HTTP.GONE',
  412: 'HTTP.PRECONDITION_FAILED',
  413: 'HTTP.PAYLOAD_TOO_LARGE',
  415: 'HTTP.UNSUPPORTED_MEDIA_TYPE',
  422: 'HTTP.UNPROCESSABLE_ENTITY',
  428: 'HTTP.PRECONDITION_REQUIRED',
  429: 'HTTP.TOO_MANY_REQUESTS',
  500: 'HTTP.INTERNAL_SERVER_ERROR',
  501: 'HTTP.NOT_IMPLEMENTED',
  502: 'HTTP.BAD_GATEWAY',
  503: 'HTTP.SERVICE_UNAVAILABLE',
  504: 'HTTP.GATEWAY_TIMEOUT',
};

/** The fallback `code` for a status with no richer domain code. */
export function httpCodeForStatus(status: number): string {
  return HTTP_CODE_BY_STATUS[status] ?? `HTTP.STATUS_${status}`;
}

/**
 * Add the envelope keys a body is missing, without touching any it already
 * carries. Purely additive by construction: existing keys always win.
 */
export function toUnifiedErrorBody(
  body: Record<string, unknown>,
  input: { status: number; code?: string; message?: string; correlationId?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (out['statusCode'] === undefined) out['statusCode'] = input.status;
  if (out['code'] === undefined) out['code'] = input.code ?? httpCodeForStatus(input.status);
  if (out['message'] === undefined && input.message !== undefined) out['message'] = input.message;
  if (out['correlationId'] === undefined && input.correlationId !== undefined) out['correlationId'] = input.correlationId;
  return out;
}
