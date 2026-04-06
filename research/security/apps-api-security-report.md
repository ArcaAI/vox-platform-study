# Security Audit Report — HOPE API Gateway (`apps/api/`)

**Audit Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Auditor**: Automated Security Auditor Agent
**Scope**: `apps/api/src/` — NestJS 11 API Gateway, `packages/applications/src/authorization/`
**Risk Score**: **6.8 / 10 (Medium-High)**

> **Update (2026-04-06)**: Re-scan confirmed all original Critical/High findings remain open. New findings added:
> - **Tenant context override via `X-Tenant-Id` header** (HIGH) — Any authenticated user can override tenant context
> - **Impersonation endpoint lacks tenant isolation** (HIGH) — Tenant admins can impersonate users across tenants
> - **Revoke-impersonation endpoint is a no-op** (MEDIUM) — Only logs, doesn't actually revoke tokens
> - **Live Azure OpenAI API key in `.env.dev`** confirmed still committed to git
> - **Session cookie `httpOnly: !isProduction`** confirmed — `false` in production

---

## Executive Summary

The HOPE API Gateway is a NestJS 11 application serving as the central entry point for a healthcare AI monorepo. It proxies requests to Python microservices (STT-v2, SMR, NLP), manages authentication (JWT, OIDC, API Key), and enforces RBAC policies via a CASL-based policy engine.

Overall, the codebase demonstrates **good security architecture** with multi-layered authentication, policy-based authorization, structured logging, and Prisma ORM (preventing raw SQL injection). However, several **critical and high-severity findings** require immediate attention:

1. **Hardcoded default JWT secret** — The fallback `'default-jwt-secret-key-change-in-production'` is embedded in source code and will be used if `JWT_SECRET_KEY` is not configured, allowing token forgery.
2. **Insecure session secret fallback** — `'a-very-secret-key'` is used when `SESSION_SECRET_KEY` is not set.
3. **Broken refresh token validation** — Refresh tokens are not stored server-side; the user ID is extracted directly from the token string, allowing any user to forge refresh tokens for arbitrary accounts.
4. **Missing `httpOnly` on session cookies in non-production** — Cookies are accessible to JavaScript in development/staging.
5. **Missing `whitelist`/`forbidNonWhitelisted`** on the global `ValidationPipe`, allowing mass assignment attacks.
6. **Prisma Studio exposed without proper auth in non-production** — The `@Public()` decorator on the GET endpoint bypasses all authentication.
7. **WebSocket gateway has no authentication** — The STT WebSocket gateway accepts connections without verifying JWT tokens.
8. **Prisma exception filter leaks internal database schema** — Raw Prisma error messages are forwarded to clients.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 5 |
| Medium | 7 |
| Low | 4 |
| Info | 3 |
| **Total** | **22** |

---

## Critical Findings

### VULN-001: Hardcoded Default JWT Secret Key

**Severity**: Critical
**Location**: `apps/api/src/modules/auth/auth.controller.ts:120, 341, 414`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The JWT signing key falls back to `'default-jwt-secret-key-change-in-production'` when the `JWT_SECRET_KEY` environment variable is not set. If deployed with this default, any attacker can forge valid JWT tokens with arbitrary claims (admin roles, any tenant ID, any user ID).

**Evidence**:

```typescript
// auth.controller.ts:120
const jwtSecretKey = this.appSettingsService.getValueWithDefault(
    'JWT_SECRET_KEY',
    'default-jwt-secret-key-change-in-production'
);
```

This pattern repeats at lines 341 (impersonation) and 414 (refresh).

**Impact**:
Complete authentication bypass. An attacker can create tokens for any user, including SUPER_ADMIN, gaining full system access including access to protected health information (PHI).

**Remediation**:
Fail fast at startup if `JWT_SECRET_KEY` is not configured:

```typescript
const jwtSecretKey = this.appSettingsService.getValue('JWT_SECRET_KEY');
if (!jwtSecretKey) {
    throw new InternalServerErrorException(
        'JWT_SECRET_KEY is not configured. Cannot issue tokens.'
    );
}
```

Add a startup validation guard in `main.ts`:

