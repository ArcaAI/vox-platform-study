# Vulnerability Scan Report — `apps/api/` (NestJS API Gateway)

**Scan Date:** 2026-03-24
**Last Updated:** 2026-04-06
**Scope:** `apps/api/` — NestJS 11 API Gateway + transitive workspace dependencies
**Classification:** Healthcare AI (HOPE) — handles PHI/ePHI
**Risk Context:** HIPAA, SOC 2, HITRUST applicable

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **CRITICAL** | 3 |
| **HIGH** | 8 |
| **MEDIUM** | 9 |
| **LOW** | 5 |
| **INFO** | 4 |

**Key Findings:**
1. **Live Azure OpenAI API key committed to Git** in `.env.dev` (CRITICAL)
2. **Refresh token forgery** — tokens are not stored server-side, can be forged by any authenticated user (CRITICAL)
3. **ValidationPipe missing `whitelist` and `forbidNonWhitelisted`** — allows mass assignment / prototype pollution via extra properties (CRITICAL)
4. **Prisma Studio exposed without proper auth** — `@Public()` decorator on GET endpoint (HIGH)
5. **Session `httpOnly: false` in non-production** — exposes session cookies to XSS (HIGH)
6. **CORS allows any HTTPS origin** in production — overly permissive for PHI-handling API (HIGH)
7. Multiple dependency CVEs including nodemailer DoS, lodash prototype pollution, and elliptic crypto weakness

---

## 1. CRITICAL: Hardcoded Secret in Git-Tracked `.env.dev`

**File:** `.env.dev` (line 166–167), tracked by Git
**Severity:** CRITICAL (CVSS 9.8)
**HIPAA Impact:** Potential unauthorized access to PHI via Azure OpenAI

```166:167:.env.dev
AZURE_OPENAI_API_KEY: F5Kvc2iVDdZVkGHsVSssaZs342f0qUURXUWIFn5VaJiodtqNV2McJQQJ99BAACYeBjFXJ3w3AAABACOGP15b
AZURE_OPENAI_ENDPOINT: https://alaas-openai.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview
```

The `.env.dev` file contains a **live Azure OpenAI API key** and is tracked by Git (`git ls-files` confirms). This key provides access to GPT-4o-mini deployments which process clinical text (summaries of PHI).

Additional hardcoded secrets found in Git-tracked env files:

| File | Secret Type | Value (truncated) | Risk |
|------|------------|-------------------|------|
| `.env.dev` | Azure OpenAI API Key | `F5Kvc2iV...P15b` | Live production key |
| `.env.dev` | MinIO Access Key | `minio_admin` | Object storage access |
| `.env.dev` | MinIO Secret Key | `minio_admin` | Object storage access |
| `.env.dev` | Vault Dev Token | `root` | Vault root access |
| `.env.dev` | Session Secret | `<CHANGE_ME>-session-secret-key` | Predictable secret |
| `.env.dev` | JWT Secret | `<CHANGE_ME>-jwt-secret-key` | Predictable JWT signing |
| `.env.dev` | DB Password | `postgres:postgres` | Database access |
| `apps/api/.env.example` | Session Secret | `hope-session-secret` | Weak default |
| `apps/api/.env.example` | Redis Password | `redis-password` | Weak default |

**Remediation:**
1. **IMMEDIATELY rotate** the Azure OpenAI API key `F5Kvc2iV...P15b`
2. Add `.env.dev`, `.env.test`, `.env.archive` to `.gitignore` and remove from tracking: `git rm --cached .env.dev .env.test .env.archive`
3. Run `git filter-branch` or `git filter-repo` to purge the key from Git history
4. Use a secrets manager (Vault, Azure Key Vault) for all production credentials

---

## 2. CRITICAL: Refresh Token Forgery — No Server-Side Storage

**File:** `apps/api/src/modules/auth/auth.controller.ts` (lines 387–432, 491–493)
**Severity:** CRITICAL (CVSS 9.1)
**HIPAA Impact:** Any user who knows another user's ID can forge a refresh token and gain full access

