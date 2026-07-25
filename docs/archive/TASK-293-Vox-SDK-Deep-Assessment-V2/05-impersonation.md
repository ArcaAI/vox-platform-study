# 05 — Impersonation (global + tenant admin)

*Reviewer A5 — TASK-293 Vox SDK Deep Assessment V2 — 2026-05-24*

---

## 1. Scope & method

### 1.1 Business requirement under review

1. **Global admins** (`SUPER_ADMIN`) can impersonate any user — including cross-tenant.
2. **Tenant admins** (`TENANT_ADMIN`) can impersonate users **only within their own tenant**.
3. Impersonation is exercised from the **playground** (`apps/ui-playground`); SDK supports it natively.
4. While impersonated, every SDK request carries the impersonated user's identity, while the original admin identity remains **auditable**.
5. Impersonation token is **stored securely** (TASK-262 SEC-D / W0-3: no admin token in publicly readable Zustand state).
6. Impersonation is **revocable** at any time.
7. Cross-tab behavior is controlled / auditable.
8. Personalization (A1), voice enrollment (A2), pipeline selection (A4) reflect the IMPERSONATED user while active.

### 1.2 Method

- Read every TS source file in the impersonation chain: SDK (`AgenticClient`, `useAuth`, `agenticStore`, `ConfigManager`, `PersonalizationManager`, `SimpleCrossTabSync`, `AgenticProvider`), backend (`auth.controller.ts`, `ImpersonationAuditInterceptor`, `ContextInterceptor`, `JwtStrategy`, `BaseService`, `AuditLogService`), playground (`auth-store.ts`, `sdk-provider.tsx`, `user-list.tsx`, `impersonation-guard.tsx`).
- Verified W0-3 status against `agenticStore.impersonation.test.ts` and `AgenticClient.impersonation.test.ts`.
- Verified SEC-J status against `ContextInterceptor` + `JwtStrategy` + `BaseService`.
- Walked end-to-end happy path and rehydration / cross-tab paths.
- All references cite `file:line`.

---

## 2. Current architecture

### 2.1 End-to-end sequence (happy path)

```
Playground (UserList.handleImpersonate)
    │
    ▼
useAuth.impersonate(targetUserId)                          # packages/agentic-sdk-v2/src/hooks/useAuth.ts:162-196
    │
    │ 1. snapshot currentToken = apiClient.getAccessToken()
    │
    ▼
POST /auth/impersonate { targetUserId }                    # AgenticClient.post → AuthController.impersonate
    │
    │ Backend (apps/api/src/modules/auth/auth.controller.ts:290-401):
    │   • clsService.get('user') → adminUser
    │   • Check adminRoles include SUPER_ADMIN or TENANT_ADMIN (401 otherwise)
    │   • Look up targetUser (400 if missing)
    │   • Reject target = SUPER_ADMIN (400)
    │   • Reject (TENANT_ADMIN && target = TENANT_ADMIN) cross-admin (400)
    │   • Look up target's *first* userRoleAssignment.tenantId, error if none
    │   • Mint impersonation JWT with claims:
    │       { id: target.id, roles: target.roles, permissions,
    │         tenantId: resolvedTenantId,
    │         impersonatedBy: adminUser.id,
    │         jti: `impersonate-${adminId}-${targetId}-${Date.now()}`,
    │         expiresIn: JWT_IMPERSONATION_EXPIRES_IN (default 15m) }
    │   • authService.trackAuthentication(adminUser.id, {…})   # audit emit
    │
    ▼ 200 OK { user, token, impersonatedBy }
    │
    ▼ Back in useAuth.impersonate:
    │ 2. apiClient.startImpersonation(currentToken)        # AgenticClient.ts:760-776
    │      └─ WeakMap<AgenticClient, string>.set(this, adminToken)   # AgenticClient.ts:30
    │ 3. store.setOriginalUser(store.authUser)
    │ 4. store.setImpersonatedUser(data.user)
    │ 5. apiClient.updateAccessToken(data.token)           # impersonation JWT now active
    │
    ▼ Back in UserList.handleImpersonate (apps/ui-playground/src/features/playground/overview/components/user-list.tsx:180-241):
    │ 6. useAuthStore.startImpersonation(result.user, result.token, tenantId)   # ← persisted to localStorage
    │ 7. snapshot admin's ConfigManager prefs; setReadOnly(true)
    │ 8. GET /admin/users/:id/settings (namespace=arcaai-sdk)
    │ 9. cm.loadExternalPreferences(impersonatedPrefs)

Every subsequent SDK request (AgenticClient.request — packages/agentic-sdk-v2/src/core/AgenticClient.ts:125-149):
   headers.Authorization = `Bearer ${impersonationJwt}`        # impersonated user identity
   headers['X-Tenant-ID'] = this.tenantId                      # ← updated by AgenticProvider from playground store
   headers['X-Request-ID'], traceparent, X-Correlation-ID

Backend per-request flow:
   passport-jwt → JwtStrategy.validate(payload)                # packages/applications/src/services/auth/jwt.strategy.ts:25-41
       └─ clsService.set('user', UserSession({ id: targetId, tenantId, roles, ... }))
       └─ payload.impersonatedBy is NOT propagated into UserSession (defect, see §5 H-2)

   ContextInterceptor.intercept                                # apps/api/src/interceptors/context.interceptor.ts:32-101
       └─ if (request.headers['x-tenant-id']) clsService.set('tenantId', header)   # SEC-J — still open

   ImpersonationAuditInterceptor.intercept                     # apps/api/src/interceptors/impersonation-audit.interceptor.ts:32-68
       └─ if (clsUser.impersonatedBy) on tap.next → eventEmitter.emit('user.authenticated', {
              userId: adminId, impersonatedUserId, ip, userAgent, endpoint, method })

   AuditLogService.handleUserAuthenticatedEvent                # packages/applications/src/services/auditLog/auditLog.service.ts:204-244
       └─ AuditLogFactory.CreateAuditLog({
              action: LOGIN, eventType: AUTHENTICATION, responsibleUserId: adminId,
              resourceId: adminId, resourceType: User,
              data: { method, timestamp, userAgent }   # ← impersonatedUserId is DROPPED (defect H-1)
          })
```

Stop impersonation sequence:

```
UserList.handleEndImpersonation
    │
    ▼
ConfigManager.setReadOnly(false); cm.restoreUserPreferences(adminSnapshot)
    │
    ▼
useAuth.endImpersonation                                       # useAuth.ts:198-222
    │ 1. POST /auth/revoke-impersonation                       # auth.controller.ts:487-506 — just audits + returns {success}
    │ 2. originalToken = apiClient.stopImpersonation()         # WeakMap.get/delete
    │ 3. originalUser  = store.authOriginalUser
    │ 4. if (originalToken) apiClient.updateAccessToken(originalToken)
    │ 5. store.setAuthUser(originalUser); setImpersonatedUser(null); setOriginalUser(null)
    │
    ▼
useAuthStore.endImpersonation()                                # apps/ui-playground/src/store/auth-store.ts:113-120
    │   impersonatedUser = null; impersonationToken = ''; tenantId = originalTenantId
```

