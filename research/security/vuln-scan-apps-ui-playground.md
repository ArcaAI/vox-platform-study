# Vulnerability Scan Report — `apps/ui-playground`

**Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Scope**: Deep vulnerability scan — dependencies, code patterns, infrastructure
**Tools**: pnpm audit, npm registry probe, manual static analysis (241 source files)
**Application**: ArcaVox Playground — React 19 / Vite 7 / TanStack Router

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 6 |
| Medium | 8 |
| Low | 5 |
| Info | 4 |

The UI Playground has **no XSS via `dangerouslySetInnerHTML`** and no `eval()` usage — both common React pitfalls are absent. However, the scan reveals **critical issues** in authentication token storage, open redirect logic, and WebSocket protocol handling that require immediate attention.

---

## 1. Dependency CVEs

### 1.1 Direct Dependency Analysis

All direct dependencies were checked against known CVE databases as of 2026-03-24.

| Package | Version | Known CVEs | Status |
|---------|---------|------------|--------|
| react | ^19.2.4 | None known | OK |
| react-dom | ^19.2.4 | None known | OK |
| vite | ^7.3.1 | None known | OK |
| @tanstack/react-router | ^1.168.3 | None known | OK |
| @tanstack/react-query | ^5.95.2 | None known | OK |
| @tanstack/react-table | ^8.21.3 | None known | OK |
| zustand | ^5.0.12 | None known | OK |
| zod | ^4.3.6 | None known | OK |
| react-markdown | ^10.1.0 | None known | OK |
| remark-gfm | ^4.0.1 | None known | OK |
| yaml | ^2.8.3 | None known | OK |
| diff | ^8.0.4 | None known | OK |
| date-fns | ^3.6.0 | None known | OK |
| sonner | ^2.0.7 | None known | OK |
| @hookform/resolvers | ^3.10.0 | None known | OK |
| react-hook-form | ^7.72.0 | None known | OK |
| class-variance-authority | ^0.7.1 | None known | OK |
| clsx | ^2.1.1 | None known | OK |
| tailwind-merge | ^3.5.0 | None known | OK |
| tailwindcss | ^4.2.2 | None known | OK |
| lucide-react | ^1.0.1 | None known | OK |
| @tabler/icons-react | ^3.40.0 | None known | OK |
| next-themes | ^0.4.6 | None known | OK |
| @radix-ui/* | Various | None known | OK |
| postcss | ^8.5.8 | None known | OK |
| typescript | ^5.9.3 | None known | OK |

### 1.2 Transitive Dependency CVEs (via `pnpm audit`)

The monorepo-wide `pnpm audit` found **26 vulnerabilities** across the workspace. Those relevant to ui-playground's transitive tree:

| Advisory | Package | Severity | Impact | Path |
|----------|---------|----------|--------|------|
| GHSA-c2qf-rxjj-qqgw | semver <5.7.2 | High | ReDoS | config-rollup > rollup-plugin-node-builtins > browserify-fs > levelup > semver |
| GHSA-x6fg-f45m-jf5q | semver <4.3.2 | High | ReDoS | Same path |
| GHSA-3ppc-4f35-3m26 | minimatch <9.0.6 | High | ReDoS | config-eslint > @vercel/style-guide > @typescript-eslint chain |
| GHSA-7r86-cg39-jmmj | minimatch <9.0.7 | High | ReDoS (GLOBSTAR) | Same path |
| GHSA-23c5-xmqv-rm74 | minimatch <9.0.7 | High | ReDoS (extglobs) | Same path |

**Risk assessment**: These are all in dev/build-time dependencies (`config-rollup`, `config-eslint`), not in the production runtime bundle. Risk is limited to CI/CD pipeline DoS during builds when processing adversarial input patterns.

**Remediation**: Update `@vercel/style-guide` and `rollup-plugin-node-builtins` to pull patched transitive deps.

---

## 2. Prototype Pollution

### 2.1 Custom `deepMerge` Function — MEDIUM

**File**: `src/features/admin/audio-pipelines/pipeline-config-editor.tsx` (lines 147-171)

```typescript
function deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(target)) {
        if (key in source) {
            // ...recursive merge
        }
    }
    for (const key of Object.keys(source)) {
        if (!(key in target)) {
            result[key] = source[key]; // copies any key, including __proto__
        }
    }
    return result;
}
```

**Vulnerability**: The `deepMerge` function does not filter `__proto__`, `constructor`, or `prototype` keys. Since `source` comes from user-editable YAML (parsed via the `yaml` package), an attacker could craft YAML like:

```yaml
__proto__:
  isAdmin: true
```

**Impact**: Medium. The merged result is used as a `PipelineConfig` typed object and rendered in a form — not passed to security-critical logic. However, if the object ever reaches `Object.assign` or similar patterns elsewhere, prototype pollution could propagate.

**Remediation**:
```typescript
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (BANNED_KEYS.has(key)) continue;
        // ... existing logic
    }
    return result;
}
```

### 2.2 `Object.assign` Usage — LOW

**Files**: `src/features/summarization/pre-summary/index.tsx` (line 355), `src/features/summarization/summary/index.tsx` (lines 386, 610)

```typescript
Object.assign(body, buildAssembledPayload({ inputMode, ... }));
```

**Assessment**: The `body` is a locally constructed object, and `buildAssembledPayload` returns computed values — not raw user input. **Low risk**, but worth noting as a pattern to watch.

---

## 3. DOM Clobbering

### 3.1 `document.getElementById` Usage — LOW

**Files**:
- `src/components/layout/table-of-contents.tsx` (line 34): `document.getElementById(section.id)` where `section.id` comes from a static sections array.
- `src/main.tsx` (line 75): `document.getElementById('root')!` — standard React mount point.

**Assessment**: Both usages reference IDs that are either hardcoded or derived from application-controlled data (not user input). **No exploitable DOM clobbering vector found**.

The app does not use named `<form>` elements or `<embed>`/`<object>` tags that could shadow global properties.

---

## 4. postMessage Vulnerabilities

### 4.1 AudioWorklet Port Communication — LOW

**File**: `src/features/summarization/components/ws-audio-transcript-demo.tsx` (lines 239, 255)

```typescript
this.port.postMessage(int16.buffer, [int16.buffer]);  // worklet → main
workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { ... }  // main ← worklet
```

**Assessment**: This communication is between an `AudioWorkletNode` and its processor — a same-origin, same-context channel. The `postMessage` here uses the `MessagePort` API (not `window.postMessage`), which is not exposed to cross-origin attacks.

### 4.2 No `window.addEventListener('message')` — PASS

No instances of `window.addEventListener('message', ...)` or `window.onmessage` were found in the codebase. The application does not accept cross-origin messages.

---

## 5. Service Worker / Web Worker Attacks

### 5.1 Inline AudioWorklet via Blob URL — MEDIUM

**File**: `src/features/summarization/components/ws-audio-transcript-demo.tsx` (lines 228-249)

```typescript
const workletCode = `
  class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) { ... }
  }
  registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;
const blob = new Blob([workletCode], { type: 'application/javascript' });
const workletUrl = URL.createObjectURL(blob);
await audioContext.audioWorklet.addModule(workletUrl);
URL.revokeObjectURL(workletUrl);
```

**Vulnerability**: The worklet code is a hardcoded string literal — not dynamically constructed from user input. The Blob URL is revoked immediately after module registration.

**Risk**: Minimal. If Content-Security-Policy (CSP) is ever deployed with `worker-src`, inline blob workers would be blocked unless `blob:` is explicitly allowed. This is not a vulnerability today but a CSP compatibility concern.

### 5.2 No Service Worker Registered — PASS

No `navigator.serviceWorker.register()` calls were found. No service worker attack surface exists.

---

## 6. Open Redirects — CRITICAL

### 6.1 Unvalidated `redirect` Search Parameter — CRITICAL

**Files**:
- `src/routes/_authenticated/route.tsx` (line 9): Sets `redirect: location.href`
- `src/features/auth/login/components/credentials-form.tsx` (line 57): `navigate({ to: search.redirect || '/' })`
- `src/features/auth/login/components/api-key-form.tsx` (line 37): `navigate({ to: search.redirect || '/' })`

**Vulnerability**: After successful authentication, the app navigates to whatever URL is in the `redirect` search parameter. The `redirect` value is validated by Zod only as `z.string().optional()` — no URL scheme or domain validation.

```typescript
// Route definition
const searchSchema = z.object({
    redirect: z.string().optional(),  // accepts ANY string
});

// Post-login navigation
navigate({ to: search.redirect || '/' });  // navigates to attacker-controlled URL
```

**Attack scenario**: An attacker crafts a phishing link:
```
https://app.arcaai.com/login?redirect=https://evil.com/steal-tokens
```

After the user authenticates, TanStack Router may interpret the `redirect` value as an external URL or a path that leads to an attacker-controlled page.

**Impact**: Critical in a healthcare context. Post-authentication redirect to an attacker-controlled page could harvest session tokens, display fake "session expired" prompts, or mimic the application to collect PHI.

**Remediation**:
```typescript
const searchSchema = z.object({
    redirect: z.string()
        .optional()
        .transform((val) => {
            if (!val) return '/';
            // Only allow relative paths starting with /
            if (val.startsWith('/') && !val.startsWith('//')) return val;
            return '/';
        }),
});
```

---

## 7. Clickjacking — HIGH

### 7.1 No Frame Protection Headers — HIGH

**Assessment**: Neither `X-Frame-Options` nor `Content-Security-Policy: frame-ancestors` headers are set anywhere in the application:

- **`index.html`**: No meta-tag CSP directives.
- **`vite.config.ts`**: No custom response headers configured for the dev server.
- **`Dockerfile`**: Uses `serve -s dist` which serves static files without security headers.

**Impact**: The application can be embedded in an `<iframe>` on any domain. An attacker could overlay transparent frames to perform clickjacking attacks, potentially tricking users into:
- Approving medical consultations
- Starting audio recordings
- Changing configuration settings

**Remediation**:
1. Add CSP meta tag to `index.html`:
```html
<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self';">
```

2. Configure `serve` with security headers in production:
```json
{
  "headers": [{
    "source": "**/*",
    "headers": [{
      "key": "X-Frame-Options",
      "value": "DENY"
    }, {
      "key": "Content-Security-Policy",
      "value": "frame-ancestors 'self'"
    }]
  }]
}
```

---

## 8. MIME Sniffing — HIGH

### 8.1 No `X-Content-Type-Options` Header — HIGH

The production serving layer (`serve -s dist`) does not set `X-Content-Type-Options: nosniff`. Without this header, browsers may MIME-sniff responses, potentially treating non-executable content as executable.

**Impact**: If an attacker can upload or inject content (e.g., via the file upload feature in `adminClient.upload()`), the browser might execute it as JavaScript.

**Remediation**: Add to `serve` configuration or reverse proxy:
```
X-Content-Type-Options: nosniff
```

---

## 9. Subdomain Takeover — LOW

### 9.1 External Resource Reference — LOW

**File**: `src/index.css` (line 1)

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:...');
```

