# 01 — Personalization & Settings

| | |
|---|---|
| Reviewer | A1 (Personalization & Settings) |
| Ticket | TASK-293 Vox SDK Deep Assessment V2 |
| Predecessor | TASK-262 (Waves 0–4 complete) |
| Reviewed | 2026-05-24 |
| Verdict | **FAIL** on all four business requirements |

---

## 1. Scope & method

**Scope evaluated.** SDK surface in `packages/agentic-sdk-v2/src/` for personalization (`PersonalizationManager`, `ConfigManager`, `useArcaConfig`, `useUserSettings`, `useGlobalSettings`, `useArcaContext`, `usePrompts`, `useDepartments`, `useAuth`, `AgenticProvider`) and the backing NestJS controllers/services for `/user/me/preferences`, `/user/me/settings`, `/prompt-templates`, `/admin/departments`, `/auth/me`, plus the underlying Prisma schemas.

**Method.** Fresh code read against the four business requirements. Every defect cites `file:line`. TASK-262 H-6 and GAP-03 are verified against the current tree. Cross-cuts (PII, performance, persistence, cascade) are audited as standalone dimensions.

**Out of scope (delegated to other reviewers).** Voice enrollment storage (A2), pipeline transports (A3, A4), DNA-style summarization plumbing (A6), impersonation glue beyond preference isolation (A7).

**Evidence policy.** "Unverified; needs runtime probe" is used where static reading alone cannot determine the answer.

---

## 2. Current architecture

### 2.1 SDK side

The SDK ships **two parallel personalization stacks** that do not share state and do not share storage:

1. **Legacy stack** — `PersonalizationManager` (`packages/agentic-sdk-v2/src/core/PersonalizationManager.ts`) → flat `UserPreferences` blob. Persists to `localStorage['arcaai-preferences']` (`STORAGE_KEYS.PREFERENCES`, see `core/constants.ts:352`). Backend sync via `PERSONALIZATION_ENDPOINTS.{GET,UPDATE}_PREFERENCES` → `/user/me/preferences`. Exposed by `useArca().preferences` and `useArcaConfig().preferences`.

2. **Three-tier stack** — `ConfigManager` (`packages/agentic-sdk-v2/src/core/ConfigManager.ts`) → typed `AppConfig`. Persists to `IndexedDB 'arcaai-config' / store 'preferences' / key 'user-preferences'` with `localStorage['arcaai-user-preferences']` fallback (`providers/AgenticProvider.tsx:23-89`). Exposed by `useArcaConfig().resolvedConfig` and `setUserPreference()`.

Both stacks are mounted side-by-side inside `AgenticProvider` and both write back to the same Zustand store (`store/agenticStore.ts`). They have **no synchronisation** between each other — one can be stale while the other is fresh.

User profile (`/auth/me`) is **not** fetched by the provider; only the manually-invoked `useAuth().getMe()` populates `store.authUser`.

### 2.2 Backend side

| Concern | Controller | Path | Guard |
|---|---|---|---|
| Profile | `apps/api/src/modules/auth/auth.controller.ts:232` | `GET /auth/me` | `@Authorize()` |
| Aggregated preferences | `apps/api/src/modules/user/controllers/user-preferences.controller.ts` | `GET/PATCH /user/me/preferences` | `@Authorize()` |
| Raw settings KV | `apps/api/src/modules/user/controllers/user-settings.controller.ts` | `GET /user/me/settings`, `PATCH /user/me/settings/:namespace/:key` | `@Authorize()` |
| Prompt templates | `apps/api/src/modules/prompt-management/prompt-management.controller.ts:14-17` | `/prompt-templates/...` | `@Authorize()` ← **no permissions** |
| Department prompt config | `apps/api/src/modules/department/department.controller.ts:13-16,97-108` | `PATCH /admin/departments/:id/prompt-config` | `@Authorize()` ← **no permissions** |

The `@Authorize()` decorator without arguments sets `REQUIRED_PERMISSIONS_KEY = []`. `AuthorizationGuard` early-returns `true` when `!required || required.length === 0` (`packages/applications/src/authorization/authorization.guard.ts:97-100`). Effect: **authentication-only**, no role/permission enforcement.

Prisma `PromptTemplate` (`packages/database/src/prisma/db_main/prompt-template.prisma:15-61`) has `tenantId`, optional `departmentId`, and `createdBy` (audit), but **no `userId` ownership field** and **no marker that separates "department default" from "doctor personal overlay"**. The data layer therefore cannot represent personal prompt templates at all.

### 2.3 Cascade resolution path

`ConfigManager.resolve()` (`core/ConfigManager.ts:202-207`):

```
SYSTEM_DEFAULTS  ←  tenantOverrides  ←  userPreferences  =  resolved AppConfig
```

This is a **three-tier** cascade. The business requirement is a **four-tier** cascade: `system → tenant → department → user`. The department tier exists only as scattered values inside individual `Department` rows (`defaultSummaryTemplate`, `newPatientPromptId`, `revisitPromptId`, `promptConfig`) and is not woven into `AppConfig` at all. `CONFIG_PERMISSIONS` (`core/ConfigSchema.ts:81-109`) has no `'department'` permission level — `getFieldPermission` only returns `'system' | 'admin' | 'user'` (`core/ConfigSchema.ts:113-115`).

---

## 3. Public surface map