The refresh token is constructed as a predictable string:

```491:493:apps/api/src/modules/auth/auth.controller.ts
    private generateRefreshToken(userId: string): string {
        return `refresh_${userId}_${Date.now()}_${randomBytes(32).toString('hex')}`;
    }
```

The refresh endpoint (line 392–397) validates by **parsing the token string** and extracting the userId:

```392:397:apps/api/src/modules/auth/auth.controller.ts
        const parts = body.refreshToken.split('_');
        if (parts.length < 3 || parts[0] !== 'refresh') {
            throw new UnauthorizedException('Invalid refresh token format');
        }

        const userId = parts[1];
```

**Vulnerability:** The refresh token is **never stored server-side**. An attacker who knows any user's ID can craft `refresh_<victimUserId>_<any-timestamp>_<any-hex>` and it will pass validation, issuing a new JWT for the victim. The `randomBytes(32)` portion is never verified.

**Remediation:**
1. Store refresh tokens in Redis/PostgreSQL with a hashed value
2. On refresh, look up the hashed token and verify it matches
3. Implement refresh token rotation (one-time use)
4. Add family tracking to detect token reuse

---

## 3. CRITICAL: ValidationPipe Missing `whitelist` and `forbidNonWhitelisted`

**File:** `apps/api/src/main.ts` (line 272)
**Severity:** CRITICAL (CVSS 8.6)
**HIPAA Impact:** Mass assignment can modify protected fields; prototype pollution via `__proto__`

```272:272:apps/api/src/main.ts
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
```

The global `ValidationPipe` has `transform: true` but is missing:
- `whitelist: true` — strip properties not in the DTO
- `forbidNonWhitelisted: true` — reject requests with unexpected properties

**Impact:** An attacker can send extra JSON properties (e.g., `isAdmin: true`, `tenantId: "other-tenant"`, `__proto__: { ... }`) and they will survive into the handler. Combined with `class-transformer`'s `transform: true`, these properties get assigned to the DTO class instance.

**Remediation:**
```typescript
app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
}));
```

---

## 4. HIGH: Prisma Studio Exposed with `@Public()` Decorator

**File:** `apps/api/src/modules/pstudio/pstudio.controller.ts` (lines 18–40)
**Severity:** HIGH (CVSS 8.1)
**HIPAA Impact:** Direct database access to PHI tables

```18:20:apps/api/src/modules/pstudio/pstudio.controller.ts
    @Get()
    @Public()
    @ApiExcludeEndpoint()
```

The Prisma Studio `GET` endpoint uses `@Public()`, bypassing JWT authentication entirely. While it checks for a `?token=` query parameter, this is only used to embed the token in the client-side HTML — it does **not** validate the JWT on the server. Any user who visits `/api/v1/admin/pstudio?token=anything` sees the Prisma Studio UI.

The POST endpoint (line 42) uses `@Authorize(['manage', 'all'])`, but the GET endpoint that serves the HTML is completely unauthenticated.

Additionally, the Studio is enabled by default in non-production (`ENABLE_PRISMA_STUDIO` defaults to `true` unless explicitly set to `false`).

**Remediation:**
1. Remove `@Public()` and require JWT authentication on the GET endpoint
2. Validate the JWT token server-side in `serveStudio()`
3. Set `ENABLE_PRISMA_STUDIO=false` by default; require explicit opt-in
4. Add IP allowlisting for Studio access

---

## 5. HIGH: Session Cookie `httpOnly: false` in Non-Production

**File:** `apps/api/src/main.ts` (lines 259–270)
**Severity:** HIGH (CVSS 7.5)

```259:270:apps/api/src/main.ts
    app.use(
        session({
            secret: process.env.SESSION_SECRET_KEY || 'a-very-secret-key',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: isProduction,
                httpOnly: !isProduction,
                maxAge: 24 * 60 * 60 * 1000
            }
        })
    );
```

