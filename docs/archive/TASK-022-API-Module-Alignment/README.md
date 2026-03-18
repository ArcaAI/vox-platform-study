# TASK-022: API Module Alignment & Architecture Improvement

**Ticket Number**: TASK-022
**Created Date**: 2026-02-17
**Last Updated**: 2026-02-17
**Status**: Completed

---

## Requirement Analysis

### Overview

A comprehensive architectural review of `apps/api/src/` and `packages/applications/src/` revealed structural inconsistencies, layer boundary violations, and pattern deviations that have accumulated as features were added. This task aligns all API modules to follow the established best-practice patterns consistently.

### Business Context

- Consistent architecture reduces onboarding time for new developers
- Clean layer boundaries prevent business logic leaking into the HTTP layer
- Interface-based DI ensures testability and maintainability
- Single convention for module location eliminates "where does this go?" decisions

### Acceptance Criteria

1. All feature modules live under a single `modules/` folder (no dual-location split)
2. All API modules follow the thin-controller pattern (no business logic in the API layer)
3. All service injection uses interface tokens (`@Inject(IXxxService)`) consistently
4. Auth module uses `AuthServiceModule` from `@arcaai/applications` instead of manual wiring
5. No redundant `CoreDatabaseModule` imports in API modules that already import `*ServiceModule`
6. `app.module.ts` uses clear, descriptive variable naming
7. `README.md` project structure documentation is accurate and current
8. All barrel exports (`index.ts`) are complete and consistent

---

## Current State Evaluation

### Architecture (The Intended Design)

```
┌──────────────────────────────────────────────────┐
│  apps/api  (NestJS - Thin Controllers)           │  HTTP/WS plumbing only
│  Controllers, DTOs, Guards, Decorators           │
└──────────────┬───────────────────────────────────┘
               │ imports *ServiceModules from:
┌──────────────┴───────────────────────────────────┐
│  packages/applications  (Business Logic)          │  Application services
│  ServiceModules, Interface-based DI              │
└──────────────┬───────────────────────────────────┘
               │ uses Repositories from:
┌──────────────┴───────────────────────────────────┐
│  packages/domains  (Domain Layer)                 │  Entities, Repos, Enums
│  CoreDatabaseModule, Factories, Mappers          │
└──────────────────────────────────────────────────┘
```

### Best-Practice Module (Gold Standard: `stt-v2`)

```typescript
// apps/api/src/controllers/stt-v2/stt-v2.module.ts
@Module({
    imports: [
        CoreDatabaseModule,
        PipelineServiceModule,        // from @arcaai/applications
        AiModelServiceModule,          // from @arcaai/applications
        TranscriptionJobServiceModule, // from @arcaai/applications
        ...
    ],
    controllers: [PipelineController, AiModelController, ...],
    providers: [SttV2StreamGateway],
})
export class SttV2Module {}
```

Pattern: Import pre-built `*ServiceModule`, declare thin controllers, no local business logic.

### Issues Found

| # | Category | Severity | Issue |
|---|----------|----------|-------|
| C1 | Architecture | Critical | Dual-location anti-pattern: `controllers/` vs `modules/` |
| C2 | Architecture | Critical | `MonitoringService` (315 lines of business logic) in API layer |
| R1 | Consistency | High | Auth module manually wires services instead of using `AuthServiceModule` |
| R2 | Consistency | Medium | Inconsistent `CoreDatabaseModule` imports (redundant when `*ServiceModule` includes it) |
| R3 | Consistency | Medium | Consultation controllers inject concrete classes instead of interface tokens |
| R4 | Documentation | Medium | `README.md` project structure is outdated (missing modules, references non-existent `session/`) |
| S1 | Naming | Low | `controllers` variable in `app.module.ts` misleadingly named (contains Modules, not Controllers) |
| S2 | Consistency | Low | `ApiKeyServiceModule` appears in both `common` array and individual module imports |
| S3 | Exports | Low | `packages/applications/src/services/index.ts` missing `./stt` export (now present, confirmed correct) |
| S4 | Testing | Low | Many `controllers/` modules lack co-located `__tests__/` directories |