**Assessment**: The only external resource loaded is from `fonts.googleapis.com`, a Google-controlled domain. No risk of subdomain takeover.

No other external CDN, analytics, or third-party script references were found in application code. The app is self-contained.

---

## 10. Dependency Confusion — CRITICAL

### 10.1 `@arcaai/*` Packages Not Reserved on npm — CRITICAL

**Registry probe results**: All 6 `@arcaai/*` workspace packages return **404 Not Found** on the public npm registry:

| Package | npm Registry Status |
|---------|-------------------|
| `@arcaai/ui` | 404 — Not found |
| `@arcaai/vox` | 404 — Not found |
| `@arcaai/room` | 404 — Not found |
| `@arcaai/stt` | 404 — Not found |
| `@arcaai/vad` | 404 — Not found |
| `@arcaai/noise-filter` | 404 — Not found |

**Vulnerability**: The `@arcaai` npm scope is not registered/owned on npmjs.com. An attacker could:

1. Register the `@arcaai` scope on npm
2. Publish malicious packages with matching names
3. If any CI/CD configuration, developer machine, or build system resolves from the public registry before the workspace, the malicious package would be installed

The project uses `workspace:*` protocol for these packages (good), and no `.npmrc` file exists in the repository (no registry override protection).

**Impact**: Critical. A dependency confusion attack could inject arbitrary code into the build pipeline, exfiltrate secrets, or inject backdoors into production builds.

