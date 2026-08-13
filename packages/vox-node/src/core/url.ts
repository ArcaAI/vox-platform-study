/**
 * Base-URL + path joining for the HOPE gateway.
 *
 * This is the single most important piece of the transport: get it wrong and
 * every request 404s. The gateway (`apps/api/src/main.ts`) sets a global
 * route prefix of `api/v1` on every controller EXCEPT a short, exact,
 * literal-path exclusion list — the v1-compat SMR summarization shims, which
 * keep their pre-existing v1 URLs so legacy clients don't have to change
 * anything:
 *
 *   - `POST /api/smr/api/v1/presummary`
 *   - `POST /api/smr/api/v1/summary/sync`
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
 * be wrong: only these two routes are compat shims).
 */
const PREFIX_EXEMPT_PATHS: ReadonlySet<string> = new Set(['api/smr/api/v1/presummary', 'api/smr/api/v1/summary/sync']);

/** The gateway's global route prefix (`app.setGlobalPrefix('api/v1', ...)`). */
const API_PREFIX = 'api/v1';

/** Query parameter values accepted by {@link buildUrl}. */
export type QueryValue = string | number | boolean | undefined | null;

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