Issues:
- **`httpOnly: !isProduction`** — In development/staging, session cookies are readable by JavaScript, enabling XSS to steal sessions
- **Fallback secret `'a-very-secret-key'`** — If `SESSION_SECRET_KEY` is unset, a hardcoded weak secret is used
- **No `sameSite` attribute** — Cookies are vulnerable to CSRF
- **No `name` override** — Default `connect.sid` name reveals Express/Connect stack fingerprint

**Remediation:**
```typescript
cookie: {
    secure: true,
    httpOnly: true,            // Always true
    sameSite: 'strict',        // CSRF protection
    maxAge: 24 * 60 * 60 * 1000,
}
```
Remove the fallback secret — fail fast if `SESSION_SECRET_KEY` is not configured.

---

## 6. HIGH: Overly Permissive CORS in Production

**File:** `apps/api/src/main.ts` (lines 74–91)
**Severity:** HIGH (CVSS 7.4)

```74:91:apps/api/src/main.ts
        // For SDK usage: Allow any HTTPS origin
        if (origin.startsWith('https://')) {
            // Block suspicious origins
            const blockedPatterns = [
                /\.onion$/,  // Tor domains
                /localhost/,  // Localhost in production
                // ...
            ];
            // ...
            return logCorsDecision(origin, true, 'https_sdk_allowed');
        }
```

In production, **any HTTPS origin** that isn't in the blocklist is allowed. This means `https://evil-attacker.com` can make credentialed cross-origin requests to the API. For a PHI-handling API, this is unacceptable.

Additionally, ngrok/localtunnel/Vercel/Netlify domains are explicitly allowed in production (lines 62–67) for "SDK testing" — these should never be allowed in production.

**Remediation:**
1. Remove the `https://` catch-all; require explicit origin registration
2. Remove dev-tool patterns (ngrok, localtunnel) from production CORS
3. Implement a tenant-specific CORS allowlist stored in the database

---

## 7. HIGH: `Math.random()` for Request ID Generation

**File:** `apps/api/src/shared/base-proxy.controller.ts` (line 121)
**Severity:** HIGH (CVSS 6.5)

```118:121:apps/api/src/shared/base-proxy.controller.ts
        const requestId =
            (req as any).requestId ||
            req.headers['x-request-id'] ||
            Math.random().toString(36).substring(2, 15);
```

`Math.random()` is not cryptographically secure. While used as a fallback for request IDs, in a healthcare context request IDs may appear in audit logs and be used for correlation. Predictable IDs could enable log injection or audit trail manipulation.

**Remediation:** Replace with `crypto.randomUUID()` or use the existing `uuidv7()` import.

---

## 8. HIGH: Template Injection via Prisma Studio HTML

**File:** `apps/api/src/modules/pstudio/pstudio.html.ts` (lines 91–92)
**Severity:** HIGH (CVSS 7.3)

```91:92:apps/api/src/modules/pstudio/pstudio.html.ts
                    url: '${studioEndpointUrl}',
                    customHeaders: { 'Authorization': 'Bearer ${token}' },
```

The `token` and `studioEndpointUrl` are interpolated directly into JavaScript via ES6 template literals inside an HTML response. While `token` comes from a query parameter and `studioEndpointUrl` from headers, an attacker can craft values containing `'` or JavaScript to break out of the string context.

For example, a token like `'; alert(document.cookie); '` would execute arbitrary JavaScript (Stored XSS).

**Remediation:**
1. JSON-encode values before interpolation: `JSON.stringify(token).slice(1, -1)`
2. Or use a CSP nonce for inline scripts and pass values via data attributes

---

## 9. HIGH: Tenant ID Override via Unauthenticated Header

**File:** `apps/api/src/interceptors/context.interceptor.ts` (lines 47–49)
**Severity:** HIGH (CVSS 8.0)
**HIPAA Impact:** Cross-tenant data access — PHI leakage