**Remediation**:
1. **Immediately register the `@arcaai` scope** on npmjs.com (even if you never publish there)
2. Add a root `.npmrc` with explicit scope mapping:
```ini
@arcaai:registry=https://registry.internal.arcaai.com/
# Or if workspace-only:
@arcaai:registry=file:./packages/
```
3. Publish placeholder packages to npm with `"private": true` to prevent squatting

---

## 11. Build-time Injection

### 11.1 Custom Vite Plugin — Path Traversal Risk — MEDIUM

**File**: `vite.config.ts` (lines 8-53)

```typescript
function resolveArcaUiSubpaths(): Plugin {
    return {
        name: 'resolve-arcaai-ui-subpaths',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source.startsWith('@arcaai/ui/')) {
                const subpath = source.slice('@arcaai/ui/'.length);
                const direct = resolve(uiSrcRoot, `${subpath}.tsx`);
                if (existsSync(direct)) return direct;
                // ...more resolution attempts
            }
        },
    };
}
```

**Vulnerability**: The `subpath` is derived from import specifiers but is not sanitized against path traversal. If an import like `@arcaai/ui/../../../../../../etc/passwd` were introduced (via a compromised dependency or malicious PR), it could resolve files outside the intended directory.

**Impact**: Medium. Exploitability requires either a compromised dependency or a malicious code contribution. The `existsSync` check limits impact to information disclosure (file existence probing), not code execution.