### 2.2 Cross-tab footprint

- **SDK-level cross-tab sync** (`SimpleCrossTabSync`): consultation-context broadcasts; **never carries the JWT**; channel is namespaced as `agentic.<tenantId>` and HMAC-signed via `CrossTabHmacKeyManager` (TASK-280). `setTenantId(newId)` reopens the channel on tenant switch (`packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts:170-200`). The SDK does **not** broadcast `impersonationStarted`/`Stopped`, so two tabs do not actively coordinate impersonation state.
- **Implicit cross-tab leakage via `localStorage`**: the playground stores `impersonationToken`, `impersonatedUser`, `isImpersonating`, `tenantId` in Zustand `persist` with key `arcavox.auth` (`apps/ui-playground/src/store/auth-store.ts:129-146`). `localStorage` fires `storage` events in sibling tabs; on next reload, both tabs read the same persisted blob. Test `auth-store.impersonation-persistence.test.ts` *asserts* this behavior is intentional. The SDK store (`agenticStore`) is **not** persisted, so it stays per-tab.

Net effect: tab A starts impersonation → tab B is not synchronously updated, but tab B *will* observe impersonation on its next mount/reload because it rehydrates from the same `arcavox.auth` localStorage entry.

---

## 3. Public surface map (SDK ↔ HTTP ↔ Backend ↔ Auth ↔ Audit)

| Layer | Identifier | HTTP | Backend handler | Auth gate | Audit emit |
|---|---|---|---|---|---|
| SDK hook | `useAuth.impersonate(targetUserId)` | `POST /auth/impersonate` | `AuthController.impersonate` (`auth.controller.ts:290-401`) | `@Authorize()` + manual role check (lines 312-316, 340-342) | `authService.trackAuthentication(adminId)` (lines 380-385) — emits `user.authenticated` |
| SDK hook | `useAuth.endImpersonation()` | `POST /auth/revoke-impersonation` | `AuthController.revokeImpersonation` (`auth.controller.ts:487-506`) | `@Authorize()` | `trackAuthentication` (lines 498-503) — server-side **no token blacklist** |
| SDK client | `AgenticClient.startImpersonation(token)` | n/a (local) | n/a | n/a | logs at info via `SDKLogger` (`AgenticClient.ts:772-775`) |
| SDK client | `AgenticClient.stopImpersonation()` | n/a (local) | n/a | n/a | logs at info (`AgenticClient.ts:789-793`) |
| SDK client | `AgenticClient.isImpersonating()` | n/a (local) | n/a | n/a | n/a |
| SDK hook | `useAuth.{startImpersonation,stopImpersonation}` (escape hatches) | n/a | n/a | n/a | n/a |
| Backend interceptor | `ImpersonationAuditInterceptor` | applied via `APP_INTERCEPTOR` to every request (`app.module.ts:64-66`) | tap on `next` emits `user.authenticated` (`impersonation-audit.interceptor.ts:48-68`) | n/a | one row per successful HTTP under impersonation |
| Constants | `AUTH_ENDPOINTS.IMPERSONATE` / `REVOKE_IMPERSONATION` | `packages/agentic-sdk-v2/src/core/constants.ts:373-374` | matches backend | — | — |

> **JWT claims contract**:
> - `id` = impersonated user id (used as subject everywhere downstream)
> - `tenantId` = impersonated user's tenant (resolved from their *first* userRoleAssignment, see §5 H-3)
> - `roles` / `permissions` = the impersonated user's
> - `impersonatedBy` = the admin's id (the only carrier of original-actor identity)
> - `jti` = `impersonate-${adminId}-${targetId}-${ts}`
> - `exp` = `JWT_IMPERSONATION_EXPIRES_IN` (default `15m`)

---

## 4. Strengths

1. **W0-3 closure verified** — admin JWT is held in a module-level `WeakMap<AgenticClient, string>` (`AgenticClient.ts:30`) rather than on the instance. Tests explicitly verify it is invisible to `Object.keys`, `JSON.stringify`, and `Object.getOwnPropertyNames` (`AgenticClient.impersonation.test.ts:77-103`). The `agenticStore` no longer contains `authOriginalToken` and the assertion is locked in by `agenticStore.impersonation.test.ts:15-18`.
2. **Single-source authoritative `isImpersonating` flag** — `useAuth.isImpersonating` derives the boolean from `apiClient.isImpersonating()` (`useAuth.ts:56-60`), so even if `authImpersonatedUser` is desynchronised, the client flag wins.
3. **Idempotent stop** — `AgenticClient.stopImpersonation()` returns `undefined` on second call rather than throwing (`AgenticClient.ts:785-795`); `useAuth.endImpersonation` also tolerates the absence of admin token and proceeds with local cleanup even if the server-side revoke fails (`useAuth.ts:198-222`).
4. **Defensive `startImpersonation` validation** — rejects empty token, rejects double-start (`AgenticClient.ts:760-776`); tests pin both edges.
5. **Backend role gating with multiple guards**:
   - Admin must hold `SUPER_ADMIN` *or* `TENANT_ADMIN` (`auth.controller.ts:312-316`).
   - Target cannot be `SUPER_ADMIN` (`auth.controller.ts:336-338`).
   - `TENANT_ADMIN` cannot impersonate any other admin (`auth.controller.ts:340-342`).
   - Shorter TTL on impersonation JWT (`JWT_IMPERSONATION_EXPIRES_IN`, 15m by default — `auth.controller.ts:362, 375`).
6. **Per-request audit emission** — `ImpersonationAuditInterceptor` fires for **every** authenticated HTTP request that carries an `impersonatedBy` claim, not just on the `/auth/impersonate` call itself (`impersonation-audit.interceptor.ts:32-68`).
7. **Cross-tab channel name re-scoped on tenant switch** — `SimpleCrossTabSync.setTenantId()` closes and reopens the `BroadcastChannel` with the new tenant id (`SimpleCrossTabSync.ts:170-200`), so consultation broadcasts cannot leak across tenants when an admin impersonates cross-tenant.
8. **TASK-245 preference isolation for `ConfigManager`** — admin preferences are snapshotted, then read-only mode + `loadExternalPreferences()` swap to the impersonated user's prefs; on stop, the snapshot is restored (`user-list.tsx:200-232, 246-254`; `impersonation-config.test.ts` proves the lifecycle).
9. **HTTP 401 retry path is safe under impersonation** — `deduplicatedRefresh()` only fires if `onUnauthorizedHandler` is set, and the SDK's `useAuth` does not auto-refresh while impersonating (refresh is gated by the consumer; the admin's `refreshToken` is not on the client, only the impersonation JWT is).

---

## 5. Defects

### Critical

**C-1. Tenant-admin cross-tenant impersonation is NOT enforced server-side.**
`apps/api/src/modules/auth/auth.controller.ts:340-342` only rejects `TENANT_ADMIN → another admin`. There is **no comparison** between the tenant admin's own `tenantId` and the target user's resolved `tenantId`. A `TENANT_ADMIN` of tenant A can supply any non-admin `targetUserId` from tenant B and the controller will mint an impersonation JWT scoped to tenant B's `userRoleAssignment.tenantId`. This is a direct violation of business requirement #2 ("tenant admins can impersonate users only within their own tenant").