| SDK hook | SDK action | HTTP verb + path | Backend controller method | Auth |
|---|---|---|---|---|
| `useAuth` | `getMe()` | `GET /auth/me` | `AuthController.me` | `@Authorize()` (authn-only) |
| `useAuth` | `login()` | `POST /auth/login` | `AuthController.login` | `@Public()` |
| `useAuth` | `impersonate()` | `POST /auth/impersonate` | `AuthController.impersonate` | `@Authorize()` ⚠️ no role check at decorator |
| `useArcaConfig` / `PersonalizationManager` | `loadFromBackend()` | `GET /user/me/preferences` | `UserPreferencesController.getPreferences` | `@Authorize()` |
| `useArcaConfig` / `PersonalizationManager` | `update()` → `syncToBackend()` | `PATCH /user/me/preferences` (actually `POST` — see DEF-C2) | `UserPreferencesController.updatePreferences` (`@Patch`) | `@Authorize()` |
| `useUserSettings` | `list()` | `GET /user/me/settings` | `UserSettingsController.getMySettings` | `@Authorize()` |
| `useUserSettings` | `updateByKey(ns,key,v)` | `PATCH /user/me/settings/:namespace/:key` | `UserSettingsController.updateSetting` | `@Authorize()` |
| `useGlobalSettings` | various | `GET/POST/PATCH/DELETE /admin/settings...` | `GlobalSettingsController` | not in scope |
| `usePrompts` | `list()/get()/create()/update()/remove()` | `/prompt-templates`, `/prompt-templates/:id` | `PromptManagementController` | `@Authorize()` ⚠️ no permission, no tenant check |
| `usePrompts` | `assignToDepartment()` | `POST /prompt-templates/assign-department` | **❌ NOT IMPLEMENTED** | n/a — 404 |
| `usePrompts` | `getVersions()/getVersion()/activateVersion()` | `/prompt-templates/:id/versions/...` | `PromptManagementController` | same as above |
| `useDepartments` | `update(...prompt-config)` | `PATCH /admin/departments/:id/prompt-config` | `DepartmentController.updatePromptConfig` | `@Authorize()` ⚠️ + `DepartmentService.updatePromptConfig` does NOT check `tenantId` ownership |
| `useArcaConfig` | `setUserPreference(path, v)` | (none — IDB write only) | n/a | n/a |

---

## 4. Strengths

- **TASK-265 endpoint reduction is real.** `useUserSettings` (`hooks/useUserSettings.ts:18-24`) and `USER_SETTINGS_ENDPOINTS` (`core/constants.ts:410-413`) match `UserSettingsController` (`user-settings.controller.ts:27,41`). GAP-03 from TASK-262 has been **remediated**.
- **PHI key redaction wired into every transport.** `SDKLogger.dispatch` runs `redactPHI` before passing entries to transports (`core/logger/SDKLogger.ts:381-389`); `PHI_KEYS` covers `patientId`, `doctorId`, `transcript`, `audioBuffer`, etc. (`core/logger/redactor.ts:37-66`). `data:` / `blob:` / `file:` URL strings are redacted (`redactor.ts:186-193`). **TASK-262 W0-2 verified present.**
- **Cross-tab BroadcastChannel namespaced by tenant.** `SimpleCrossTabSync.channelName` returns `agentic.<tenantId>` when a tenant id is set (`core/SimpleCrossTabSync.ts:233-238`), and `setTenantId()` closes/reopens the channel on a runtime tenant switch (`SimpleCrossTabSync.ts:177-191`). The bare `'agentic'` name is no longer reachable. TASK-262 H-6 is **partially** remediated — see DEF-S1 for the residual PHI in the fallback path.
- **Three-tier ConfigManager has permission gating.** `setUserValue` rejects writes to admin-only or tenant-locked paths (`ConfigManager.ts:68-87`). Read-only mode for impersonation exists (`ConfigManager.ts:146-180`).
- **Personalization tests cover happy-path CRUD.** `PersonalizationManager.test.ts`, `useArcaConfig.test.ts`, `ConfigManager.test.ts`, `useUserSettings.test.ts`, `usePrompts.test.ts` exist and run.

---

## 5. Defects

### 5.1 Critical

#### DEF-C1 — `PromptTemplate` schema cannot model personal overlays (violates BR-1)

- **Files**: `packages/database/src/prisma/db_main/prompt-template.prisma:15-61`; `packages/applications/src/services/prompt-management/prompt-management.service.ts:34-74`; `packages/agentic-sdk-v2/src/hooks/usePrompts.ts:46-170`.
- **Observed**: `PromptTemplate` carries `tenantId` + optional `departmentId` + audit `createdBy`. No `userId` ownership column, no `scope` discriminator (`tenant_default` vs `department_default` vs `user_personal`). `PromptManagementService.createPromptTemplate` only stamps `tenantId` and `createdBy` audit. `usePrompts.create()` does not pass any "personal" flag — it cannot, because the DTO has nowhere to put it.
- **Impact**: BR-1 ("Doctor users can make personal prompt templates for their department; MUST NOT impact default department prompt templates") is **structurally unimplementable** with the current schema. The "personal overlay" feature does not exist at the data layer.
- **Recommended fix**: extend the schema with a `scope` enum and an optional owner `userId`:

  ```prisma
  enum PromptTemplateScope {
      TENANT_DEFAULT
      DEPARTMENT_DEFAULT
      USER_PERSONAL
      @@schema("core")
  }

  model PromptTemplate {
      // ... existing fields ...
      scope        PromptTemplateScope @default(TENANT_DEFAULT)
      ownerUserId  String?
      User         User?               @relation(fields: [ownerUserId], references: [id])

      @@index([tenantId, scope])
      @@index([ownerUserId])
      @@unique([tenantId, departmentId, ownerUserId, name])
  }
  ```

  Then split the service into `listDefaultsForDepartment`, `listMyPersonalForDepartment`, `createPersonal(...)` (forces `scope = USER_PERSONAL`, stamps `ownerUserId = this.requestUserId`, rejects requests trying to set `scope = *_DEFAULT` unless the caller has `manage PromptTemplate`).

#### DEF-C2 — `PromptManagementController` allows any authenticated user to mutate any tenant's templates (IDOR + permission bypass)

- **Files**: `apps/api/src/modules/prompt-management/prompt-management.controller.ts:14-17,87-101`; `packages/applications/src/services/prompt-management/prompt-management.service.ts:76-100,130-134,177-188`; `packages/applications/src/authorization/authorization.guard.ts:94-100`.
- **Observed**:
  1. The controller is decorated `@Authorize()` (no permissions, no subject). `AuthorizationGuard.canActivate` short-circuits to `true` when `required.length === 0` (`authorization.guard.ts:98`).
  2. `PromptManagementService.updatePromptTemplate(id, dto)` (`prompt-management.service.ts:79`) calls `findById(id)` and writes — **never** verifies `template.tenantId === this.tenantId`, **never** verifies `template.createdBy === this.requestUserId`.
  3. `softDeletePromptTemplate(id)` (`prompt-management.service.ts:178`) and `getPromptTemplate(id)` (`prompt-management.service.ts:131`) have the same hole.
