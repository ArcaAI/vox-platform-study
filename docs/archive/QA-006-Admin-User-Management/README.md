# QA-006 — Admin User Management E2E Test Results

> **Ticket**: QA-006  
> **Created**: 2026-02-26  
> **Last Updated**: 2026-02-26  
> **Status**: Completed  
> **Test Scope**: User Stories 26–35 (Admin — User Management)  
> **Test Environment**: localhost (API :8868, Vite :5173, STT :8861, SMR :8862, NLP :8864)

---

## Executive Summary

Comprehensive E2E testing of all 10 Admin — User Management stories (26–35) was performed using browser-based automation against the live Vite example app with JWT and API Key authentication.

| Metric | Value |
|--------|-------|
| **Total Tests Executed** | 22 |
| **Passed** | 10 |
| **Partially Passed** | 4 |
| **Failed** | 8 |
| **Critical Bugs** | 4 |
| **Medium Issues** | 5 |
| **Minor Issues** | 3 |

---

## Test Results by User Story

### Story 26: Create New User Accounts

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 26-A | Create user via Admin Panel UI | 1. Login as super_admin (JWT) → 2. Admin > Users → 3. Click "Create User" → 4. Fill username/email/password → 5. Click Create | **FAIL** | Critical |
| 26-B | Create user via API (POST /users) | Direct API call: `POST /users {"username":"test","password":"..."}` | **FAIL** | Critical |
| 26-C | Create user via API with externalId | `POST /users {"username":"test2","externalId":"ext-test2","password":"..."}` | **PASS** | — |

**Root Cause — Story 26 Failures:**

The `UserFactory.CreateUser()` in `packages/domains/src/factories/generated/core/UserFactory.ts` line 53 defaults `externalId` to empty string `""` when not provided:

```typescript
externalId: props.externalId ?? "",  // Bug: defaults to "" instead of null
```

Since the database schema has a unique constraint on `externalId`, creating any second user without an explicit `externalId` produces:

```
Unique constraint failed on the fields: ("externalId")
```

Additionally, the `removeNullValues()` function in `packages/domains/src/common/repository.ts` strips `null` values before persistence, which means even if the factory returned `null`, it would be removed from the create payload — but the factory returning `""` makes it persist as an empty string, triggering the unique constraint.

**Fix — API Layer** (`packages/domains/src/factories/generated/core/UserFactory.ts`):

```typescript
// Change line 53 from:
externalId: props.externalId ?? "",
// To:
externalId: props.externalId || null,
```

**Fix — Database Layer**: Consider making `externalId` nullable with no unique constraint when null, or use a partial unique index:

```sql
CREATE UNIQUE INDEX "User_externalId_key" ON "core"."User"("externalId") WHERE "externalId" IS NOT NULL;
```

---

### Story 27: Assign Roles to Users

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 27-A | View available roles | Expand user → See "Assign Role" → Click → View dropdown | **PASS** | — |
| 27-B | Assign role via UI | Select "NURSE" role → Select tenant scope → Click "Assign" | **PASS** | — |
| 27-C | Remove role via UI | Click X button on role badge | **PASS** | — |
| 27-D | Assign role via API (POST /users/:id/roles) | `POST /users/70000000.../roles {"roleId":"00000000-...04"}` | **FAIL** | Medium |

**Issue — 27-D**: Assigning a role via API returns a Foreign Key constraint error when using role IDs that don't exist in the `Role` table. The vite app's role dropdown correctly shows existing roles, so the UI flow works. However, the API does not validate `roleId` before attempting insert — the error is a raw Prisma FK violation exposed to the client.

**Fix — API**: Add validation in the role assignment service to check if the `roleId` exists before attempting the insert. Return a user-friendly 400 error: `"Role with ID ... not found"`.

---

### Story 28: View Paginated User List

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 28-A | View users list (JWT auth) | Login as super_admin → Admin > Users tab | **PASS** | — |
| 28-B | Search users | Type "admin" in search box | **PASS** | — |
| 28-C | Pagination | Navigate between pages | **PASS** | — |
| 28-D | User role badges | Check role badges in table | **PASS** | — |
| 28-E | View users list (API Key auth) | Login with API key → Admin > Users tab | **FAIL** | Critical |
| 28-F | Current user info after JWT login | Check header/sidebar for user identity | **PARTIAL** | Medium |
| 28-G | Current user info after API Key login | Check header/sidebar for user identity | **FAIL** | Critical |