**Remediation**:
```typescript
resolveId(source, importer) {
    if (source.startsWith('@arcaai/ui/')) {
        const subpath = source.slice('@arcaai/ui/'.length);
        // Prevent path traversal
        if (subpath.includes('..') || subpath.startsWith('/')) return undefined;
        // ...existing logic
    }
}
```

### 11.2 PostCSS / Tailwind Configuration — PASS

No `postcss.config.js` or `tailwind.config.js` files exist in the ui-playground directory. PostCSS is configured via `@tailwindcss/postcss` (a dev dependency), and Tailwind v4 is loaded via the `@tailwindcss/vite` plugin. These are well-maintained, widely-used packages with no known injection vectors.

### 11.3 TanStack Router Plugin — LOW

The `@tanstack/router-plugin/vite` plugin auto-generates route files via filesystem convention. This is a trusted, well-maintained plugin. No injection risk identified.

---

## 12. WebSocket Protocol Downgrade — HIGH

### 12.1 HTTP-to-WS Protocol Derivation — HIGH

**File**: `src/features/summarization/components/ws-audio-transcript-demo.tsx` (lines 68-70)

```typescript
const base = apiBaseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
setWsUrl(`${wsBase}/ws/stt-v2/stream`);
```

**Vulnerability**: The WebSocket URL scheme is derived from the API base URL. If `apiBaseUrl` uses `http://` (e.g., in development, or if a user manually configures it), the WebSocket connection will use unencrypted `ws://`.

**Compounding factor**: The WebSocket URL field in the UI is **user-editable** (line 362):
```typescript
<Input
    value={wsUrl}
    onChange={(e) => setWsUrl(e.target.value)}
    placeholder="ws://localhost:8868/ws/stt-v2/stream"
/>
```

A user could be socially engineered to paste a `ws://` URL, sending authentication tokens and live audio over an unencrypted channel.

**Impact**: High for a healthcare application. Medical audio data and authentication tokens transmitted over `ws://` are visible to any network observer (MITM, shared WiFi, corporate proxy).

### 12.2 Vite Dev Server Proxy Uses HTTP — MEDIUM

**File**: `vite.config.ts` (lines 73-82)

```typescript
proxy: {
    '/api': {
        target: 'http://localhost:8868',
        changeOrigin: true,
    },
    '/ws': {
        target: 'http://localhost:8868',
        changeOrigin: true,
        ws: true,
    },
},
```

**Assessment**: The dev proxy targets `http://localhost`, which is standard for local development. However, if this configuration is accidentally deployed to a staging environment or used in a non-localhost context, all API and WebSocket traffic would be unencrypted.

**Remediation**:
1. Enforce `wss://` for non-localhost WebSocket connections:
```typescript
const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
if (!wsBase.startsWith('wss://') && !wsBase.includes('localhost') && !wsBase.includes('127.0.0.1')) {
    console.warn('WebSocket using insecure ws:// for non-localhost host');
}
```
2. Consider making the WebSocket URL input read-only or adding a warning when `ws://` is used.

---

## 13. Authentication & Token Security

### 13.1 Sensitive Tokens in localStorage — HIGH

**File**: `src/store/auth-store.ts` (lines 131-148)

