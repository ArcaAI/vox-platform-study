/**
 * PHI-safe, stable token for an identifier on a log line.
 *
 * The TypeScript twin of `hope_obs.phi.redact_id`
 * (`packages/py-obs/src/hope_obs/phi.py`) and deliberately byte-for-byte the
 * same algorithm: the first 12 hex characters of the SHA-256 of the UTF-8
 * string form, with `null`/`undefined`/`''` rendered as `"-"` so a missing id
 * is visibly missing. Identical output is the point — one consultation's
 * hashed id then correlates across the gateway and every Python service.
 *
 * Unsalted, so it hides a high-entropy id (a UUID) but NOT a guessable one:
 * never route a short numeric identifier (an MRN) through it.
 */

import { createHash } from 'node:crypto';

export function redactId(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}