The admin's own tenant id is reachable two ways but neither is consulted:
- `clsService.get('user').tenantId` (from `JwtStrategy.validate` — but note `UserSession.tenantId` IS available, just unused here).
- A second `userRoleAssignment.findFirst({ userId: adminUser.id, … })` query.

**Patch**:

```typescript
// auth.controller.ts after line 355 (resolvedTenantId resolution)
if (!isSuperAdmin) {
  // adminUser is the CLS UserSession from JwtStrategy
  const adminTenantId = adminUser.tenantId;
  if (!adminTenantId) {
    throw new BadRequestException('Tenant admin missing tenant context');
  }
  if (adminTenantId !== resolvedTenantId) {
    throw new ForbiddenException('Tenant admin cannot impersonate users outside their own tenant');
  }
}
```

Test coverage gap to fill: `auth.controller.task224.test.ts` covers TENANT_ADMIN→TENANT_ADMIN rejection (lines 351-389) but does **not** test TENANT_ADMIN→non-admin in another tenant. Add a red test that creates a TENANT_ADMIN of tenant A and a DOCTOR in tenant B and asserts 403.

**C-2. `x-tenant-id` header still overrides JWT tenant claim (SEC-J unfixed).**
`apps/api/src/interceptors/context.interceptor.ts:55-60` unconditionally writes the request header into CLS `tenantId`:

```typescript
const tenantIdHeader = request.headers['x-tenant-id'];
if (tenantIdHeader) {
  this.tryClsSet('tenantId', tenantIdHeader);
}
```

`JwtStrategy.validate` does **NOT** call `clsService.set('tenantId', payload.tenantId)` (`packages/applications/src/services/auth/jwt.strategy.ts:25-41`) — it only sets `'user'`. `BaseService.tenantId` reads CLS `'tenantId'` (`packages/applications/src/common/base.service.ts:80-82`). Therefore: any authenticated client can send `X-Tenant-ID: <other-tenant>` and `BaseService.tenantId` will return the attacker-supplied value, bypassing the JWT's tenant scope.

This is independent of impersonation but **amplified** by it: while impersonating, the SDK already sets `X-Tenant-ID` to the impersonated user's tenant. An admin (or anyone with a stolen impersonation JWT) can replay the same JWT with a different `X-Tenant-ID` header to access yet another tenant's data.

**Patch**:

```typescript
// jwt.strategy.ts — JwtStrategy.validate
async validate(payload: any): Promise<UserSession> {
  const userSession = new UserSession({ ... });
  this.clsService.set('user', userSession);
  this.clsService.set('tenantId', payload.tenantId);   // ← ADD
  return userSession;
}

// context.interceptor.ts — drop the header override OR gate it on
// a separate "trusted-actor" claim
- const tenantIdHeader = request.headers['x-tenant-id'];
- if (tenantIdHeader) {
-   this.tryClsSet('tenantId', tenantIdHeader);
- }
+ // x-tenant-id header is informational only; never override JWT-derived tenant
+ const tenantIdHeader = request.headers['x-tenant-id'];
+ const jwtTenant = (this.tryClsGet('user') as UserSession | undefined)?.tenantId;
+ if (tenantIdHeader && jwtTenant && tenantIdHeader !== jwtTenant) {
+   this.logger.warn({ message: 'x-tenant-id header diverges from JWT tenant', tenantIdHeader, jwtTenant });
+ }
```

**C-3. Audit log loses the impersonated subject — actor + subject are NOT both recorded.**
The interceptor emits the event correctly with `impersonatedUserId` in the payload (`impersonation-audit.interceptor.ts:52-60`), but `AuditLogService.handleUserAuthenticatedEvent` constructs the audit row with `responsibleUserId: userId` (= adminId), `resourceId: userId` (= adminId), and a fixed `data: { method, timestamp, userAgent }` — **`impersonatedUserId` is dropped** (`packages/applications/src/services/auditLog/auditLog.service.ts:208-228`).

Net result: every impersonated request creates an audit row that says "admin X performed LOGIN on themselves", with no record of the impersonated user, the endpoint, or the HTTP method. This violates business requirement #4 (actor + subject both auditable) and conflates per-request audit with login audit (every request creates a LOGIN row, polluting the auth audit stream).

**Patch (audit-log handler)**:

```typescript
// auditLog.service.ts:handleUserAuthenticatedEvent
const isImpersonatedRequest = !!(event as { impersonatedUserId?: string }).impersonatedUserId;
const auditLog = AuditLogFactory.CreateAuditLog({
  action: isImpersonatedRequest ? AuditAction.IMPERSONATED_ACTION : AuditAction.LOGIN,
  eventType: isImpersonatedRequest ? 'IMPERSONATION' : 'AUTHENTICATION',
  success: true,
  responsibleUserId: userId,                                    // admin
  responsibleIp: event.ip || this.requestIp,
  resourceId: (event as any).impersonatedUserId ?? userId,      // subject
  resourceType: ResourceType.User,
  data: {
    method: event.method,
    endpoint: (event as any).endpoint,
    httpMethod: (event as any).httpMethod,
    impersonatedUserId: (event as any).impersonatedUserId,
    timestamp: timestamp.toISOString(),
    userAgent: event.userAgent || null,
  },
  ...
});
```

Also add a new `AuditAction.IMPERSONATED_ACTION` enum value (or reuse an existing `ACTION` type with a discriminator) so impersonation events are queryable.

**C-4. Server has no token revocation — `POST /auth/revoke-impersonation` is a no-op for security.**
`auth.controller.ts:487-506` only calls `trackAuthentication` and returns `{ success: true }`. The impersonation JWT (`jti = impersonate-${admin}-${target}-${ts}`) remains valid until its 15-minute TTL expires. If the JWT is captured (e.g. via an XSS, a localStorage exfiltration — see C-5, or a stolen browser session), an attacker can replay it for the full TTL **after** the admin "ended" impersonation.

**Patch sketch**: maintain a Redis set of revoked `jti` values (TTL = original `exp`) and consult it in `JwtStrategy.validate`. Alternatively, store impersonation grants in a database table with `revokedAt` and check at validate time.

### High

**H-1. Playground persists the impersonation JWT to localStorage (in-spirit SEC-D regression).**
`apps/ui-playground/src/store/auth-store.ts:104-120` writes `impersonationToken` into the Zustand `persist`ed state with key `arcavox.auth` (lines 129-146). On every impersonation start, the *impersonated user's* JWT is written to localStorage; persistence-test `auth-store.impersonation-persistence.test.ts:43-54` even asserts this is desired behavior.

While this is an **app**-level store (not the SDK store SEC-D originally targeted), the same vulnerability shape persists: any third-party script on the page can read `localStorage.getItem('arcavox.auth')` and exfiltrate the active session's JWT. The admin's own JWT (`accessToken`) is also there. The 15-minute TTL on the impersonation JWT is a partial mitigation, but the admin's `accessToken` has the regular `JWT_EXPIRES_IN` TTL (default `1h`).

