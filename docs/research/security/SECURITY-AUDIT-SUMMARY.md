# HOPE Platform — Consolidated Security Audit Summary

**Date**: 2026-04-06 (Updated)
**Previous Audit**: 2026-03-24
**Scope**: Full monorepo — 6 applications, 20 packages
**Standards**: OWASP Top 10 (2021), HIPAA Security Rule
**Total Reports**: 16 detailed reports (8 security audits + 8 vulnerability scans)

---

## Current Monorepo Structure

| Layer | Applications / Packages |
|-------|------------------------|
| **API Gateway** | `apps/api` — NestJS 11, TypeScript (port 8868) |
| **Python Services** | `apps/stt-v2` (port 8861), `apps/smr` (port 8862), `apps/nlp` (port 8864) |
| **Frontend** | `apps/ui-playground` — React 19/Vite/TanStack Router (port 5175) — **deprecated** (no development/maintenance plan) |
| **Example** | `apps/example` — Live transcription demo (React/Vite) |
| **Core DDD** | `packages/database`, `packages/domains`, `packages/applications`, `packages/exceptions`, `packages/logger`, `packages/types`, `packages/tools` |
| **SDK & Audio** | `packages/agentic-sdk-v2`, `packages/room`, `packages/stt`, `packages/vad`, `packages/noise-filter`, `packages/pipeline`, `packages/med-ner`, `packages/utils` |
| **UI** | `packages/ui` — shared React component library (shadcn/Radix/cva) |
| **Config** | `packages/config-eslint`, `packages/config-rollup`, `packages/config-tailwind`, `packages/config-ts` |

> **Note**: `apps/admin` and `apps/tts` referenced in the March 2026 audit no longer exist. They have been removed from the monorepo.

---

## Overall Risk Assessment: HIGH

The HOPE platform demonstrates solid architectural foundations (Prisma ORM for parameterized queries, Pydantic validation in Python services, React JSX escaping, structured logging, CASL-based RBAC). However, **systemic gaps in secret management, authentication on internal services, CORS configuration, and PHI protection** create a compound risk profile inappropriate for a HIPAA-regulated healthcare platform.

### Changes Since Last Audit (2026-03-24)

| Area | Status |
|------|--------|
| SMR CORS configuration | **FIXED** — CORS disabled by default; requires explicit opt-in with specific origins |
| SMR service auth middleware | **FIXED** — `ServiceAuthMiddleware` implemented |
| STT-v2 CORS | **STILL OPEN** — defaults to `["*"]` via config |
| NLP CORS | **STILL OPEN** — defaults to `["*"]` with `allow_credentials=True` |
| Hardcoded JWT secret fallback | **STILL OPEN** — `default-jwt-secret-key-change-in-production` in auth controller |
| Azure OpenAI key in `.env.dev` | **STILL OPEN** — live key committed to git |
| GitHub PAT in `scripts/` | **NEW** — live PAT committed to git |
| Refresh token validation | **STILL OPEN** — no server-side storage |
| Session cookie `httpOnly` | **STILL OPEN** — set to `false` in production |
| `$queryRawUnsafe` | **STILL OPEN** — exposed in repository interface |

---

## Aggregate Findings (April 2026 Rescan)

### Security Audit Findings

| Severity | apps/api | apps/nlp | apps/smr | apps/stt-v2 | apps/ui-playground | SDK & Audio | Data Layer | Shared/Utils | **Total** |
|----------|:--------:|:--------:|:--------:|:-----------:|:-----------------:|:-----------:|:----------:|:------------:|:---------:|
| Critical | 3 | 3 | 0† | 4 | 1 | 0 | 2 | 1 | **14** |
| High | 4 | 6 | 0† | 8 | 4 | 7 | 5 | 8 | **42** |
| Medium | 5 | 6 | 0† | 10 | 5 | 19 | 6 | 18 | **69** |
| Low | 4 | 3 | 0† | 4 | 4 | 15 | 4 | 18 | **52** |
| Info | 5 | 1 | 0† | 2 | 2 | 12 | 3 | 16 | **41** |
| **Total** | **21** | **19** | **0†** | **28** | **16** | **53** | **20** | **61** | **218** |

