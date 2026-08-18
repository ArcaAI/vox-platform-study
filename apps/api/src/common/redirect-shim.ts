import type { Request, Response } from 'express';

/**
 * TASK-760 — the one place a retired business-plane URI is turned into a
 * redirect.
 *
 * **308, never 301/302.** RFC 7231 §6.4.2/§6.4.3 explicitly permit a client
 * that follows a 301/302 to rewrite a POST/PATCH/DELETE into a GET, which
 * silently drops the request body — a summarization POST would arrive at the
 * new path as an empty GET and the caller would see a confusing 404/405
 * instead of a redirect. 308 (RFC 7538) is the permanent form that MUST
 * preserve both method and body, so it is the only status this helper emits.
 *
 * Shims are written in library-specific mode (`@Res()`), so no interceptor
 * runs over them — which is correct: there is no representation to ETag, and
 * the guards (auth, throttling, API-key surface) have already run by the time
 * a handler is entered. An unauthenticated call therefore still 401s AT the
 * shim; it never redirects an anonymous caller onward.
 */
export const API_V1_PREFIX = '/api/v1';

/**
 * Emits `308 Permanent Redirect` to `${API_V1_PREFIX}/${targetPath}`,
 * carrying the original query string across verbatim.
 *
 * @param req   the inbound request (read only for its query string)
 * @param res   the express response
 * @param targetPath the NEW path, WITHOUT the global `api/v1` prefix and
 *                   without a leading slash (e.g. `users/me/preferences`)
 */
export function redirect308(req: Request, res: Response, targetPath: string): void {
  const queryIndex = req.originalUrl.indexOf('?');
  const queryString = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
  res.setHeader('Location', `${API_V1_PREFIX}/${targetPath}${queryString}`);
  res.status(308).end();
}