- **Impact**: A doctor user — or any authenticated patient/external API key holder — who learns a `promptTemplateId` (UUIDv7 is monotonic, so adjacent IDs are guessable) can `PATCH` or `DELETE` **any tenant's** prompt template, including tenant admin defaults and other tenants' templates. Cross-tenant data corruption + violates BR-1 ("personal changes MUST NOT impact the default department prompt templates").
- **Recommended fix** (two parts):

  Controller — require a real CASL permission:

  ```ts
  @Controller('prompt-templates')
  @Authorize(['read', 'PromptTemplate'])
  export class PromptManagementController {
      @Patch(':id')
      @Authorize(['update', 'PromptTemplate'])
      async update(@Param('id') id: string, @Body() request: UpdatePromptTemplateRequest) { ... }

      @Delete(':id')
      @Authorize(['delete', 'PromptTemplate'])
      async remove(@Param('id') id: string) { ... }
  }
  ```

  Service — enforce tenant scope and (post DEF-C1) personal-ownership rule in every mutation:

  ```ts
  async updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest) {
      const tenantId = this.tenantId;
      const userId = this.requestUserId;
      if (!tenantId) throw new BadRequestException('Tenant ID is required');

      const template = await this.promptTemplateRepository.findById(id);
      if (!template || template.tenantId !== tenantId) {
          throw new NotFoundException(`Prompt template ${id} not found`);
      }
      if (template.scope === PromptTemplateScope.USER_PERSONAL && template.ownerUserId !== userId) {
          throw new ForbiddenException('Cannot modify another user\'s personal template');
      }
      if (template.scope !== PromptTemplateScope.USER_PERSONAL && !this.ability.can('manage', 'PromptTemplate')) {
          throw new ForbiddenException('Only tenant admins can modify default templates');
      }
      // ...existing version-snapshot + update...
  }
  ```

  Apply the same scope check to `getPromptTemplate`, `softDeletePromptTemplate`, and the `assign-department` endpoint (DEF-C4).

#### DEF-C3 — `DepartmentController.updatePromptConfig` lets any authenticated user mutate any department's default prompts (cross-tenant IDOR)

- **Files**: `apps/api/src/modules/department/department.controller.ts:13-16,97-108`; `packages/applications/src/services/department/department.service.ts:216-240`.
- **Observed**: Controller `@Authorize()` with no permissions. Service `updatePromptConfig` (line 217) does `findById(id)` without verifying `department.tenantId === this.tenantId` and without any role check. Compare with `update()` at line 157-201 of the same service, which **does** verify tenant ownership at line 169-171 — the prompt-config path skipped this guard.
- **Impact**: A doctor user in Tenant A can swap Tenant B's department defaults (`newPatientPromptId`, `revisitPromptId`, `preSummaryPromptId`) just by knowing a department id. This is the exact "personal changes must not impact tenant-admin defaults" violation called out in BR-1, except it goes further — it lets a doctor mutate a *different tenant's* admin defaults.
- **Recommended fix**:

  ```ts
  @ApiEndpoint({ ... path: ':id/prompt-config', ... })
  @Authorize(['manage', 'Department'])  // or a finer-grained ['update', 'DepartmentPromptConfig']
  async updatePromptConfig(@Param('id') id: string, @Body() request: UpdateDepartmentPromptConfigRequest) { ... }

  // department.service.ts
  async updatePromptConfig(id: string, dto: UpdateDepartmentPromptConfigRequest) {
      const tenantId = this.tenantId;
      if (!tenantId) throw new BadRequestException('Tenant ID is required');

      const department = await this.departmentRepository.findById(id);
      if (!department || department.tenantId !== tenantId) {
          throw new NotFoundException(`Department ${id} not found`);
      }
      // ...existing assignment logic...
  }
  ```

#### DEF-C4 — SDK calls `POST /prompt-templates/assign-department` but the route does not exist

- **Files**: `packages/agentic-sdk-v2/src/core/constants.ts:160`; `packages/agentic-sdk-v2/src/hooks/usePrompts.ts:125-129`; backend (no match).
- **Observed**: `PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT = '/prompt-templates/assign-department'`. `usePrompts.assignToDepartment` POSTs to it. `PromptManagementController` exposes no `assign-department` route (`prompt-management.controller.ts:14-160` lists every handler — none match). The DTO exists (`packages/applications/src/services/prompt-management/dto/assign-department-prompt.request.ts`) but no controller method consumes it.
- **Impact**: Every call from the playground / admin UI to `assignToDepartment` will 404. Tests pass because they mock the `apiClient.post`, not the network. This was on the TASK-262 GAP-list and is **still unfixed**.
- **Recommended fix**: implement the missing controller method, route it through the prompt-template service, and gate it on `@Authorize(['manage', 'Department'])` (because the side effect is mutating department defaults, not prompt-template content):

  ```ts
  @Post('assign-department')
  @Authorize(['manage', 'Department'])
  async assignToDepartment(@Body() dto: AssignDepartmentPromptRequest): Promise<void> {
      return this.promptService.assignToDepartment(dto);
  }
  ```

  Add a service method that delegates to `DepartmentService.updatePromptConfig` after enforcing the tenant scope from DEF-C3.

#### DEF-C5 — `ConfigManager` is a 3-tier cascade; the requirement mandates 4 tiers (no department tier)