This same shape also defeats W0-3's stated reliance on cross-tab isolation: a sibling tab on the same origin can read both tokens by simply reading localStorage.

**Recommendation**:
- Move both `accessToken` and `impersonationToken` to `sessionStorage` (per-tab, no `storage` event leakage). Page reload still works because `sessionStorage` survives reload within the same tab.
- Drop `impersonationToken` from `partialize` entirely; require explicit re-impersonation after reload. Page-refresh-during-impersonation is a rare flow and the security/audit benefits dominate.
- Alternatively, encrypt the persisted blob with a per-origin key bound to `crypto.subtle` (see TASK-262 R-5 for the design).

**H-2. JWT `impersonatedBy` claim is dropped at the passport-jwt boundary.**
`UserSession` (`packages/applications/src/services/auth/dto/userSession.dto.ts`, referenced from `jwt.strategy.ts:25-41`) does not include `impersonatedBy`. The strategy reads `payload.tenantId`, `payload.roles`, etc., but ignores `payload.impersonatedBy`. The interceptor recovers it by reading `clsService.get('user').impersonatedBy` (`impersonation-audit.interceptor.ts:37`), but `'user'` is a `UserSession` instance — `impersonatedBy` simply ends up on the object because `clsService.set('user', userSession)` doesn't go through a typed schema and JavaScript permits the extra property.

This is fragile in two ways:
- A future refactor of `UserSession` to a strict class with `@Expose()`-only assignment will silently strip `impersonatedBy` and break the audit interceptor.
- Any code path that builds `UserSession` via `class-transformer` (e.g. test helpers) loses the claim.

**Patch**:

```typescript
// userSession.dto.ts — add the field
@ApiProperty({ required: false })
impersonatedBy?: string;

// jwt.strategy.ts — propagate it
const userSession = new UserSession({
  id: payload.id,
  …
  tenantId: payload.tenantId,
  roles: payload.roles || [],
  permissions: payload.permissions || [],
  impersonatedBy: payload.impersonatedBy,                // ← ADD
});
```

**H-3. Tenant resolution for the impersonation JWT picks an arbitrary tenant.**
`auth.controller.ts:346-354` picks the target user's *first* `userRoleAssignment.tenantId` (`orderBy: { createdAt: 'asc' }`). If a user is assigned to multiple tenants, the admin cannot choose which one to impersonate **as**, and a `TENANT_ADMIN` cannot impersonate a user who has assignments in their own tenant but whose oldest assignment is elsewhere.

Combined with **C-1**, this becomes a security issue: imagine a doctor with assignments in tenant A (admin's tenant) and tenant B. The TENANT_ADMIN of tenant A can issue an impersonation request for that doctor, and depending on assignment order, may receive a JWT scoped to tenant **B**. C-1 then lets them act as that user in tenant B even though their nominal scope is tenant A.

**Patch**: accept an optional `targetTenantId` in the `ImpersonateRequest` body. Validate it is one of the target user's enabled assignments. If the admin is not `SUPER_ADMIN`, validate `targetTenantId === adminUser.tenantId`.

**H-4. `PersonalizationManager` has no impersonation isolation.**
TASK-245's isolation only covers `ConfigManager.setReadOnly()` + `loadExternalPreferences()`. `PersonalizationManager.updatePreferences()` (`packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:99-166`) unconditionally calls `saveLocal()` and `syncToBackend()`. While impersonating, any consumer that calls `useArcaConfig.updatePreference(...)` will:
- Write the changed value to the admin's localStorage IndexedDB slot (overwriting admin's personal preference).
- POST it to the backend under the impersonated user's identity (because `apiClient.accessToken` is the impersonation JWT).

This violates business requirement #8 (impersonation must reflect the impersonated user's settings, in-memory only). The playground does call `cm.setReadOnly(true)` for the audio `ConfigManager`, but no equivalent gate exists on `PersonalizationManager`.

**Patch**:

```typescript
// PersonalizationManager.ts
private impersonationReadOnly = false;
setImpersonationReadOnly(flag: boolean) { this.impersonationReadOnly = flag; }

async updatePreferences(updates: UserPreferencesUpdate): Promise<void> {
  if (this.impersonationReadOnly) {
    this.preferences = { ...this.preferences, ...updates };   // in-memory only
    this.notifyListeners();
    return;
  }
  …
}

// useAuth.impersonate (after setImpersonatedUser):
personalizationManager?.setImpersonationReadOnly(true);

// useAuth.endImpersonation (after restoreUserPreferences):
personalizationManager?.setImpersonationReadOnly(false);
```

**H-5. SDK does not re-bind to its impersonation state after page reload.**
On reload, the playground rehydrates `impersonationToken` from localStorage. `sdk-provider.tsx:27-29` forwards it to `AgenticConfig.api.accessToken`. `AgenticProvider.tsx:382-406` sees `store.authImpersonatedUser === null` (SDK store is not persisted) and calls `client.updateAccessToken(impersonationToken)` — so the impersonation JWT becomes the active token. But:
- `apiClient.startImpersonation(adminToken)` is **NEVER called** on rehydration (the admin token was never re-injected into the WeakMap).
- `apiClient.isImpersonating()` returns `false`.
- `useAuth.isImpersonating` therefore evaluates to `(impersonatedUser !== null) || false`. `impersonatedUser` is recovered from playground store on rehydration — but is set into the SDK store **only** by `useAuth.impersonate()`, which is not called on rehydration. So both fallbacks evaluate to `false`/null.

In effect: after a reload during impersonation, the SDK sends impersonation-JWT requests but believes it is not impersonating. `useAuth.endImpersonation()` then fails to restore the admin token (because the WeakMap entry is gone, `stopImpersonation()` returns `undefined`). The playground's `sdk-provider` then takes over and sets the admin's `accessToken` from the playground store — so the flow *partially* recovers, but only because the playground (insecurely) kept the admin token in localStorage.

If H-1's fix is applied (drop `impersonationToken` from `partialize`), the SDK's behavior post-reload becomes inconsistent with the playground UI (which shows "currently impersonating") for the brief window before the playground re-derives state. A clean fix is to rehydrate the SDK's impersonation state from the playground store on mount.

**Patch sketch (sdk-provider.tsx)**:

```typescript
useEffect(() => {
  if (persistedImpersonating && impersonationToken && accessToken && !apiClient.isImpersonating()) {
    apiClient.startImpersonation(accessToken);
    apiClient.updateAccessToken(impersonationToken);
    setImpersonatedUser(persistedImpersonatedUser);
    setOriginalUser(persistedAdminUser);
  }
}, []);
```

**H-6. `useAuth.startImpersonation`/`stopImpersonation` escape hatches bypass server.**
`useAuth.ts:225-236` exposes low-level proxies to `apiClient.startImpersonation()` and `apiClient.stopImpersonation()`. A consumer can call `useAuth().startImpersonation(arbitraryString)` and the SDK happily stashes it in the WeakMap and proceeds as if impersonation were active locally. There is no server round-trip — the consumer must remember to also `apiClient.updateAccessToken(...)` and somehow obtain an impersonation JWT.