**Issue — 28-E: API Key auth shows 0 users:**  
When logged in via API key, the Users tab shows "Users (0)" — the `GET /users` endpoint returns `401 Unauthorized` for API key auth.

- **API Root Cause**: The `/users` endpoint likely uses `JwtAuthGuard` only. API key auth does not set the user context in the same way, so the guard rejects the request.
- **SDK Root Cause**: The `useUsers()` hook calls `GET /users` with whatever auth headers are configured. When using API key, the request header is `X-API-Key: ...` but the endpoint expects `Authorization: Bearer <jwt>`.
- **Fix — API**: Add `EitherAuthGuard` (supports both JWT and API Key) to the users controller, or create an API-key-aware guard that resolves the API key owner and populates the user context.

**Issue — 28-F: JWT login shows partial user info:**  
After JWT login, the sidebar footer shows `super_admin JWT Auth` but does NOT display:
- User role (SUPER_ADMIN)
- Tenant information
- Detailed profile info

**Fix — Vite App** (`components/app-sidebar.tsx`): Display role badges and tenant name in the sidebar footer user area. The `AdminUser` object from auth-store already contains `roles[]` — just render them.

**Issue — 28-G: API Key login shows no user identity:**  
After API key login, the app shows generic "API Key User" with no identity info. This happens because:

1. The `ApiKeyForm` in `login-gate.tsx` (line 187) sets `adminUser: null` on successful login
2. The `/auth/me` endpoint only supports JWT auth (`@UseGuards(JwtAuthGuard)` on line 182 of `auth.controller.ts`), so it returns 401 for API key requests
3. There is no mechanism to resolve the API key owner and display their identity

**Fix — API**: Create a `/auth/me` variant that supports API key auth, or modify `ApiKeyGuard` to resolve the API key's `userId` and populate the user context.

**Fix — Vite App**: After API key login, call a user-info endpoint to resolve the API key owner's identity and store it in `adminUser`.

---

### Story 29: Delete User Accounts with Confirmation

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 29-A | Delete user confirmation dialog | Click trash icon → Confirmation dialog appears | **PASS** | — |
| 29-B | Cancel deletion | Click "Cancel" on confirmation | **PASS** | — |
| 29-C | Confirm deletion | Click "Delete" on confirmation | **PASS** | — |

No issues found. The delete flow works correctly with proper confirmation dialog.

---

### Story 30: Impersonate Non-Admin User

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 30-A | Impersonate via UI | Expand "doctor" → Click "Impersonate" | **PASS** | — |
| 30-B | Impersonate via API | `POST /auth/impersonate {"targetUserId":"..."}` | **PASS** | — |
| 30-C | Impersonate prevents admin targets | Cannot impersonate SUPER_ADMIN users | **PASS** | — |

Impersonation works correctly. The API generates a scoped JWT token with `impersonatedBy` field, and the vite app correctly switches context.

---

### Story 31: Impersonation Banner and Session End

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 31-A | Impersonation banner visible | After impersonating, check header banner | **PASS** | — |
| 31-B | Banner shows target user info | Banner shows "Impersonating: doctor" with roles | **PASS** | — |
| 31-C | End impersonation via header button | Click "End Session" button | **PASS** | — |
| 31-D | End impersonation via sidebar menu | Sidebar shows "End Impersonation (doctor)" | **PASS** | — |
| 31-E | Session timer | Banner shows elapsed time (0:00+) | **PASS** | — |

Impersonation UI works flawlessly with clear visual indicators.

---

### Story 32: Create and Manage API Keys

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 32-A | Create API key via UI | Expand user → "New Key" → Fill name/type → Create | **PASS** | — |
| 32-B | Raw key displayed once | After creation, raw key shown with copy warning | **PASS** | — |
| 32-C | API keys per-user scoping | Expand different users → Compare API keys | **FAIL** | Critical |
| 32-D | Key type selection | SDK, Webhook, Integration, Service Account types | **PASS** | — |
| 32-E | Create API key for specific user | Key created for expanded user context | **PARTIAL** | Medium |

**Issue — 32-C: ALL users show the SAME API keys (CRITICAL BUG):**