- **Files**: `packages/agentic-sdk-v2/src/core/ConfigManager.ts:14-25,202-207`; `packages/agentic-sdk-v2/src/core/ConfigSchema.ts:81-109,113-115`; `packages/agentic-sdk-v2/src/core/__tests__/ConfigManager.test.ts:29` (test suite literally titled `'3-tier merge'`).
- **Observed**: `resolve()` merges `SYSTEM_DEFAULTS ← tenantOverrides ← userPreferences`. No `departmentOverrides` field on the manager, no department metadata in `CONFIG_PERMISSIONS`, no department-fetch in `AgenticProvider`'s init block. `/auth/me` (`auth.controller.ts:271-281`) intentionally omits `departmentId` from `MeResponse` (`tenantId` is commented out too), so the SDK has no way to even *know* which department's defaults to fetch.
- **Impact**: BR-3 ("system → tenant → department → user") is unimplemented. Today a department's `promptConfig` JSONB on `Department` (set via DEF-C3's broken endpoint) is invisible to the cascade; consumer hooks reading `useArcaConfig().resolvedConfig` will never see a department-scoped override.
- **Recommended fix**: 4-tier cascade in three steps.

  1. Extend the cascade:

      ```ts
      // ConfigManager.ts
      private departmentOverrides: DeepPartial<AppConfig> = {};
      private departmentLockedPaths: Set<string> = new Set();

      setDepartmentConfig(overrides: DeepPartial<AppConfig>, lockedPaths: string[] = []): void {
          this.departmentOverrides = overrides;
          this.departmentLockedPaths = new Set(lockedPaths);
          this.resolve();
          this.emit('departmentConfigChanged', this.resolved);
      }

      private resolve(): void {
          const afterTenant = deepmerge(SYSTEM_DEFAULTS, this.tenantOverrides) as AppConfig;
          const afterDept   = deepmerge(afterTenant, this.departmentOverrides) as AppConfig;
          const allowedUserPrefs = this.stripLockedAndAdminPaths(this.userPreferences);
          const merged     = deepmerge(afterDept, allowedUserPrefs) as AppConfig;
          this.resolved    = v.parse(AppConfigSchema, merged);
      }
      ```

      Treat `departmentLockedPaths ∪ tenantLockedPaths` as the user's locked set.

  2. Expose `departmentId` on `MeResponse` (`apps/api/src/modules/auth/dto/me.response.ts`) and re-enable the `tenantId` field; `AuthController.me` already has the user row.

  3. In `AgenticProvider.tsx:295-340`, fetch the doctor's department config (`GET /admin/departments/:id/prompt-config` — or a new `/department/me/config` endpoint that resolves from JWT — and call `configManager.setDepartmentConfig(...)` BEFORE `loadUserPreferences()`.

  Add at least one ConfigManager test asserting `(tenant=X) + (department=Y) + (user=Z) → Z` and `(tenant=X) + (department=Y) + (user=undefined) → Y`.

#### DEF-C6 — `AgenticProvider` does NOT preload the user profile; downstream hooks fire before profile/settings are ready (violates BR-2)

- **Files**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:154-376`; `packages/agentic-sdk-v2/src/hooks/useAuth.ts:118-136`.
- **Observed**: The init `useEffect` fetches tenant config (lines 263-277), starts personalization sync (lines 237-260), and loads ConfigManager user prefs (lines 294-340). It **never** calls `getMe()` / `GET /auth/me`. The user profile only enters `store.authUser` if a consumer manually invokes `useAuth().getMe()`. Meanwhile `store.setConfigReady(true)` is set even on the error path (line 332) and is **independent of whether the profile has loaded**.
- **Impact**: BR-2 ("must be able to fetch profile, cache settings, load them, and have them ready before exercising any SDK capability") is violated. Child components calling `useArca()` / `useArcaConfig()` cannot tell whether the user is authenticated and which department they belong to — `store.authUser` is `null` until *they* call `getMe()`. The `configReady` flag promises something it doesn't deliver: it just means "system + tenant tiers merged"; the user tier and the profile are not gated.
- **Recommended fix**: add a `profileReady` state, wire the profile fetch into the init effect, and gate `configReady` on profile+prefs both succeeding.

  ```ts
  // AgenticProvider.tsx (inside the init effect, before configOp)
  const meOp = providerLogger.startOperation('loadProfile');
  let me: AuthUser | null = null;
  try {
      me = await apiClient.get<AuthUser>(AUTH_ENDPOINTS.ME);
      store.setAuthUser(me);
      store.setIsAuthenticated(true);
      meOp.end(true);
  } catch (err) {
      meOp.error(err as Error);
      // Non-fatal: SDK still works unauthenticated; downstream hooks see store.authUser = null.
  }

  // Only after we know `me`, hydrate department + user prefs, then set ready.
  if (me?.departmentId) {
      const deptCfg = await apiClient.get(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(me.departmentId));
      configManager.setDepartmentConfig(adaptDeptCfg(deptCfg));
  }
  await configManager.loadUserPreferences();
  store.setResolvedConfig(configManager.getResolved());
  store.setConfigReady(true);
  ```

  Add a `configReady` precondition to every mutation hook (`useArca`, `useArcaConfig.update`, `usePrompts.create`) so callers cannot fire before settings are loaded — or expose a `useArcaConfigReady()` boolean for app shells to gate their UI.

  Tests must cover: (a) `configReady === false` until `/auth/me` resolves; (b) `getMe()` failure leaves `configReady` false and surfaces the error; (c) department config is merged before `configReady` flips true.

### 5.2 High

#### DEF-H1 — Persisted preferences are NOT scoped per-user-per-tenant; previous user's prefs leak across logouts

- **Files**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:23-26,62-89`; `packages/agentic-sdk-v2/src/core/constants.ts:351-355`; `packages/agentic-sdk-v2/src/store/agenticStore.ts:456-465`.
- **Observed**:
  1. `IDB_DB_NAME='arcaai-config'`, `IDB_STORE_NAME='preferences'`, `IDB_KEY='user-preferences'` — single global record keyed only by `'user-preferences'`. No `userId`, no `tenantId` partitioning.
  2. `STORAGE_KEYS.PREFERENCES='arcaai-preferences'` — same single global record for the legacy stack.
  3. `clearOnLogout` (`agenticStore.ts:456-465`) `removeItem`s the **localStorage** keys but does **not** delete the IndexedDB record.
