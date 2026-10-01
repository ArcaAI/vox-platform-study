/** The gateway's global prefix plus the internal controllers' segment (`api/v1` + `internal/*`). */
export const INTERNAL_PATH_PREFIX = '/api/v1/internal/';

/**
 * True only when the request's parsed PATH sits under the gateway's internal prefix. The query
 * string and fragment are never consulted: `/api/v1/admin/x?y=/internal/` is a user route.
 */
export function isInternalPath(req: { path?: string; originalUrl?: string; url?: string } | undefined): boolean {
  const raw = req?.originalUrl ?? req?.url ?? '';
  let pathname = typeof req?.path === 'string' && req.path.length > 0 ? req.path : '';
  if (!pathname) {
    try {
      pathname = new URL(raw, 'http://internal.invalid').pathname;
    } catch {
      return false;
    }
  }
  return pathname.startsWith(INTERNAL_PATH_PREFIX);
}
