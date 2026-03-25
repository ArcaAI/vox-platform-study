# Security Audit Report — `apps/ui-playground`

**Application**: ArcaVox Playground (UI Playground)  
**Framework**: React 19 / Vite 7 / TanStack Router  
**Audit Date**: 2026-03-24  
**Auditor**: Security Auditor Agent  
**Status**: Complete  

---

## Executive Summary

The UI Playground is an internal SDK playground for the HOPE healthcare AI platform. It provides authentication (API key and credentials), admin user management, medical summarization, real-time speech-to-text via WebSocket, and SDK integration features.

The audit identified **16 findings** across 10 security categories. The most critical issue is the storage of authentication tokens (access tokens, refresh tokens, API keys, and impersonation tokens) in `localStorage`, which exposes them to XSS-based exfiltration. Given this is a **healthcare application** handling clinical data (transcriptions, medical summaries), the stakes are elevated due to HIPAA and PHI considerations.

No `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, or `document.write()` usage was found — React's default JSX escaping is properly leveraged. The `react-markdown` usage includes `skipHtml: true` and safe link filtering, which is a strong defensive posture. Build configuration correctly disables source maps in production.

### Risk Distribution

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High     | 4 |
| Medium   | 5 |
| Low      | 4 |
| Info     | 2 |

---

## Findings Summary Table

| ID | Severity | Category | Title | File(s) | OWASP |
|----|----------|----------|-------|---------|-------|
| VULN-001 | Critical | Auth / Storage | Auth tokens (access, refresh, API key, impersonation) stored in localStorage | `src/store/auth-store.ts` | A02, A07 |
| VULN-002 | High | Auth / Token | Client-side JWT decoding without signature verification | `src/lib/auth-refresh.ts` | A02, A07 |
| VULN-003 | High | Auth / Token | Refresh token sent in JSON body instead of httpOnly cookie | `src/lib/auth-refresh.ts` | A02, A07 |
| VULN-004 | High | WebSocket | WebSocket URL user-editable — potential SSRF / connection hijack | `src/features/summarization/components/ws-audio-transcript-demo.tsx` | A10, A05 |
| VULN-005 | High | WebSocket | Auth token passed in WebSocket URL query parameter | `src/hooks/use-realtime-transcription.ts` | A02, A09 |
| VULN-006 | Medium | CSP | No Content Security Policy headers configured | `Dockerfile`, `vite.config.ts` | A05 |
| VULN-007 | Medium | Storage | Medical summarization history stored in localStorage unencrypted | `src/features/summarization/history/index.tsx` | A02, A04 |
| VULN-008 | Medium | API | Base API URL persisted in localStorage and user-modifiable | `src/store/playground-store.ts` | A05, A10 |
| VULN-009 | Medium | Auth | API key auth mode skips server-side validation on login | `src/features/auth/login/components/api-key-form.tsx` | A07 |
| VULN-010 | Medium | Auth | No rate limiting on client-side login attempts | `src/features/auth/login/components/credentials-form.tsx` | A07 |
| VULN-011 | Low | Secrets | AdminUser type includes `secret1` and `secret2` fields from API | `src/features/admin/api/users.ts` | A02, A01 |
| VULN-012 | Low | Build | Vite VITE_API_URL embedded in production bundle | `Dockerfile`, `vite.config.ts` | A05 |
| VULN-013 | Low | Error | Error boundary logs to console.error in production | `src/components/error-boundary.tsx` | A09 |
| VULN-014 | Low | Deps | `serve@14` used in production Dockerfile without pinned minor | `Dockerfile` | A06 |
| VULN-015 | Info | Build | Production source maps correctly disabled | `vite.config.ts` | — |
| VULN-016 | Info | XSS | React-Markdown uses `skipHtml: true` and safe href filtering | `src/features/doc-panel/components/doc-content.tsx` | — |

---

## Detailed Findings

---

### VULN-001: Auth Tokens Stored in localStorage (Critical)

**Severity**: Critical  
**Location**: `src/store/auth-store.ts:131–148`  
**OWASP**: A02 (Cryptographic Failures), A07 (Identification and Authentication Failures)

**Description**:
The Zustand auth store uses `persist()` middleware to serialize the **entire auth state** — including `accessToken`, `refreshToken`, `apiKey`, and `impersonationToken` — into `localStorage` under key `arcavox.auth`. This makes all tokens accessible to any JavaScript running on the page, including XSS payloads, browser extensions, and injected scripts.

**Evidence**:

```typescript
// src/store/auth-store.ts:131-148
persist(
    (set) => ({ ... }),
    {
        name: STORAGE_KEYS.AUTH,  // 'arcavox.auth'
        partialize: (state) => ({
            authMethod: state.authMethod,
            apiKey: state.apiKey,            // ← API key in localStorage
            accessToken: state.accessToken,  // ← Access token in localStorage
            refreshToken: state.refreshToken, // ← Refresh token in localStorage
            impersonationToken: state.impersonationToken, // ← Impersonation token
            // ... all auth state persisted
        }),
    },
),
```

**Impact**:
- Any XSS vulnerability (even in a third-party dependency) can exfiltrate all authentication material
- Stolen refresh tokens enable persistent account takeover
- Stolen impersonation tokens allow adversaries to act as impersonated users
- In a healthcare context, this could lead to unauthorized access to PHI

**Recommended Fix**:
1. Move token management to **httpOnly, Secure, SameSite=Strict cookies** set by the backend on `/auth/login` and `/auth/refresh` responses
2. Remove `accessToken`, `refreshToken`, `apiKey`, and `impersonationToken` from the Zustand persist `partialize`
3. Use the cookie-based session for API calls (browser automatically attaches cookies)
4. For the playground/dev use case, at minimum encrypt tokens before storage using Web Crypto API, or use `sessionStorage` to limit persistence window

---

### VULN-002: Client-side JWT Decoding Without Signature Verification (High)

**Severity**: High  
**Location**: `src/lib/auth-refresh.ts:21–33`, `src/hooks/use-auto-refresh.ts:73`  
**OWASP**: A02 (Cryptographic Failures), A07 (Identification and Authentication Failures)

**Description**:
The `getTokenExpiryMs()` and `isTokenExpired()` functions decode JWTs using `atob(parts[1])` to read the `exp` claim, and `useAutoRefresh` decodes JWT payloads to extract `tenantId`. None of these verify the JWT signature. A tampered token with a manipulated `exp` could bypass expiry checks.

**Evidence**:

```typescript
// src/lib/auth-refresh.ts:23-28
const parts = token.split('.');
if (parts.length < 2) return 0;
const payload = JSON.parse(atob(parts[1]));  // No signature verification
if (typeof payload.exp !== 'number') return 0;
```

```typescript
// src/hooks/use-auto-refresh.ts:73
const payload = JSON.parse(atob(data.token.split('.')[1]));
if (payload.tenantId) tenantId = payload.tenantId;
```

**Impact**:
- Client-side decisions (proactive refresh timing, impersonation tenant assignment) rely on unverified JWT claims
- An attacker who controls localStorage could inject a JWT with a far-future `exp` to prevent refresh, or a manipulated `tenantId` to redirect impersonation

**Recommended Fix**:
1. Treat client-side JWT decoding as untrusted advisory data only — acknowledge this limitation in code comments
2. Always rely on the server's 401 response as the authoritative expiry signal
3. Validate `tenantId` against the server response rather than extracting from the token payload
4. Consider using a lightweight JWT library like `jose` for at least structural validation

---

### VULN-003: Refresh Token Sent in JSON Body (High)

**Severity**: High  
**Location**: `src/lib/auth-refresh.ts:84–91`  
**OWASP**: A02 (Cryptographic Failures), A07 (Identification and Authentication Failures)

**Description**:
The refresh token is transmitted as a JSON body field in a `POST /auth/refresh` request. This means the refresh token is readable by client-side JavaScript and must be stored in an accessible location (localStorage, as per VULN-001).

**Evidence**:

```typescript
// src/lib/auth-refresh.ts:86-89
const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),  // Refresh token in request body
});
```

**Impact**:
- Refresh token is exposed to all client-side code
- Combined with VULN-001, a single XSS can achieve persistent access via stolen refresh token

**Recommended Fix**:
1. Backend should set the refresh token as an **httpOnly, Secure, SameSite=Strict** cookie
2. The `/auth/refresh` endpoint should read the refresh token from the cookie, not the body
3. Frontend should not need to handle the refresh token at all

---

### VULN-004: User-Editable WebSocket URL (High)

**Severity**: High  
**Location**: `src/features/summarization/components/ws-audio-transcript-demo.tsx:361–366`  
**OWASP**: A10 (Server-Side Request Forgery), A05 (Security Misconfiguration)

**Description**:
The WebSocket demo component exposes an editable `<Input>` field for the WebSocket URL. A user (or XSS attacker) can change this to any arbitrary `ws://` or `wss://` URL, and the component will connect and send authentication tokens and audio data to that endpoint.

