# OpenAPI Documentation Consistency

- **Ticket**: TASK-030
- **Created**: 2026-02-19
- **Last Updated**: 2026-02-19
- **Status**: Completed

## Requirement Analysis

Part of the API Gateway Consolidation plan (Work Stream 1). The NestJS API Gateway had inconsistent Swagger/OpenAPI documentation across controllers:

- 24/30 controllers had complete decorators
- 6 controllers used a custom `@ApiEndpoint` decorator or were missing standard Swagger decorators
- The Swagger configuration in `main.ts` was minimal (no API key auth, no server URLs, no contact/license metadata)

### Acceptance Criteria

1. All 6 incomplete controllers must have standard Swagger decorators (`@ApiOperation`, `@ApiResponse`, `@ApiParam`, `@ApiQuery`, `@ApiBearerAuth`)
2. Swagger config must include API key auth scheme, server URLs, contact info, and license
3. All changes must be test-driven (TDD)
4. No existing tests should break

## Current State Evaluation

### Controllers Needing Fixes

| Controller | Had `@ApiTags` | Had `@ApiBearerAuth` | Had `@ApiOperation` | Had `@ApiResponse` (errors) | Had `@ApiParam` | Had `@ApiQuery` |
|---|---|---|---|---|---|---|
| `stt.controller.ts` | Yes | Yes | No | No | No | N/A |
| `tenant.controller.ts` | Yes | Yes | Via `@ApiEndpoint` | No | No | No |
| `users.controller.ts` | Yes | **No** | Via `@ApiEndpoint` | No | No | No |
| `user-settings.controller.ts` | Yes | **No** | Via `@ApiEndpoint` | No | No | No |
| `global-settings.controller.ts` | Yes | **No** | Via `@ApiEndpoint` | No | No | No |
| `audit-log.controller.ts` | Yes | **No** | Partial | No (for errors) | Partial | No |

### Custom `@ApiEndpoint` Decorator

The existing `@ApiEndpoint` decorator (`src/decorators/apiEndpoint.decorator.ts`) already provides `@ApiOperation` with auto-generated summaries and `@ApiOkResponse`. It does **not** provide error responses, parameter documentation, or query parameter documentation.

**Decision**: Keep `@ApiEndpoint` for the OK response generation, supplement with standard decorators for everything else.

## Implementation Plan

Approach: TDD (Red-Green-Refactor)

1. Write failing unit tests for all 6 controllers verifying expected Swagger metadata
2. Write failing tests for enhanced Swagger config in `main.ts`
3. Add missing decorators to make tests pass
4. Verify no regressions

## Implementation Summary

### Files Created (Tests)

| File | Tests | Purpose |
|---|---|---|
| `src/modules/stt/__tests__/stt.controller.swagger.test.ts` | 18 | `@ApiOperation` + `@ApiResponse` on all 8 proxy endpoints |
| `src/modules/tenant/__tests__/tenant.controller.swagger.test.ts` | 18 | `@ApiParam`, `@ApiQuery`, `@ApiResponse` for errors |
| `src/modules/user/__tests__/users.controller.swagger.test.ts` | 13 | `@ApiBearerAuth`, `@ApiParam`, `@ApiResponse` for errors |
| `src/modules/user-settings/__tests__/user-settings.controller.swagger.test.ts` | 12 | `@ApiBearerAuth`, `@ApiParam`, `@ApiQuery`, `@ApiResponse` |
| `src/modules/global-settings/__tests__/global-settings.controller.swagger.test.ts` | 12 | `@ApiBearerAuth`, `@ApiParam`, `@ApiQuery`, `@ApiResponse` |
| `src/modules/audit-log/__tests__/audit-log.controller.swagger.test.ts` | 9 | `@ApiBearerAuth`, `@ApiQuery`, `@ApiResponse` for errors |
| `src/__tests__/swagger-config.test.ts` | 5 | DocumentBuilder config verification |

**Total: 87 new tests**

### Files Modified (Controllers)

| File | Changes |
|---|---|
| `src/modules/stt/stt.controller.ts` | Added `@ApiOperation`, `@ApiResponse`, `@ApiParam` to all 8 methods |
| `src/modules/tenant/tenant.controller.ts` | Added `@ApiParam`, `@ApiQuery`, `@ApiResponse` (400/404) |
| `src/modules/user/users.controller.ts` | Added `@ApiBearerAuth`, `@ApiParam`, `@ApiQuery`, `@ApiResponse` (400/404) |
| `src/modules/user-settings/user-settings.controller.ts` | Added `@ApiBearerAuth`, `@ApiParam`, `@ApiQuery`, `@ApiResponse` (400/404) |
| `src/modules/global-settings/global-settings.controller.ts` | Added `@ApiBearerAuth`, `@ApiParam`, `@ApiQuery`, `@ApiResponse` (400/404) |
| `src/modules/audit-log/audit-log.controller.ts` | Added `@ApiBearerAuth`, `@ApiQuery`, `@ApiResponse` (200/404) |
| `src/main.ts` | Enhanced Swagger config with API key auth, server URLs, contact, license |

### Swagger Config Changes (`main.ts`)

- Title: `Api` → `HOPE API`
- Description: `Main api backend` → `HOPE API Gateway - Healthcare Operations Platform Engine`
- Added `.addApiKey()` for `x-api-key` header authentication
- Added `.addServer()` for local development and staging URLs
- Added `.setContact()` with ARCA AI details
- Added `.setLicense()` with Proprietary license

### Test Results

- 87 new swagger metadata tests: **All passing**
- 323 existing tests: **All still passing**
- 10 pre-existing failures in `transcriptionStream.controller.test.ts`: **Unrelated, pre-existing**
- No lint errors introduced

### Deviations from Plan

- The plan mentioned the Swagger CLI plugin in `tsconfig.json` as optional. Not implemented since the `@ApiEndpoint` custom decorator and explicit decorators already provide complete DTO documentation.
- The plan mentioned replacing `@ApiEndpoint`. Kept `@ApiEndpoint` since it provides auto-generated OK responses and extra model registration; supplemented with standard decorators for gaps.