```typescript
const requiredEnvVars = ['JWT_SECRET_KEY', 'SESSION_SECRET_KEY'];
for (const key of requiredEnvVars) {
    if (!process.env[key]) {
        throw new Error(`Required environment variable ${key} is not set`);
    }
}
```

---

### VULN-002: Refresh Token Forgery — No Server-Side Storage

**Severity**: Critical
**Location**: `apps/api/src/modules/auth/auth.controller.ts:387-432`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
Refresh tokens are generated as `refresh_{userId}_{timestamp}_{randomHex}` and returned to the client, but they are **never stored or tracked server-side**. The `/auth/refresh` endpoint merely splits the token string and extracts the user ID at index `[1]`, then issues a new JWT for that user:

```typescript
// auth.controller.ts:392-397
const parts = body.refreshToken.split('_');
if (parts.length < 3 || parts[0] !== 'refresh') {
    throw new UnauthorizedException('Invalid refresh token format');
}
const userId = parts[1];
```

**Impact**:
An attacker who knows any valid user ID can forge a refresh token:
```
refresh_<targetUserId>_9999999999999_aaaa...
```
This grants them a fresh JWT for that user, bypassing authentication entirely. The random hex suffix is never verified.

**Remediation**:
Store refresh tokens server-side (Redis or database) with a hash:

```typescript
// On generation
const token = `refresh_${userId}_${Date.now()}_${randomBytes(32).toString('hex')}`;
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
await this.redis.set(`refresh_token:${tokenHash}`, JSON.stringify({
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
}), 'EX', 7 * 24 * 60 * 60);

// On refresh
const tokenHash = crypto.createHash('sha256').update(body.refreshToken).digest('hex');
const stored = await this.redis.get(`refresh_token:${tokenHash}`);
if (!stored) throw new UnauthorizedException('Invalid refresh token');
const { userId, expiresAt } = JSON.parse(stored);
if (Date.now() > expiresAt) throw new UnauthorizedException('Refresh token expired');
// Delete used token (rotation)
await this.redis.del(`refresh_token:${tokenHash}`);
```

---

### VULN-003: Hardcoded Session Secret Fallback

**Severity**: Critical
**Location**: `apps/api/src/main.ts:261`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The express-session middleware uses a hardcoded fallback secret:

```typescript
// main.ts:261
secret: process.env.SESSION_SECRET_KEY || 'a-very-secret-key',
```

Additionally, the `.env.example` and `.env.production` files both contain the weak default `hope-session-secret`.

**Impact**:
Session forgery. An attacker can craft valid session cookies to hijack any user session. In a healthcare context, this enables unauthorized access to PHI.

**Remediation**:
Remove the fallback and fail fast at startup:

```typescript
const sessionSecret = process.env.SESSION_SECRET_KEY;
if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET_KEY must be set to a value >= 32 characters');
}
app.use(session({ secret: sessionSecret, /* ... */ }));
```

---

## High Findings

### VULN-004: Missing `whitelist` and `forbidNonWhitelisted` on Global ValidationPipe

**Severity**: High
**Location**: `apps/api/src/main.ts:272`
**OWASP**: A03 — Injection

**Description**:
The global `ValidationPipe` is configured with only `transform: true`:

```typescript
app.useGlobalPipes(new ValidationPipe({ transform: true }));
```

The `.cursor/rules/05-nestjs-api.mdc` explicitly states that `whitelist: true` and `forbidNonWhitelisted: true` should be configured, but they are missing. This means any extra properties in request bodies pass through unstripped, potentially enabling mass assignment attacks.

**Impact**:
Attackers can inject unexpected fields into DTOs, potentially modifying fields that should not be user-controllable (e.g., `resourceStatus`, `roles`, `tenantId`).

**Remediation**:

```typescript
app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
}));
```

---

### VULN-005: WebSocket Gateway Has No Authentication

**Severity**: High
**Location**: `apps/api/src/modules/streaming/stt-ws.gateway.ts:37-96`
**OWASP**: A01 — Broken Access Control

**Description**:
The `SttWsGateway` accepts WebSocket connections without verifying any JWT token or authentication credential. The only requirement is a `sessionId` query parameter:

```typescript
handleConnection(client: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
        client.close(4001, 'Missing required query parameter: sessionId');
        return;
    }
    // No JWT validation, no auth check
}
```

