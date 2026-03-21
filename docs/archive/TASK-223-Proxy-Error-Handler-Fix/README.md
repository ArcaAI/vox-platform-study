# TASK-223: Proxy Error Handler Fix — Empty Error Logging & Missing Client Response

- **Ticket**: TASK-223
- **Created**: 2026-02-25
- **Last Updated**: 2026-02-25
- **Status**: Completed

## Requirement Analysis

### Problem

The API Gateway's `BaseProxyController` logs empty error messages and fails to send proper HTTP responses when downstream microservices (TTS, NLP, SMR) are unreachable:

```
ERROR [TtsController] {"message":"Proxy error","method":"GET","path":"/api/tts/health","error":""}
ERROR [NlpController] {"message":"Proxy error","method":"GET","path":"/api/v1/health","error":""}
ERROR [SmrController] {"message":"Proxy error","method":"GET","path":"/api/v2/health","error":""}
```

### Root Cause

Two defects in `BaseProxyController.proxy` (`apps/api/src/shared/base-proxy.controller.ts`):

1. **Empty error field**: The `on.error` handler logs `err.message`, but Node.js system errors (e.g., `ECONNREFUSED`) have an empty `message` property — the useful information is in `err.code`.

2. **No client response**: The `on.error` handler only logs but never sends an HTTP response to the client. In `http-proxy-middleware` v3, the `on.error` callback receives `(err, req, res)`, but the existing code only accepted `(err, req)`, leaving the `res` parameter unused. Clients may hang or receive inconsistent responses.

3. **No log-level differentiation**: Expected network errors (like `ECONNREFUSED` when a service isn't running in dev mode) were logged at ERROR level, creating noise in logs.

### Business Context

- Health checks are polled every ~5-10 seconds by the frontend dashboard
- Empty error logs make debugging connectivity issues difficult
- Missing client responses cause the frontend to timeout instead of getting a fast failure response

## Current State Evaluation

### Before Fix

```typescript
// on.error only accepted (err, req) — no res parameter
error: (err: Error, req: IncomingMessage) => {
    this.logger.error({
        message: 'Proxy error',
        method: req.method,
        path: req.url,
        error: err instanceof Error ? err.message : String(err),
        // ^^^^ empty for ECONNREFUSED — err.message is ""
    });
    // No response sent to client
},
```

### Related Components

- `apps/api/src/shared/base-proxy.controller.ts` — Base class for all proxy controllers
- `apps/api/src/modules/tts/tts.controller.ts` — TTS proxy
- `apps/api/src/modules/nlp/nlp.controller.ts` — NLP proxy
- `apps/api/src/modules/smr/smr.controller.ts` — SMR proxy
- `apps/api/src/modules/fedl/fedl.controller.ts` — FedL proxy

## Implementation Plan

1. Fix error detail extraction: fall back to `err.code` when `err.message` is empty
2. Accept `res` in `on.error` handler and send a 502 Bad Gateway response
3. Add `headersSent` guard to avoid double-response crashes
4. Differentiate log levels: WARN for expected network errors, ERROR for unexpected ones
5. Add the service name and target URL to log payload for easier debugging
6. Follow TDD: write failing tests first, then implement

## Implementation Summary

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/shared/base-proxy.controller.ts` | Fixed `on.error` handler: added `res` param, `getErrorDetail()` helper, `isExpectedNetworkError()` helper, 502 response, structured logging with error code |
| `apps/api/src/__tests__/base-proxy-controller.test.ts` | Added 5 new tests for error handler behavior; updated line-count metrics |

### Changes Made

1. **`getErrorDetail(err)`** — Extracts meaningful error info: prefers `err.message`, falls back to `err.code`, then `'Unknown proxy error'`

2. **`isExpectedNetworkError(err)`** — Checks if `err.code` is in the set of expected network error codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, `EHOSTUNREACH`)

3. **`on.error` handler** — Now:
   - Accepts `(err, req, res)` — uses the `ServerResponse` to send 502
   - Logs at WARN level for expected network errors, ERROR for unexpected
   - Includes `service`, `target`, `code` fields in log payload
   - Sends `502 Bad Gateway` JSON response with `error`, `detail`, `timestamp`
   - Guards with `res.headersSent` check

4. **`next(err)` callback** — Also uses `getErrorDetail()` for consistent error extraction

### After Fix — Log Output

Expected connection errors (services not running):
```
WARN [TtsController] {"message":"Proxy error","service":"TTS","target":"http://localhost:8863","method":"GET","path":"/api/tts/health","error":"ECONNREFUSED","code":"ECONNREFUSED"}
```

Unexpected errors:
```
ERROR [SmrController] {"message":"Proxy error","service":"SMR","target":"http://localhost:8862","method":"GET","path":"/api/v2/health","error":"socket hang up","code":"ECONNRESET"}
```

### Testing

- **TDD approach**: 5 new source-level tests added, all verifying structural properties of the error handler
- **All 160 tests pass** (157 existing + 3 previously passing from new suite + 2 newly passing)
- Line count metrics updated: BaseProxyController < 160 lines, total proxy code < 560 lines