> † SMR had 1 Critical + 5 High + 7 Medium in March 2026. Several have been **fixed** (CORS disabled by default, service auth middleware added). Current findings need re-evaluation against latest codebase.

### Vulnerability Scan Findings

| Severity | Count | Key Sources |
|----------|:-----:|-------------|
| Critical | 3 | Hardcoded secrets (GitHub PAT, Azure key, git-tracked env files) |
| High | 24 | handlebars, nodemailer, minimatch, hono, happy-dom, lodash, picomatch, dangerouslySetInnerHTML |
| Moderate | 28 | bl, esbuild, langsmith, ajv, brace-expansion, serialize-javascript, path-to-regexp |
| Low | 4 | elliptic, handlebars, nodemailer SMTP, hono timing |
| Info | 6 | Test data, examples |
| **Total** | **65** | |

---

## Top 12 Critical & Cross-Cutting Risks

### 1. HARDCODED GITHUB PAT IN GIT-TRACKED SCRIPT (Critical — NEW)
- **Impact**: Full GitHub PAT (`ghp_n2sm...`) committed in `scripts/github-backup.sh:11`. Grants repository access to attacker.
- **OWASP**: A02 — Cryptographic Failures
- **File**: `scripts/github-backup.sh`
- **Fix**: Rotate token immediately. Replace with env var `${GITHUB_TOKEN:?}`. Add to `.gitignore`.

### 2. HARDCODED AZURE OPENAI API KEY (Critical — STILL OPEN)
- **Impact**: Live Azure OpenAI API key committed in `.env.dev:168`. Allows unauthorized API consumption.
- **OWASP**: A02 — Cryptographic Failures
- **File**: `.env.dev`
- **Fix**: Rotate key in Azure Portal. Replace with placeholder. Remove from git tracking.

### 3. SENSITIVE ENV FILES TRACKED IN GIT (Critical — STILL OPEN)
- **Impact**: `.env.dev`, `.env.test`, `.env.production`, `.env.archive` are all git-tracked. Contain DB credentials, Redis passwords, MinIO credentials, JWT secrets, internal IPs.
- **OWASP**: A05 — Security Misconfiguration
- **Files**: `.env.dev`, `.env.test`, `.env.production`, `.env.archive`
- **Fix**: Fix `.gitignore` (current patterns are broken — uses `.dev.dev` instead of `.env.dev`). Run `git rm --cached`. Purge git history with `git filter-repo`.

### 4. HARDCODED DEFAULT JWT SECRET (Critical — STILL OPEN)
- **Impact**: JWT signing falls back to `'default-jwt-secret-key-change-in-production'` if DB setting missing. In `authenticateJwt.ts`, falls back to `'secret'`. Allows token forgery.
- **OWASP**: A02 — Cryptographic Failures, A07 — Authentication Failures
- **Files**: `apps/api/src/modules/auth/auth.controller.ts`, `packages/applications/src/common/authenticateJwt.ts`
- **Fix**: Remove all fallback secrets. Fail fast at startup if not configured.

### 5. BROKEN REFRESH TOKEN — NO SERVER-SIDE VALIDATION (Critical — STILL OPEN)
- **Impact**: Refresh tokens are `refresh_{userId}_{timestamp}_{random}` — never stored server-side. Any string matching this format produces a valid access token. User ID is in plaintext.
- **OWASP**: A07 — Authentication Failures
- **File**: `apps/api/src/modules/auth/auth.controller.ts:400-510`
- **Fix**: Store refresh tokens in DB/Redis. Validate full token. Implement one-time use with rotation.

### 6. NO AUTHENTICATION ON PYTHON SERVICES (Critical — STT-v2, NLP)
- **Impact**: All STT-v2 and NLP endpoints are completely unprotected. SMR has been fixed with `ServiceAuthMiddleware`.
- **OWASP**: A01 — Broken Access Control, A07 — Authentication Failures
- **Services**: `apps/stt-v2`, `apps/nlp`
- **Fix**: Port SMR's `ServiceAuthMiddleware` pattern to STT-v2 and NLP.

