/**
 * TASK-799 P1-C.2 — `extraJson` shape contract.
 *
 * THE DEFECT THIS REPLACES: `extraJson` accepted literally anything (a bare
 * `@IsObject()`), while the wire-entry builder forwarded a FIXED ALLOW-LIST of
 * four keys (`model`/`foundryModel`, `project`, `location`). Everything else was
 * accepted on write and silently DROPPED in transit, so per-endpoint capability
 * quirks — a JSON response-format flag, a reasoning mode, a "no think" switch,
 * an adaptive-limits toggle — could not be expressed even though the column
 * existed to hold them.
 *
 * THE RULE THAT REPLACES IT: validate the SHAPE, never enumerate the KEYS. A
 * new provider quirk must not require a code change here — that is the entire
 * point. What IS constrained is the envelope:
 *
 *   - keys are safe, bounded identifiers (no dots, no prototype pollution);
 *   - values are JSON SCALARS or arrays of scalars — the envelope stays FLAT,
 *     so each consuming service can validate it with one Pydantic model
 *     (D-1 rule 4: one injection envelope, not per-call-site wiring);
 *   - the keys the wire entry OWNS are reserved: `extraJson` may never supply
 *     the credential, the endpoint, or the DERIVED `funding` label. A row that
 *     could stamp its own `funding` would reintroduce exactly the silent
 *     mis-billing that deriving it was meant to remove;
 *   - the whole thing is bounded, because it is folded into EVERY request body
 *     for the tenant that owns the row.
 *
 * TWO ENFORCEMENT POINTS, deliberately asymmetric:
 *   - `validateProviderExtras` runs on the WRITE path (the upsert DTO) and
 *     REJECTS — a bad row never reaches the database;
 *   - `sanitizeProviderExtras` runs on the READ path and DROPS — a row stored
 *     before this validator existed must degrade to "that key is missing",
 *     never to a failed request. Same failure class as the per-credential
 *     decrypt fail-open: a fault in stored data must not become a policy denial.
 */

/** A value `extraJson` may carry, once flattened onto the wire entry. */
export type ProviderExtraScalar = string | number | boolean;
export type ProviderExtraValue = ProviderExtraScalar | ProviderExtraScalar[];

/**
 * The envelope bounds. These are size limits, not a vocabulary — raising one is
 * a judgement call about request-body weight, never about which provider quirks
 * are expressible.
 */
export const PROVIDER_EXTRA_LIMITS = {
  maxKeys: 32,
  maxKeyLength: 64,
  maxStringLength: 2048,
  maxArrayItems: 64,
} as const;

/**
 * Keys the wire entry itself owns. `extraJson` may not set them — not because
 * they are secret, but because each has exactly one authoritative source: the
 * decrypted ciphertext (`api_key`), a dedicated column (`base_url`, `region`,
 * `api_version`, `deployment_name`), or the row's own tenant id (`funding`).
 */
export const PROVIDER_EXTRA_RESERVED_KEYS: readonly string[] = [
  'api_key',
  'funding',
  'base_url',
  'region',
  'api_version',
  'deployment_name',
];

/** Keys that would mutate an object's prototype rather than its contents. */
const UNSAFE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** A conservative identifier: what a snake_case wire field or a camelCase console field looks like. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isScalar(value: unknown): value is ProviderExtraScalar {
  return typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Why this single key/value pair is not admissible, or `null` when it is.
 * ONE predicate, shared by the write validator and the read sanitiser, so the
 * two can never disagree about what a valid extra looks like.
 */
function rejectionReason(key: string, value: unknown): string | null {
  if (UNSAFE_KEYS.includes(key)) return `key '${key}' is reserved by the JavaScript object model`;
  if (!SAFE_KEY.test(key)) return `key '${key}' is not a simple identifier (letters, digits and underscore only)`;
  if (key.length > PROVIDER_EXTRA_LIMITS.maxKeyLength) return `key '${key}' exceeds ${PROVIDER_EXTRA_LIMITS.maxKeyLength} characters`;
  if (PROVIDER_EXTRA_RESERVED_KEYS.includes(key)) {
    return `key '${key}' is supplied by the connection row itself and cannot be overridden here`;
  }

  if (Array.isArray(value)) {
    if (value.length > PROVIDER_EXTRA_LIMITS.maxArrayItems) return `'${key}' has more than ${PROVIDER_EXTRA_LIMITS.maxArrayItems} items`;
    for (const item of value) {
      if (!isScalar(item)) return `'${key}' must be an array of strings, numbers or booleans`;
      if (typeof item === 'string' && item.length > PROVIDER_EXTRA_LIMITS.maxStringLength) {
        return `an item of '${key}' exceeds ${PROVIDER_EXTRA_LIMITS.maxStringLength} characters`;
      }
    }
    return null;
  }

  if (!isScalar(value)) return `'${key}' must be a string, number, boolean, or an array of those (nested objects are not forwarded)`;
  if (typeof value === 'string' && value.length > PROVIDER_EXTRA_LIMITS.maxStringLength) {
    return `'${key}' exceeds ${PROVIDER_EXTRA_LIMITS.maxStringLength} characters`;
  }
  return null;
}

/**
 * WRITE path. Every reason `value` is not a valid extras object; `[]` means it
 * is. `null`/`undefined` are valid (the column is nullable — "no extras").
 */
export function validateProviderExtras(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['extraJson must be a JSON object'];

  // `Reflect.ownKeys`-style enumeration: `Object.entries` skips a `__proto__`
  // key set through a literal, but `JSON.parse` produces a real own property —
  // and it is precisely the JSON-sourced one a request can carry.
  const keys = Object.getOwnPropertyNames(value);
  const errors: string[] = [];
  if (keys.length > PROVIDER_EXTRA_LIMITS.maxKeys) {
    errors.push(`extraJson carries more than ${PROVIDER_EXTRA_LIMITS.maxKeys} keys`);
  }
  for (const key of keys) {
    const reason = rejectionReason(key, Object.getOwnPropertyDescriptor(value, key)?.value);
    if (reason) errors.push(reason);
  }
  return errors;
}

/**
 * READ path. Every admissible key/value, on a plain object.
 *
 * Anything inadmissible is DROPPED, never thrown: a row written before this
 * contract existed degrades to a missing key, not a failed request.
 *
 * An EMPTY STRING is dropped rather than forwarded. `""` carries no
 * configuration, and "absent" is the wire convention for unset — the allow-list
 * this replaces enforced exactly that for the one key it knew about
 * (`model.length > 0`), and forwarding `model: ""` to an adapter that reads
 * presence as "use this model" would turn a blank console field into a failed
 * request instead of the platform default. Generalising it to every key keeps
 * the rule about SHAPE rather than about a key vocabulary.
 *
 * Deliberately NOT symmetric with `validateProviderExtras`: an empty string is
 * accepted on WRITE (so a PUT round-trips exactly what the console sent, and
 * clearing a field is not a 400) and simply not forwarded on READ.
 */
export function sanitizeProviderExtras(value: unknown): Record<string, ProviderExtraValue> {
  const out: Record<string, ProviderExtraValue> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;

  let admitted = 0;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (admitted >= PROVIDER_EXTRA_LIMITS.maxKeys) break;
    const raw = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (rejectionReason(key, raw) !== null) continue;
    if (raw === '') continue;
    out[key] = (Array.isArray(raw) ? [...raw] : raw) as ProviderExtraValue;
    admitted += 1;
  }
  return out;
}
