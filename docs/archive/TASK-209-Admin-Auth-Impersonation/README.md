# TASK-209: Admin Auth & User Impersonation for SDK Example Apps

- **Ticket Number**: TASK-209
- **Created Date**: 2026-02-21
- **Last Updated**: 2026-02-21
- **Status**: Completed

## Requirement Analysis

Both SDK example apps (Vite and Next.js) lacked authentication gates and user impersonation capabilities. The apps were fully open with API key-based access only, making it difficult to demonstrate user-specific features like preferences, transcriptions, DNA writing style, and summarization for different users.

### Business Context

- Administrators need to log in to the example apps to manage and demonstrate features
- For demonstrations, admins need to impersonate non-admin users to show user-specific workflows
- The impersonation session must be clearly indicated in the UI to avoid confusion

### Acceptance Criteria

1. Example apps require authentication (API key or admin login) before accessing any page
2. Admin login via username/password uses the existing `/api/auth/login` endpoint
3. Admins can impersonate non-admin users via a token-swap mechanism
4. Impersonation panel is available on the Setup & Config page (visible only to JWT-authenticated admins)
5. An amber banner in the navigation header indicates active impersonation sessions
6. Impersonation can be ended at any time, restoring the admin session
7. Admin users cannot be impersonated (security constraint)

## Current State Evaluation

### Before Implementation

- No authentication gate on either example app
- API key configured via environment variables or runtime settings panel
- No user session management or login UI
- No impersonation capability
- SDK provided `useAuth()` hook but it was unused in example apps

### Related Components

- Backend: `apps/api/src/modules/auth/auth.controller.ts` (login, logout, me endpoints)
- SDK: `packages/agentic-sdk-v2/src/hooks/useAuth.ts`, `useUsers.ts`
- Vite app: `packages/agentic-sdk-v2/examples/vite-app/`
- Next.js app: `packages/agentic-sdk-v2/examples/nextjs-app/`

## Implementation Plan

### Architecture

1. **Backend**: Add `POST /auth/impersonate` endpoint (admin-only, token-swap)
2. **SDK**: Extend `useAuth` hook with `impersonate()` and `endImpersonation()`
3. **Example Apps**: Add login gate, impersonation panel, and header indicator

## Implementation Summary

### Backend Changes

**New files:**
- `apps/api/src/modules/auth/dto/impersonate.dto.ts` - Request/response DTOs for impersonation

**Modified files:**
- `apps/api/src/modules/auth/auth.controller.ts` - Added `POST /auth/impersonate` endpoint
- `apps/api/src/modules/auth/dto/index.ts` - Re-exported new DTOs

The impersonate endpoint:
- Requires JWT authentication (JwtAuthGuard)
- Validates caller has admin role (SUPER_ADMIN, TENANT_ADMIN, admin, system-admin)
- Rejects impersonation of admin users
- Generates a scoped JWT for the target user with `impersonate-{adminId}-{targetId}` JTI
- Tracks the impersonation event via authService

### SDK Changes

**Modified files:**
- `packages/agentic-sdk-v2/src/types/auth.ts` - Added `ImpersonateRequest`, `ImpersonateResponse` types
- `packages/agentic-sdk-v2/src/core/constants.ts` - Added `AUTH_ENDPOINTS.IMPERSONATE`
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` - Added impersonation state fields (`authImpersonatedUser`, `authOriginalToken`, `authOriginalUser`)
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts` - Added `getCurrentApiKey()` method
- `packages/agentic-sdk-v2/src/hooks/useAuth.ts` - Added `impersonate()`, `endImpersonation()`, `impersonatedUser`, `isImpersonating`
- `packages/agentic-sdk-v2/src/core.ts` - Exported `AuthUser`, `LoginResponse`, `ImpersonateResponse` types

### Vite App Changes

**New files:**
- `examples/vite-app/src/lib/auth-store.ts` - Session storage-backed auth state (authMode, adminUser, jwtToken)
- `examples/vite-app/src/components/login-gate.tsx` - Login screen with API Key and Admin Login tabs

**Modified files:**
- `examples/vite-app/src/App.tsx` - Wrapped app content with `LoginGate`, extracted `AppContent` component
- `examples/vite-app/src/components/navigation.tsx` - Added `AuthStatusBadge`, `ImpersonationBanner` components
- `examples/vite-app/src/pages/setup.tsx` - Added `ImpersonationCard` at top of setup page

### Next.js App Changes

**New files:**
- `examples/nextjs-app/src/lib/auth-store.ts` - SSR-safe session storage-backed auth state
- `examples/nextjs-app/src/components/login-gate.tsx` - Client-side login screen
- `examples/nextjs-app/src/components/app-shell.tsx` - Dynamic import wrapper for LoginGate (SSR-safe)

**Modified files:**
- `examples/nextjs-app/src/app/layout.tsx` - Added `AppShell` wrapper around children
- `examples/nextjs-app/src/components/navigation.tsx` - Added `AuthStatusBadge`, `ImpersonationBanner` components
- `examples/nextjs-app/src/app/setup/_content.tsx` - Added `ImpersonationCard` at top of setup page

### Key Design Decisions

1. **Login Gate outside AgenticProvider**: The login gate sits outside the SDK provider so API key/token can be configured before the SDK initializes
2. **sessionStorage over localStorage**: Auth sessions use sessionStorage (cleared on tab close) for security
3. **Token-swap impersonation**: Admin gets a scoped JWT for the target user, enabling full SDK functionality as that user
4. **Original token preservation**: The admin's JWT is preserved in the SDK store (memory only) so it can be restored when ending impersonation
5. **Dynamic import for Next.js**: LoginGate uses `next/dynamic` with `ssr: false` since it accesses browser APIs

### Security Considerations

- Impersonation endpoint requires JWT auth and admin role verification
- Admin users cannot be impersonated (prevents privilege escalation)
- Scoped tokens include identifiable JTI (`impersonate-{adminId}-{targetId}-{timestamp}`) for audit trail
- Auth session stored in sessionStorage (not persisted across browser sessions)
- Original admin token kept in memory only (not persisted to storage)