**Evidence**:

```typescript
// ws-audio-transcript-demo.tsx:361-366
<Label className="text-xs">WebSocket URL</Label>
<Input
    value={wsUrl}
    onChange={(e) => setWsUrl(e.target.value)}
    className="font-mono text-xs"
    placeholder="ws://localhost:8868/ws/stt-v2/stream"
/>
```

Then at line 125, this URL is used directly:

```typescript
const ws = new WebSocket(fullUrl);
// ... later sends auth token to this arbitrary URL
const authMsg = JSON.stringify({ type: 'auth', token: effectiveToken });
ws.send(authMsg);
```

**Impact**:
- Auth tokens can be exfiltrated by pointing the WebSocket to an attacker-controlled server
- Audio data (potentially containing PHI) can be redirected
- This is essentially a controlled SSRF from the browser

**Recommended Fix**:
1. Validate the WebSocket URL against an allowlist of permitted origins/hosts
2. Or derive the WebSocket URL exclusively from the configured API base URL — do not allow user override
3. At minimum, display a warning when the WebSocket URL does not match the expected base URL

---

### VULN-005: Auth Token in WebSocket URL Query Parameter (High)

**Severity**: High  
**Location**: `src/hooks/use-realtime-transcription.ts:174–175`  
**OWASP**: A02 (Cryptographic Failures), A09 (Security Logging and Monitoring Failures)