**Impact**:
Any unauthenticated client can connect to the WebSocket endpoint and send/receive audio data if they know or guess a valid session ID (which uses UUIDv7 — somewhat predictable).

**Remediation**:

```typescript
handleConnection(client: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');

    if (!sessionId || !token) {
        client.close(4001, 'Missing sessionId or token');
        return;
    }

    try {
        const payload = this.jwtService.verify(token);
        // Validate the session belongs to this user/tenant
    } catch {
        client.close(4003, 'Invalid or expired token');
        return;
    }
}
```

---

### VULN-006: Prisma Studio Publicly Accessible Without Authentication

**Severity**: High
**Location**: `apps/api/src/modules/pstudio/pstudio.controller.ts:18-39`
**OWASP**: A01 — Broken Access Control

**Description**:
The Prisma Studio GET endpoint is decorated with `@Public()`, bypassing all authentication guards. While a `?token=` query parameter is checked, this token is **never validated server-side** — it is simply injected into the HTML template as a string:

```typescript
@Get()
@Public()  // Bypasses all auth guards
serveStudio(@Req() req: Request, @Res() res: Response, @Query('token') token?: string) {
    if (!token) {
        res.status(401).type('text/plain').send('Access denied...');
        return;
    }
    const html = getStudioHtml(studioEndpointUrl, token);
    res.type('text/html').send(html);
}
```

The POST endpoint correctly requires `@Authorize(['manage', 'all'])`, but the GET endpoint serves the full database browser UI to anyone who provides any string as the token.

**Impact**:
In non-production environments (where Prisma Studio is enabled by default), anyone can access the database browser UI. The injected token is passed in subsequent BFF calls, but the GET endpoint itself reveals the database schema and application structure.

**Remediation**:
Remove `@Public()` and require authentication:

```typescript
@Get()
@Authorize(['manage', 'all'])
@ApiBearerAuth()
serveStudio(@Req() req: Request, @Res() res: Response) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        res.status(401).type('text/plain').send('Access denied');
        return;
    }
    // Token is already validated by the Authorize guard
    const html = getStudioHtml(studioEndpointUrl, token);
    res.type('text/html').send(html);
}
```

Also ensure `ENABLE_PRISMA_STUDIO` defaults to `false` in non-dev environments:

```typescript
const enableStudio = process.env.ENABLE_PRISMA_STUDIO === 'true';
```

---

### VULN-007: Session Cookie Missing `httpOnly` in Non-Production

**Severity**: High
**Location**: `apps/api/src/main.ts:264-268`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The session cookie configuration inverts the `httpOnly` flag:

```typescript
cookie: {
    secure: isProduction,
    httpOnly: !isProduction,  // false in production!
    maxAge: 24 * 60 * 60 * 1000
}
```

This means:
- In **production**: `httpOnly: false` — cookies are accessible to JavaScript (XSS can steal sessions)
- In **development**: `httpOnly: true` — correct, but backwards

**Impact**:
In production, any XSS vulnerability (even in third-party scripts) can read session cookies and exfiltrate them, enabling session hijacking.

**Remediation**:

```typescript
cookie: {
    secure: isProduction,
    httpOnly: true,        // Always true — never expose to JS
    sameSite: 'strict',    // Add CSRF protection
    maxAge: 24 * 60 * 60 * 1000,
}
```

---

### VULN-008: Prisma Exception Filter Leaks Database Schema

**Severity**: High
**Location**: `apps/api/src/filters/prisma.filter.ts:33-49`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The `PrismaClientExceptionFilter` forwards the raw Prisma error message directly to the client:

```typescript
case 'P2002': {
    const status = HttpStatus.CONFLICT;
    response.status(status).json({
        statusCode: status,
        message: message,  // Raw Prisma message with table/column names
        error: 'Unique constraint violation',
    });
    break;
}
```

Prisma error messages typically include table names, column names, and constraint names (e.g., `"Unique constraint failed on the fields: (email)"` or `"An operation failed because it depends on one or more records that were required but not found. Record to delete does not exist. (field: User.id)"`).

**Impact**:
Attackers can enumerate database schema, table names, column names, and relationship structures by triggering different error conditions.