```47:49:apps/api/src/interceptors/context.interceptor.ts
        const tenantIdHeader = request.headers['x-tenant-id'];
        if (tenantIdHeader) {
            this.tryClsSet('tenantId', tenantIdHeader);
        }
```

Any request can override the tenant context by setting the `X-Tenant-Id` header. This header value is accepted **without validation** and used to set the CLS tenant context. This runs in the `ContextInterceptor` which executes for every request, potentially overriding the authenticated tenant from the JWT.

**Remediation:**
1. Only allow `X-Tenant-Id` header from service-to-service calls (validate with internal service token)
2. After the auth guard sets the tenant from JWT, never allow header override
3. Add validation that the header value matches the authenticated user's assigned tenants

---

## 10. HIGH: Request Body Controls Request ID (Client-Controlled Correlation)

**File:** `apps/api/src/interceptors/context.interceptor.ts` (line 37)
**Severity:** MEDIUM (CVSS 5.3)

```36:38:apps/api/src/interceptors/context.interceptor.ts
        if (!request.requestId) {
            request.requestId = request?.body?.requestId ?? uuidv7();
            this.tryClsSet('correlationId', request.requestId);
        }
```

The request body's `requestId` field is used as the correlation ID. An attacker can set this to any value, potentially:
- Injecting malicious strings into log entries (log injection)
- Correlating with another user's request IDs to confuse audit trails
- Setting it to a very large string for log flooding

**Remediation:** Never trust client-supplied request IDs for internal correlation. Generate server-side UUIDs exclusively.

---

## 11. Dependency CVE Table

### Direct Dependencies

| Package | Version | CVE | Severity | Description | Fix |
|---------|---------|-----|----------|-------------|-----|
| `speakeasy` | `2.0.0` | Unmaintained | **HIGH** | Package is abandoned (last update 2017). No security patches since 2017. Known timing attack vulnerability in TOTP verification. | Replace with `otpauth` or `@simplewebauthn/server` |
| `passport-local` | `1.0.0` | Unmaintained | **MEDIUM** | Package is abandoned (last update 2017). | Consider using NestJS built-in auth strategies |
| `class-transformer` | `0.5.1` | None current | **MEDIUM** (Design) | When `whitelist` is not set on `ValidationPipe`, `plainToInstance` with `transform: true` copies all properties including `__proto__` | See Finding #3 |

### Transitive Dependencies (from `pnpm audit`)

| Package | Installed | CVE | Severity | CVSS | Description | Fix Version |
|---------|-----------|-----|----------|------|-------------|-------------|
| `nodemailer` | `6.10.1` | CVE-2025-14874 | **HIGH** | 7.5 | DoS via recursive address parser — single request crashes Node.js process | `>=7.0.11` |
| `nodemailer` | `6.10.1` | CVE-2025-13033 | **MEDIUM** | — | Email misrouting via quoted local-part parsing | `>=7.0.7` |
| `lodash` | `4.17.21` | CVE-2025-13465 | **HIGH** | 7.5 | Prototype pollution in nested property access | `>=4.17.22` |
| `elliptic` | `6.6.1` | CVE-2025-14505 | **LOW** | 5.6 | Incorrect ECDSA signature generation with leading-zero k values | No patch (affects all versions) |
| `bl` | `0.8.2` | CVE-2020-8244 | **MEDIUM** | 6.5 | Buffer over-read / memory exposure | `>=1.2.3` |
| `bl` | `0.8.2` | GHSA-wrw9-m778-g6mc | **MEDIUM** | — | Memory exposure via `append(number)` | `>=0.9.5` |
| `hono` | `4.11.4` | GHSA-gq3j-xvxp-8hrf | **LOW** | — | Non-constant-time comparison in auth middleware | `>=4.11.10` |
| `langsmith` | `<0.4.6` | CVE-2026-25528 | **MEDIUM** | 5.8 | SSRF via tracing header injection (baggage header) | `>=0.4.6` |

---

## 12. SSRF Analysis