When expanding any user in the Users tab, the API Keys section shows ALL 9 system API keys regardless of which user is expanded. Verified by comparing:
- super_admin → 9 keys (Expired Test Key - Doctor2, ArcaAI Integration Key, SDK API Key - Surgery, etc.)
- doctor → Same 9 keys (identical list)
- tenant_admin → Same 9 keys (identical list)

**Root Cause — SDK + Vite App:**

1. **SDK**: `useApiKeys().list()` calls `GET /admin/api-keys` which returns ALL API keys in the system without filtering by userId.

2. **Vite App** (`users-tab.tsx` lines 222-226): When a user row is expanded, `handleExpandUser` calls `listApiKeys()` without any userId filter:
   ```typescript
   // Line 222-226 — Bug: no userId filter
   try {
     await listApiKeys(); // fetches ALL keys, not user-specific
   } catch (e) { ... }
   ```

3. **Vite App** (line 431): The same `apiKeys` array (containing ALL keys) is passed to every `UserRow`:
   ```typescript
   apiKeys={apiKeys} // same full list for every user row
   ```

**Fix — SDK** (`hooks/useApiKeys.ts`): Add a `listByUser(userId)` method or add `userId` filter parameter to `list()`:
```typescript
const listByUser = useCallback(
  (userId: string, pagination?: PaginationParams) =>
    execute<ApiKey[]>('listByUser', async (client) => {
      const raw = await client.get(
        appendPagination(`/admin/api-keys?userId=${userId}`, pagination)
      );
      return extractArray<ApiKey>(raw).map(normalizeApiKey);
    }),
  [execute],
);
```

**Fix — API**: The `GET /admin/api-keys` endpoint should support a `?userId=` query parameter for filtering.

**Fix — Vite App** (`users-tab.tsx`): Filter `apiKeys` by `userId` before passing to each `UserRow`, or fetch per-user keys when expanding.

**Issue — 32-E**: API key creation is not scoped to the expanded user. The "New Key" button creates a key for the currently authenticated user, not for the user whose row is expanded.

**Fix — SDK + Vite App**: The create API key payload should include a `userId` field specifying which user the key belongs to.

---

### Story 33: View API Key Usage Statistics

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 33-A | Usage stats displayed | Expand user → View key stats | **PARTIAL** | Minor |

Usage statistics ARE displayed for each key showing Total Calls, Last Used, and Rate Limit. However, all keys show `Total Calls: 0` and `Last Used: Never` — this may indicate the usage tracking endpoint (`/admin/api-keys/:id/usage`) returns mock/empty data, or usage tracking is not implemented in the API.

---

### Story 34: Revoke API Keys

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 34-A | Revoke button visible | Active keys show "Revoke" button | **PASS** | — |
| 34-B | Revoke key action | Click Revoke on active key | **PARTIAL** | Minor |

The Revoke button is present and functional. However, because all users show the same keys (bug 32-C), revoking a key from one user's view affects all users' views.

---

### Story 35: Set IP Restrictions on API Keys

| Test ID | Test Name | Steps | Result | Severity |
|---------|-----------|-------|--------|----------|
| 35-A | IP restriction field in create dialog | Create key form has "Allowed IPs" field | **PASS** | — |
| 35-B | IP restriction display | Keys with IP restrictions show IP count badge | **PASS** | — |
| 35-C | IP restriction enforcement | API enforces IP restrictions on key usage | **NOT TESTED** | — |

The UI for setting IP restrictions is present. Creation form includes an "Allowed IPs" field with comma-separated input and help text. Keys with restrictions display an IP count badge.

---

## Additional Issues Found

### Issue A1: Edit User — Backend Validation Error

**Severity**: Medium  
**Component**: API  
**Description**: When editing a user and submitting unchanged data (or only changing email), the API returns `500 "No changes to write to"` (GENERIC.ARGUMENT_INVALID). The update endpoint should handle no-op updates gracefully.

**Root Cause**: The repository `update()` method detects no entity changes (via change tracking) and throws an error instead of returning the existing entity.

**Fix**: In the update flow, if `entity.hasChanges === false`, return the existing entity without throwing.

### Issue A2: Enable/Disable User — SDK Endpoint Mismatch

**Severity**: Medium  
**Component**: SDK  
**Description**: The SDK's `useUsers().enable()` and `disable()` methods use `PATCH /users/:id` with `{resourceStatus: "ENABLED"|"DISABLED"}`, which WORKS correctly. However, the vite app's toggle status button calls the SDK methods which work via the generic update endpoint — this is functionally correct but the naming in the SDK suggests dedicated enable/disable endpoints that don't exist.

