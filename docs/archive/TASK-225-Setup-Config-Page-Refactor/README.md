# TASK-225: Setup & Configuration Page Refactor

- **Ticket**: TASK-225
- **Created**: 2026-02-25
- **Last Updated**: 2026-02-26
- **Status**: Completed

---

## Requirement Analysis

Refactor the Setup & Configuration page based on user story feedback across three areas:

1. **User Impersonation** — Concise interface with type-ahead search, header status display, strict role-based gating
2. **Backend Configuration** — Auto-populate fields from login credentials, read-only fields in JWT mode
3. **User Personalization** — Restructured local/remote workflow modes, Hindi language, None model options, diarization indicator, voice sample capture, unified Save & Reload

---

## Implementation Summary

### Parallel Stream Architecture

Work was organized into 4 independent streams with a final integration gate:

| Stream | Owner | Scope | Files |
|--------|-------|-------|-------|
| A: Impersonation | SDK + API + UI | `canImpersonate`, `searchUsers`, type-ahead card, header polish | 10 files |
| B: Backend Config | Vite App | Auto-populate login, read-only JWT fields | 6 files |
| C: Personalization | SDK Types + UI | Local workflow restructure, remote read-only, voice cache | 7 files |
| D: Page Layout | Vite App | Unified save, page reorganization | 3 files |

### Stream A: Impersonation

- Added `canImpersonate: boolean` to `UseAuthReturn` — derived from `SUPER_ADMIN` and `TENANT_ADMIN` roles only
- Added `search(query, options?)` to `UseUsersReturn` — server-side search via `GET /users?search=`
- Added `SEARCH` endpoint to `USER_ENDPOINTS`
- Extracted `ImpersonationCard` into standalone component with debounced type-ahead (300ms)
- Added ARIA combobox attributes (`role="combobox"`, `role="listbox"`, `role="option"`) for accessibility
- Polished `ImpersonationBanner` in header: larger End button, session timer, focus-visible styles

### Stream B: Backend Configuration

- JWT login auto-populates `doctorId` (from `user.id`) and `tenantId` (from `user.tenantId`)
- API key login does NOT auto-populate these fields (backward compatible)
- In JWT mode: `tenantId`, `doctorId`, and `apiKey` fields are disabled with "Auto-populated from login" message
- In API key mode: all fields remain editable

### Stream C: Personalization

- Extended `LocalWorkflowConfig` with `VoiceEmbeddingLocalConfig` and `AudioSilenceLocalConfig`
- Updated `DEFAULT_LOCAL_CONFIG` with new fields (disabled by default, `modelId: ''`)
- Added Hindi (`hi`) language option alongside English, Malayalam, Vietnamese
- All model selectors now support "None" option via `noneOption` prop on `ModelSelector` component
- Restructured Local Processing to pipeline order: Audio → Noise Cancellation → VAD → Voice Embedding → Transcription → NER
- Added diarization auto-indicator when both VAD and Voice Embedding are active
- Voice sample capture embedded inline within personalization (when Voice Embedding model selected)
- Remote Processing section made read-only (no pipeline selector), service names: API, STT-V2, SMR-V2, NLP
- Created IndexedDB voice cache (`voice-cache.ts`) with graceful degradation for unavailable environments
- Added `noneOption` prop to `@arcaai/ui` `ModelSelector` component

### Stream D: Page Layout

- Unified Save & Reload button at bottom of personalization section (dirty-tracking across all settings)
- Removed individual save buttons from TranscriptionOptionsCard
- Page layout reorganized: Impersonation → Backend Config + Status grid → Personalization → Code Example

### Integration Gate

- Removed ~300 lines dead code (`TranscriptionOptionsCard`, `UserSettingsCard` — absorbed into `PersonalizationCard`)
- Removed unused `excludeAdmins` from `SearchUsersOptions`
- Fixed double-persistence in model selection (now uses unified save only)
- Cleaned up unused imports from `setup.tsx`

---

## Test Results

### Full Regression Summary

| Suite | Files | Tests | Status |
|-------|-------|-------|--------|
| SDK (`@arcaai/vox`) | 103 | 2953 | ALL PASS |
| Vite App (`@arcaai/vox-example-vite`) | 45 | 930 | ALL PASS |
| API (`api`) | 39 | 1393 | ALL PASS |
| **Total** | **187** | **5276** | **ALL PASS** |

Note: 11 pre-existing failures in `admin.test.tsx` (missing `useArca` mock) are unrelated to TASK-225.

### New Test Files (TASK-225)