---

## Implementation Plan

### Phase 1: Consolidate Module Location (C1)

**Goal**: Eliminate the `controllers/` vs `modules/` dual-location anti-pattern by renaming `controllers/` to `modules/` and merging the two `modules/` entries.

**Rationale**: The NestJS convention is `modules/` for feature modules. The existing `controllers/` name is misleading since each folder contains a full NestJS Module (not just a controller). The `modules/` folder already exists and follows the correct naming. We rename `controllers/` to `modules/` to unify.

#### Task 1.1: Rename `controllers/` to `modules/` and merge

**Files**:
- Rename: `apps/api/src/controllers/` -> merge all subdirectories into `apps/api/src/modules/`
- Modify: `apps/api/src/app.module.ts` (update all import paths)

**Steps**:

1. Move all subdirectories from `apps/api/src/controllers/` into `apps/api/src/modules/`:
   ```bash
   # Move each controller folder into modules/
   # Folders to move: audit-log, auth, department, fedl, feedback,
   #   global-settings, health, mlflow, monitoring, nlp, rbac,
   #   smr, stt, stt-v2, tenant, tts, user, user-settings
   ```

2. Update all import paths in `apps/api/src/app.module.ts`:
   ```typescript
   // BEFORE:
   import { AuthModule } from './controllers/auth/auth.module';
   import { SmrModule } from './controllers/smr/smr.module';
   // ...

   // AFTER:
   import { AuthModule } from './modules/auth/auth.module';
   import { SmrModule } from './modules/smr/smr.module';
   // ...
   ```

3. Update internal cross-references between modules. Known cross-references:
   - `apps/api/src/modules/user/users.module.ts` imports `../auth/auth.module` (path changes)
   - `apps/api/src/modules/user-settings/user-settings.module.ts` imports `../auth/auth.module`
   - `apps/api/src/modules/audit-log/audit-log.module.ts` imports `../auth/auth.module`
   - `apps/api/src/modules/consultation/consultation.controller.ts` imports `../../guards` (path stays same)
   - `apps/api/src/modules/consultation/summary.controller.ts` imports `../../guards` (path stays same)
   - `apps/api/src/modules/consultation/job.controller.ts` imports `../../guards` (path stays same)
   - `apps/api/src/modules/user-preferences/user-preferences.controller.ts` imports `../../guards` (path stays same)

4. Verify the build passes:
   ```bash
   cd apps/api && pnpm build
   ```

5. Run existing tests:
   ```bash
   cd apps/api && pnpm test
   ```

#### Task 1.2: Update `app.module.ts` variable naming (S1)

**Files**:
- Modify: `apps/api/src/app.module.ts`

**Steps**:

1. Rename the `controllers` variable to `featureModules`:
   ```typescript
   // BEFORE:
   const controllers: any[] = [
       TenantModule, HealthModule, ...
   ];
   @Module({
       imports: [...common, ...controllers],
   })

   // AFTER:
   const featureModules: any[] = [
       TenantModule, HealthModule, ...
   ];
   @Module({
       imports: [...common, ...featureModules],
   })
   ```