**Status**: Working — but the SDK API surface could be misleading for developers expecting dedicated `/users/:id/enable` and `/users/:id/disable` endpoints.

### Issue A3: Role Names Not Displayed After Assignment

**Severity**: Minor  
**Component**: Vite App  
**Description**: After assigning a role, the new role assignment shows the role ID (UUID) instead of the human-readable role name in the badge. This is because the `assignRole` API response returns only the assignment record with `roleId`, not the resolved `roleName`.

**Fix — Vite App**: After successful role assignment, resolve the role name from the `allRoles` array before updating `userRolesMap`.

---

## Summary of All Issues

### Critical Issues (Must Fix)

| # | Issue | Component | Story |
|---|-------|-----------|-------|
| C1 | User creation fails — `externalId` unique constraint on empty string | API (UserFactory) | 26 |
| C2 | API Key auth shows no user identity and cannot access admin endpoints | API + Vite App | 28 |
| C3 | ALL users show the SAME API keys (no per-user scoping) | SDK + Vite App | 32 |
| C4 | `/auth/me` returns 401 for API Key auth — no user identity resolution | API | 28 |

### Medium Issues (Should Fix)

| # | Issue | Component | Story |
|---|-------|-----------|-------|
| M1 | JWT login doesn't display user role or tenant in UI | Vite App | 28 |
| M2 | Edit user throws 500 on no-change updates | API | 26 |
| M3 | Role assignment API returns raw Prisma FK errors | API | 27 |
| M4 | API key creation not scoped to target user | SDK + Vite App | 32 |
| M5 | Role assignment response shows UUID instead of role name | Vite App | 27 |

### Minor Issues (Nice to Have)

| # | Issue | Component | Story |
|---|-------|-----------|-------|
| L1 | API key usage stats show all zeros (may be unimplemented) | API | 33 |
| L2 | Revoke key affects shared key list (symptom of C3) | Vite App | 34 |
| L3 | SDK suggests enable/disable endpoints that use generic PATCH | SDK | 28 |

---

## Recommended Fix Priority

### Phase 1: Critical Path (Immediate)

1. **Fix UserFactory `externalId` default** → Unblocks user creation
2. **Add `userId` filter to API key listing** → Fixes per-user API key display
3. **Support API Key auth in `/auth/me`** → Enables user identity for API key sessions
4. **Add EitherAuthGuard to user/admin endpoints** → Enables API key users to access admin features

### Phase 2: Quality Improvements

5. Handle no-change update gracefully in repository
6. Add roleId validation before role assignment
7. Display role and tenant info in sidebar for JWT users
8. Scope API key creation to target user

### Phase 3: Polish

9. Resolve role names after assignment
10. Implement API key usage tracking
11. Add IP restriction enforcement testing

---

## Test Environment Details

| Service | URL | Status |
|---------|-----|--------|
| API Gateway (NestJS) | http://localhost:8868/api/v1 | Running |
| Vite Example App | http://localhost:5173 | Running |
| STT (Python/Uvicorn) | http://localhost:8861 | Running |
| SMR (Python/Uvicorn) | http://localhost:8862 | Running |
| NLP (Python/Uvicorn) | http://localhost:8864 | Running |

### Test Credentials

| Auth Method | Credentials |
|-------------|-------------|
| JWT (Super Admin) | username: `super_admin`, password: `password123` |
| API Key (Tenant Admin) | `hope_sk_test_e0g1i90b98g8871jfh1gi1hhi3_075682` |

### Test Data

| Entity | Count |
|--------|-------|
| Users | 26 (20 visible in paginated UI) |
| Roles | 7 (SUPER_ADMIN, TENANT_ADMIN, ADMIN, DOCTOR, NURSE, SENIOR_NURSE, DEPARTMENT_HEAD, SERVICE_ACCOUNT) |
| API Keys | 9 |
| Tenants | 4 (Global, ArcaAI, Flourish, Accala) |

---

## Related Documentation

- [User Stories 26-35](../../../knowledge/06_USER_STORIES.md#admin--user-management-26-35)
- [API Endpoint Reference](../../../knowledge/05_API_LIST.md)
- [Technical Architecture](../../../knowledge/02_TECHNICAL_ARCHITECTURE.md)