```typescript
persist(
    (set) => ({ ... }),
    {
        name: STORAGE_KEYS.AUTH,  // 'arcavox.auth'
        partialize: (state) => ({
            accessToken: state.accessToken,
            refreshToken: state.refreshToken,
            apiKey: state.apiKey,
            impersonationToken: state.impersonationToken,
            // ...all auth state
        }),
    },
),
```

**Vulnerability**: The Zustand store persists **all sensitive authentication material** to `localStorage`:
- JWT access tokens
- Refresh tokens
- API keys
- Impersonation tokens

`localStorage` is accessible to any JavaScript running on the same origin, making it vulnerable to XSS-based token theft. While no XSS vectors were found in this scan, defense-in-depth demands that tokens be stored in more secure locations.

**Impact**: High. In a healthcare application, stolen tokens could grant access to patient consultations, medical records, and audio recordings.

**Remediation**:
1. Move to `httpOnly` cookies for access/refresh tokens (requires API gateway changes)
2. If `localStorage` must be used, store only a session identifier and keep tokens in memory
3. At minimum, do NOT persist `refreshToken` or `apiKey` — these are long-lived credentials

### 13.2 JWT Decoding Without Verification — MEDIUM

**File**: `src/lib/auth-refresh.ts` (lines 21-33)

```typescript
export function getTokenExpiryMs(token: string): number {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(atob(parts[1]));
    if (typeof payload.exp !== 'number') return 0;
    const ms = payload.exp * 1000 - Date.now();
    return Math.max(0, ms);
}
```

**Assessment**: The JWT payload is decoded via `atob()` without signature verification. This is expected behavior for a frontend application (token verification happens server-side), but the decoded `exp` claim is trusted for scheduling token refresh. A tampered token with a far-future `exp` could prevent automatic refresh, causing silent auth failures.

**Impact**: Medium. Not directly exploitable for auth bypass, but could cause UX issues and delayed token rotation.

### 13.3 Impersonation Token Persistence — MEDIUM

**File**: `src/store/auth-store.ts` (lines 106-113)

The impersonation system persists the impersonated user's token and tenant context across page refreshes. If a super-admin's machine is compromised while impersonating a doctor, the attacker gains the doctor's session — potentially accessing patient data under the doctor's identity.

**Remediation**: Add a maximum impersonation duration; clear impersonation state on page close (use `sessionStorage` instead of `localStorage` for impersonation data).

---

## 14. Dockerfile Security

### 14.1 `--no-frozen-lockfile` in Dependency Stage — HIGH

**File**: `Dockerfile` (line 26)

```dockerfile
RUN pnpm install --no-frozen-lockfile
```

**Vulnerability**: Using `--no-frozen-lockfile` allows `pnpm` to resolve and install different dependency versions than what's in `pnpm-lock.yaml`. This defeats the purpose of lockfile integrity and opens the door to supply chain attacks where a compromised package publishes a malicious minor/patch version.

**Remediation**: Change to `--frozen-lockfile`:
```dockerfile
RUN pnpm install --frozen-lockfile
```

### 14.2 Node.js 22 Base Image — INFO

**File**: `Dockerfile` (line 1)

```dockerfile
ARG NODE_VERSION=22
```

Node.js 22 is the current LTS. No issues, but ensure base images are updated regularly for security patches.

### 14.3 Non-Root User — PASS

The Dockerfile correctly creates and switches to a non-root user (`ui:hope`) for the production stage.

### 14.4 Static File Server Security — MEDIUM

**File**: `Dockerfile` (line 72)

```dockerfile
CMD ["serve", "-s", "dist", "-l", "3000"]
```

The `serve` package (v14) serves static files but does **not** set security headers by default:
- No `X-Frame-Options`
- No `X-Content-Type-Options`
- No `Content-Security-Policy`
- No `Strict-Transport-Security`
- No `Referrer-Policy`

**Remediation**: Either:
1. Place a reverse proxy (nginx/Caddy) in front of `serve` with proper headers
2. Use a `serve.json` configuration file with custom headers
3. Replace `serve` with `nginx:alpine` in the production stage

---

## 15. Additional Findings

### 15.1 React-Markdown with `skipHtml: true` — PASS (Good Practice)

**File**: `src/features/doc-panel/components/doc-content.tsx` (line 162)

```typescript
const markdownRenderOptions = {
    remarkPlugins: [remarkGfm],
    skipHtml: true,          // prevents HTML injection
    components: markdownComponents,
};
```