**File:** `apps/api/src/shared/base-proxy.controller.ts`
**File:** `apps/api/src/modules/streaming/smr-proxy.controller.ts`
**File:** `apps/api/src/modules/health/health.controller.ts`
**Severity:** LOW (mitigated)

The proxy and HTTP client calls use environment-configured URLs (`SMR_URL`, `TTS_URL`, etc.), not user-controlled input. The `BaseProxyController` target is set from `config.serviceUrl` which comes from environment variables.

In `smr-proxy.controller.ts`, the `taskId` parameter is interpolated into URLs (line 337):
```typescript
this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}`, ...)
```

While `taskId` comes from a route parameter, it could theoretically be used for path injection (e.g., `../../admin/secret`). However, axios URL handling and the base URL structure mitigate this risk.

**Status:** Low risk, but consider validating `taskId` as UUID format.

---

## 13. Path Traversal Analysis

**File:** `apps/api/src/modules/storage/storage.controller.ts`
**Severity:** LOW (mitigated)

The storage controller has proper path traversal checks:
```typescript
if (/[.]{2}|[/\\]/.test(fileKey)) {
    throw new BadRequestException('Invalid file key: path traversal not allowed');
}
```

This check is applied consistently across bucket names (lines 63, 76, 92, 104) and file keys (line 145). The file `:key` route parameter (lines 156, 170) does not have the traversal check, but S3/MinIO APIs handle key validation.

**Gap:** The `prefix` query parameter for `listFiles` (line 119) is passed directly without traversal validation.

**Remediation:** Add `../` check on the `prefix` parameter.

---

## 14. ReDoS (Regular Expression DoS) Analysis

**Severity:** LOW

All regex patterns found in `apps/api/src/` are simple patterns without nested quantifiers:
- `/[.]{2}|[/\\]/` — Storage traversal check (safe: no backtracking)
- `/\.ngrok\.io$/`, `/\.vercel\.app$/` — CORS domain matching (safe: anchored)
- `/^http:\/\/localhost:\d+$/` — Localhost matching (safe: anchored with `$`)
- `/^(audio|video|application|text|image)\//` — File type validation (safe: alternation without nesting)
- `/172\.(1[6-9]|2[0-9]|3[0-1])\./` — Private network check (safe: bounded character classes)

**Status:** No ReDoS vulnerabilities found.

---

## 15. Race Condition / TOCTOU Analysis

**File:** `apps/api/src/modules/auth/auth.controller.ts`
**Severity:** MEDIUM

In the login flow (lines 80–116), the sequence is:
1. Find user by username
2. Verify password
3. Get user roles
4. Verify tenant assignment
5. Issue JWT

Between steps 1–5, the user's status or roles could change (e.g., user disabled, role revoked). This is a classic TOCTOU (Time-of-Check-Time-of-Use) pattern. In a healthcare context, a user could be revoked but still receive a valid JWT.

**Remediation:** Use a database transaction for the entire login flow, or verify user status again at token issuance time.

---

## 16. Unsafe Deserialization

**File:** `apps/api/src/modules/streaming/stt-ws.gateway.ts` (line 154)
**File:** `apps/api/src/modules/streaming/smr-proxy.controller.ts` (lines 208, 281)
**Severity:** MEDIUM

`JSON.parse()` is used on WebSocket messages and tenant configuration values:

```154:157:apps/api/src/modules/streaming/stt-ws.gateway.ts
            msg = JSON.parse(str);
        } catch {
            this.sendError(client, 'INVALID_JSON', 'Message must be valid JSON');
            return;
```

While the parse is wrapped in try-catch, the parsed object is used with dynamic property access (`msg.type`, `msg.seq`, `msg.data`) without schema validation. A malicious WebSocket client could send deeply nested JSON to consume memory, or craft messages that exploit downstream processing.

**Remediation:**
1. Add JSON schema validation (e.g., `zod`, `ajv`) after parsing
2. Limit JSON payload size at the WebSocket level
3. Validate `msg.type` is one of expected values before any processing

