import { BadRequestException, createParamDecorator, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

/**
 * RFC 7232 strong-validator pattern: `"<digits>"` — exactly one set of
 * double-quotes wrapping a non-empty decimal integer. NO leading `W/`
 * (weak comparator), no `*` wildcard, no unquoted body, no whitespace.
 *
 * The regex deliberately disallows leading zeros (`"007"`) because they
 * imply a different value space; the production interceptor (D.1) only
 * ever renders `"<n>"` with no padding.
 */
const STRONG_VALIDATOR_RE = /^"(0|[1-9][0-9]*)"$/;

/**
 * Parses the inbound `If-Match` header into a positive integer — TASK-302
 * Stream D Phase D (D.2).
 *
 * Behavior table:
 *
 * | header                 | route w/ @RequiresIfMatch | result               |
 * |------------------------|---------------------------|----------------------|
 * | `If-Match: "7"`        | either                    | `7`                  |
 * | (missing)              | NOT annotated             | `undefined`          |
 * | (missing)              | annotated                 | throws **428**       |
 * | `If-Match: 7`          | either                    | throws 400 (no quotes) |
 * | `If-Match: W/"7"`      | either                    | throws 400 (weak)    |
 * | `If-Match: *`          | either                    | throws 400 (wildcard) |
 * | `If-Match: "0"`        | either                    | throws 400 (zero)    |
 * | `If-Match: "-1"`       | either                    | throws 400 (negative)|
 * | `If-Match: "abc"`      | either                    | throws 400 (NaN)     |
 *
 * The `undefined` fall-through is intentional: it lets the service-to-service
 * `expectedVersion: number` body field continue to work for non-browser
 * callers (cron jobs, internal services, CLI tools). Browser clients drive
 * OCC through the header.
 *
 * The handler factory `createParamDecorator(extractExpectedVersion)` is the
 * thinnest possible wrapper around this function; the named export
 * `extractExpectedVersion` exists so unit tests don't need to spin up a
 * NestJS test module.
 *
 * @see apps/api/src/decorators/requiresIfMatch.guard.ts
 * @see apps/api/src/decorators/requiresIfMatch.decorator.ts
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
 * @see https://www.rfc-editor.org/rfc/rfc6585.html
 */
export function extractExpectedVersion(_data: unknown, ctx: ExecutionContext): number | undefined {
  const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; _requiresIfMatch?: boolean }>();
  const raw = req.headers['if-match'];

  if (raw === undefined || raw === '') {
    if (req._requiresIfMatch) {
      // RFC 6585 §3 — 428 distinguishes "you forgot the header" from "you
      // sent a bad value." Clients can branch on this status to surface a
      // different message ("please update your SDK") vs. 412 ("refresh
      // the page; someone else edited this").
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          code: 'HTTP.PRECONDITION_REQUIRED',
          message: 'If-Match header is required for this operation.',
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    return undefined;
  }

  const match = STRONG_VALIDATOR_RE.exec(raw);
  if (!match) {
    throw new BadRequestException(`Invalid If-Match header: ${raw}. Expected a strong validator of the form "<positive integer>" (RFC 7232 §3.1).`);
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    // The regex catches negative / non-numeric; this guard is defense in
    // depth for the zero case + future regex relaxations.
    throw new BadRequestException(`Invalid If-Match header: ${raw}. Version must be a positive integer (>= 1).`);
  }
  return parsed;
}

/**
 * Inject the parsed `If-Match` version into a route handler parameter as
 * `number | undefined`.
 *
 * Example:
 *
 *   @Patch('me/config')
 *   @RequiresIfMatch()
 *   async updateMyConfig(
 *     @Body() configs: UpdateTenantConfigRequest[],
 *     @ExpectedVersion() expected: number | undefined,
 *   ) { ... }
 *
 * The undefined branch only ever fires on routes WITHOUT `@RequiresIfMatch()`,
 * in which case the body-field `expectedVersion` is the service's source
 * of truth.
 */
export const ExpectedVersion = createParamDecorator(extractExpectedVersion);