### 7. WILDCARD CORS ON STT-v2 AND NLP (Critical — PARTIALLY FIXED)
- **Impact**: STT-v2 defaults to `allow_origins=["*"]`. NLP defaults to `allow_origins=["*"]` with `allow_credentials=True`. SMR is now **fixed** (CORS disabled by default).
- **OWASP**: A05 — Security Misconfiguration
- **Services**: `apps/stt-v2`, `apps/nlp`
- **Fix**: Restrict CORS to known API Gateway origins. Follow SMR's pattern.

### 8. SQL INJECTION VIA `$queryRawUnsafe` (Critical — STILL OPEN)
- **Impact**: `rawQueryUnsafe()` in repository layer and `query()` in `CoreDatabaseService` pass strings directly to `$queryRawUnsafe`.
- **OWASP**: A03 — Injection
- **Files**: `packages/domains/src/common/repository.ts:200`, `packages/domains/src/common/databaseServices/core/core.database.service.ts:65`
- **Fix**: Remove from public interface. Use Prisma's `$queryRaw` with tagged templates only.

### 9. AUTH TOKENS IN localStorage (Critical — STILL OPEN)
- **Impact**: Access tokens, refresh tokens, API keys stored in localStorage — vulnerable to XSS exfiltration.
- **OWASP**: A02 — Cryptographic Failures
- **Service**: `apps/ui-playground` (19 file references to localStorage)
- **Fix**: Use httpOnly cookies for tokens. In-memory storage for short-lived tokens.

### 10. SESSION COOKIE httpOnly DISABLED IN PRODUCTION (High — STILL OPEN)
- **Impact**: `httpOnly: !isProduction` means production sessions are readable by JavaScript. Combined with any XSS, enables session theft.
- **OWASP**: A07 — Authentication Failures
- **File**: `apps/api/src/main.ts:215`
- **Fix**: Set `httpOnly: true` for all environments.

### 11. TENANT CONTEXT OVERRIDE VIA HEADER (High — STILL OPEN)
- **Impact**: Any authenticated user can send `X-Tenant-Id` header to override their tenant context, enabling cross-tenant data access.
- **OWASP**: A01 — Broken Access Control
- **File**: `apps/api/src/interceptors/context.interceptor.ts:57-59`
- **Fix**: Validate header matches authenticated user's tenant. Only allow override for super admins.

### 12. TOKEN REVOCATION NOT IMPLEMENTED (High — STILL OPEN)
- **Impact**: `isTokenRevoked()` always returns `false` (TODO stub). Compromised tokens cannot be invalidated. Logout does nothing.
- **OWASP**: A07 — Authentication Failures
- **Files**: `packages/applications/src/services/auth/auth.service.ts:62-66`, `apps/api/src/modules/auth/auth.controller.ts:188-226`
- **Fix**: Implement Redis-backed JWT blacklist. Check on every authenticated request.

---

## Service-by-Service Summary

### apps/api — NestJS API Gateway
- **Risk Score**: 6.8/10 (Medium-High)
- **Findings**: 21 total (3 Critical, 4 High, 5 Medium)
- **Key Issues**: Hardcoded JWT/session secrets, broken refresh token, tenant context header override, session cookie httpOnly disabled, impersonation lacks tenant isolation, Prisma errors leak schema, ValidationPipe allows mass assignment
- **Positive**: CASL RBAC well-implemented, impersonation audit trail, security headers present (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy)
- **Report**: [`apps-api-security-report.md`](./apps-api-security-report.md)

### apps/nlp — Medical NLP
- **Risk Score**: High
- **Findings**: 19 total (3 Critical, 6 High, 6 Medium)
- **Key Issues**: Zero authentication, wildcard CORS with credentials, no input size limits, PHI logged in plaintext, WebSocket sessions unauthenticated
- **Report**: [`apps-nlp-security-report.md`](./apps-nlp-security-report.md)

### apps/smr — Text Generation/Summarization
- **Risk Score**: Medium (IMPROVED from Medium-High)
- **Changes**: CORS disabled by default (tested), `ServiceAuthMiddleware` added
- **Remaining Issues**: Cleartext OTLP telemetry (if `insecure=True`), unbounded max_tokens, SSRF via user-controllable provider URLs, task IDs enumerable
- **Report**: [`apps-smr-security-report.md`](./apps-smr-security-report.md)