2. Remove `ApiKeyServiceModule` from `featureModules` array (it's a shared service, not a feature module) - move it to `common` if not already there, or confirm it's redundant because individual modules already import it:
   ```typescript
   // BEFORE (in featureModules):
   ApiKeyServiceModule, // <-- this is a service module, not a feature

   // AFTER: Remove from featureModules array
   // Individual modules (monitoring, stt-v2, consultation, user-preferences)
   // already import it directly
   ```

---

### Phase 2: Extract Microservice Health Monitoring to Applications Package (C2)

**Goal**: Move the microservice health check, heartbeat, and uptime logic out of the API layer into `packages/applications/`.

**Context**: The existing `MonitoringServiceModule` in `packages/applications/src/services/baseServices/monitoring/` handles **system metrics** (CPU, memory, KPI, Prometheus gauges). The API-level `MonitoringService` handles **microservice health monitoring** (heartbeats, uptime, session counts for STT/TTS/SMR). These are distinct concerns and should remain separate.

#### Task 2.1: Create `ServiceHealthMonitoringService` in applications package

**Files**:
- Create: `packages/applications/src/services/baseServices/serviceHealth/IServiceHealthMonitoringService.ts`
- Create: `packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts`
- Create: `packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.module.ts`
- Create: `packages/applications/src/services/baseServices/serviceHealth/dto/index.ts`
- Create: `packages/applications/src/services/baseServices/serviceHealth/index.ts`
- Modify: `packages/applications/src/services/baseServices/index.ts` (add export)

**Steps**:

1. Create the interface `IServiceHealthMonitoringService`:
   ```typescript
   // IServiceHealthMonitoringService.ts
   export interface IServiceHealthMonitoringService {
       getUptime(): Promise<UptimeResponse>;
       getServiceUptime(serviceName: string): Promise<ServiceUptime | null>;
       getHeartbeatHistory(serviceName: string): Promise<HeartbeatRecord[]>;
       getSessionCounts(): Promise<SessionsResponse>;
   }
   export const IServiceHealthMonitoringService = Symbol('IServiceHealthMonitoringService');
   ```

2. Move DTO types from `apps/api/src/modules/monitoring/dto/monitoring.dto.ts` to `packages/applications/src/services/baseServices/serviceHealth/dto/`:
   - `HeartbeatRecord`, `ServiceStatus`, `ServiceUptime`, `UptimeResponse`, `ServiceSessionCount`, `SessionsResponse`
   - Remove Swagger `@ApiProperty` decorators (those belong in the API layer DTOs which will import and re-export)

3. Move business logic from `apps/api/src/modules/monitoring/monitoring.service.ts` to `serviceHealthMonitoring.service.ts`:
   - Redis connection management
   - Cron-based health checks
   - HTTP health checks to downstream services
   - Heartbeat storage/retrieval
   - Uptime calculation
   - Session count aggregation
   - Use `IRedisCacheService` from applications package instead of direct Redis

4. Create the service module:
   ```typescript
   // serviceHealthMonitoring.service.module.ts
   @Module({
       imports: [ConfigModule, RedisCacheModule.register()],
       providers: [{
           provide: IServiceHealthMonitoringService,
           useClass: ServiceHealthMonitoringService,
       }],
       exports: [IServiceHealthMonitoringService],
   })
   export class ServiceHealthMonitoringServiceModule {}
   ```

5. Add barrel export in `packages/applications/src/services/baseServices/serviceHealth/index.ts`

6. Add to `packages/applications/src/services/baseServices/index.ts`:
   ```typescript
   export * from './serviceHealth';
   ```

#### Task 2.2: Refactor API monitoring module to thin controller

**Files**:
- Modify: `apps/api/src/modules/monitoring/monitoring.module.ts`
- Modify: `apps/api/src/modules/monitoring/monitoring.controller.ts`
- Delete: `apps/api/src/modules/monitoring/monitoring.service.ts` (logic moved to applications)
- Keep: `apps/api/src/modules/monitoring/dto/monitoring.dto.ts` (Swagger-decorated API DTOs)

**Steps**:

1. Update `monitoring.module.ts` to import from applications:
   ```typescript
   import { ApiKeyServiceModule, ServiceHealthMonitoringServiceModule } from '@arcaai/applications';
   import { Module } from '@nestjs/common';
   import { MonitoringController } from './monitoring.controller';

   @Module({
       imports: [ApiKeyServiceModule, ServiceHealthMonitoringServiceModule],
       controllers: [MonitoringController],
   })
   export class MonitoringModule {}
   ```

2. Update `monitoring.controller.ts` to inject via interface:
   ```typescript
   constructor(
       @Inject(IServiceHealthMonitoringService)
       private readonly monitoringService: IServiceHealthMonitoringService,
   ) {}
   ```

3. Delete `apps/api/src/modules/monitoring/monitoring.service.ts`

4. Verify build and tests pass

---

### Phase 3: Align Auth Module to Standard Pattern (R1)

**Goal**: Make the Auth API module use `AuthServiceModule` from `@arcaai/applications` instead of manually wiring services and repositories.

**Context**: `AuthServiceModule` already exists in `packages/applications/src/services/auth/auth.service.module.ts` and properly exports `IAuthService`, `JwtStrategy`, `OidcStrategy`, `GatewayJwtStrategy`, and `PassportModule`. However, the API's `AuthModule` bypasses it and manually wires `UserRepository`, `RoleRepository`, `UserRoleAssignmentRepository`, `UserService`, `AuthService`, and `AppSettingsService`.

#### Task 3.1: Refactor Auth API module to use `AuthServiceModule`

**Files**:
- Modify: `apps/api/src/modules/auth/auth.module.ts`

**Steps**:

1. Replace manual wiring with `AuthServiceModule` import:
   ```typescript
   // BEFORE:
   import { AuthService, IAuthService, IUserService, UserService, ... } from '@arcaai/applications';
   import { CoreDatabaseModule, RoleRepository, UserRepository, ... } from '@arcaai/domains';

   @Module({
       imports: [ClsModule, CoreDatabaseModule, PassportModule.register(...)],
       controllers: [AuthController],
       providers: [
           UserRepository, UserRoleAssignmentRepository, RoleRepository,
           JwtStrategy,
           { provide: IUserService, useClass: UserService },
           { provide: IAuthService, useClass: AuthService },
           { provide: IAppSettingsService, useClass: AppSettingsService },
       ],
   })

   // AFTER:
   import { AuthServiceModule, UserServiceModule } from '@arcaai/applications';
   import { CoreDatabaseModule } from '@arcaai/domains';

   @Module({
       imports: [AuthServiceModule, UserServiceModule, CoreDatabaseModule],
       controllers: [AuthController],
   })
   export class AuthModule {}
   ```

2. **Important**: The `AuthController` directly uses `UserRepository`, `UserRoleAssignmentRepository`, `RoleRepository`, and `CoreDatabaseService` for login logic (querying users, roles, password comparison). This business logic should ideally be in the `AuthService` in `@arcaai/applications`. However, this refactoring may be too large for this task.

   **Intermediate approach**: Keep `CoreDatabaseModule` in imports so repositories are available, but remove manual provider wiring for services that `AuthServiceModule` already provides.

3. Verify the existing auth endpoints still work:
   - `POST /auth/login`
   - `POST /auth/logout`
   - `GET /auth/me`

#### Task 3.2: (Future) Move login business logic from AuthController to AuthService

**Note**: This is a follow-up task beyond the scope of TASK-022. The `AuthController` currently contains business logic for:
- Password comparison (`bcrypt.compare`)
- Role/permission fetching (direct Prisma queries via `CoreDatabaseService`)
- JWT token generation
- Refresh token generation

This should eventually be encapsulated in `IAuthService.login()` in `@arcaai/applications`. Document as a follow-up item.

---

### Phase 4: Fix Interface-Based Injection (R3)

**Goal**: Ensure all controllers inject services via interface tokens (`@Inject(IXxxService)`) rather than concrete classes.

#### Task 4.1: Fix Consultation controllers

**Files**:
- Modify: `apps/api/src/modules/consultation/consultation.controller.ts`
- Modify: `apps/api/src/modules/consultation/summary.controller.ts`

**Steps**:

1. Update `consultation.controller.ts`:
   ```typescript
   // BEFORE:
   import { ConsultationService, ContextService, ... } from '@arcaai/applications';
   constructor(
       private readonly consultationService: ConsultationService,
       private readonly contextService: ContextService,
       ...
   )

   // AFTER:
   import {
       IConsultationService, IContextService,
       ConsultationResponse, ContextItemResponse, ...
   } from '@arcaai/applications';
   constructor(
       @Inject(IConsultationService) private readonly consultationService: IConsultationService,
       @Inject(IContextService) private readonly contextService: IContextService,
       ...
   )
   ```

2. Update `summary.controller.ts`:
   ```typescript
   // BEFORE:
   import { SummaryService, ... } from '@arcaai/applications';
   constructor(
       private readonly summaryService: SummaryService,
       ...
   )

   // AFTER:
   import { ISummaryService, ... } from '@arcaai/applications';
   constructor(
       @Inject(ISummaryService) private readonly summaryService: ISummaryService,
       ...
   )
   ```

#### Task 4.2: Fix UserPreferences controller

**Files**:
- Modify: `apps/api/src/modules/user-preferences/user-preferences.controller.ts`

**Steps**:

1. Update to use interface injection:
   ```typescript
   // BEFORE:
   import { UserPreferencesService, ... } from '@arcaai/applications';
   constructor(private readonly userPreferencesService: UserPreferencesService)

   // AFTER:
   import { IUserPreferencesService, ... } from '@arcaai/applications';
   constructor(
       @Inject(IUserPreferencesService)
       private readonly userPreferencesService: IUserPreferencesService,
   )
   ```

2. Verify the `IUserPreferencesService` interface exists in `@arcaai/applications`. If not, create it following the standard pattern.

---

### Phase 5: Clean Up Redundant CoreDatabaseModule Imports (R2)

**Goal**: Remove `CoreDatabaseModule` from API modules that already import `*ServiceModule` (which internally imports `CoreDatabaseModule`).

#### Task 5.1: Audit and remove redundant imports

**Files**:
- Modify: `apps/api/src/modules/stt-v2/stt-v2.module.ts`
- Modify: `apps/api/src/modules/department/department.module.ts`
- Modify: `apps/api/src/modules/consultation/consultation.module.ts`

**Steps**:

1. For each module, verify the imported `*ServiceModule` already includes `CoreDatabaseModule`:
   - `PipelineServiceModule` -> imports `CoreDatabaseModule` internally? Verify.
   - `DepartmentServiceModule` -> imports `CommonServiceModule` + `CoreDatabaseModule` internally. Yes, redundant.
   - `ConsultationServiceModule` -> imports `CommonServiceModule` + `CoreDatabaseModule` internally. Yes, redundant.

2. Remove redundant `CoreDatabaseModule` import from each API module:
   ```typescript
   // BEFORE (department.module.ts):
   imports: [CoreDatabaseModule, DepartmentServiceModule]
   // AFTER:
   imports: [DepartmentServiceModule]
   ```

3. **Caveat**: Only remove if the API module's controllers do NOT directly inject repositories from `@arcaai/domains`. If they do (like `AuthController`), keep `CoreDatabaseModule`.

4. Build and test after each change

---

### Phase 6: Documentation Updates (R4, S4)

#### Task 6.1: Update API README.md project structure

**Files**:
- Modify: `apps/api/README.md`

**Steps**:

1. Update the "Project Structure" section to reflect the consolidated `modules/` layout:
   ```
   apps/api/
   ├── src/
   │   ├── main.ts
   │   ├── app.module.ts
   │   │
   │   ├── modules/                  # Feature modules
   │   │   ├── audit-log/
   │   │   ├── auth/
   │   │   ├── consultation/
   │   │   ├── department/
   │   │   ├── fedl/
   │   │   ├── feedback/
   │   │   ├── global-settings/
   │   │   ├── health/
   │   │   ├── mlflow/
   │   │   ├── monitoring/
   │   │   ├── nlp/
   │   │   ├── rbac/
   │   │   ├── smr/
   │   │   ├── stt/
   │   │   ├── stt-v2/
   │   │   ├── tenant/
   │   │   ├── tts/
   │   │   ├── user/
   │   │   ├── user-preferences/
   │   │   └── user-settings/
   │   │
   │   ├── services/                 # API-level shared services
   │   ├── guards/
   │   ├── decorators/
   │   ├── interceptors/
   │   └── filters/
   ```

2. Remove references to non-existent `session/` controller
3. Add mention of WebSocket gateways in the modules section
4. Update the "Adding a New Feature" guide to reference `modules/` instead of `controllers/`

#### Task 6.2: Update `.cursor/rules/03-app-api.mdc`

**Files**:
- Modify: `.cursor/rules/03-app-api.mdc`

**Steps**:

1. Update "Project Structure" section to reference `modules/` instead of `controllers/`
2. Update module pattern examples to show import from `./modules/`
3. Add note about the interface-based injection pattern requirement

#### Task 6.3: Update API reference documentation

**Files**:
- Modify: `apps/api/docs/05-api-reference.md`

**Steps**:

1. Update file paths in the Controllers section from `src/controllers/` to `src/modules/`
2. Remove references to `SessionController` (doesn't exist; replaced by `ConsultationController`)
3. Add documentation for newer modules (consultation, user-preferences, rbac, department, audit-log)

---

### Phase 7: Testing & Validation

#### Task 7.1: Ensure all existing tests pass after restructuring

**Steps**:

1. Run full API test suite:
   ```bash
   cd apps/api && pnpm test
   ```

2. Run full applications package test suite:
   ```bash
   cd packages/applications && pnpm test
   ```

3. Run TypeScript compilation check:
   ```bash
   pnpm turbo run build --filter=@arcaai/api
   ```

4. Check for broken imports:
   ```bash
   pnpm turbo run lint --filter=@arcaai/api
   ```

#### Task 7.2: Verify runtime startup

**Steps**:

1. Start the API in development mode:
   ```bash
   cd apps/api && pnpm dev
   ```

2. Verify key endpoints respond correctly:
   - `GET /health` -> 200
   - `GET /monitoring/uptime` -> 200
   - `POST /auth/login` -> 200 (with valid credentials)

---

## Implementation Summary

### Phase 1: Module Consolidation (C1 + S1)
- Moved all 18 subdirectories from `apps/api/src/controllers/` into `apps/api/src/modules/`
- Removed the now-empty `controllers/` directory
- Updated all 18 import paths in `app.module.ts` from `./controllers/` to `./modules/`
- Renamed `controllers` variable to `featureModules` in `app.module.ts`
- Removed `ApiKeyServiceModule` from the `featureModules` array (already imported by individual modules)
- Removed unused `ApiKeyServiceModule` import from `app.module.ts`
- Alphabetically sorted feature module imports and array entries

### Phase 2: MonitoringService Extraction (C2)
- Created `packages/applications/src/services/baseServices/serviceHealth/` with:
  - `dto/index.ts` - Plain TypeScript interfaces for heartbeat, uptime, session DTOs
  - `IServiceHealthMonitoringService.ts` - Interface + Symbol token
  - `serviceHealthMonitoring.service.ts` - Full service (Redis heartbeats, cron health checks, session counts)
  - `serviceHealthMonitoring.service.module.ts` - NestJS module with interface-based DI
  - `index.ts` - Barrel exports
- Added `serviceHealth` and `monitoring` exports to `packages/applications/src/services/baseServices/index.ts`
- Deleted `apps/api/src/modules/monitoring/monitoring.service.ts` (315 lines of business logic)
- Refactored `monitoring.module.ts` to import `ServiceHealthMonitoringServiceModule` from `@arcaai/applications`
- Refactored `monitoring.controller.ts` to inject via `@Inject(IServiceHealthMonitoringService)`
- Updated `monitoring/index.ts` to remove deleted service export

### Phase 3: Auth Module Alignment (R1)
- Replaced manual service/repository wiring in `auth.module.ts` with `AuthServiceModule` and `UserServiceModule` imports
- Kept `CoreDatabaseModule` because `AuthController` still directly uses repositories (documented as follow-up)
- Added JSDoc documenting the follow-up task

### Phase 4: Interface-Based Injection (R3)
- `consultation.controller.ts`: Changed `ConsultationService` to `@Inject(IConsultationService)` and `ContextService` to `@Inject(IContextService)`
- `summary.controller.ts`: Changed `SummaryService` to `@Inject(ISummaryService)` (kept `ChainSummaryService` concrete as it has no interface)
- `user-preferences.controller.ts`: Changed `UserPreferencesService` to `@Inject(IUserPreferencesService)`

### Phase 5: Redundant Import Cleanup (R2)
- Removed `CoreDatabaseModule` from `department.module.ts` (provided by `DepartmentServiceModule`)
- Removed `CoreDatabaseModule` from `stt-v2.module.ts` (provided by multiple `*ServiceModule`s)
- Removed `CoreDatabaseModule` from `consultation.module.ts` (provided by `ConsultationServiceModule` et al.)
- Kept `CoreDatabaseModule` in `auth.module.ts` and `rbac.module.ts` (controllers directly use repositories)

### Phase 6: Documentation Updates (R4)
- Updated `apps/api/README.md` project structure to show `modules/` with all 20 subdirectories
- Updated "Adding a New Feature" guide to reference `modules/` paths
- Updated `.cursor/rules/03-app-api.mdc` to reference `modules/`
- Updated `apps/api/Dockerfile` build verification paths from `controllers/` to `modules/`

### Files Modified
| Package | Files Created | Files Modified | Files Deleted |
|---------|--------------|----------------|---------------|
| `apps/api` | 0 | 8 files | 1 (`monitoring.service.ts`) |
| `packages/applications` | 5 files | 1 (`baseServices/index.ts`) | 0 |
| Root docs | 0 | 3 files (README, rules, Dockerfile) | 0 |
| 18 module folders | 0 | 0 (paths unchanged) | 0 |

### Pre-Existing Build Errors (Not Related)
Two pre-existing TypeScript errors were found in the applications package:
- `timeline.service.module.ts`: Missing `CoreDatabaseModule` export from `@arcaai/database`
- `streamingAudioBridge.service.ts`: Type mismatch in Redis command overload

These are unrelated to TASK-022 changes and should be addressed separately.

---

## Change History

> _No changes yet. Will be updated as implementation progresses._

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Path changes break imports | High | Run `pnpm build` and `pnpm test` after each phase |
| Auth refactoring breaks login flow | High | Keep `CoreDatabaseModule` available; test login endpoint after changes |
| `MonitoringService` extraction misses runtime dependencies | Medium | Test health check cron + Redis heartbeat storage in dev |
| Cross-module references break | Medium | Search for all relative imports before moving folders |

## Execution Order

| Phase | Tasks | Dependency | Est. Effort |
|-------|-------|------------|-------------|
| Phase 1 | T1.1, T1.2 | None | 30-45 min |
| Phase 2 | T2.1, T2.2 | Phase 1 | 45-60 min |
| Phase 3 | T3.1 | Phase 1 | 20-30 min |
| Phase 4 | T4.1, T4.2 | Phase 1 | 15-20 min |
| Phase 5 | T5.1 | Phases 1-4 | 15-20 min |
| Phase 6 | T6.1, T6.2, T6.3 | All above | 20-30 min |
| Phase 7 | T7.1, T7.2 | All above | 15-20 min |
| **Total** | | | **~3-4 hours** |

## Follow-Up Items (Out of Scope)

These items were identified during the review but are deferred to separate tickets:

1. **Auth Business Logic Extraction**: Move login/password/role logic from `AuthController` to `AuthService` in `@arcaai/applications`
2. **Test Coverage**: Add `__tests__/` directories and unit tests for modules currently lacking them (most modules under the old `controllers/` folder)
3. **Monitoring Enhancement**: Extend `ServiceHealthMonitoringService` to also cover STT-V2 service health checks
4. **API Reference Docs**: Full rewrite of `05-api-reference.md` to cover all current endpoints