Risk: this is a sharp edge that invites misuse. If a developer wires a "switch user" UX directly to `startImpersonation`, they bypass the backend's role/tenant checks (which only happen on `POST /auth/impersonate`).

**Recommendation**: keep the escape hatches but rename them `__unstable_setImpersonationToken` / `__unstable_clearImpersonationToken` and add explicit warnings in the docstring. Or hide them entirely behind a separate sub-import (`@arcaai/vox/internal/auth`).

### Medium

**M-1. `endImpersonation` does not abort in-flight streams.**
`useAuth.endImpersonation` (`useAuth.ts:198-222`) flips the access token but does not signal any currently-open SSE / WebSocket / WebRTC connection to reconnect. Any in-flight consultation transcription will keep streaming under the impersonation JWT (and survives until the JWT expires on the server side, given C-4 means no real revocation). The `TranscriptionPipeline` / `SttWebSocketClient` should be told to reconnect when the SDK swaps tokens.

**Patch**: emit a typed `auth:tokenChanged` event from `AgenticClient.updateAccessToken` that `SttWebSocketClient`, `SSEClient`, and `PluginManager` subscribe to and trigger a clean reconnect.

**M-2. `impersonatedUser` is `unknown` in the store.**
`packages/agentic-sdk-v2/src/store/agenticStore.ts:93-97`:

```typescript
authUser: unknown;
authImpersonatedUser: unknown;
authOriginalUser: unknown;
```

The `useAuth` hook does a runtime cast `(store.authImpersonatedUser as AuthUser | null) ?? null` (`useAuth.ts:53-55`). Any malformed value written to the store passes type-check but breaks at runtime. This was flagged in TASK-262 (TypeScript strict-mode section) and the impersonation surface is the most-affected consumer.

**M-3. No telemetry on the impersonation lifecycle.**
The SDK only logs at `info`: "Impersonation started", "Impersonation stopped" (`AgenticClient.ts:772-775, 789-793`). There is no:
- Counter of active impersonations per user (for back-pressure / abuse detection).
- Duration of impersonation sessions in the audit trail (the JWT `jti` is unique but stop time is not recorded).
- Per-action audit row that ties an HTTP request to a session id rather than the per-request audit log.

**Recommendation**: add `impersonationSessionStartedAt` / `impersonationSessionEndedAt` audit rows in a new `AuditAction.IMPERSONATION_STARTED` / `IMPERSONATION_STOPPED` enum. These complement (not replace) the per-request rows from C-3's fix.

**M-4. The "Impersonation already active" error is unrecoverable from the SDK side.**
`AgenticClient.startImpersonation` throws when a token is already stashed (`AgenticClient.ts:766-770`). If `useAuth.impersonate` is called twice in rapid succession (e.g. double-clicking the "Start Impersonation" button), the second call will POST to `/auth/impersonate` successfully, then throw on `startImpersonation`. The exception propagates, the in-flight POST has already burned a server resource and audit row, and the access token may already be partially written by the time the error is caught. The playground catches with a generic `toast.error('Failed to impersonate user')` (`user-list.tsx:236-238`) and there is no rollback path.

**Patch**: make `useAuth.impersonate` idempotent — call `apiClient.stopImpersonation()` first if `isImpersonating()`, then proceed. Or guard the button on `isLoading`.

**M-5. Playground takes a `tenantId` from the JWT by decoding without verifying.**
`user-list.tsx:188-196`:

```typescript
const payload = JSON.parse(atob(result.token.split('.')[1]));
if (payload.tenantId) tenantId = payload.tenantId;
```

`atob` does not validate signature; a man-in-the-middle returning a forged response could supply any `tenantId` and the playground would adopt it for cross-tab namespacing. This is mostly hypothetical (HTTPS + same-origin), but the fallback is unnecessary — the server's response already includes `user.tenantId` (`auth.controller.ts:393`). Use that directly and drop the JWT-decode fallback.

**M-6. `IMPERSONATION_ROLES` constant duplicates server-side role list.**
`useAuth.ts:18` defines `['SUPER_ADMIN', 'TENANT_ADMIN']` as the only impersonation-capable client roles, but the server (`auth.controller.ts:313`) recognises `['TENANT_ADMIN', 'admin', 'system-admin']` for tenant-admin equivalents. A user with role `'admin'` will pass the server check but `canImpersonate` will be `false` in the SDK, hiding the impersonation UI. Either align both, or — better — drive `canImpersonate` from a server-returned capability (e.g. `me.capabilities.canImpersonate: true`).

**M-7. `clearOnLogout` does not call `apiClient.stopImpersonation()`.**
`useAuth.logout` does this defensively (`useAuth.ts:102-103`), but `agenticStore.clearOnLogout` (referenced by tests at line 36 of `agenticStore.impersonation.test.ts`) is invoked elsewhere as a generic reset (e.g. on auth errors, on tenant switch). If `clearOnLogout` runs while impersonating, the WeakMap entry leaks until the `AgenticClient` is GC'd. Add `apiClient.stopImpersonation()` to the action.

**M-8. No SSE/WebSocket auth check on impersonation token shape.**
The stream-ticket flow (`AuthController.issueStreamTicket` — `auth.controller.ts:458-485`) issues a ticket bound to `userId` + `tenantId` for the *currently authenticated* user. While impersonating, the authenticated user is the impersonated user — correct. But the ticket payload does **not** carry `impersonatedBy`, so SSE/WebSocket sessions opened via ticket auth lose the impersonation context entirely. Audit interceptor does not fire on the ticket-auth path because there is no `impersonatedBy` claim on `req.user` after ticket consumption (`jwtauth.guard.ts:108`).

Streaming consultations under impersonation therefore produce **no impersonation audit trail** (the ticket-auth path) but the impersonated user appears as the actor on the streamed data. This violates business requirement #11 ("WS/SSE session must be authorized as impersonated user, audit logged with both identities").

**Patch**: include `impersonatedBy` in the `StreamTicket` payload; restore it on `req.user` in `JwtAuthGuard.handleTicketAuth` (`jwtauth.guard.ts:108`).

### Low

**L-1. `useAuth.canImpersonate` is recomputed on every render.**
`useAuth.ts:61` — `user?.roles?.some(...)` runs on every render even when `user` is stable. Wrap in `useMemo`.

**L-2. `authService.trackAuthentication` from inside `impersonate` claims `endpoint: '/auth/impersonate'` — correct, but it does not record the *target* user.**
`auth.controller.ts:380-385` only passes `adminUser.id`. The impersonation event has no separate "started impersonating <X>" audit row distinct from the per-request rows. Use a dedicated event type for impersonation start.

**L-3. `revoke-impersonation` does not require the impersonation JWT specifically.**
`auth.controller.ts:487-506` accepts any authenticated request. If an admin's regular JWT is sent (not the impersonation JWT), the endpoint still returns `success: true`, even though there is nothing to revoke. Defensive check: `if (!user.impersonatedBy) throw new BadRequestException('Not currently impersonating')`.