- **Impact**: User A logs out, User B logs in on the same browser — `loadUserPreferencesFromStorage()` returns User A's IndexedDB blob. User B's `useArcaConfig().resolvedConfig` is poisoned with A's overlay. Violates BR-1 (isolation) and BR-4 (correct persistence semantics across reloads).
- **Recommended fix**: namespace storage keys, and clear IDB on logout/impersonation switch.

  ```ts
  // AgenticProvider.tsx
  const userScope = () => {
      const u = store.authUser as { id?: string } | null;
      const t = configRef.current.api.tenantId ?? 'no-tenant';
      return `${t}::${u?.id ?? 'anonymous'}`;
  };
  const idbKey = `user-preferences/${userScope()}`;
  const lsKey  = `arcaai-user-preferences/${userScope()}`;
  ```

  In `clearOnLogout`:

  ```ts
  clearOnLogout: async () => {
      try {
          const db = await openConfigDB();
          const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
          tx.objectStore(IDB_STORE_NAME).clear();
      } catch { /* swallow */ }
      // ...existing localStorage removeItem calls...
  }
  ```

  In `AgenticProvider`, re-hydrate ConfigManager whenever `store.authUser?.id` changes (or `authImpersonatedUser` flips), not only on mount.

#### DEF-H2 — `PersonalizationManager` syncs the wrong HTTP verb (POST instead of PATCH) against `/user/me/preferences`

- **Files**: `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:269`; `apps/api/src/modules/user/controllers/user-preferences.controller.ts:32-43`.
- **Observed**: `syncToBackend` calls `apiClient.post(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES, payload)`. The controller registers the update handler as `@Patch()`. NestJS will not route a `POST` to a `@Patch()` handler — the request hits the controller path but the verb mismatch produces a 404 (or 405 if a `POST` handler exists on the same path; here none does).
- **Impact**: Every "hybrid" / "backend" mode call to update preferences silently fails on the server. The local copy is kept (because hybrid swallows the error at `PersonalizationManager.ts:154-159`), so users *think* their changes saved, but a reload from the backend reverts them. Violates BR-2 ("settings ready") and BR-4 ("persistence").
- **Recommended fix**:

  ```ts
  // PersonalizationManager.ts:269
  await this.apiClient.patch(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES, payload);
  ```

  Add an integration test that goes through `AgenticClient.patch` rather than mocking it.

#### DEF-H3 — `useArcaConfig` and `useArca` subscribe to the entire Zustand store, forcing whole-app re-renders on any state change

- **Files**: `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts:94`; `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts` (same pattern); granular selectors that already exist at `store/agenticStore.ts:553-574`.
- **Observed**: `const store = useAgenticStore();` without a selector subscribes to the whole `AgenticState`. The store mutates on every transcript segment, every audio level tick, every model-registry version bump (`incrementModelRegistryVersion`). Each tick re-renders every component that calls `useArcaConfig` — and the dependency-array of the returned `useMemo` includes `store.preferences`, `store.tenantConfig`, `store.resolvedConfig`, `store.configReady`, etc., but is keyed off `store` itself.
- **Impact**: For a 30-minute consultation streaming audio at ~50 Hz audio-level updates, the settings panel re-renders ~90 000 times even when no setting changed. CPU and battery drain on the doctor's tablet. Reactivity remains *correct* (because the underlying values don't change), but the cost is high.
- **Recommended fix**: subscribe selectively.

  ```ts
  // useArcaConfig.ts
  const preferences          = useAgenticStore(selectPreferences);
  const tenantConfig         = useAgenticStore(selectTenantConfig);
  const resolvedConfig       = useAgenticStore(selectResolvedConfig);
  const configReady          = useAgenticStore(selectConfigReady);
  const personalizationMgr   = useAgenticStore(s => s.personalizationManager);
  const configManager        = useAgenticStore(selectConfigManager);
  const modelRegistry        = useAgenticStore(s => s.modelRegistry);
  const modelRegistryVersion = useAgenticStore(s => s.modelRegistryVersion);
  const logger               = useAgenticStore(selectLogger);
  ```

  And use shallow equality (`useAgenticStore(selector, shallow)`) where the selected slice is an object.

#### DEF-H4 — Two parallel preference stores (PersonalizationManager + ConfigManager) drift apart

- **Files**: `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:202-219` (localStorage `'arcaai-preferences'`); `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:62-89` (IndexedDB `'arcaai-config'`); `packages/agentic-sdk-v2/src/store/agenticStore.ts:564` (`selectPreferences`) vs `:573` (`selectResolvedConfig`).
- **Observed**: `useArcaConfig` exposes both `preferences` (legacy, from `PersonalizationManager`) and `resolvedConfig` (typed, from `ConfigManager`). `update()` writes through `PersonalizationManager` only. `setUserPreference()` writes through `ConfigManager` only. There is no reconciliation pass; the two storages never read each other.
- **Impact**: Consumer apps that call `update({ language: 'th' })` won't see `resolvedConfig.ui.language` change. Consumer apps that call `setUserPreference('ui.language','th')` won't see `preferences.language` change. The "single source of truth" is split.
- **Recommended fix** (lower-cost): pick one as the canonical store. Recommendation: keep `ConfigManager` (typed, permission-aware, locked-paths), deprecate `PersonalizationManager`'s `localConfig` blob, and make `PersonalizationManager.updatePreferences` forward into `ConfigManager.setUserValue` for any field that has a `CONFIG_PERMISSIONS` entry. Higher-cost: merge them.

#### DEF-H5 — `AgenticProvider` loads tenant config TWICE on mount

