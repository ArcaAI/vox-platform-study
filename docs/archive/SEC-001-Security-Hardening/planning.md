# SEC-001: Security Hardening - Execution Checklist

## Quick Reference

### Priority Order

Execute tasks in this order to minimize risk:

```
Phase 1 (Critical - Day 1-2):
├── C1: Remove SQL Injection Risk (2h)
├── C2: Remove Sensitive Logs (3h)
├── C3: Secure Refresh Tokens (4h)
└── C4: Token Revocation (4h)

Phase 2 (High - Day 3-4):
├── H1: Pin Dependencies (1h)
├── H2: Enable Security Headers (2h)
├── H3: API Key Expiration (2h)
└── H4: Global Rate Limiting (4h)

Total Estimated: 22 hours
```

---

## Pre-Implementation Checklist

- [ ] Create feature branch: `git checkout -b security/SEC-001-hardening`
- [ ] Ensure all tests pass on main: `pnpm test`
- [ ] Backup database (if modifying schema)
- [ ] Review Redis availability for token revocation
- [ ] Notify team of security work in progress

---

## Phase 1: Critical Security Fixes

### C1: Remove SQL Injection Vulnerability

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Pre-checks**:
- [ ] Search for usages: `grep -r "\.query\(" packages/`
- [ ] Identify all callers of unsafe method

**Implementation**:
- [ ] Open `packages/domains/src/common/databaseServices/core/core.database.service.ts`
- [ ] Remove lines 117-119 (the `query` method)
- [ ] Update any callers to use `queryRaw` with parameterized queries
- [ ] Run TypeScript compilation: `pnpm build:packages`

**Verification**:
- [ ] No TypeScript errors
- [ ] `grep -r "\$queryRawUnsafe" packages/` returns no results
- [ ] Run database tests: `pnpm test --filter @arcaai/domains`

---

### C2: Remove Sensitive Data from Logs

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to modify**:

1. **apikey.guard.ts (Line 82)**
   - [ ] Remove: `console.log('apiKeyEntity', apiKeyEntity);`

2. **api-key-validation.service.ts (Line 95)**
   - [ ] Remove: `console.log('apiKeyEntity', apiKeyEntity);`

3. **auth.controller.ts (Line 114)**
   - [ ] Replace `console.warn` with logger (no user ID in prod)

4. **main.ts (Lines 250-259)**
   - [ ] Remove session config logging block

**Verification**:
- [ ] Run: `grep -rn "console\.\(log\|warn\)" apps/api/src/`
- [ ] Review remaining console statements for sensitive data
- [ ] Start API in dev mode and check logs

---

### C3: Implement Secure Refresh Token Generation

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Database Changes** (if needed):
- [ ] Create migration for RefreshToken table
- [ ] Run migration: `pnpm db:migrate`

**Code Changes**:
- [ ] Update `auth.controller.ts` with secure token generation
- [ ] Add `storeRefreshToken` method to `auth.service.ts`
- [ ] Add `validateRefreshToken` method to `auth.service.ts`
- [ ] Add refresh token endpoint (optional)

**Verification**:
- [ ] Generate 100 tokens, verify all unique
- [ ] Verify tokens stored in database
- [ ] Test token validation
- [ ] Test token expiration

---

### C4: Implement Token Revocation

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Prerequisites**:
- [ ] Redis connection available
- [ ] Redis client injected into AuthService

**Code Changes**:
- [ ] Update `IAuthService.ts` interface
- [ ] Implement `isTokenRevoked` in `auth.service.ts`
- [ ] Implement `revokeToken` in `auth.service.ts`
- [ ] Update `jwt.strategy.ts` to check revocation
- [ ] Update logout endpoint to revoke token

**Verification**:
- [ ] Login and get token
- [ ] Logout (token revoked)
- [ ] Try to use revoked token (should fail)
- [ ] Check Redis for revocation entry

---

## Phase 2: High Priority Fixes

### H1: Pin Dependency Versions

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Steps**:
- [ ] Run `pnpm outdated` to see current versions
- [ ] Update `package.json` with pinned versions
- [ ] Run `pnpm install`
- [ ] Run `pnpm build`
- [ ] Run `pnpm test`

**Packages to pin**:
- [ ] turbo: `latest` → `^2.x.x`
- [ ] typescript: `latest` → `^5.x.x`
- [ ] vitest: `latest` → `^3.x.x`

---

### H2: Enable Security Headers by Default

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to modify**:
- [ ] `apps/stt/src/stt/infrastructure/middleware.py` (Line 170)
- [ ] Check TTS service for similar file
- [ ] Check SMR service for similar file
- [ ] Check NLP service for similar file

**Change**:
```python
# FROM:
self.enabled = os.getenv("ENABLE_SECURITY_HEADERS", "false").lower() == "true"
# TO:
self.enabled = os.getenv("ENABLE_SECURITY_HEADERS", "true").lower() == "true"
```

**Verification**:
- [ ] Start each Python service
- [ ] `curl -I http://localhost:5003/api/health`
- [ ] Verify X-Content-Type-Options, X-Frame-Options present

---

### H3: Implement API Key Expiration Check

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Code Changes**:
- [ ] Uncomment expiration check in `api-key-validation.service.ts`
- [ ] Add proper logging for expired keys
- [ ] Update error message

**Verification**:
- [ ] Create API key with past expiration date
- [ ] Make request with expired key
- [ ] Verify 401 response with "API key has expired" message

---

### H4: Apply Rate Limiting Globally

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Code Changes**:
- [ ] Create `apps/api/src/interceptors/rate-limit.interceptor.ts`
- [ ] Create decorators for custom rate limits
- [ ] Add interceptor to `app.module.ts`
- [ ] Configure default rate limits

**Verification**:
- [ ] Make 101 requests in 1 minute
- [ ] Verify 429 response on 101st request
- [ ] Check X-RateLimit-* headers in response
- [ ] Test authenticated vs unauthenticated limits

---

## Post-Implementation Checklist

- [ ] All tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm build`
- [ ] Lint passes: `pnpm lint`
- [ ] Security scan: `npm audit` / `pnpm audit`
- [ ] Manual testing of auth flows
- [ ] Update documentation
- [ ] Create PR with detailed description
- [ ] Request security review

---

## Rollback Plan

If issues arise after deployment:

1. **Token Revocation Issues**:
   ```bash
   # Disable revocation check temporarily
   # Set env var: SKIP_TOKEN_REVOCATION=true
   ```

2. **Rate Limiting Issues**:
   ```bash
   # Increase limits or disable
   # Set env var: RATE_LIMIT_REQUESTS=10000
   ```

3. **Security Headers Breaking Clients**:
   ```bash
   # Disable security headers
   # Set env var: ENABLE_SECURITY_HEADERS=false
   ```

4. **Full Rollback**:
   ```bash
   git revert <commit-hash>
   pnpm install
   pnpm build
   # Redeploy
   ```

---

## Environment Variables Added

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET_KEY` | (required) | JWT signing secret - must be set |
| `SKIP_TOKEN_REVOCATION` | `false` | Disable token revocation check |
| `RATE_LIMIT_REQUESTS` | `100` | Default requests per minute |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |
| `ENABLE_SECURITY_HEADERS` | `true` | Enable security headers |

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | | | |
| Security Reviewer | | | |
| Tech Lead | | | |