**Remediation**:

```typescript
case 'P2002': {
    response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: 'A record with the provided data already exists',
        error: 'Conflict',
    });
    break;
}
case 'P2025': {
    response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Record not found',
        error: 'Not Found',
    });
    break;
}
```

Log the full message server-side (already done) but never expose it to clients.

---

## Medium Findings

### VULN-009: CORS Allows Any HTTPS Origin in Production

**Severity**: Medium
**Location**: `apps/api/src/main.ts:74-91`
**OWASP**: A05 — Security Misconfiguration

**Description**:
In production mode, after checking allow-listed domains, the CORS configuration falls back to allowing **any HTTPS origin**:

```typescript
// For SDK usage: Allow any HTTPS origin
if (origin.startsWith('https://')) {
    // Block suspicious origins
    const blockedPatterns = [/\.onion$/, /localhost/, ...];
    const isBlocked = blockedPatterns.some(pattern => pattern.test(origin));
    if (isBlocked) return false;
    return logCorsDecision(origin, true, 'https_sdk_allowed');
}
```

**Impact**:
Any attacker-controlled HTTPS domain can make credentialed cross-origin requests to the API. While this may be intentional for SDK usage, it significantly increases the CSRF attack surface. An attacker's site at `https://evil.com` can issue authenticated requests using the victim's cookies.