**Description**:
The `useRealtimeTranscription` hook builds the WebSocket URL by calling `sessionManager.getWebSocketUrl(token)`, which embeds the authentication token in the URL query string. Tokens in URLs are logged in browser history, server access logs, proxy logs, and referrer headers.

**Evidence**:

```typescript
// src/hooks/use-realtime-transcription.ts:174-175
const token = apiClient.getAccessToken?.() || apiClient.getApiKey?.() || '';
const wsUrl = sessionManager.getWebSocketUrl(token);
```

**Impact**:
- Token appears in browser history, server logs, CDN/proxy logs, and network monitoring tools
- Violates best practice of never placing secrets in URLs
- Server log retention could create a long-lived token exposure

**Recommended Fix**:
1. Send the auth token as the first WebSocket message after connection (similar to the demo component's approach at line 134)
2. Or use the WebSocket subprotocol header for authentication
3. Update `StreamingSessionManager.getWebSocketUrl()` to not include the token in the URL

---

### VULN-006: No Content Security Policy (Medium)

**Severity**: Medium  
**Location**: `Dockerfile:72`, `vite.config.ts`  
**OWASP**: A05 (Security Misconfiguration)

**Description**:
The production deployment uses `serve -s dist` without any CSP headers. No `<meta>` CSP tag exists in the HTML, and no Vite plugin is configured to inject CSP headers. There is no CSP, X-Frame-Options, X-Content-Type-Options, or other security headers.

**Impact**:
- Without CSP, if an XSS vector is found, script execution is unrestricted
- No protection against clickjacking (missing X-Frame-Options)
- MIME-type sniffing attacks possible (missing X-Content-Type-Options)

**Recommended Fix**:
1. Configure `serve` with a `serve.json` that sets security headers:
   ```json
   {
     "headers": [
       { "source": "**", "headers": [
         { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; connect-src 'self' wss://*.yourdomain.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:" },
         { "key": "X-Frame-Options", "value": "DENY" },
         { "key": "X-Content-Type-Options", "value": "nosniff" },
         { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
       ]}
     ]
   }
   ```
2. Or use nginx/caddy as a reverse proxy with header injection
3. Add a Vite plugin to inject `<meta http-equiv="Content-Security-Policy">` during build

---

### VULN-007: Medical Summarization History in localStorage Unencrypted (Medium)

**Severity**: Medium  
**Location**: `src/features/summarization/history/index.tsx:66–79`  
**OWASP**: A02 (Cryptographic Failures), A04 (Insecure Design)

**Description**:
Generated medical summaries (pre-summaries and clinical summaries) are stored in localStorage under key `arcaai-summarization-history` as plaintext JSON. This data may contain PHI (patient conditions, medications, treatment plans).

**Evidence**:

```typescript
// src/features/summarization/history/index.tsx:68-79
function loadHistory(): StoredResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(items: StoredResult[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}
```

The `StoredResult` type includes `content: string` which holds the full medical summary text.

**Impact**:
- PHI persists on the client device indefinitely (until manually cleared)
- Accessible to any JavaScript via `localStorage`
- Shared/public computers could leak patient data to subsequent users
- Does not comply with data minimization principles

**Recommended Fix**:
1. Store history server-side with proper access controls rather than in localStorage
2. If client-side storage is necessary, use encrypted storage (Web Crypto API `AES-GCM` with a session-derived key)
3. Implement automatic expiry (TTL) for stored history entries
4. Add a clear warning/consent before storing clinical data locally
5. Consider using `sessionStorage` instead of `localStorage` to limit persistence to the tab lifetime

---

### VULN-008: User-Modifiable API Base URL in localStorage (Medium)

**Severity**: Medium  
**Location**: `src/store/playground-store.ts:26`  
**OWASP**: A05 (Security Misconfiguration), A10 (SSRF)

**Description**:
The `apiBaseUrl` is persisted in localStorage and can be modified via `setApiBaseUrl()`. An XSS attack could change this URL to redirect all API calls (including those carrying auth tokens in headers) to an attacker-controlled server.

**Evidence**:

```typescript
// src/store/playground-store.ts:26
apiBaseUrl: import.meta.env.VITE_API_URL || 'http://localhost:8868/api/v1',
```

This value is persisted and used by `adminClient`, `smrClient`, and the SDK provider for all API requests, each of which attaches Bearer tokens or API keys.

**Impact**:
- A single localStorage write redirects all authenticated API traffic
- Auth headers (Bearer token, X-API-Key) sent to attacker server
- Combined with VULN-001, enables complete credential exfiltration

**Recommended Fix**:
1. Validate the API base URL against an allowlist of permitted origins
2. Do not persist `apiBaseUrl` — derive it from the environment variable on each load
3. At minimum, verify the URL's origin matches the current page origin or a configured trusted domain before sending credentials

---

### VULN-009: API Key Auth Skips Server Validation (Medium)

**Severity**: Medium  
**Location**: `src/features/auth/login/components/api-key-form.tsx:33–41`  
**OWASP**: A07 (Identification and Authentication Failures)

**Description**:
The API Key authentication form immediately stores the key and navigates to the app without any server-side validation. The user is marked as `isAuthenticated: true` before the API key is ever tested against the backend.

**Evidence**:

```typescript
// api-key-form.tsx:33-41
const onSubmit = async (data: ApiKeyFormValues) => {
    setIsLoading(true);
    try {
        setApiKeyAuth(data.apiKey, data.tenantId);  // No server validation!
        navigate({ to: search.redirect || '/' });
    } finally {
        setIsLoading(false);
    }
};
```

**Impact**:
- Users can enter invalid API keys and appear "authenticated" until the first API call fails
- No immediate feedback on invalid credentials
- Could lead to confusing error states deep in the application

**Recommended Fix**:
1. Make a validation request (e.g., `GET /health` or `GET /auth/me` with the API key header) before marking the user as authenticated
2. Only call `setApiKeyAuth()` after successful server validation

---

### VULN-010: No Client-Side Rate Limiting on Login (Medium)

**Severity**: Medium  
**Location**: `src/features/auth/login/components/credentials-form.tsx:37–63`  
**OWASP**: A07 (Identification and Authentication Failures)

**Description**:
The credentials login form has no client-side throttling, lockout, or exponential backoff. While server-side rate limiting should be the primary defense, the absence of client-side protection allows rapid-fire login attempts.

**Impact**:
- Facilitates automated brute-force attacks from the browser
- Excessive failed requests could cause DoS on the auth endpoint if server-side rate limiting is insufficient

**Recommended Fix**:
1. Implement exponential backoff after failed attempts (e.g., 1s, 2s, 4s delays)
2. Add a lockout counter (disable the submit button after N consecutive failures with a cooldown)
3. Consider adding a CAPTCHA challenge after 3+ failed attempts

---

### VULN-011: AdminUser Type Includes Secret Fields (Low)

**Severity**: Low  
**Location**: `src/features/admin/api/users.ts:44–47`  
**OWASP**: A02 (Cryptographic Failures), A01 (Broken Access Control)

**Description**:
The `AdminUser` TypeScript interface includes `secret1`, `secret1Expiry`, `secret2`, and `secret2Expiry` fields. If the backend returns these, they would be present in the browser's memory and potentially logged.

**Evidence**:

```typescript
// src/features/admin/api/users.ts:44-47
export interface AdminUser {
  // ...
  secret1?: string;
  secret1Expiry?: string;
  secret2?: string;
  secret2Expiry?: string;
  // ...
}
```

**Impact**:
- If the backend includes these values in responses, secrets are exposed to client-side code
- React Query caching means secrets persist in memory

**Recommended Fix**:
1. The backend should **never** return secret values in user list/detail responses — return only metadata (e.g., existence, partial mask, expiry)
2. Remove `secret1`/`secret2` from the client-side type definition
3. Add a DTO filter on the backend to strip sensitive fields

---

### VULN-012: Vite Environment Variable Embedded in Bundle (Low)

**Severity**: Low  
**Location**: `Dockerfile:34–35`, `vite.config.ts`, `src/store/playground-store.ts:26`  
**OWASP**: A05 (Security Misconfiguration)

**Description**:
`VITE_API_URL` is set as a Docker build argument and baked into the JavaScript bundle at build time. This is standard Vite behavior — all `VITE_*` variables are replaced at build time and visible in the client bundle.

**Evidence**:

```dockerfile
# Dockerfile:34-35
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
```

**Impact**:
- Low risk since this is only the API URL, not a secret
- However, this pattern could be misused if someone adds `VITE_SECRET_KEY` — there is no guardrail preventing secrets from being prefixed with `VITE_`

**Recommended Fix**:
1. Add a CI/build step that validates no sensitive-looking `VITE_*` variables are used (e.g., reject `VITE_*KEY*`, `VITE_*SECRET*`, `VITE_*PASSWORD*`)
2. Document the security boundary: `VITE_*` variables are public, never put secrets there
3. Consider using a runtime configuration endpoint (`/config.json`) instead of build-time env vars for deployment flexibility

---

### VULN-013: Error Boundary Logs to console.error in Production (Low)

**Severity**: Low  
**Location**: `src/components/error-boundary.tsx:23–24`  
**OWASP**: A09 (Security Logging and Monitoring Failures)

**Description**:
The `ErrorBoundary` class logs full error objects and error info (including component stack traces) to `console.error` in all environments, including production.

**Evidence**:

```typescript
// error-boundary.tsx:23-24
componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
}
```

**Impact**:
- Stack traces in production can reveal internal component structure, file paths, and logic
- Browser DevTools or log-capturing extensions can harvest this data

**Recommended Fix**:
1. In production, send errors to a monitoring service (Sentry, Datadog) instead of console
2. Suppress or sanitize `console.error` output in production builds
3. At minimum, remove `errorInfo` (component stack) from production logs

---

### VULN-014: Unpinned `serve` Version in Dockerfile (Low)

**Severity**: Low  
**Location**: `Dockerfile:57`  
**OWASP**: A06 (Vulnerable and Outdated Components)

**Description**:
The production Dockerfile installs `serve@14` without a pinned minor/patch version, which means builds could pull different versions over time.

**Evidence**:

```dockerfile
RUN npm install -g serve@14
```

**Impact**:
- A compromised or buggy minor release could be silently pulled into production
- Non-reproducible builds

**Recommended Fix**:
1. Pin the exact version: `serve@14.2.4` (or latest known-good)
2. Use a lock file or checksum verification for global installs

---

### VULN-015: Production Source Maps Correctly Disabled (Info — Positive)

**Severity**: Info (Positive Finding)  
**Location**: `vite.config.ts:86`

**Description**:
The Vite configuration correctly disables source maps in production builds.

```typescript
sourcemap: process.env.NODE_ENV === 'production' ? false : true,
```

This prevents exposing original source code in production deployments.

---

### VULN-016: React-Markdown Uses skipHtml and Safe Link Filtering (Info — Positive)

**Severity**: Info (Positive Finding)  
**Location**: `src/features/doc-panel/components/doc-content.tsx:106–112, 160–163`

**Description**:
The `ReactMarkdown` component is configured with `skipHtml: true` (prevents raw HTML injection) and a `getSafeHref()` function that only allows `http://`, `https://`, and `mailto:` protocols (preventing `javascript:` URI attacks). Links include `rel="noopener noreferrer"`.

```typescript
const markdownRenderOptions = {
  remarkPlugins: [remarkGfm],
  skipHtml: true,          // Blocks raw HTML
  components: markdownComponents,
};

function getSafeHref(href?: string) {
  if (!href) return undefined;
  const isSafe = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:');
  return isSafe ? href : undefined;
}
```

This is a strong defensive pattern against XSS via markdown content.

---

## Recommendations Summary

### Immediate (Critical / High — within 1–2 sprints)

1. **Migrate token storage from localStorage to httpOnly cookies** — Coordinate with backend team to set auth cookies on login/refresh responses. This resolves VULN-001, VULN-003, and reduces impact of VULN-002.

2. **Validate/restrict WebSocket URL** — Remove the user-editable WebSocket URL input or validate it against the configured API base URL origin. (VULN-004)

3. **Remove token from WebSocket URL query parameter** — Send authentication as the first WebSocket frame message instead of embedding in the URL. (VULN-005)

### Short-term (Medium — within 1–2 months)

4. **Implement Content Security Policy** — Add CSP headers via `serve.json` or a reverse proxy. Start with a report-only policy and tighten over time. (VULN-006)

5. **Encrypt or relocate medical history storage** — Either move summarization history to server-side storage, encrypt client-side data, or use sessionStorage with automatic TTL. (VULN-007)

6. **Validate API base URL against allowlist** — Prevent redirecting authenticated requests to arbitrary origins. (VULN-008)

7. **Add server-side validation for API key auth** — Validate the API key on login before marking the user as authenticated. (VULN-009)

8. **Add client-side login rate limiting** — Implement exponential backoff and attempt counters. (VULN-010)

### Long-term (Low / Maintenance)

9. **Strip secret fields from API responses** — Backend should never return `secret1`/`secret2` to the frontend. (VULN-011)

10. **Add VITE_ variable safety check to CI** — Prevent accidental secret exposure via build-time env vars. (VULN-012)

11. **Integrate error monitoring service** — Replace console.error in production with Sentry/Datadog. (VULN-013)

12. **Pin all Docker dependency versions** — Use exact versions for reproducible builds. (VULN-014)

---

## OWASP Top 10 Compliance Checklist

| Category | Status | Notes |
|----------|--------|-------|
| A01: Broken Access Control | **Partial** | Admin routes use role checks via store; secret fields exposure risk |
| A02: Cryptographic Failures | **Fail** | Tokens in localStorage; JWT decoded without verification; PHI in plaintext client storage |
| A03: Injection | **Pass** | No SQL, no dangerouslySetInnerHTML, no eval, React JSX escaping, skipHtml on markdown |
| A04: Insecure Design | **Partial** | Medical data in localStorage without encryption or TTL |
| A05: Security Misconfiguration | **Fail** | No CSP headers, no X-Frame-Options, user-editable API URL, unpinned deps |
| A06: Vulnerable Components | **Pass** | Dependencies are current; no known CVEs in listed packages as of audit date |
| A07: Authentication Failures | **Fail** | Tokens in localStorage, no client rate limiting, API key auth without validation |
| A08: Integrity Failures | **Pass** | Dependencies from npm registry; no unsigned CDN scripts |
| A09: Logging Failures | **Partial** | Error boundary logs stack traces to console in production; token in WS URL could be logged |
| A10: SSRF | **Partial** | User-editable WebSocket URL; user-modifiable API base URL |

---

## Scope of Audit

- **Files reviewed**: 259 files across `apps/ui-playground/`
- **Source files scanned**: All `.ts`, `.tsx` files in `src/`
- **Patterns searched**: `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, `document.write()`, `localStorage`, `sessionStorage`, `JSON.parse`, `WebSocket`, `VITE_`, `CORS`, `CSP`, `helmet`, secrets/tokens/keys, window.open/location manipulation
- **Configuration files**: `vite.config.ts`, `Dockerfile`, `package.json`, `.env.example`
- **Not in scope**: Backend API security, @arcaai/vox SDK internals, network-level security