- **Files**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:263-277,294-316`.
- **Observed**: First call at line 264 (`modelRegistry.loadTenantConfig()` → `store.setTenantConfig`); a second `await modelRegistry.loadTenantConfig()` at line 300 inside the ConfigManager IIFE. Both fire on mount, both hit the network. Strict Mode double-mount further doubles this.
- **Impact**: 2× requests for the same data, latency added to the ready signal, and a small race window where the second call's `tenantOverrides` may be applied before the first call's `setTenantConfig` resolves.
- **Recommended fix**: cache the promise.

  ```ts
  const tenantCfgPromise = modelRegistry.loadTenantConfig();
  tenantCfgPromise.then((tc) => store.setTenantConfig(tc)).catch(/* ... */);
  // ...
  const tenantCfg = await tenantCfgPromise;
  ```

#### DEF-H6 — `clearSensitiveData()` does not invalidate `preferences` or `resolvedConfig` after logout / impersonation switch

- **Files**: `packages/agentic-sdk-v2/src/store/agenticStore.ts:416-438`.
- **Observed**: `clearSensitiveData` clears auth + consultation + transcript state but leaves `preferences`, `tenantConfig`, `resolvedConfig`, and the `configManager` instance intact. `clearOnLogout` clears localStorage but not the in-memory store of preferences.
- **Impact**: After logout, the previous user's resolved preferences remain visible until the page is reloaded. Combined with DEF-H1, this means a casual "log out, log in as another user" doesn't truly switch the personalization view.
- **Recommended fix**: clear the in-memory preference slices in `clearOnLogout` and re-create `configManager` on next mount keyed to the new user.

  ```ts
  clearOnLogout: () => {
      // ...existing localStorage removeItem...
      set({
          preferences: { ...DEFAULT_PREFERENCES },
          tenantConfig: null,
          resolvedConfig: null,
          configReady: false,
          configManager: null,
          personalizationManager: null,
          // ...rest of the existing reset...
      });
  }
  ```

### 5.3 Medium

#### DEF-M1 — Residual PHI in BroadcastChannel name when `tenantId` is missing

- **Files**: `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts:132-138,233-238`.
- **Observed**: `consultationKey` is `${patientId}_${doctorId}_${appointmentDate}`. When no `tenantId` is provided, `channelName()` returns `agentic.${consultationKey}` — raw PHI in the channel name visible in DevTools. The earlier TASK-262 H-6 fix prevented the *bare* `'agentic'` channel but kept this fallback.
- **Impact**: In any code path where `AgenticProvider` mounts before `config.api.tenantId` is known (e.g. token-only bootstrap), DevTools shows the channel name with the patient + doctor ids until `setTenantId(...)` reopens it.
- **Recommended fix**: hash the fallback.

  ```ts
  // SimpleCrossTabSync.ts
  private async hashFallback(consultationKey: string): Promise<string> {
      const bytes = new TextEncoder().encode(consultationKey);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest, 0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  ```

  Make the channel name async on construction or precompute the hash in `openChannel`. Tests must assert the channel name does not contain a raw UUID-shaped substring.

#### DEF-M2 — `PromptManagementService.listPromptTemplates` returns disabled-by-default but every call site asks for them anyway

- **Files**: `packages/applications/src/services/prompt-management/prompt-management.service.ts:136-157`; `apps/api/src/modules/prompt-management/prompt-management.controller.ts:43-64`; `packages/agentic-sdk-v2/src/hooks/usePrompts.ts:62-79`.
- **Observed**: Service hides disabled when `includeDisabled !== true`. Controller parses `includeDisabled === 'true'`. SDK never passes `includeDisabled`. After pagination is applied client-side at the controller (slice in JS), the response can fluctuate when the underlying enabled-set changes between calls.
- **Impact**: Minor — UX flicker, but also a real SQL anti-pattern: full table read followed by `Array.slice()` in JS.
- **Recommended fix**: push pagination into the repository (`take`/`skip` in Prisma), and pass `includeDisabled` through a typed `ListPromptTemplatesQuery` DTO.

#### DEF-M3 — `useUserSettings.list()` swallows pagination metadata

- **Files**: `packages/agentic-sdk-v2/src/hooks/useUserSettings.ts:30-39`; backend returns a flat array (`UserSettingsController.getMySettings` returns `UserSettingsResponse[]`).
- **Observed**: SDK calls `appendPagination(url, pagination)` but the backend ignores `page`/`limit` and returns *all* settings unbounded. For doctor users with many `arcaai-sdk.*` keys this is wasteful; for the playground it's irrelevant.
- **Impact**: Minor wire bloat. Not a correctness defect, but the API surface promises something the backend does not honour.
- **Recommended fix**: either implement pagination on the backend (`take/skip` against `UserSettingsRepository`) or drop the `pagination` param from the SDK signature to match reality.

#### DEF-M4 — `useArca().preferences` and `useArcaConfig().preferences` derive from the SAME store slice but expose unfreezable mutable shapes

- **Files**: `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts:254`; `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:84-86`.
- **Observed**: `getPreferences()` returns a shallow clone of `preferences`. Mutating `prefs.localConfig` from consumer code mutates the same nested objects held by `this.preferences.localConfig` (shallow clone, not deep).
- **Impact**: Subtle bugs in playground code that nests `localConfig.audio.foo = ...` — the change is then auto-persisted on next sync without going through `updatePreferences`.
- **Recommended fix**: deep-clone on return, or freeze.

### 5.4 Low

#### DEF-L1 — `STORAGE_KEYS.SESSION_STATE` is defined but not used anywhere

- **File**: `packages/agentic-sdk-v2/src/core/constants.ts:354`.
- **Observed**: Grep returns zero readers. Dead constant.
- **Fix**: remove, or wire it up to a session-restore feature.

#### DEF-L2 — `usePrompts.assignToDepartment` has 4 tests but mocks `apiClient.post` so the missing route (DEF-C4) is invisible to CI

- **File**: `packages/agentic-sdk-v2/src/hooks/__tests__/usePrompts.test.ts:201-650`.
- **Observed**: Each test mocks the client. None probes the real Nest route (which doesn't exist).
- **Fix**: add an integration test in `apps/api/test/...` that exercises `POST /prompt-templates/assign-department` against the live `INestApplication`. It will currently red until DEF-C4 is fixed — that's the point.

#### DEF-L3 — `ConfigManager.loadUserPreferences` swallows ALL load errors silently

- **File**: `packages/agentic-sdk-v2/src/core/ConfigManager.ts:113-125`.
- **Observed**: `try { ... } catch { /* Silently fall back to defaults */ }`. No logger call, no metric, no `onError` callback.
- **Impact**: A corrupted IDB record (likely after DEF-H1's per-user partition is introduced) will silently revert to defaults; ops will not know.
- **Fix**: surface via the SDK logger that AgenticProvider already wires in.

---

## 6. Security findings (HIPAA, PII, permission boundary)

| Finding | Defect ID | Severity | Status |
|---|---|---|---|
| Doctor can mutate ANY tenant's prompt templates | DEF-C2 | Critical | Open |
| Doctor can mutate ANY tenant's department prompt config | DEF-C3 | Critical | Open |
| Patient/external user can hit prompt-template endpoints (any authenticated principal does) | DEF-C2 | Critical | Open |
| Cross-user preference leak across logout (shared browser) | DEF-H1 | High | Open |
| Stale auth user data + preferences in store after logout | DEF-H6 | High | Open |
| Residual PHI in cross-tab BroadcastChannel name (fallback path only) | DEF-M1 | Medium | Partially remediated by TASK-262 H-6 |
| `redactPHI` applied to every transport entry | n/a | OK | TASK-262 W0-2 verified |
| BroadcastChannel HMAC signing + per-tenant namespace | n/a | OK | TASK-262 W0-4/5 verified |
| `/auth/me` returns minimal fields (no tenantId/department leak) | n/a | OK (but blocks BR-3 — see DEF-C5) | |

**Permission boundary verdict**: **FAIL**. `@Authorize()` with no permissions is used as a "any authenticated user" guard on routes that mutate shared admin data (`PromptManagementController`, `DepartmentController.updatePromptConfig`, and likely others in adjacent reviewers' scope). Every mutation route that touches data shared across users MUST require a CASL permission (e.g. `['update','PromptTemplate']`) AND every service method MUST verify `tenantId` ownership.

---

## 7. Performance findings

| ID | Issue | File | Cost | Recommended fix |
|---|---|---|---|---|
| PERF-1 | Whole-store subscription in `useArcaConfig` causes re-render on every audio-level tick | `hooks/useArcaConfig.ts:94` | High during sessions | Selector subscriptions (DEF-H3) |
| PERF-2 | Tenant config loaded twice on mount | `providers/AgenticProvider.tsx:263-277,300` | One extra round-trip on every mount, doubled in Strict Mode | Promise cache (DEF-H5) |
| PERF-3 | `listPromptTemplates` paginates after fetching the whole result | `prompt-management.service.ts:136-157`; `prompt-management.controller.ts:43-64` | O(N) per request | Push to Prisma `take/skip` (DEF-M2) |
| PERF-4 | `PersonalizationManager.syncToBackend` retries indefinitely on `setInterval(..., DEFAULT_SYNC_INTERVAL)` even after auth failure | `PersonalizationManager.ts:359-395` | Continuous background traffic from logged-out tabs | Stop sync on 401/403 / on `clearOnLogout` |
| PERF-5 | `JSON.parse(JSON.stringify(...))` for snapshot/restore in `ConfigManager.snapshotUserPreferences` | `ConfigManager.ts:167-180` | Negligible at current size, watch as schema grows | Switch to `structuredClone` when the SDK targets browsers that support it (already required by IndexedDB code path) |

---

## 8. Test coverage gaps

| Behavior | Test exists? | Where it should live |
|---|---|---|
| `configReady` is false until `/auth/me` resolves | ❌ | `providers/__tests__/AgenticProvider.test.tsx` |
| Profile fetch failure blocks `configReady` | ❌ | same |
| Four-tier cascade: `system + tenant + department + user` precedence | ❌ (only 3-tier exists) | `core/__tests__/ConfigManager.test.ts` |
| Doctor in Tenant A cannot mutate Tenant B's prompt template (cross-tenant IDOR) | ❌ | `apps/api/src/modules/prompt-management/__tests__/prompt-management.e2e.test.ts` |
| Non-admin doctor cannot `PATCH /admin/departments/:id/prompt-config` | ❌ | `apps/api/.../department.e2e.test.ts` |
| `POST /prompt-templates/assign-department` returns 201, not 404 | ❌ (mocked-only) | new e2e test (DEF-L2) |
| User-scoped IndexedDB key — User A's prefs do not bleed into User B's session | ❌ | `providers/__tests__/AgenticProvider.test.tsx` impersonation suite |
| Personal prompt template cannot be modified by another doctor in the same tenant | ❌ | after DEF-C1 schema fix |
| `PersonalizationManager.syncToBackend` uses PATCH not POST | ❌ (mocks both) | `core/__tests__/PersonalizationManager.test.ts` with a fake `AgenticClient` recording verb |
| BroadcastChannel fallback name does not contain raw `patientId`/`doctorId` | ❌ | `core/__tests__/SimpleCrossTabSync.test.ts` |
| `clearOnLogout` wipes IDB user-preferences | ❌ | `store/__tests__/agenticStore.test.ts` |
| Highlight transport receives `[REDACTED]` for `doctorId` not the raw id | partial | `core/logger/__tests__/highlight.transport.test.ts` (verify end-to-end through SDKLogger.dispatch) |

---

## 9. Conformance to the business requirement

### 9.1 Personal vs tenant/department default isolation — **VERDICT: FAIL**

Evidence:
- Schema: `PromptTemplate` has no `userId` / `scope` (DEF-C1).
- Service: `updatePromptTemplate(id)` performs no `tenantId` ownership check, no `createdBy` check (DEF-C2 — `packages/applications/src/services/prompt-management/prompt-management.service.ts:79`).
- Controller: `@Authorize()` is empty (DEF-C2, DEF-C3).
- API: `POST /prompt-templates/assign-department` does not exist (DEF-C4).

A doctor user today can `PATCH /prompt-templates/<tenant-admin-default-id>` and overwrite the tenant default. The schema cannot even distinguish "personal" from "default", so isolation is structurally impossible.

### 9.2 Profile fetch + cache + load lifecycle — **VERDICT: FAIL**

Evidence:
- `AgenticProvider` mount-effect (`providers/AgenticProvider.tsx:154-376`) never calls `/auth/me`.
- `useAuth().getMe()` is a manual call site (`hooks/useAuth.ts:118-136`); nothing in the SDK invokes it automatically.
- `store.setConfigReady(true)` flips even when no profile was fetched (`providers/AgenticProvider.tsx:322,332`).
- Two persistence stores (`PersonalizationManager` localStorage + `ConfigManager` IndexedDB) do not synchronise (DEF-H4).

Consumers can call `useArcaConfig` while `authUser === null`. There is no documented gate for "everything is ready".

### 9.3 Cascade order — **VERDICT: FAIL**

Evidence:
- `ConfigManager.resolve` is documented and tested as 3-tier (`core/ConfigManager.ts:14-25`; `core/__tests__/ConfigManager.test.ts:29 'describe(3-tier merge)'`).
- Department defaults live in `Department.promptConfig` JSONB and `Department.{preSummaryPromptId, newPatientPromptId, revisitPromptId}` (`packages/database/src/prisma/db_main/department.prisma`) but are not merged into `AppConfig`.
- `MeResponse` omits `departmentId` (`apps/api/src/modules/auth/auth.controller.ts:271-281`), so the SDK cannot fetch department config even if a tier existed.

### 9.4 Persistence across reload — **VERDICT: PARTIAL FAIL**

Evidence:
- IDB persistence works on the happy path — `loadUserPreferencesFromStorage` correctly reads back on reload (`providers/AgenticProvider.tsx:62-89`).
- BUT the keys are global, so a second user on the same browser sees the previous user's prefs (DEF-H1).
- `clearOnLogout` does not clear IDB (DEF-H1).
- `PersonalizationManager.syncToBackend` issues a `POST` against a `@Patch()` handler (DEF-H2), so backend persistence silently fails for the legacy stack.

Per-user persistence across reload **on the same logged-in user** works. Per-user isolation across user switches does **not**.

---

## 10. Recommended fixes (prioritized)

### P0 — must fix before TASK-293 closes

1. **DEF-C1** — add `scope` enum + `ownerUserId` to `PromptTemplate`, migrate existing rows to `TENANT_DEFAULT`, update factory/mapper/repo/service. (Schema, domain, service.)
2. **DEF-C2** — gate `PromptManagementController` on `@Authorize(['*', 'PromptTemplate'])` per action and enforce tenant + owner checks in service. (Backend.)
3. **DEF-C3** — gate `DepartmentController.updatePromptConfig` on `@Authorize(['manage', 'Department'])` and enforce tenant check in service. (Backend.)
4. **DEF-C4** — implement the missing `POST /prompt-templates/assign-department` route. (Backend.)
5. **DEF-C5** — extend `ConfigManager` to a 4-tier cascade with `setDepartmentConfig`; add department tier in `CONFIG_PERMISSIONS`; surface `departmentId` from `/auth/me`; hydrate in `AgenticProvider`. (SDK + backend.)
6. **DEF-C6** — preload `/auth/me` in `AgenticProvider` before `configReady` flips. Block downstream hook mutations on `configReady === false`. (SDK.)
7. **DEF-H1** — namespace IndexedDB / localStorage keys by `${tenantId}::${userId}`; clear IDB in `clearOnLogout`. (SDK.)
8. **DEF-H2** — change `apiClient.post` → `apiClient.patch` in `PersonalizationManager.syncToBackend`. (One-line fix; ship today.)

### P1 — should fix this sprint

9. **DEF-H3** — replace bare `useAgenticStore()` with selector-scoped subscriptions in `useArcaConfig`, `useArcaContext`, and any other personalization hook that uses the whole-store hook. (SDK.)
10. **DEF-H4** — collapse `PersonalizationManager.localConfig` into `ConfigManager`; deprecate the duplicate path. (SDK.)
11. **DEF-H5** — single `tenantConfigPromise` in `AgenticProvider`. (SDK.)
12. **DEF-H6** — `clearOnLogout` resets `preferences/tenantConfig/resolvedConfig/configReady` slices. (SDK.)
13. **Test coverage** — add the 11 missing tests from §8.

### P2 — nice to have

14. **DEF-M1** — hash the BroadcastChannel fallback name.
15. **DEF-M2** — push prompt-template pagination into Prisma.
16. **DEF-M3** — implement (or remove) `useUserSettings.list` pagination.
17. **DEF-M4** — deep-clone in `getPreferences()`.
18. **DEF-L1** — remove unused `STORAGE_KEYS.SESSION_STATE`.
19. **DEF-L3** — log instead of swallow in `ConfigManager.loadUserPreferences`.

---

## 11. Per-package scorecard

| Package | Personalization correctness | Security | Perf | Test coverage |
|---|:-:|:-:|:-:|:-:|
| `@arcaai/vox` (`packages/agentic-sdk-v2`) | **D** (3-tier cascade, dual stores, no profile preload) | **C** (PHI redaction good; per-user persistence isolation bad) | **C** (whole-store subs, double tenant fetch) | **C** (CRUD covered; cascade/lifecycle/isolation uncovered) |
| `apps/api` prompt-management module | **F** (cannot model personal vs default) | **F** (cross-tenant IDOR + empty `@Authorize()`) | **C** (in-memory pagination) | **D** (no e2e for IDOR or assign-department) |
| `apps/api` department module | **C** | **F** (cross-tenant IDOR on `updatePromptConfig`) | **A** | **C** |
| `apps/api` user/profile module | **B** (`/auth/me` correct but minimal — by design) | **B** | **A** | **B** |
| `packages/database` (Prisma `PromptTemplate`) | **F** (no `userId`/`scope`) | n/a | n/a | n/a |
| `packages/applications` authorization layer | **C** (decorators are correct; empty `@Authorize()` callers misuse them) | **D** (silent allow on empty required) | **A** | **B** |

**Composite verdict**: the personalization story today is not safe for production doctor-user use against multi-tenant data. The seven P0 fixes above are the minimum bar.