**Remediation**:
If SDK usage requires broad CORS, consider using API key authentication for SDK clients (which doesn't rely on cookies) and restrict cookie-based CORS to known origins:

```typescript
// For SDK usage: Allow HTTPS origins but only for API-key-authenticated requests
// Cookie-based auth: restrict to known domains only
```

---

### VULN-010: Token Passed in URL Query Parameter (Prisma Studio)

**Severity**: Medium
**Location**: `apps/api/src/modules/pstudio/pstudio.controller.ts:24`
**OWASP**: A04 — Insecure Design

**Description**:
The JWT token is passed as a URL query parameter `?token=<jwt>`:

```typescript
@Query('token') token?: string,
```

**Impact**:
Tokens in URLs are logged in server access logs, browser history, proxy logs, and potentially shared via Referer headers. In healthcare, audit requirements demand that tokens not be exposed in URLs.

**Remediation**:
Use `Authorization` header or cookie-based authentication instead. If URL-based auth is unavoidable, use a short-lived, one-time-use token that is exchanged for a session.

---

### VULN-011: TranscriptionJobController Endpoints Missing Auth Guards

**Severity**: Medium
**Location**: `apps/api/src/modules/streaming/transcription-job.controller.ts`
**OWASP**: A01 — Broken Access Control

**Description**:
The `TranscriptionJobController` does not have any `@Authorize()` or `@UseGuards()` decorator at the class level or on individual endpoints. While the `@ApiBearerAuth()` decorator is present (for Swagger documentation), it does not enforce authentication:

```typescript
@ApiBearerAuth()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
export class TranscriptionJobController {
    // No @Authorize() or @UseGuards()
    @Post()
    async create(@Body() dto: any) { ... }  // Unguarded
```

**Impact**:
All transcription job endpoints (create, list, cancel, retry, stream) are accessible without authentication. Attackers can create jobs, upload files, and access transcription results.

**Remediation**:

```typescript
@ApiBearerAuth()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
@Authorize()  // Add class-level auth guard
export class TranscriptionJobController {
```

---

### VULN-012: Untyped `@Body() dto: any` Parameters

**Severity**: Medium
**Location**: `apps/api/src/modules/streaming/transcription-job.controller.ts:56, 63, 70`
**OWASP**: A03 — Injection

**Description**:
Several endpoints accept `@Body() dto: any` with no validation:

```typescript
@Post()
async create(@Body() dto: any) {
    return this.jobService.create(dto);
}
@Post('batch')
async createBatch(@Body() dto: any) { ... }
@Post('streaming')
async createStreaming(@Body() dto: any) { ... }
```

**Impact**:
Without typed DTOs, no input validation is performed. Malicious payloads pass through directly to the service layer, potentially causing unexpected behavior or injection.

**Remediation**:
Create proper DTOs with `class-validator` decorators:

```typescript
class CreateTranscriptionJobRequest {
    @IsString()
    @IsNotEmpty()
    pipelineId: string;

    @IsOptional()
    @IsString()
    consultationId?: string;

    @IsOptional()
    @IsString()
    language?: string;
}

@Post()
async create(@Body() dto: CreateTranscriptionJobRequest) { ... }
```

---

### VULN-013: Health Endpoint Leaks Internal Service URLs on Error

**Severity**: Medium
**Location**: `apps/api/src/modules/health/health.controller.ts:210-220`
**OWASP**: A05 — Security Misconfiguration

**Description**:
When downstream service health probes fail, the error message (which may contain internal hostnames, ports, and network topology) is returned in the response:

```typescript
return {
    status: 'down',
    service: svc.name,
    error: err instanceof Error ? err.message : String(err),
};
```

Errors like `"connect ECONNREFUSED 10.0.1.5:8862"` reveal internal network addresses.

**Impact**:
Attackers can enumerate internal services, ports, and network topology through the public health endpoint.

**Remediation**:

```typescript
return {
    status: 'down',
    service: svc.name,
    error: 'Service unreachable',
};
```

---

### VULN-014: No Request Body Size Limit Configured

**Severity**: Medium
**Location**: `apps/api/src/main.ts`
**OWASP**: A05 — Security Misconfiguration

**Description**:
No explicit body size limit is configured for the Express application. The default Express body parser limit is 100KB for JSON, but the `rawBody: true` option is enabled, and file upload endpoints exist with a 100MB limit.

**Impact**:
Without explicit limits, attackers may send extremely large payloads to non-file-upload endpoints, causing memory exhaustion (DoS).

**Remediation**:
Add explicit body size limits in `main.ts`:

```typescript
import * as bodyParser from 'body-parser';

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
```

---

### VULN-015: Proxy Controller Leaks Internal Error Details

**Severity**: Medium
**Location**: `apps/api/src/shared/base-proxy.controller.ts:96-106`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The proxy error handler includes the `errorDetail` in the 502 response body:

```typescript
const body = JSON.stringify({
    error: `${config.serviceName} service unavailable`,
    detail: errorDetail,  // May contain internal hostnames, ports
    timestamp: new Date().toISOString(),
});
```

**Impact**:
Internal network errors (connection strings, hostnames, ports) leak to clients.

**Remediation**:

```typescript
const body = JSON.stringify({
    error: `${config.serviceName} service unavailable`,
    timestamp: new Date().toISOString(),
});
```

---

## Low Findings

### VULN-016: `X-XSS-Protection` Header is Deprecated

**Severity**: Low
**Location**: `apps/api/src/main.ts:331`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The `X-XSS-Protection: 1; mode=block` header is set:

```typescript
res.setHeader('X-XSS-Protection', '1; mode=block');
```

This header is deprecated in modern browsers and can actually introduce XSS vulnerabilities in older browsers. Modern protection comes from `Content-Security-Policy`.

**Remediation**:
Replace with `X-XSS-Protection: 0` (disable the filter) and rely on CSP:

```typescript
res.setHeader('X-XSS-Protection', '0');
res.setHeader('Content-Security-Policy', "default-src 'self'");
```

---

### VULN-017: Missing `Strict-Transport-Security` Header

**Severity**: Low
**Location**: `apps/api/src/main.ts:327-340`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The `Strict-Transport-Security` (HSTS) header is not set, even in production. This means browsers won't enforce HTTPS-only connections.

**Remediation**:

```typescript
if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
}
```

---

### VULN-018: `.env.production` Committed to Repository

**Severity**: Low
**Location**: `apps/api/.env.production`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The `.env.production` file is tracked in git and contains database credentials, Redis passwords, and session secrets:

```
DB_CONNECTION_STRING=postgres://prisma.arcaai:prisma@localhost:5432/postgres
REDIS_PASS=redis-password
SESSION_SECRET_KEY=hope-session-secret
```

While these appear to be development defaults (the file has `NODE_ENV=development` despite the filename), committing `.env.production` creates risk of accidentally including real credentials.

**Remediation**:
- Add `.env.production` to `.gitignore`
- Remove it from git history: `git rm --cached apps/api/.env.production`
- Use environment-specific secrets management (Vault, Kubernetes secrets, etc.)

---

### VULN-019: Logout Does Not Invalidate JWT Token

**Severity**: Low
**Location**: `apps/api/src/modules/auth/auth.controller.ts:177-214`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
The logout endpoint only tracks the event but does not invalidate the JWT token:

```typescript
async logout(@Request() req: any): Promise<LogoutResponse> {
    // Only tracks the logout event
    await this.authService.trackAuthentication(user.id, { ... });
    return { success: true, message: 'Successfully logged out' };
}
```

JWTs remain valid until their `exp` claim expires (default 1 hour).

**Remediation**:
Implement a token deny-list in Redis:

```typescript
async logout(@Request() req: any): Promise<LogoutResponse> {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        const decoded = this.jwtService.decode(token);
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
            await this.redis.set(`blacklist:${decoded.jti}`, '1', 'EX', ttl);
        }
    }
    return { success: true, message: 'Successfully logged out' };
}
```

---

## Informational Findings

### INFO-001: Helmet Not Applied Globally

**Severity**: Info
**Location**: `apps/api/src/main.ts`

**Description**:
The `helmet` package is listed in `package.json` but is not imported or applied in `main.ts`. Instead, security headers are manually set in a middleware function. While the manual approach covers some headers, Helmet provides a more comprehensive set of defaults.

**Remediation**:

```typescript
import helmet from 'helmet';
app.use(helmet({
    contentSecurityPolicy: false, // Configure separately for API
    crossOriginEmbedderPolicy: false,
}));
```

---

### INFO-002: Request ID Can Be Set by Client

**Severity**: Info
**Location**: `apps/api/src/interceptors/context.interceptor.ts:37`

**Description**:
The `ContextInterceptor` accepts a `requestId` from the request body:

```typescript
request.requestId = request?.body?.requestId ?? uuidv7();
```

This allows clients to inject arbitrary request IDs, which could be used to confuse log correlation or inject log entries.

**Remediation**:
Only accept request IDs from trusted headers, not from the body:

```typescript
request.requestId = request.headers['x-request-id'] ?? uuidv7();
```

---

### INFO-003: Tenant ID Header Override Without Validation

**Severity**: Info
**Location**: `apps/api/src/interceptors/context.interceptor.ts:47-49`

**Description**:
The `X-Tenant-Id` header can override the tenant context set by the JWT auth guard:

```typescript
const tenantIdHeader = request.headers['x-tenant-id'];
if (tenantIdHeader) {
    this.tryClsSet('tenantId', tenantIdHeader);
}
```

**Impact**:
A user authenticated for Tenant A could potentially set `X-Tenant-Id: TenantB` to access data from another tenant, depending on downstream authorization checks.

**Remediation**:
Validate that the header matches the JWT's tenant claim, or only allow SUPER_ADMIN to override:

```typescript
const tenantIdHeader = request.headers['x-tenant-id'];
const jwtTenantId = this.tryClsGet('tenantId');
if (tenantIdHeader && tenantIdHeader !== jwtTenantId) {
    const user = this.tryClsGet('user') as any;
    if (!user?.roles?.includes('SUPER_ADMIN')) {
        // Ignore header override for non-admin users
        return;
    }
}
```

---

## Dependency Audit Results

### Vulnerable Dependencies (from `pnpm audit`)

| Package | Severity | CVE | Issue | Fix |
|---------|----------|-----|-------|-----|
| `bl` (via rollup-plugin-node-builtins) | Moderate | CVE-2020-8244 | Buffer over-read / memory exposure | Upgrade to bl >= 1.2.3 |
| `nodemailer` (via @arcaai/applications) | Moderate | CVE-2025-13033 | Email address parsing misrouting | Upgrade to >= 7.0.7 |
| `elliptic` (via browserify-sign) | Low | CVE-2025-14505 | ECDSA incorrect signature generation | No patch available |
| `lodash` (via prisma > chevrotain) | Moderate | CVE-2025-13465 | Prototype pollution in `_.unset`/`_.omit` | Upgrade to >= 4.17.23 |

### Direct Dependencies Assessment

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `bcryptjs` | ^3.0.3 | Low | Acceptable; prefer `argon2` for new projects |
| `jsonwebtoken` | ^9.0.3 | Low | Acceptable; ensure `algorithms` whitelist in verify |
| `passport` | ^0.7.0 | Low | Current |
| `express-session` | ^1.19.0 | Medium | Ensure Redis store in production (not MemoryStore) |
| `helmet` | ^8.1.0 | Info | Installed but not used |
| `speakeasy` | ^2.0.0 | Low | Used for TOTP; last update 2017 — consider alternatives |

---

## Recommendations

### Immediate Actions (Critical — within 48 hours)

1. **Remove hardcoded JWT secret fallback** — Fail at startup if `JWT_SECRET_KEY` is not set
2. **Implement server-side refresh token storage** — Store hashed tokens in Redis with expiration
3. **Remove hardcoded session secret fallback** — Fail at startup if `SESSION_SECRET_KEY` is not set
4. **Fix `httpOnly` cookie flag** — Set to `true` always, not `!isProduction`

### Short-Term Actions (High — within 1 week)

5. **Add `whitelist` and `forbidNonWhitelisted`** to global `ValidationPipe`
6. **Add JWT authentication to WebSocket gateway**
7. **Remove `@Public()` from Prisma Studio** and require admin auth
8. **Sanitize Prisma error messages** before sending to clients

### Medium-Term Actions (within 1 sprint)

9. **Restrict CORS in production** — Use API keys for SDK clients, restrict cookie-based CORS
10. **Add authentication to `TranscriptionJobController`**
11. **Create typed DTOs** for all `@Body() dto: any` parameters
12. **Add request body size limits**
13. **Sanitize error details** in proxy and health endpoints

### Long-Term Actions (within 1 quarter)

14. **Implement JWT deny-list** for logout invalidation
15. **Apply Helmet** globally with proper configuration
16. **Validate tenant ID header** against JWT claims
17. **Add HSTS header** in production
18. **Audit and upgrade** vulnerable transitive dependencies
19. **Consider migrating** from `speakeasy` to a maintained TOTP library

---

## Compliance Notes (Healthcare / HIPAA)

Given that HOPE processes Protected Health Information (PHI):

- **Access Control** (§ 164.312(a)): The refresh token forgery vulnerability (VULN-002) and missing WebSocket auth (VULN-005) represent immediate HIPAA compliance risks.
- **Audit Controls** (§ 164.312(b)): The existing audit logging via `ImpersonationAuditInterceptor` and `trackAuthentication` is good. Ensure all data access is logged.
- **Transmission Security** (§ 164.312(e)): Missing HSTS (VULN-017) and the cookie configuration issue (VULN-007) need remediation.
- **Integrity Controls** (§ 164.312(c)): The JWT secret fallback (VULN-001) undermines all integrity guarantees.

---

## Appendix: Files Reviewed

| Category | Files | Key Observations |
|----------|-------|------------------|
| Bootstrap | `main.ts`, `app.module.ts` | Session/CORS config, global pipes |
| Auth | `auth.controller.ts`, `dto/*.ts` | JWT flow, refresh tokens, impersonation |
| Guards | `jwtauth.guard.ts`, `oidcauth.guard.ts` | Auth bypass via `SKIP_AUTH_KEY` |
| Controllers | 15 controller files | Auth coverage varies |
| Interceptors | `context.interceptor.ts`, `impersonation-audit.interceptor.ts` | Request context, audit logging |
| Filters | `prisma.filter.ts` | Error message leakage |
| Proxy | `base-proxy.controller.ts`, `smr-proxy.controller.ts` | Service token forwarding |
| WebSocket | `stt-ws.gateway.ts` | No auth verification |
| Prisma Studio | `pstudio.controller.ts`, `pstudio.html.ts` | Public endpoint, XSS risk in HTML template |
| Throttle | `throttle.module.ts`, `rate-limit-config.service.ts` | Rate limiting configured |
| Config | `.env.example`, `.env.production` | Hardcoded secrets |
| Storage | `storage.controller.ts` | File upload with validation |
| Health | `health.controller.ts` | Internal URL leakage |

---

*Report generated by Security Auditor Agent — 2026-03-24*