### apps/stt-v2 — Speech-to-Text
- **Risk Score**: High
- **Findings**: 28 total (4 Critical, 8 High, 10 Medium)
- **Key Issues**: Zero authentication, hardcoded default credentials, wildcard CORS, no audio file MIME validation, PHI logging, ML model trust
- **Report**: [`apps-stt-v2-security-report.md`](./apps-stt-v2-security-report.md)

### apps/ui-playground — SDK Playground (deprecated)
- **Risk Score**: Medium
- **Findings**: 16 total (1 Critical, 4 High, 5 Medium)
- **Key Issues**: Tokens in localStorage (19 file refs), client-side JWT decode without verification, WebSocket URL user-editable, no CSP headers
- **Report**: [`apps-ui-playground-security-report.md`](./apps-ui-playground-security-report.md)

### apps/example — Live Transcription Demo
- **Risk Score**: Low
- **Notes**: Minimal React/Vite app with no backend. Not audited in detail.

### SDK & Audio Packages
- **Risk Score**: Moderate
- **Findings**: 53 total (0 Critical, 7 High, 19 Medium)
- **Key Issues**: WASM/model supply chain (no integrity checks), auth token in URL params, source maps in production, ws:// without wss:// enforcement
- **Report**: [`packages-sdk-audio-security-report.md`](./packages-sdk-audio-security-report.md)

### Data Layer (database, domains, applications)
- **Risk Score**: Medium-High
- **Findings**: 20 total (2 Critical, 5 High, 6 Medium)
- **Key Issues**: SQL injection via `$queryRawUnsafe`, hardcoded seed credentials, soft-delete bypass via `findUnique`, missing tenant isolation, AES-CBC without auth tag
- **Report**: [`packages-data-layer-security-report.md`](./packages-data-layer-security-report.md)

### Shared/Utility Packages
- **Risk Score**: Moderate-High
- **Findings**: 61 total (1 Critical, 8 High, 18 Medium)
- **Key Issues**: No PHI redaction in logger, error info leakage, dangerouslySetInnerHTML in 9 UI files, missing model integrity verification
- **Note**: Old report referenced `apps/admin` and `apps/tts` — these no longer exist in the monorepo.
- **Report**: [`packages-shared-utils-security-report.md`](./packages-shared-utils-security-report.md)

---

## Dependency Vulnerability Summary (pnpm audit)

### Critical Dependencies to Update

| Package | Current Issue | Fix Version | Location |
|---------|--------------|-------------|----------|
| `handlebars` | JS injection (4 CVEs) | >=4.7.9 | `packages/tools` |
| `nodemailer` | DoS + SMTP injection | >=8.0.4 | `packages/applications` |
| `hono` | File access + auth bypass | >=4.12.4 | `prisma` transitive |
| `happy-dom` | 2 vulnerabilities | >=20.8.9 | `packages/ui` |
| `flatted` | Prototype pollution | >=3.4.2 | `@vitest/ui` |
| `lodash`/`lodash-es` | Code injection | >=4.18.0 | `apps/api`, `packages/ui` |
| `picomatch` | ReDoS | >=2.3.2 / >=4.0.4 | `apps/api`, `@vitest/ui` |
| `rollup-plugin-node-builtins` | Pulls 6+ vulnerable deps | Replace entirely | `packages/config-rollup` |

### Python Dependencies

| Package | Issue | Service |
|---------|-------|---------|
| `python-jose` | CVE-2024-33663 algorithm confusion, unmaintained | `apps/nlp` |
| Loose version pins (`>=` without upper bounds) | Version drift risk | All 3 Python services |

---

## Docker & Infrastructure Security