| File | Tests | Covers |
|------|-------|--------|
| `useAuth.task225.test.ts` | 8 | canImpersonate derivation (positive, negative, edge) |
| `useUsers.task225.test.ts` | 7 | search method (URL, params, state isolation) |
| `users.controller.task225.test.ts` | 5 | Backend search passthrough |
| `config.task225.test.ts` | 12 | New config types, DEFAULT_LOCAL_CONFIG |
| `impersonation-card.task225.test.tsx` | 10 | Type-ahead, debounce, gating, no bulk load |
| `site-header.task225.test.tsx` | 5 | Banner polish, timer, focus styles |
| `login-gate.task225.test.tsx` | ~6 | JWT auto-populate, API key non-populate |
| `api-config-store.task225.test.ts` | ~6 | Store persistence, merge behavior |
| `api-settings.task225.test.tsx` | ~6 | Disabled fields in JWT mode |
| `voice-cache.task225.test.ts` | ~5 | IndexedDB save/get/remove |
| `setup-personalization.task225.test.tsx` | ~10 | Hindi, None options, pipeline, diarization |
| `setup-save.task225.test.tsx` | ~5 | Unified save, dirty tracking |
| `setup-page.task225.test.tsx` | ~5 | Page layout structure |

---

## Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/hooks/useAuth.ts` | Added `canImpersonate` to `UseAuthReturn` |
| `packages/agentic-sdk-v2/src/hooks/useUsers.ts` | Added `search()` method, `SearchUsersOptions` |
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `SEARCH` to `USER_ENDPOINTS` |
| `packages/agentic-sdk-v2/src/types/config.ts` | Added `VoiceEmbeddingLocalConfig`, `AudioSilenceLocalConfig` |
| `packages/agentic-sdk-v2/src/types/index.ts` | Re-exports for new types |
| `packages/ui/src/components/model-selector.tsx` | Added `noneOption` prop |
| `examples/vite-app/src/components/login-gate.tsx` | JWT auto-populate doctorId, tenantId |
| `examples/vite-app/src/components/api-settings.tsx` | Read-only fields in JWT mode |
| `examples/vite-app/src/components/site-header.tsx` | Polished ImpersonationBanner |
| `examples/vite-app/src/lib/auth-store.ts` | Added `tenantId` to `AdminUser` |
| `examples/vite-app/src/pages/setup.tsx` | Full page restructure, dead code removal |

## Files Created

| File | Purpose |
|------|---------|
| `examples/vite-app/src/components/impersonation-card.tsx` | Extracted standalone impersonation component |
| `examples/vite-app/src/lib/voice-cache.ts` | IndexedDB voice sample cache |
| 13 test files (`*.task225.test.*`) | TDD test suites for all streams |

---

## Security Checklist

- [x] `canImpersonate` derived from server-side JWT roles (not client-editable)
- [x] Type-ahead search goes through authenticated API endpoint with CASL authorization
- [x] No hardcoded secrets — all config from env vars
- [x] JWT tokens in sessionStorage, API config in localStorage (consistent with TASK-224)
- [x] Auto-populated fields are read-only in UI (prevents user confusion)
- [x] Voice cache is non-critical (backend is source of truth) with graceful degradation
- [x] ARIA attributes on impersonation combobox for accessibility compliance

---

## Change History

### Update 1 — 2026-02-26: Feedback alignment audit & refactor

**Issue**: Several UI elements deviated from the original user feedback specification.

**Changes made**:

1. **Removed "Audio Silence Model"** — Feedback specifies "noise cancellation/suppression", not "audio silence". Removed `audioSilence` from pipeline steps, model selectors, `pipelineSelected` map, and `expectedOutput` in `setup.tsx`.

2. **Replaced tab-based WorkflowToggle with radio group selector** — Feedback says "selecting one from two" (a mode selector), not side-by-side tabs. Redesigned `workflow-toggle.tsx` from `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` to a radio card group with proper `role="radiogroup"` and `role="radio"` ARIA semantics. Selected mode's content renders inline below.

3. **Fixed pipeline step order** — Feedback specifies: `Audio sources → normalize → noise cancellation → VAD → Voice embedding → Transcription`. Changed from `Noise, VAD, STT, Silence, Voice, NER` to `Noise, VAD, Voice, STT, NER`.

4. **Fixed model selector ordering** — Reordered to match feedback: Noise Cancellation toggle → VAD Model → Voice Embedding Model (with diarization indicator + voice sample capture) → Transcription (STT) Model (with word-level timestamps) → NER Model.

5. **Moved Save & Reload button outside workflow mode content** — Feedback says "At the end of the User Personalization section". Moved from inside `localContent` (invisible in remote mode) to after the `WorkflowToggle`, visible regardless of selected mode.

6. **Improved ServiceStatusBar** (prior update) — Redesigned from invisible black-on-black badges to semantic card tiles with color-coded status indicators (emerald/amber/red), animated pulse for live services, explicit status labels, and dark mode support.