**L-4. The 15-minute TTL is hard-coded as a string in `AppSettingsService`.**
`auth.controller.ts:362` — `JWT_IMPERSONATION_EXPIRES_IN` defaults to `'15m'`. There is no validation that the value parses as a valid `jsonwebtoken` `expiresIn` string. A misconfigured tenant setting (`'15 minutes'`, etc.) will throw at JWT mint time at the worst possible moment. Validate and clamp on read.

**L-5. `ImpersonateUserResponse` includes `roles` and `permissions` of the target.**
`auth.controller.ts:387-394` returns the target's full role + permission set to the admin's browser. This is necessary for the SDK to know what the impersonated session can do, but it widens the data surface of `/auth/impersonate`'s 200 response. If an attacker exfiltrates the response, they learn the target's privileges. Consider filtering to a minimal set.

**L-6. `clearAccessToken()` does not also clear the impersonation token.**
`AgenticClient.clearAccessToken` (`AgenticClient.ts:671-677`) nulls only `this.accessToken`. The WeakMap entry remains. Consumers expecting `clearAccessToken` to imply a clean state will leave a dangling admin token in memory until the next `stopImpersonation()` or GC. Documenting this is sufficient; alternatively, have `clearAccessToken` also `stopImpersonation()`.

---

## 6. Security findings

| ID | Finding | Severity | File:line |
|---|---|---|---|
| SEC-J | `x-tenant-id` header overrides JWT tenant claim | **Critical (unfixed)** | `apps/api/src/interceptors/context.interceptor.ts:57-60` + `packages/applications/src/services/auth/jwt.strategy.ts:25-41` |
| SEC-A5-1 | Tenant admin can impersonate cross-tenant (no tenant check) | Critical | `apps/api/src/modules/auth/auth.controller.ts:312-342` |
| SEC-A5-2 | `revoke-impersonation` is not a real revocation; JWT replay possible for full 15m TTL | Critical | `apps/api/src/modules/auth/auth.controller.ts:487-506` |
| SEC-A5-3 | Audit log loses impersonated-subject identity | Critical (compliance) | `packages/applications/src/services/auditLog/auditLog.service.ts:204-244` |
| SEC-A5-4 | Playground stores `impersonationToken` + admin `accessToken` in `localStorage` under `arcavox.auth` | High | `apps/ui-playground/src/store/auth-store.ts:104-146` |
| SEC-A5-5 | Cross-tab impersonation leakage via `localStorage` rehydration in sibling tabs | High | `apps/ui-playground/src/store/__tests__/auth-store.impersonation-persistence.test.ts` (designed-in) |
| SEC-A5-6 | Stream tickets (SSE) shed the `impersonatedBy` claim → impersonated streams unaudited | High | `apps/api/src/guards/jwtauth.guard.ts:67-110` + `apps/api/src/modules/auth/stream-ticket.service.ts` |
| SEC-A5-7 | `PersonalizationManager` writes through to backend/localStorage during impersonation | High | `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:99-166` |
| SEC-A5-8 | Impersonation JWT decoded via `atob` without signature verification on the client | Medium | `apps/ui-playground/src/features/playground/overview/components/user-list.tsx:190-196` |
| SEC-A5-9 | Backend mints impersonation JWT for an arbitrary `userRoleAssignment.tenantId` | Medium | `apps/api/src/modules/auth/auth.controller.ts:346-355` |
| SEC-A5-10 | `useAuth.startImpersonation` escape hatch bypasses server check | Medium | `packages/agentic-sdk-v2/src/hooks/useAuth.ts:225-231` |

### Status of the two predecessor security gates

| Gate | Predecessor finding | Verdict |
|---|---|---|
| **W0-3 (SEC-D)** Impersonation token in Zustand store | TASK-262 SEC-4 | **CLOSED for the SDK**. Admin JWT lives in `WeakMap<AgenticClient, string>` (`AgenticClient.ts:30`). Verified by `AgenticClient.impersonation.test.ts:77-103` and `agenticStore.impersonation.test.ts:15-18`. **But the same vulnerability shape persists in `apps/ui-playground/src/store/auth-store.ts` for both admin and impersonation tokens** — this is a *playground-level* defect (SEC-A5-4), not an SDK-level one, and the original SEC-D was scoped to the SDK store, so W0-3 is technically closed but the spirit of the protection is partially undone by the consuming app. |
| **SEC-J** `x-tenant-id` header overrides JWT tenant claim | TASK-262 `08-api-cross-reference.md` §3.4 | **NOT CLOSED**. Confirmed open: `ContextInterceptor` still writes the request header into CLS `tenantId` unconditionally; `JwtStrategy.validate` never sets CLS `tenantId`. This is a horizontal-privilege-escalation risk that is amplified during impersonation. |

---

## 7. Performance findings

**P-1. `useAuth.isImpersonating` reads `apiClient?.isImpersonating()` on every render.**
`useAuth.ts:60` — `apiClient.isImpersonating()` is a WeakMap.has call, cheap, but the resulting boolean is fed into a `useMemo` deps array (line 245). Because each render computes a fresh boolean, the memo recomputes only when the value actually flips, which is correct. No real cost. (Documenting because the pattern is unusual.)

**P-2. Per-request audit-log write fires synchronously in the request `tap` chain.**
`ImpersonationAuditInterceptor` (`impersonation-audit.interceptor.ts:48-66`) calls `eventEmitter.emit` from `tap.next`, which is synchronous for `@nestjs/event-emitter` (the default emitter has sync handlers unless `async: true` is configured). `AuditLogService.handleUserAuthenticatedEvent` then performs a Prisma INSERT (`auditLog.service.ts:229`). For a busy admin under impersonation, this serialises one audit-log INSERT on the request path of every request. On a 200ms-budget endpoint, a slow audit DB will inflate p99. Consider routing the impersonation audit through the same Redis queue used for CRUD audit events.

**P-3. `AgenticProvider` re-syncs `accessToken` on every render** (already cited in TASK-262 P-3) — under impersonation this code path is gated by `authImpersonatedUser !== null` (`AgenticProvider.tsx:396-406`), so an extra getter call runs on each render but no write. No measurable cost.