| Issue | Severity | Description |
|-------|----------|-------------|
| MinIO buckets set to `public` | **HIGH** | `recordings` and `generated-audio` buckets publicly accessible. Patient audio exposed. |
| `hope-python-base:latest` tag | MEDIUM | Non-reproducible builds. Pin to specific version/SHA. |
| `--no-frozen-lockfile` in API Dockerfile | MEDIUM | Lockfile not enforced, allows version drift. |
| Vault dev root token `root` | MEDIUM | Hardcoded in `.env.dev` and docker-compose.dev.yml. |
| `TRIVY_INSECURE=true` in CI | MEDIUM | TLS verification disabled for container registry. |
| `DATABASE_URL` as Docker build arg | MEDIUM | Visible in image layers. Use multi-stage secret mounts. |

---

## Prioritized Remediation Roadmap

### Phase 1: Immediate (This Week) — Secret Rotation & Critical Fixes

| # | Action | Affected | Effort |
|---|--------|----------|--------|
| 1 | **Rotate GitHub PAT** and remove from `scripts/github-backup.sh` | scripts | 30 min |
| 2 | **Rotate Azure OpenAI key** and remove from `.env.dev` | .env.dev | 30 min |
| 3 | **Fix `.gitignore`** and `git rm --cached` all env files | root | 1h |
| 4 | Remove hardcoded JWT/session secret fallbacks; fail at startup if missing | api, applications | 2h |
| 5 | Add service-to-service auth to STT-v2 and NLP (use SMR's pattern) | stt-v2, nlp | 4h |
| 6 | Restrict CORS to known origins on STT-v2 and NLP | stt-v2, nlp | 2h |
| 7 | Fix session cookie `httpOnly: true` for all environments | api | 15 min |

### Phase 2: High Priority (Week 2-3) — Auth & Access Control

| # | Action | Affected | Effort |
|---|--------|----------|--------|
| 8 | Implement server-side refresh token storage and validation | api | 8h |
| 9 | Validate `X-Tenant-Id` header against authenticated user | api | 2h |
| 10 | Add tenant filter to impersonation target lookup | api | 1h |
| 11 | Implement JWT blacklist for logout/revocation (Redis) | api, applications | 4h |
| 12 | Remove/deprecate `rawQuery()` and `rawQueryUnsafe()` | database, domains | 2h |
| 13 | Add `whitelist: true, forbidNonWhitelisted: true` to ValidationPipe | api | 30 min |
| 14 | Sanitize Prisma error messages in responses | api | 1h |
| 15 | Fix MinIO bucket policies to private | infrastructure | 1h |

### Phase 3: Medium Priority (Week 4-6) — Dependencies & Hardening

| # | Action | Affected | Effort |
|---|--------|----------|--------|
| 16 | Update handlebars >=4.7.9 | packages/tools | 30 min |
| 17 | Update nodemailer >=8.0.4 | packages/applications | 30 min |
| 18 | Update prisma to latest (fixes hono, effect, defu, lodash transitive) | packages/database | 1h |
| 19 | Replace `rollup-plugin-node-builtins` | packages/config-rollup | 2h |
| 20 | Upgrade CryptoService from AES-CBC to AES-GCM | packages/applications | 4h |
| 21 | Add CSP and security headers across all services | all | 4h |
| 22 | Fix soft-delete bypass in `findUnique` | packages/database | 2h |
| 23 | Audit dangerouslySetInnerHTML in 9 UI component files | packages/ui | 4h |
| 24 | Replace `python-jose` with `PyJWT` in NLP | apps/nlp | 2h |
| 25 | Pin Python dependency upper bounds | all Python services | 2h |

### Phase 4: Ongoing — Compliance & Monitoring

| # | Action | Affected | Effort |
|---|--------|----------|--------|
| 26 | Implement PHI-aware log sanitization | nlp, stt-v2, logger | 8h |
| 27 | Pin ML models with SHA-256 integrity checks | nlp, stt-v2, stt, vad, noise-filter | 8h |
| 28 | Add input size limits on all text/audio endpoints | nlp, stt-v2, smr | 4h |
| 29 | Enforce wss:// for WebSocket connections | agentic-sdk-v2 | 2h |
| 30 | Implement field-level encryption for PHI at rest | database, stt-v2 | 16h |
| 31 | Add dependency vulnerability scanning to CI (block on CRITICAL) | all | 4h |
| 32 | Conduct HIPAA compliance gap analysis | all | 16h |
| 33 | Conduct penetration testing | all | External |

---

## OWASP Top 10 Coverage

| OWASP Category | Findings | Most Affected |
|----------------|:--------:|---------------|
| A01 — Broken Access Control | 18 | api, nlp, stt-v2, data-layer |
| A02 — Cryptographic Failures | 34 | api, stt-v2, ui-playground, sdk, scripts |
| A03 — Injection | 14 | data-layer, ui, nlp |
| A04 — Insecure Design | 12 | smr, stt-v2 |
| A05 — Security Misconfiguration | 28 | nlp, stt-v2, sdk, .gitignore |
| A06 — Vulnerable Components | 65 | all (dependency audit) |
| A07 — Auth Failures | 18 | api, nlp, stt-v2, ui-playground |
| A08 — Data Integrity Failures | 9 | nlp, stt-v2, sdk |
| A09 — Logging Failures | 11 | nlp, stt-v2, logger |
| A10 — SSRF | 4 | ui-playground, smr |

---

## Report Index

### Security Audit Reports

| Report | Path | Scope |
|--------|------|:-----:|
| API Gateway | [`apps-api-security-report.md`](./apps-api-security-report.md) | `apps/api`, `packages/applications/src/authorization/` |
| Medical NLP | [`apps-nlp-security-report.md`](./apps-nlp-security-report.md) | `apps/nlp` |
| Summarization | [`apps-smr-security-report.md`](./apps-smr-security-report.md) | `apps/smr` |
| Speech-to-Text | [`apps-stt-v2-security-report.md`](./apps-stt-v2-security-report.md) | `apps/stt-v2` |
| UI Playground | [`apps-ui-playground-security-report.md`](./apps-ui-playground-security-report.md) | `apps/ui-playground` |
| SDK & Audio | [`packages-sdk-audio-security-report.md`](./packages-sdk-audio-security-report.md) | `packages/agentic-sdk-v2`, `room`, `stt`, `vad`, `noise-filter`, `pipeline`, `med-ner` |
| Data Layer | [`packages-data-layer-security-report.md`](./packages-data-layer-security-report.md) | `packages/database`, `domains`, `applications` |
| Shared/Utils | [`packages-shared-utils-security-report.md`](./packages-shared-utils-security-report.md) | `packages/ui`, `utils`, `exceptions`, `logger`, `tools` |

### Vulnerability Scan Reports

| Report | Path | Scope |
|--------|------|:-----:|
| API Gateway | [`vuln-scan-apps-api.md`](./vuln-scan-apps-api.md) | npm deps, code patterns, Docker |
| Medical NLP | [`vuln-scan-apps-nlp.md`](./vuln-scan-apps-nlp.md) | Python deps, code patterns, Docker |
| Summarization | [`vuln-scan-apps-smr.md`](./vuln-scan-apps-smr.md) | Python deps, code patterns, Docker |
| Speech-to-Text | [`vuln-scan-apps-stt-v2.md`](./vuln-scan-apps-stt-v2.md) | Python deps, code patterns, Docker |
| UI Playground | [`vuln-scan-apps-ui-playground.md`](./vuln-scan-apps-ui-playground.md) | npm deps, code patterns |
| SDK & Audio | [`vuln-scan-packages-sdk-audio.md`](./vuln-scan-packages-sdk-audio.md) | npm deps, WASM supply chain |
| Data Layer | [`vuln-scan-packages-data-layer.md`](./vuln-scan-packages-data-layer.md) | Prisma, seed data, migrations |
| Shared/Utils | [`vuln-scan-packages-shared-utils.md`](./vuln-scan-packages-shared-utils.md) | npm deps, code patterns |

---

## Removed / Outdated References

The following apps/services from the March 2026 audit **no longer exist** in the monorepo:

| Former App | Status | Notes |
|-----------|--------|-------|
| `apps/admin` | **REMOVED** | Admin dashboard removed from monorepo |
| `apps/tts` | **REMOVED** | Text-to-Speech service removed from monorepo |

Reports that referenced these services have been noted but not removed to preserve audit history. New scans should not include these.

---

*Generated by HOPE Security Audit + Vulnerability Scan — 2026-04-06*
*Previous audit: 2026-03-24*