---

## 17. Memory Leak / DoS Vectors

**File:** `apps/api/src/modules/streaming/stt-ws.gateway.ts` (line 30)
**Severity:** MEDIUM

```30:30:apps/api/src/modules/streaming/stt-ws.gateway.ts
    private readonly sessions = new Map<WebSocket, SessionInfo>();
```

The WebSocket sessions map grows with each connection and is cleaned on disconnect. However:
- No maximum connection limit per IP or tenant
- No rate limiting on WebSocket connections
- A malicious client could open thousands of connections, exhausting server memory
- `binarySeq` counter increments unboundedly per session

**Remediation:**
1. Implement per-IP connection limits
2. Add per-tenant WebSocket connection quotas
3. Set a maximum session duration / idle timeout
4. Add WebSocket-level rate limiting via `@nestjs/throttler`

---

## 18. Dockerfile Security Analysis

**File:** `apps/api/Dockerfile`
**Severity:** LOW (mostly good practices)

**Good:**
- Multi-stage build (dependencies → builder → production)
- Non-root user created (`api:hope`, UID 1001)
- `dumb-init` for signal handling
- Specific Node version via ARG (not `latest`)
- `--no-install-recommends` on apt-get
- Layer cleanup with `rm -rf /var/lib/apt/lists/*`

**Issues Found:**

| Line | Issue | Severity | Recommendation |
|------|-------|----------|----------------|
| 30, 105 | `--no-frozen-lockfile` | MEDIUM | Allows dependency resolution changes between builds. Use `--frozen-lockfile` for reproducibility. |
| 65 | No `USER api` statement | **HIGH** | Production stage creates user but **never switches to it** (`USER api` is missing). Container runs as root. |
| 1 | `ARG NODE_VERSION=22` | LOW | Major version without minor pin. Use `22.14` or similar for reproducibility. |
| 80–84 | `curl` and `wget` installed in production | LOW | Attack surface — remove unless needed for health checks. |

**Critical Missing:** The Dockerfile creates user `api` (line 87) but never runs `USER api`. The container process runs as **root**.

**Remediation:**
Add before the ENTRYPOINT:
```dockerfile
USER api
```

---

## 19. HTTP Response Splitting / CRLF Injection

**Severity:** LOW

Headers set via `res.setHeader()` in `main.ts` use hardcoded values. The `X-Forwarded-Proto` header in `pstudio.controller.ts` is used to construct the Studio URL, but is rendered into HTML (not headers), so CRLF injection doesn't apply.

No header values are constructed from user input. **No vulnerabilities found.**

---

## 20. Open Redirects

**Severity:** NONE

No `res.redirect()` calls found in the codebase. No redirect endpoints exist. **No vulnerabilities found.**

---

## 21. Hardcoded Internal URLs / Infrastructure Details

**File:** `apps/api/src/main.ts` (lines 51–58)
**File:** Various `.env` files
**Severity:** INFO

Production domain names are hardcoded:
- `https://app.arcaai.com`
- `https://dashboard.arcaai.com`
- `https://admin.arcaai.com`
- `https://staging.arcaai.com`
- `https://staging-app.arcaai.com`
- `https://staging-dashboard.arcaai.com`

Internal service URLs in `.env.dev`:
- `http://localhost:8861` (STT)
- `http://localhost:8862` (SMR)
- `http://localhost:8863` (TTS)
- `http://localhost:8864` (NLP)

Azure endpoint: `https://alaas-openai.openai.azure.com/` (in committed `.env.dev`)