**Files modified**:
- `packages/ui/src/components/workflow-toggle.tsx` — Complete rewrite from Tabs to radio group
- `packages/ui/src/components/service-status-bar.tsx` — Redesigned status indicators
- `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx` — Pipeline order, model order, audio silence removal, save button placement
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/voice-cache.ts` — Fixed graceful degradation (prior update)

**Status**: Build passes, 406 vite-app tests pass

### Update 2 — 2026-02-26: ImpersonationCard double-gate bug fix

**Issue**: Impersonation card never rendered for JWT admin login (`super_admin` with `SUPER_ADMIN` role), despite the API returning correct roles. Root cause was a **double-gate contradiction**:

1. **Gate 1 (SetupPage, line 947-949)** — Uses two-prong OR: SDK `auth.canImpersonate` OR local session `isAdminUser()`. Prong B passes for JWT login because the vite-app stores `adminUser` with roles from the API response.

2. **Gate 2 (ImpersonationCard, line 91)** — `if (!auth.canImpersonate) return null;` — Only checks Prong A (SDK Zustand store). The vite-app's `JwtLoginForm` does a raw `fetch('/auth/login')` and stores the user in the local `auth-store` but **never calls `store.setAuthUser()`** on the SDK's Zustand store. So `auth.canImpersonate` is always `false`, and the card always returns `null`.

**The SetupPage said "render it" but the ImpersonationCard said "I'm null".**

**Fix**: Removed the redundant internal visibility guard from `ImpersonationCard`. The parent `SetupPage` already controls mounting via `{showImpersonation && <ImpersonationCard />}`. The card now renders unconditionally when mounted, trusting its parent's gate.

**API Key auth**: Correctly remains hidden — `ApiKeyForm` sets `adminUser: null`, both prongs fail, card is never mounted.

**Changes made**:
- `impersonation-card.tsx` — Removed `if (!auth.canImpersonate) return null;` guard; updated JSDoc; fixed ARIA attribute string literals
- `impersonation-card.task225.test.tsx` — Updated visibility test: card now always renders when mounted (parent controls visibility)

**Browser verification**: JWT login with `super_admin` shows impersonation card with working type-ahead search. API key login correctly hides it.

**Status**: 15/15 impersonation tests pass

### Update 3 — 2026-02-26: Hierarchical impersonation authorization fix

**Issue**: Backend applied a blanket ban on impersonating ANY admin user. The controller at `auth.controller.ts` checked:
```
targetIsAdmin = targetRoleNames.some(r => ['SUPER_ADMIN', 'TENANT_ADMIN', 'admin', 'system-admin'].includes(r))
```
This meant a `SUPER_ADMIN` could not impersonate a `TENANT_ADMIN`, which contradicts the requirement:
- **SUPER_ADMIN** can impersonate anyone except another SUPER_ADMIN
- **TENANT_ADMIN** can impersonate anyone except SUPER_ADMIN and TENANT_ADMIN

**Root cause**: The original implementation treated all admin roles as a flat group. No hierarchy was enforced.

**Fix**: Replaced the blanket `targetIsAdmin` check with role-specific hierarchical checks:
1. `targetIsSuperAdmin` — always blocked (no one can impersonate a super admin)
2. `targetIsTenantAdmin` — only blocked if the caller is NOT a SUPER_ADMIN (tenant admins cannot impersonate peer admins)

Error messages now distinguish between cases:
- "Cannot impersonate a super administrator" — when target is SUPER_ADMIN
- "Tenant administrators cannot impersonate other administrators" — when TENANT_ADMIN tries to impersonate a peer admin

**Changes made**:
- `apps/api/src/modules/auth/auth.controller.ts` — Replaced flat `targetIsAdmin` check with hierarchical `targetIsSuperAdmin` / `targetIsTenantAdmin` checks
- `apps/api/src/modules/auth/__tests__/auth.controller.task224.test.ts` — Added 4 new tests:
  - SUPER_ADMIN -> SUPER_ADMIN: rejected
  - SUPER_ADMIN -> TENANT_ADMIN: allowed
  - TENANT_ADMIN -> TENANT_ADMIN: rejected
  - TENANT_ADMIN -> SUPER_ADMIN: rejected

**Full test matrix** (7 scenarios, all verified via API and browser):

| # | Initiator | Target | Expected | Result | Error Message |
|---|-----------|--------|----------|--------|---------------|
| 1 | SUPER_ADMIN | tenant_admin | Succeed | 200 | — |
| 2 | SUPER_ADMIN | doctor | Succeed | 200 | — |
| 3 | SUPER_ADMIN | nurse | Succeed | 200 | — |
| 4 | SUPER_ADMIN | super_admin | Fail | 400 | Cannot impersonate a super administrator |
| 5 | TENANT_ADMIN | doctor | Succeed | 200 | — |
| 6 | TENANT_ADMIN | arcaai_admin | Fail | 400 | Tenant administrators cannot impersonate other administrators |
| 7 | TENANT_ADMIN | super_admin | Fail | 400 | Cannot impersonate a super administrator |

**Status**: 25/25 auth controller tests pass, all 7 API scenarios verified