**P-4. `AuthController.impersonate` does up to 5 Prisma queries per call** (admin roles, target user, target roles, target permissions, target's first tenant assignment). For a server-side endpoint called rarely (start of impersonation) this is acceptable but the queries are sequential. `Promise.all` for the independent ones is a trivial win.

---

## 8. Test coverage gaps

| Area | Test present | Missing |
|---|---|---|
| SDK `AgenticClient.startImpersonation` / `stopImpersonation` | `AgenticClient.impersonation.test.ts` (7 tests) | Page-reload rehydration path (H-5); concurrent `startImpersonation` from two threads (theoretical, low risk) |
| SDK `useAuth.impersonate` / `endImpersonation` | `useAuth.task224.test.ts`, `useAuth.task225.test.ts` | Double-click idempotency (M-4); server-error path on `/auth/revoke-impersonation` + token still cleared; consumer expectations after `endImpersonation()` when no original user was stored |
| SDK `ConfigManager` impersonation lifecycle | `impersonation-config.test.ts` (5 tests) | None — fully covered for `ConfigManager` |
| SDK `PersonalizationManager` impersonation isolation | **None** | H-4 is uncovered — no test exists for personalization-during-impersonation |
| Backend `AuthController.impersonate` role gate | `auth.controller.task224.test.ts` (6 tests covering SUPER_ADMIN→TENANT_ADMIN, TENANT_ADMIN→TENANT_ADMIN reject, etc.) | **C-1: TENANT_ADMIN→cross-tenant non-admin user** (the core business-rule test) is missing; no test verifies the `tenantAssignment` resolution chooses correctly when target has multiple tenants |
| Backend `ImpersonationAuditInterceptor` | `impersonation-audit.interceptor.test.ts` (6+ tests) | None for the interceptor itself; **but** no end-to-end test that asserts the resulting audit-log row contains both `responsibleUserId` and `impersonatedUserId` (because the handler drops the latter — C-3) |
| Backend `revoke-impersonation` | `auth.controller.task224.test.ts` (3 tests on the endpoint surface) | No test that the *token continues to be valid* after revoke (would prove C-4); no test that revoke without active impersonation rejects (L-3) |
| Backend `JwtStrategy.validate` tenant propagation | `jwt.strategy.test.ts` exists | **No test** that `clsService.get('tenantId')` after a JWT request equals `payload.tenantId` — would catch SEC-J |
| Backend `ContextInterceptor` header override | `context.interceptor.test.ts` exists | No test that a non-matching `x-tenant-id` header is rejected or warned; current tests probably verify the buggy override behavior |
| Playground `UserList` impersonate / endImpersonate flow | none in scope of this review | UI integration test that the table refreshes scope after impersonation; that cross-tab observation works as expected |
| Playground `auth-store` rehydration with stale impersonation token | `auth-store.impersonation-persistence.test.ts` (cements the behavior) | This test should be **inverted** to assert the token is NOT persisted (per H-1's recommended fix), once policy is decided |

---

## 9. Conformance to the business requirement

### 9.1 Global admin can impersonate any user — VERDICT: **PASS WITH CAVEATS**

- Code: `auth.controller.ts:312-316, 336-338` — SUPER_ADMIN passes both gates as long as target ≠ SUPER_ADMIN.
- Test evidence: `auth.controller.task224.test.ts:264-302` ("should reject SUPER_ADMIN impersonating another SUPER_ADMIN") and `304-349` (allow SUPER_ADMIN→TENANT_ADMIN).
- **Caveat**: the global admin's impersonation JWT is scoped to the target user's *first* tenant assignment (H-3). A global admin cannot consciously choose which tenant context the impersonation runs in, which is a usability constraint but not a security failure.

### 9.2 Tenant admin scoped to own tenant — VERDICT: **FAIL**

- Code: `auth.controller.ts:340-342` only blocks tenant-admin→tenant-admin. No check that `target.tenantId === adminUser.tenantId`. This is **C-1**.
- Test evidence: `auth.controller.task224.test.ts:351-389, 391-429` cover TENANT_ADMIN→TENANT_ADMIN and TENANT_ADMIN→SUPER_ADMIN rejection but **do not** cover TENANT_ADMIN→non-admin in another tenant.
- **Fix required before this requirement can be marked Met.** See C-1 patch.

### 9.3 Token stored securely (W0-3 closed?) — VERDICT: **CLOSED for SDK, OPEN for playground**

- SDK side: **CLOSED**. `WeakMap` (`AgenticClient.ts:30`); explicit tests at `AgenticClient.impersonation.test.ts:77-103` and `agenticStore.impersonation.test.ts:15-18`.
- Playground side: **OPEN**. `apps/ui-playground/src/store/auth-store.ts:129-146` persists both `accessToken` (admin) and `impersonationToken` (scoped) to `localStorage` under `arcavox.auth`. Persistence-test `auth-store.impersonation-persistence.test.ts:43-54` *codifies* the leak. Same vulnerability class as TASK-262 SEC-D, only moved to the app layer.

### 9.4 Audit log captures both actor and subject — VERDICT: **FAIL**

- The audit emit pipeline is wired (`ImpersonationAuditInterceptor`), but the audit-log writer drops the subject (C-3, `auditLog.service.ts:208-228`). The audit row records only the admin id as both `responsibleUserId` and `resourceId`, with no record of which user was being impersonated and no record of which endpoint was hit. The information is in the event payload but discarded at the persistence boundary.
- Additionally, SSE/WebSocket sessions opened via stream tickets drop `impersonatedBy` entirely (H-8 / SEC-A5-6), so the live audio path is **unaudited under impersonation**.
- Fix required: extend `handleUserAuthenticatedEvent` to persist `impersonatedUserId` and `endpoint`; extend `StreamTicket` to carry `impersonatedBy`.

### 9.5 Personalization + voice + pipeline reflect impersonated user — VERDICT: **PARTIAL PASS**

- **ConfigManager (audio config, A1+A4)**: PASS. TASK-245 implemented snapshot + read-only + `loadExternalPreferences` (`user-list.tsx:200-232`; tests in `impersonation-config.test.ts`). The impersonated user's audio settings load; edits stay in-memory; admin prefs restore on stop.
- **PersonalizationManager (prompt-template overlays, A1)**: FAIL. H-4 — no read-only gate. Any `useArcaConfig.updatePreference(...)` during impersonation writes through to the admin's local IndexedDB **and** POSTs to backend as the impersonated user. Tests for this path are absent.
- **Voice enrollment (A2)**: out of scope here, but: the impersonation JWT is sent as the bearer on all `/voice-profile/*` calls, so backend enrollment correctly attributes to the impersonated user. The local voice-sample IndexedDB cache, however, is per-origin not per-user — admin's cached voice sample bleeds into the impersonated session unless the consumer clears it. Cross-link to A2's review.
- **Pipeline selection (A4)**: PASS in principle. The pipeline definition is fetched via `usePipelines` using the impersonation token, so the impersonated user sees their own pipelines. Subject to ConfigManager isolation working (which it does).

---

## 10. Recommended fixes (P0/P1/P2)

### P0 — must ship before next release

| ID | Action | Effort | Owner |
|---|---|---|---|
| P0-1 | **Enforce TENANT_ADMIN tenant scope on `/auth/impersonate`** (C-1). Add `adminUser.tenantId === resolvedTenantId` check; throw 403 otherwise. Add RED test for TENANT_ADMIN(A)→DOCTOR(B). | S | backend |
| P0-2 | **Close SEC-J end-to-end** (C-2). Set CLS `tenantId` from JWT in `JwtStrategy.validate`; remove/gate the `x-tenant-id` override in `ContextInterceptor`; add tests on both paths. | M | backend |
| P0-3 | **Persist `impersonatedUserId` + `endpoint` on the audit row** (C-3). Add `AuditAction.IMPERSONATED_ACTION` (or equivalent discriminator). Extend `auditLog.service.handleUserAuthenticatedEvent`. | S | backend |
| P0-4 | **Implement real token revocation** (C-4). Maintain Redis revoked-`jti` set with TTL = original `exp`; check in `JwtStrategy.validate`. | M | backend + ops |
| P0-5 | **Carry `impersonatedBy` on stream tickets** (SEC-A5-6 / M-8). Add to `StreamTicket` payload; rehydrate on `req.user` in `JwtAuthGuard.handleTicketAuth`. | S | backend |

### P1 — should ship in the next minor

| ID | Action | Effort | Owner |
|---|---|---|---|
| P1-1 | **Add `PersonalizationManager.setImpersonationReadOnly()`** (H-4); wire from `useAuth.impersonate` / `endImpersonation`. Add tests mirroring `impersonation-config.test.ts`. | S | SDK |
| P1-2 | **Move playground tokens off `localStorage`** (H-1 / SEC-A5-4). Drop `accessToken` + `impersonationToken` from `partialize`; switch to `sessionStorage` for per-tab persistence; invert the existing rehydration test. | M | playground |
| P1-3 | **Rehydrate SDK impersonation state from playground store on mount** (H-5). Add a `useEffect` in `sdk-provider.tsx` that calls `apiClient.startImpersonation(adminToken)` + `setImpersonatedUser(...)` when rehydration recovers an impersonation session. | S | playground/SDK |
| P1-4 | **Propagate `impersonatedBy` through `UserSession`** (H-2). Add the field to the DTO and copy in `JwtStrategy.validate`. | S | applications |
| P1-5 | **Accept `targetTenantId` on `/auth/impersonate`** (H-3); validate against target's enabled assignments; require equality with admin's tenant for TENANT_ADMIN. | S | backend |
| P1-6 | **Hide low-level `startImpersonation`/`stopImpersonation` on `useAuth`** (H-6); rename to `__unstable_*` or move behind `@arcaai/vox/internal/auth`. | XS | SDK |
| P1-7 | **`endImpersonation` triggers transport reconnect** (M-1). Add `auth:tokenChanged` event; subscribers reconnect cleanly. | M | SDK |

### P2 — opportunistic / nice to have

| ID | Action | Effort | Owner |
|---|---|---|---|
| P2-1 | Tighten audit emission to async queue (P-2). | S | backend |
| P2-2 | Add `IMPERSONATION_STARTED` / `IMPERSONATION_STOPPED` audit rows (M-3). | S | backend |
| P2-3 | Idempotent `useAuth.impersonate` (M-4): stop existing session before starting a new one. | XS | SDK |
| P2-4 | Type `authImpersonatedUser` / `authOriginalUser` strictly (M-2). | S | SDK |
| P2-5 | Use `user.tenantId` from response directly; drop client-side `atob` JWT decode (M-5). | XS | playground |
| P2-6 | Align `IMPERSONATION_ROLES` with backend or drive from `me.capabilities` (M-6). | S | both |
| P2-7 | `clearOnLogout` should `stopImpersonation` (M-7). | XS | SDK |
| P2-8 | `revoke-impersonation` requires active impersonation (L-3). | XS | backend |
| P2-9 | Validate `JWT_IMPERSONATION_EXPIRES_IN` setting at startup (L-4). | XS | backend |
| P2-10 | `useAuth.canImpersonate` memoization (L-1). | XS | SDK |

---

## 11. Scorecard

| Dimension | Grade | Notes |
|---|:---:|---|
| Architecture | B | Clear separation between SDK token storage (WeakMap), store state (UI-cue), and backend grant. Single source of truth on `apiClient`. |
| Correctness | C− | Page-reload + endImpersonation interaction is fragile (H-5); `PersonalizationManager` not isolated (H-4); per-request audit row is malformed (C-3); transport reconnect missing on token swap (M-1). |
| Security | D | **Two critical regressions / unfixed gates**: tenant-admin tenant-scope not enforced (C-1) and SEC-J still open. No real token revocation (C-4). Playground keeps tokens in `localStorage` (H-1). Streaming under impersonation is unaudited (M-8). |
| Performance | B+ | Sync audit on hot path (P-2) and 5-query impersonate endpoint (P-4) are the only material findings; both small. |
| Test coverage | C+ | SDK side well covered (W0-3 + ConfigManager lifecycle). Backend side has the critical role-gate tests but **misses the most important one** (TENANT_ADMIN cross-tenant non-admin). Audit-log persistence isn't tested end-to-end. SEC-J has no failing test. |
| Conformance to requirement | C− | Reqs 1, 3, 6 — Pass. Req 2 — **Fail** (C-1). Req 4 — **Fail** (C-3 + M-8). Req 5 — Pass in SDK / **Fail** in playground (H-1). Req 7 — implicit cross-tab leak via localStorage. Req 8 — **Partial** (ConfigManager yes, PersonalizationManager no). |
| **Overall** | **C−** | Foundation is sound; W0-3 is closed for the SDK. But two structural security holes (C-1, SEC-J) plus the audit-log subject loss (C-3) mean the feature is **not production-safe** for tenant admins or HIPAA audit purposes today. |

---

## Appendix A — Files reviewed (with line anchors)

| File | Anchors |
|---|---|
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | 30, 132-149, 663-717, 742-802 |
| `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.impersonation.test.ts` | full |
| `packages/agentic-sdk-v2/src/core/__tests__/impersonation-config.test.ts` | full |
| `packages/agentic-sdk-v2/src/hooks/useAuth.ts` | 18, 48-274 |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | 92-97, 184-186, 269-273, 408-415, 425-435, 472-485 |
| `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.impersonation.test.ts` | full |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | 378-415 |
| `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts` | 90-173 |
| `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts` | 1-30, 170-200 |
| `packages/agentic-sdk-v2/src/core/constants.ts` | 371-376 |
| `apps/api/src/modules/auth/auth.controller.ts` | 290-401, 487-506 |
| `apps/api/src/modules/auth/dto/impersonate.dto.ts` | full |
| `apps/api/src/interceptors/impersonation-audit.interceptor.ts` | full |
| `apps/api/src/interceptors/__tests__/impersonation-audit.interceptor.test.ts` | full |
| `apps/api/src/interceptors/context.interceptor.ts` | 32-103 |
| `apps/api/src/guards/jwtauth.guard.ts` | 35-110 |
| `packages/applications/src/services/auth/jwt.strategy.ts` | full |
| `packages/applications/src/services/auditLog/auditLog.service.ts` | 195-244 |
| `packages/applications/src/common/base.service.ts` | 23-90 |
| `apps/ui-playground/src/store/auth-store.ts` | full |
| `apps/ui-playground/src/providers/sdk-provider.tsx` | full |
| `apps/ui-playground/src/features/playground/overview/components/user-list.tsx` | 30-264 |
| `apps/ui-playground/src/features/summarization/components/impersonation-guard.tsx` | full |
| `apps/ui-playground/src/store/__tests__/auth-store.impersonation-persistence.test.ts` | full |
| `apps/ui-playground/src/store/__tests__/auth-store.impersonation-tenant.test.ts` | full |