**Remediation:** Move domain allowlists to configuration. The Azure endpoint exposure is mitigated by key rotation (see Finding #1).

---

## 22. `speakeasy` Package — Abandoned and Vulnerable

**File:** `apps/api/package.json` (line 75)
**Severity:** HIGH

The `speakeasy` package (v2.0.0) was last updated in **2017** and is unmaintained. Known issues:
- Timing attack vulnerability in TOTP verification (no CVE assigned)
- No TypeScript types maintained
- No security patches in 9+ years
- NPM advisory: "This package has been deprecated"

**Remediation:** Replace with `otpauth` (actively maintained, TypeScript-first) or `@simplewebauthn/server`.

---

## 23. JWT Default Secret Key

**File:** `apps/api/src/modules/auth/auth.controller.ts` (lines 120, 341, 414)
**Severity:** HIGH

```120:120:apps/api/src/modules/auth/auth.controller.ts
            const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
```

The JWT signing key has a hardcoded default value `'default-jwt-secret-key-change-in-production'`. If the `JWT_SECRET_KEY` setting is not configured, all JWTs are signed with a well-known key, allowing any attacker to forge authentication tokens.

**Remediation:**
1. Remove the default value — throw an error if `JWT_SECRET_KEY` is not set
2. Validate key strength at startup (minimum 256 bits of entropy)
3. Use RS256 (asymmetric) instead of HS256 for JWT signing

---

## Remediation Priority

### Immediate (within 24 hours)
1. **Rotate the Azure OpenAI API key** and purge from Git history
2. **Add `USER api`** to Dockerfile before ENTRYPOINT
3. **Fix ValidationPipe** — add `whitelist: true, forbidNonWhitelisted: true`
4. **Fix session cookie** — set `httpOnly: true` always, add `sameSite: 'strict'`
5. **Remove JWT default secret** — fail fast if unconfigured

### Short-term (within 1 week)
6. **Implement server-side refresh token storage** with rotation
7. **Fix Prisma Studio auth** — remove `@Public()`, validate JWT server-side
8. **Fix tenant ID header override** — validate against JWT tenant
9. **Remove `.env.dev`** from Git tracking
10. **Update nodemailer** to `>=7.0.11` to fix DoS vulnerability
11. **Replace `speakeasy`** with `otpauth`
12. **Restrict CORS** — remove `https://` catch-all in production

### Medium-term (within 1 month)
13. **Update lodash** to `>=4.17.22` (via dependency chain)
14. **Add WebSocket connection limits** and rate limiting
15. **Add JSON schema validation** for WebSocket messages
16. **Remove `Math.random()`** fallback in base-proxy controller
17. **Sanitize Prisma Studio HTML template** — escape interpolated values
18. **Add `prefix` validation** in storage list endpoint
19. **Use `--frozen-lockfile`** in Dockerfile

### Ongoing
20. Enable automated dependency scanning in CI/CD (Snyk, GitHub Dependabot)
21. Regular penetration testing focused on HIPAA compliance
22. Implement secrets rotation policy (90-day maximum)
23. Add SAST scanning for hardcoded secrets in pre-commit hooks

---

## Appendix A: Files Scanned

```
apps/api/package.json
apps/api/Dockerfile
apps/api/src/main.ts
apps/api/src/app.module.ts
apps/api/src/shared/base-proxy.controller.ts
apps/api/src/modules/auth/auth.controller.ts
apps/api/src/modules/pstudio/pstudio.controller.ts
apps/api/src/modules/pstudio/pstudio.html.ts
apps/api/src/modules/storage/storage.controller.ts
apps/api/src/modules/streaming/stt-ws.gateway.ts
apps/api/src/modules/streaming/smr-proxy.controller.ts
apps/api/src/interceptors/context.interceptor.ts
apps/api/src/interceptors/exception.interceptor.ts
apps/api/src/guards/oidcauth.guard.ts
apps/api/src/services/graceful-shutdown.service.ts
.env.dev, .env.test, .env.production, .env.example
apps/api/.env.example, apps/api/.env.production
```

## Appendix B: Tools Used

- `pnpm audit --json` — Dependency CVE scanning
- Manual code review — Pattern matching for OWASP Top 10
- `git ls-files` — Tracking verification for sensitive files
- Regex analysis — ReDoS pattern evaluation
