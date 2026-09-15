/**
 * `If-Match` for HOPE's optimistic-concurrency routes.
 *
 * The gateway accepts ONLY a strong validator — a quoted integer, matched by
 * `/^"(0|[1-9][0-9]*)"$/` (`apps/api/src/decorators/expectedVersion.decorator.ts`).
 * An unquoted `3` is refused, and the refusal surfaces as a precondition error
 * rather than as anything naming the header's format.
 *
 * The only version an SDK consumer can obtain is `ConsultationGetResponse.version`,
 * a NUMBER — `String(c.version)` produces exactly the unquoted form the gateway
 * rejects. So the normalisation lives here rather than in each caller's head:
 * pass the number you read, or a raw `ETag` you captured, and either works.
 */
export function toStrongValidator(ifMatch: string | number): string {
  if (typeof ifMatch === 'number') {
    if (!Number.isInteger(ifMatch) || ifMatch < 0) {
      throw new TypeError(`If-Match must be a non-negative integer version; received ${ifMatch}`);
    }
    return `"${ifMatch}"`;
  }
  const raw = ifMatch.trim();
  // Already a strong validator (`"7"`) or a weak one (`W/"7"`) — pass through untouched.
  if (/^(W\/)?"/.test(raw)) return raw;
  if (/^(0|[1-9][0-9]*)$/.test(raw)) return `"${raw}"`;
  throw new TypeError(`If-Match must be a version number or a quoted ETag; received ${JSON.stringify(ifMatch)}`);
}
