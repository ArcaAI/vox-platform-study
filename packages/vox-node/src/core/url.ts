/**
 * Base-URL + path joining for the HOPE gateway.
 *
 * This is the single most important piece of the transport: get it wrong and
 * every request 404s. The gateway (`apps/api/src/main.ts`) sets a global
 * route prefix of `api/v1` on every controller EXCEPT a short, exact,
 * literal-path exclusion list — the v1-compat shims, which keep their
 * pre-existing v1 URLs so legacy clients don't have to change anything:
 *
 *   - `POST /api/smr/api/v1/presummary` (summarization; the renamed
 *   - `POST /api/smr/api/v1/summary/sync` `text` service's frozen
 *                                             `text`-legacy routes)
 *   - `POST /api/stt/start_session` (speech-to-text session
 * `POST /api/stt/switch` lifecycle —)
 *   - `POST /api/stt/stop_session`
 *
 * Everything else (e.g. `consultations/:id/summary`) DOES get the `api/v1`
 * prefix. Naively prepending `api/v1` to every path would turn the compat
 * routes into `/api/v1/api/smr/api/v1/...`, which 404s — hence this module.
 */

/**
 * Exact relative paths (no leading slash) that `main.ts` excludes from the
 * `api/v1` global prefix. Kept as a literal set — matching `main.ts`'s own
 * `exclude: [...]` array — rather than a pattern, because the exclusion is
 * itself a short, exact list, not a rule ("everything under `api/smr/`" would
 * be wrong: only these exact routes are compat shims).
 *
 * The `api/stt/*` entries are unreachable from THIS SDK today — it ships no
 * speech-to-text resource, and its zero-dependency, non-audio posture means it
 * is not getting one. They are carried anyway because this set is a verbatim
 * mirror of `main.ts`'s `exclude: [...]`: a partial mirror is the failure mode
 * that turns a future STT call into a silent `/api/v1/api/stt/...` 404.
 */
const PREFIX_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  'api/smr/api/v1/presummary',
  'api/smr/api/v1/summary/sync',
  'api/stt/start_session',
  'api/stt/switch',
  'api/stt/stop_session',
]);

/** The gateway's global route prefix (`app.setGlobalPrefix('api/v1', ...)`). */
const API_PREFIX = 'api/v1';

/** A single query parameter value. */
export type QueryPrimitive = string | number | boolean;

/**
 * Query parameter values accepted by {@link buildUrl}.
 *
 * A LIST is a first-class value here, not a convenience: routes that take a
 * selection declare `type: [String]` and the generated admin surface renders
 * that faithfully as `string[]` (today only `admin/users/export`'s `ids`, but
 * the next such route would break the build the same way if this union did not
 * admit it). Serialized as a REPEATED param — see {@link buildQueryString}.
 */
export type QueryValue = QueryPrimitive | undefined | null | readonly QueryPrimitive[];

/** Options for {@link buildUrl}. */
export interface BuildUrlOptions {
  /**
   * Query parameters to append. `undefined`/`null` values are omitted
   * entirely (not serialized as `key=`); numbers/booleans are stringified.
   */
  query?: Record<string, QueryValue>;
}

/**
 * Strip trailing slashes, then, if the result ends with `/api/v1`, strip
 * that too.
 *
 * DECISION: a `baseUrl` that already includes
 * `/api/v1` — e.g. a consumer copies the origin straight from a browser tab
 * that was pointed at the Swagger docs at `/api/v1/docs` — is normalized
 * down to the bare origin/base path first. `buildUrl` then re-applies the
 * prefix (or not) uniformly from that normalized base, so
 * `http://host:8868`, `http://host:8868/api/v1`, and
 * `http://host:8868/api/v1/` all produce IDENTICAL output for both prefixed
 * and exempt paths. The alternative (trust the caller's baseUrl verbatim)
 * would silently double-prefix non-exempt paths for exactly the consumer
 * this decision protects.
 */
function normalizeBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  const suffix = `/${API_PREFIX}`;
  if (base.toLowerCase().endsWith(suffix.toLowerCase())) {
    base = base.slice(0, base.length - suffix.length);
  }
  return base;
}

function stripLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, '');
}

function buildQueryString(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // A list is repeated (`?ids=a&ids=b`), never joined. `String(['a','b'])`
    // would answer `a,b`, which the gateway does accept — `parseIdsQuery`
    // splits on commas — but lossily: one item containing a comma and the set
    // the server rebuilds is not the set that was sent. An EMPTY list appends
    // nothing, so it vanishes from the URL rather than arriving as `ids=`,
    // which is what lets the gateway read it as "no selection" (the same
    // reason `parseIdsQuery` answers `undefined` rather than `[]`).
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.append(key, String(value));
  }
  return params.toString();
}

/**
 * Join a `baseUrl` with a gateway-relative `path`, applying the `api/v1`
 * prefix unless `path` is one of the {@link PREFIX_EXEMPT_PATHS}.
 *
 * `path` may be given with or without a leading slash. Query params, when
 * given, are appended and encoded via `URLSearchParams` (space → `+`, which
 * is the standard `application/x-www-form-urlencoded` query encoding).
 */
export function buildUrl(baseUrl: string, path: string, options: BuildUrlOptions = {}): string {
  const base = normalizeBaseUrl(baseUrl);
  const relPath = stripLeadingSlashes(path);
  const finalPath = PREFIX_EXEMPT_PATHS.has(relPath) ? relPath : `${API_PREFIX}/${relPath}`;

  let url = `${base}/${finalPath}`;
  const queryString = options.query ? buildQueryString(options.query) : '';
  if (queryString) url += `?${queryString}`;
  return url;
}

/**
 * Percent-encode a single path segment (e.g. a consultation id) via
 * `encodeURIComponent`. Callers MUST use this for any user/server-supplied
 * id interpolated into a path — an unencoded `/` in an id would otherwise
 * inject an extra path segment.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}
