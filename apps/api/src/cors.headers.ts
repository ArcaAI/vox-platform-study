/**
 * CORS request/response header lists for the API gateway.
 *
 * Extracted from `main.ts` for the same reason `cors.config.ts` was: the values
 * are only reachable to a test if they live outside the `bootstrap()` closure.
 * `cors.config.ts` owns WHICH ORIGINS are admitted; this file owns WHICH HEADERS
 * may cross once an origin is admitted. They are deliberately separate concerns.
 */

/**
 * Request headers a cross-origin caller may send (`Access-Control-Allow-Headers`).
 *
 * The list is explicit rather than reflective: `cors` echoes exactly what is
 * declared here, so a header absent from this array fails the PREFLIGHT and the
 * request never reaches a guard. Header matching is case-insensitive per RFC
 * 7230, which is why the `-Id` / `-ID` spellings below are equivalent — the
 * duplicates are historical, not load-bearing.
 */
export const CORS_ALLOWED_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  // RFC 7232 conditional request. The SDK's OCC lane
  // (`AgenticClient.patchWithIfMatch`) sends this on every versioned PATCH;
  // omitting it here fails the preflight, so the request never arrives and
  // `RequiresIfMatchGuard` never gets to answer.
  'If-Match',
  'X-API-Key',
  'api-key',
  'apikey',
  'x-api-key',
  'traceparent',
  'tracestate',
  'X-Request-Id',
  'X-Correlation-ID',
  'x-correlation-id',
  'X-Tenant-Id',
  'X-Project-Id',
  'X-Session-Id',
  'X-User-Agent',
  'X-SDK-Version',
  'Accept',
  'Accept-Language',
  'Accept-Encoding',
  'Cache-Control',
  'Origin',
  'Referer',
  'User-Agent',
];

/**
 * Response headers the browser makes readable to cross-origin JS
 * (`Access-Control-Expose-Headers`).
 *
 * Without an entry here only the CORS-safelisted response headers reach
 * `fetch`. `ETagInterceptor` sets a strong `ETag` on every versioned response,
 * but `AgenticClient.getWithEtag` would read `undefined` and the follow-up
 * PATCH would send no validator — which `RequiresIfMatchGuard` answers with
 * 428. The OCC round trip is therefore broken cross-origin unless `ETag` is
 * exposed, however correct the server side is.
 */
export const CORS_EXPOSED_HEADERS: readonly string[] = ['ETag'];
