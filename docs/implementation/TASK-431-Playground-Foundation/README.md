# TASK-431 — Admin Console Playground Foundation (tier 50–59 shell)

- **Status**: Completed
- **Type**: feature — shared foundation for the Playground tier inside `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 (design gate approved 2026-07-06); sibling screen tickets TASK-432…TASK-436

## Requirement Analysis

TASK-420's frames 50–59 were approved on 2026-07-06. The five playground screens are built in parallel (TASK-432…436); everything they share must land first in ONE place so the parallel agents never touch the same files:

1. **Route group** `src/app/(console)/(playground)/` with a tier guard layout (GLOBAL_ADMIN or TENANT_ADMIN → else `notFound()`, matching the `(tenant)` posture). Screens mount at `/playground/*`.
2. **Sidebar tier** — extend `NavTier` with `'50-59'`, add the `Playground` section and the five entries (unique icons, `implemented: true`; ability gate `required: []` = any authenticated user, because playground planes are end-user planes run under the admin's own account; the route-group layout still 404s non-admins). Update `nav-config.test.ts` counts.
3. **Session tenant id** — the STT WS tenant-claim guard (TASK-320 B5) requires `tenantId` on the WS URL. Elevated admins use `workingTenantId`; tenant-bound admins need their own tenant id, which the gateway login response already carries but the BFF session drops. Add `user.tenantId` to `SessionPayload`/`SafeSession` (non-secret).
4. **`@arcaai/vox` dependency** — add to `apps/admin-console/package.json` (prebuilt dist; NOT added to `transpilePackages`).
5. **SDK WS-origin fix** — `StreamingSessionManager.getWebSocketUrl()` derives the WS origin from `apiClient.getBaseUrl()`. In the console the SDK's `baseUrl` is the BFF proxy (`<origin>/api/hope`) so REST rides the encrypted session cookie, but the WS must hit the gateway (`NEXT_PUBLIC_API_HOST`). Honor `ApiConfig.wsUrl` when set (TDD in `packages/agentic-sdk-v2`).

### Playground SDK auth architecture (decision, applies to TASK-432/433)

- SDK REST → `baseUrl = <console origin>/api/hope` (BFF attaches `Authorization` + `X-Tenant-Id` server-side; SDK gets NO `accessToken`/`apiKey`; `autoWireTokenRefresh: false` — the BFF proxy owns 401 recovery).
- SDK `tenantId` config → `workingTenantId ?? session.user.tenantId` (drives the WS `tenantId=` claim; the BFF strips any client `X-Tenant-ID` header and re-applies its own, so no spoofing surface).
- WS → direct to gateway: `config.api.wsUrl = NEXT_PUBLIC_API_HOST` (requires fix 5).
- SSE panes → prefer the console's `useEventStream` (tickets minted via `/api/auth/stream-ticket`, EventSource direct to gateway). SDK-internal SSE (job hooks) rides the BFF proxy pass-through.

## Current State Evaluation

- `src/app/(console)/` has `(global)`, `(shared)`, `(tenant)` groups only; `NavTier = '10-19' | '20-29' | '30-49'`; 29 nav entries (see `nav-config.test.ts`).
- `SessionUser` = `{ id, username, email, roles, permissions? }` — no `tenantId`; `GatewayLoginResponse.user.tenantId` already typed in `api/auth/login/route.ts` but unmapped.
- `@arcaai/vox` absent from admin-console deps. `getWebSocketUrl()` (packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:148-181) ignores `config.wsUrl`.

## Implementation Plan

1. **vox fix (TDD)**: failing test — `wsUrl` host ≠ `baseUrl` host → URL must use `wsUrl` origin (http→ws / https→wss). Fix `getWebSocketUrl()`; `pnpm --filter @arcaai/vox test build`.
2. **Nav**: extend `NavTier`/`NAV_SECTIONS`/`NAV_ENTRIES`; update `nav-config.test.ts` (34 entries, 4 sections, 5 × tier 50-59).
3. **Route group**: `(playground)/layout.tsx` guard + tests colocated with the nav test updates.
4. **Session**: `tenantId?` on `SessionUser` + `SafeSession` + `toSafeSession` + login mapping (existing sessions simply lack it until re-login; consumers must tolerate `undefined`).
5. **Dependency**: add `@arcaai/vox: workspace:*`, `pnpm install`.
6. Verify: `pnpm --filter @arcaai/admin-console test lint`; screens land via TASK-432…436.

## Implementation Summary

All five foundation pieces landed 2026-07-06 (TDD where behavior changed):

| Change | Files |
|---|---|
| SDK WS-origin fix — `ApiConfig.wsUrl` origin wins over `baseUrl` in `getWebSocketUrl()` (https/wss → wss, http/ws → ws); new `AgenticClient.getWsUrl()` | `packages/agentic-sdk-v2/src/core/AgenticClient.ts`, `core/StreamingSessionManager.ts`, `core/__tests__/StreamingSessionManager.test.ts` (2 new tests, RED→GREEN) |
| Nav tier `'50-59'` + `Playground` section + 5 entries (`IconHeartbeat/IconBroadcast/IconUserScan/IconDna2/IconSparkles`, `required: []`); `visibleNavEntries(rules, roles?)` role-gates tier 50-59 (GLOBAL_ADMIN or TENANT_ADMIN) | `src/shared/navigation/nav-config.ts`, `__tests__/nav-config.test.ts` (34 entries / 4 sections; 2 new cases) |
| Sidebar passes session roles | `src/shared/layout/app-sidebar.tsx`, `__tests__/app-sidebar.test.tsx` (fetch stub now routes session vs permissions) |
| `(playground)` route-group guard (GLOBAL_ADMIN or TENANT_ADMIN, else `notFound()`) | `src/app/(console)/(playground)/layout.tsx` |
| Session home-tenant plumb-through: `SessionUser.tenantId?`, `SafeSession.user.tenantId: string \| null`, login mapping | `src/server/session.ts`, `src/server/safe-user.ts`, `src/app/api/auth/login/route.ts`, account test fixture |
| Deps: `@arcaai/vox`, `@arcaai/stt`, `@arcaai/room` (all prebuilt dist — NOT in `transpilePackages`) | `apps/admin-console/package.json` |

**Evidence**: `@arcaai/vox` 3496/3496 tests green; `@arcaai/admin-console` 584/584 tests green, `lint` 0 errors, `check-types` clean. Pre-existing vox prettier warnings (71) verified identical on HEAD before the change.

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 plan step 3 (post-approval split). |
| 2026-07-06 | Implemented + verified (see summary). Status → Completed. Screen tickets TASK-432…436 unblocked. |