The `skipHtml: true` option prevents raw HTML in markdown from being rendered, which mitigates XSS via markdown injection. The custom link renderer (`getSafeHref`) also validates URL schemes.

### 15.2 Href Sanitization — PASS (Good Practice)

**File**: `src/features/doc-panel/components/doc-content.tsx` (lines 106-112)

```typescript
function getSafeHref(href?: string) {
    if (!href) return undefined;
    const isSafe = href.startsWith('http://') ||
                   href.startsWith('https://') ||
                   href.startsWith('mailto:');
    return isSafe ? href : undefined;
}
```

This prevents `javascript:` URI injection in rendered markdown links.

### 15.3 Summarization History in localStorage — LOW

**File**: `src/features/summarization/history/index.tsx` (lines 68-79)

```typescript
function loadHistory(): StoredResult[] {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
}
```

**Assessment**: Medical summarization results are stored in `localStorage` without encryption. This data could contain sensitive patient information. While localStorage is same-origin protected, it persists after logout and is accessible to browser extensions.

**Remediation**: Clear summarization history on logout, or store in-memory only.

### 15.4 No CSRF Protection on State-Changing Requests — MEDIUM

The `adminClient` and `smrClient` use `fetch()` with bearer tokens in headers. Since cookies are not used for authentication, traditional CSRF is not applicable. However, if the API gateway ever switches to cookie-based auth, CSRF tokens would be needed.

### 15.5 Error Messages May Leak Internal Details — LOW

**File**: `src/features/summarization/api/smr-client.ts` (line 80)

```typescript
throw new SmrApiError(
    `Network error: Unable to reach ${url}. Is the API gateway running?`,
    0,
);
```

Error messages include full internal URLs which could reveal infrastructure details to users.

---

## Remediation Priority Matrix

| # | Finding | Severity | Effort | Priority |
|---|---------|----------|--------|----------|
| 1 | **Register @arcaai npm scope** | Critical | Low (1h) | P0 — Immediate |
| 2 | **Fix open redirect on login** | Critical | Low (30m) | P0 — Immediate |
| 3 | **Add security headers (X-Frame-Options, CSP, nosniff)** | High | Medium (2h) | P1 — This sprint |
| 4 | **Use `--frozen-lockfile` in Dockerfile** | High | Low (5m) | P1 — This sprint |
| 5 | **Enforce wss:// for non-localhost** | High | Low (30m) | P1 — This sprint |
| 6 | **Move tokens out of localStorage** | High | High (1-2d) | P1 — This sprint |
| 7 | **Add prototype pollution guards to deepMerge** | Medium | Low (15m) | P2 — Next sprint |
| 8 | **Add path traversal guard to Vite plugin** | Medium | Low (15m) | P2 — Next sprint |
| 9 | **Limit impersonation duration** | Medium | Medium (4h) | P2 — Next sprint |
| 10 | **Production static server hardening** | Medium | Medium (2h) | P2 — Next sprint |
| 11 | **Clear summarization history on logout** | Low | Low (15m) | P3 — Backlog |
| 12 | **Sanitize error messages** | Low | Low (30m) | P3 — Backlog |
| 13 | **Update transitive deps (semver, minimatch)** | Low | Low (30m) | P3 — Backlog |

---

## Positive Security Findings

The following security best practices were observed:

1. **No `dangerouslySetInnerHTML`** — React's default escaping is used throughout
2. **No `eval()` or `new Function()`** — no dynamic code execution
3. **No `document.write()`** — no DOM injection vectors
4. **No `window.addEventListener('message')`** — no cross-origin message handling
5. **No Service Workers** — no scope hijacking surface
6. **Markdown HTML sanitized** — `skipHtml: true` prevents HTML injection
7. **Link href sanitized** — scheme validation prevents `javascript:` URIs
8. **Non-root Docker user** — production container runs as unprivileged user
9. **Token refresh with deduplication** — concurrent refresh requests are coalesced
10. **Zod validation on route params** — search parameters are type-checked
11. **Blob URL immediately revoked** — AudioWorklet blob URL doesn't leak
12. **No lodash** — avoids lodash prototype pollution vectors entirely
13. **Source maps disabled in production** — `sourcemap: process.env.NODE_ENV === 'production' ? false : true`
14. **Private package** — `"private": true` prevents accidental npm publish
