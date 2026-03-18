# Internal Endpoint Consolidation (Prefix-based)

- **Ticket**: TASK-001
- **Parent Plan**: API Gateway Consolidation Plan — Section 4
- **Created**: 2026-02-19
- **Last Updated**: 2026-02-19
- **Status**: Completed

---

## Requirement Analysis

Standardize all internal (service-to-service) routes under a dedicated `/internal/` prefix with consistent patterns for authentication, rate limiting, Swagger visibility, and API versioning.

### Business Context

- Only STT-V2 has internal endpoints today (`/internal/stt/*`), but the pattern was embedded inside a feature module (`SttV2Module`) rather than isolated.
- Future internal controllers (streaming sessions, cache management) need a clear home.
- Internal endpoints should not appear in public API docs, should be exempt from rate limiting, and should remain version-neutral.

### Acceptance Criteria

- [x] Dedicated `InternalModule` exists at `apps/api/src/modules/internal/`
- [x] `SttInternalController` moved from `SttV2Module` to `InternalModule`
- [x] `@ApiExcludeController()` hides internal endpoints from public Swagger
- [x] `@SkipThrottle()` exempts internal endpoints from rate limiting
- [x] `InternalModule` registered in `AppModule`
- [x] Internal API contract documented in `knowledge/05_API_LIST.md`

---

## Current State Evaluation

### Before

- `SttInternalController` registered in `SttV2Module` alongside public controllers
- Already had `@UseGuards(ApiKeyGuard)` and `@ApiSecurity('api-key')` — good
- No `@SkipThrottle`, `@ApiExcludeController`, or `VERSION_NEUTRAL` anywhere in codebase
- No dedicated `internal/` module directory
- `05_API_LIST.md` had a minimal 3-line entry for internal APIs

---

## Implementation Plan

1. Create `apps/api/src/modules/internal/internal.module.ts`
2. Add `@SkipThrottle()` and `@ApiExcludeController()` to `SttInternalController`
3. Remove `SttInternalController` (and its service imports) from `SttV2Module`
4. Register `InternalModule` in `AppModule`
5. Expand internal API documentation in `knowledge/05_API_LIST.md`

---

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `apps/api/src/modules/internal/internal.module.ts` | New module consolidating all internal controllers |

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/modules/stt-v2/sttInternal.controller.ts` | Added `@ApiExcludeController()`, `@SkipThrottle()` decorators and their imports |
| `apps/api/src/modules/stt-v2/stt-v2.module.ts` | Removed `SttInternalController`, `SttInternalServiceModule`, `ApiKeyServiceModule` |
| `apps/api/src/app.module.ts` | Added `InternalModule` import and registration |
| `knowledge/05_API_LIST.md` | Expanded internal API section with endpoint table, common patterns, version history |

### Key Decisions

1. **`@SkipThrottle()` added now**: The throttler isn't configured yet (Section 2 of the plan), but the decorator is a safe no-op until enabled. This avoids a second pass later.
2. **`VERSION_NEUTRAL` deferred**: API versioning (Section 3) isn't enabled yet. Adding `@Version(VERSION_NEUTRAL)` now would cause an import error. Documented as a TODO in the module comment.
3. **Controller stays in `stt-v2/` directory**: The controller file itself remains at `apps/api/src/modules/stt-v2/sttInternal.controller.ts` and is imported cross-module. Moving the file would break barrel exports and existing import paths for no benefit.

### Route Behavior

No route paths changed. All `/internal/stt/*` endpoints continue to work identically:

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/internal/stt/transcripts` | API Key |
| `PATCH` | `/internal/stt/jobs/:id/start` | API Key |
| `PATCH` | `/internal/stt/jobs/:id/progress` | API Key |
| `PATCH` | `/internal/stt/jobs/:id/complete` | API Key |
| `PATCH` | `/internal/stt/jobs/:id/fail` | API Key |
| `POST` | `/internal/stt/audio-records` | API Key |

---

## Remaining Work (Other Sections)

- **Section 2 — Rate Limiting**: When ThrottlerGuard is enabled globally, `@SkipThrottle()` on internal controllers will take effect automatically.
- **Section 3 — API Versioning**: When `enableVersioning()` is added, `@Version(VERSION_NEUTRAL)` must be applied to `SttInternalController` so `/internal/stt/*` routes don't get a version prefix.
