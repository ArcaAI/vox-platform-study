# TASK-218: Admin Panel E2E Test Gaps — Implementation Plan

**Ticket**: TASK-218
**Created**: 2026-02-24
**Last Updated**: 2026-02-24
**Status**: In Progress

---

## Requirement Analysis

E2E testing of the ARCAAI SDK v2 Vite example app (admin panel) against 68 user stories revealed a **20.6% pass rate (14/68)**. This plan addresses all identified gaps organized by priority.

### E2E Test Summary

| Category | Pass | Fail | Not Implemented |
|----------|------|------|-----------------|
| Users (CRUD, status, roles) | 3 | 2 | 0 |
| User Groups | 0 | 0 | 7 |
| Roles | 0 | 5 | 0 |
| Policies | 0 | 4 | 0 |
| Sessions | 1 | 0 | 0 |
| Tenant Config | 1 | 1 | 2 |
| Departments | 2 | 1 | 2 |
| Prompts | 4 | 1 | 4 |
| Storage/Buckets | 3 | 0 | 6 |
| STT Workflows | 0 | 7 | 0 |
| Global Admin | 0 | 7 | 5 |

---

## Architecture Overview

The admin panel follows a layered architecture:

```
Vite App (UI)  →  SDK Hooks (@arcaai/vox)  →  API Controllers (NestJS)  →  Application Services  →  Domain/DB
```

**UI patterns**: Tab components in `admin.tsx`, each tab is a self-contained component in `src/components/admin/`. Uses `@arcaai/ui` (shadcn-based) + `lucide-react` icons. CRUD via Dialog modals, AlertDialog confirmations, toast notifications.

**SDK patterns**: Hooks in `packages/agentic-sdk-v2/src/hooks/`, endpoint constants in `src/core/constants.ts`. Each hook uses `useApiOperation` for requests + `useState` for caching.

---

## Implementation Plan

### Priority 1: Remove UserGroup (Cleanup)

**Rationale**: UserGroup is unused (no API controller, no SDK hook, no UI). Users are managed through Departments. Removing dead code reduces maintenance burden.

#### Task 1.1: Remove UserGroup Prisma Models

**Files**:
- Modify: `packages/database/src/prisma/db_main/user.prisma`
- Modify: `packages/database/src/prisma/db_main/rbac.prisma`
- Modify: `packages/database/src/prisma/db_main/audit.prisma`
- Create: New Prisma migration

**Steps**:
1. Remove `UserGroupRoleAssignment` model (lines 56-92 in `user.prisma`)
2. Remove `UserGroup` model (lines 229-269 in `user.prisma`)
3. Remove `UserGroups` relation field from `User` model (line 135 in `user.prisma`)
4. Remove `UserGroupRoleAssignments` relation from `Role` model (line 55 in `rbac.prisma`)
5. Remove `UserGroupAssignment` and `UserGroup` from `ResourceType` enum (lines 109, 113 in `audit.prisma`)
6. Generate migration: `pnpm --filter @arcaai/database prisma migrate dev --name remove_user_groups`
7. Run `pnpm --filter @arcaai/database prisma generate`

#### Task 1.2: Remove UserGroup Domain Layer

**Files**:
- Delete: `packages/domains/src/entities/generated/core/UserGroupEntity.ts`
- Delete: `packages/domains/src/entities/generated/core/UserGroupAssignmentEntity.ts`
- Delete: `packages/domains/src/models/generated/core/UserGroupModel.ts`
- Delete: `packages/domains/src/models/generated/core/UserGroupAssignmentModel.ts`
- Delete: `packages/domains/src/mappers/generated/core/UserGroupEntityMapper.ts`
- Delete: `packages/domains/src/mappers/generated/core/UserGroupAssignmentEntityMapper.ts`
- Delete: `packages/domains/src/factories/generated/core/UserGroupFactory.ts`
- Delete: `packages/domains/src/factories/generated/core/UserGroupAssignmentFactory.ts`
- Delete: `packages/domains/src/repositories/generated/core/UserGroupRepository.ts`
- Delete: `packages/domains/src/repositories/generated/core/UserGroupAssignmentRepository.ts`
- Modify: All `index.ts` barrel files in each directory to remove exports
- Modify: `packages/domains/src/entities/generated/core/UserEntity.ts` — remove `UserGroups` relation
- Modify: `packages/domains/src/entities/generated/core/RoleEntity.ts` — remove `UserGroupAssignments` relation
- Modify: `packages/domains/src/entities/generated/core/PermissionEntity.ts` — remove `UserGroupAssignments` relation
- Modify: `packages/domains/src/models/generated/core/UserModel.ts` — remove `UserGroups` property
- Modify: `packages/domains/src/models/generated/core/RoleModel.ts` — remove `UserGroupAssignments` property
- Modify: `packages/domains/src/models/generated/core/PermissionModel.ts` — remove `UserGroupAssignments` property
- Modify: `packages/domains/src/mappers/generated/core/UserEntityMapper.ts` — remove `UserGroups` mapping
- Modify: `packages/domains/src/mappers/generated/core/RoleEntityMapper.ts` — remove `UserGroupAssignments` mapping
- Modify: `packages/domains/src/mappers/generated/core/PermissionEntityMapper.ts` — remove `UserGroupAssignments` mapping
- Modify: `packages/domains/src/enums/generated/ResourceType.ts` — remove `UserGroupAssignment`, `UserGroup`
- Modify: `packages/domains/src/common/events/eventTypes.ts` — remove `UserGroupCreated`, `UserGroupUpdated`
- Modify: `packages/domains/src/common/databaseServices/core/core.database.module.ts` — remove repository imports/providers

**Steps**:
1. Delete all standalone UserGroup/UserGroupAssignment files listed above
2. Remove UserGroup-related properties and imports from shared entity/model/mapper files
3. Remove from barrel exports (`index.ts` files)
4. Remove from `ResourceType` enum and event types
5. Remove from `core.database.module.ts` providers
6. Run `pnpm build --filter @arcaai/domains` to verify no broken imports

#### Task 1.3: Remove UserGroup Application Layer

**Files**:
- Delete: `packages/applications/src/services/user/userGroup/` (entire directory)
- Delete: `packages/applications/src/services/user/userGroupAssignment/` (entire directory)
- Modify: `packages/applications/src/authorization/policy.engine.ts` — remove `userGroupRoleAssignment` queries (lines ~243-248, ~534-537) and `invalidateUserGroup()` method (line ~603)
- Delete: All related test files in `__tests__/` directories

**Steps**:
1. Delete `userGroup/` and `userGroupAssignment/` service directories
2. In `policy.engine.ts`, remove the group-based policy loading logic (lines 243-248 where it queries `prisma.userGroupRoleAssignment.findMany()`) and the `findUsersByRoleViaGroups` logic (lines 534-537)
3. Remove `invalidateUserGroup()` cache method
4. Delete test files for UserGroup services and update policy engine tests
5. Run `pnpm build --filter @arcaai/applications` and `pnpm test --filter @arcaai/applications`

#### Task 1.4: Remove UserGroup from Seed Data and Docs

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/01-policy.ts` — remove `UserGroupRoleAssignment` and `UserGroup` policy rules
- Modify: `docs/RBAC_IMPLEMENTATION_AND_USAGE.md` — remove UserGroup references
- Modify: `docs/RBAC_BEST_PRACTICES.md` — remove UserGroup references
- Modify: `knowledge/database/01_DATA_MODEL.md` — remove UserGroup from data model docs
- Modify: `knowledge/04_ACCESS_CONTROL.md` — remove UserGroup from access control docs

---

### Priority 2: Tenant Management UI (for Tenant Admin)

**Rationale**: API exists at `GET/POST/PATCH/DELETE /api/v1/admin/tenants` + config endpoints. No UI or SDK hook exists.

#### Task 2.1: Create `useTenants` SDK Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useTenants.ts`
- Modify: `packages/agentic-sdk-v2/src/hooks/index.ts` — add export
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` — add/verify `TENANT_ENDPOINTS`

**Steps**:
1. Add endpoint constants (if not already present):
   ```typescript
   export const TENANT_ENDPOINTS = {
     LIST: '/admin/tenants',
     GET_BY_ID: (id: string) => `/admin/tenants/${id}`,
     CREATE: '/admin/tenants',
     UPDATE: (id: string) => `/admin/tenants/${id}`,
     DELETE: (id: string) => `/admin/tenants/${id}`,
     GET_CONFIGS: (id: string) => `/admin/tenants/configs/${id}`,
     UPDATE_CONFIGS: (id: string) => `/admin/tenants/configs/${id}`,
   };
   ```
2. Create `useTenants` hook following `useUsers` pattern with methods: `list`, `get`, `create`, `update`, `remove`, `getConfigs`, `updateConfigs`
3. Export from `hooks/index.ts`

#### Task 2.2: Create `TenantConfigTab` Component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/tenant-config-tab.tsx`

**Steps**:
1. Create component following `UsersTab` pattern
2. Sections:
   - **Tenant Info Card**: Display current tenant name, key, description, status
   - **Tenant Configs Table**: List configs with key, value, dataType, namespace columns
   - **Edit Config Dialog**: Modal to update individual config values
   - **Status Toggle**: Enable/disable tenant config entries
   - **Delete Config**: AlertDialog confirmation for config deletion
3. Use `useTenants` hook for data operations
4. Use `useToast()` for notifications

#### Task 2.3: Wire TenantConfigTab into Admin Panel

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/admin-code-examples.tsx`

**Steps**:
1. Import `TenantConfigTab`
2. Add `TabsTrigger` with `Settings` icon and "Tenant" label
3. Add `TabsContent` wrapping `<TenantConfigTab />`
4. Add code example entry

---

### Priority 3: Roles Management UI (for Tenant Admin)

**Rationale**: Full CRUD API exists at `/api/v1/admin/rbac/roles`. SDK `useRoles` hook exists but only exposes list + user-role assignment. No admin UI tab.

#### Task 3.1: Extend `useRoles` SDK Hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useRoles.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` — verify `ROLE_ENDPOINTS`

**Steps**:
1. Add missing methods to `useRoles`: `createRole`, `updateRole`, `deleteRole`, `assignPolicy`, `removePolicy`
2. Ensure `ROLE_ENDPOINTS` includes all needed paths:
   ```typescript
   export const ROLE_ENDPOINTS = {
     LIST: '/admin/rbac/roles',
     GET_BY_ID: (id: string) => `/admin/rbac/roles/${id}`,
     CREATE: '/admin/rbac/roles',
     UPDATE: (id: string) => `/admin/rbac/roles/${id}`,
     DELETE: (id: string) => `/admin/rbac/roles/${id}`,
     ASSIGN_POLICY: (roleId: string, policyId: string) => `/admin/rbac/roles/${roleId}/policies/${policyId}`,
     REMOVE_POLICY: (roleId: string, policyId: string) => `/admin/rbac/roles/${roleId}/policies/${policyId}`,
     // existing user-role endpoints
     USER_ROLES: (userId: string) => `/users/${userId}/roles`,
     ASSIGN_USER_ROLE: (userId: string) => `/users/${userId}/roles`,
     REMOVE_USER_ROLE: (userId: string, roleId: string) => `/users/${userId}/roles/${roleId}`,
   };
   ```

#### Task 3.2: Create `RolesTab` Component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/roles-tab.tsx`

**Steps**:
1. Create component following `UsersTab` pattern (Table + Dialog CRUD)
2. Features:
   - **Roles Table**: Name, Description, External Name, System Role (badge), Status, Actions
   - **Create Role Dialog**: name, description, externalName, isSystemRole toggle
   - **Edit Role Dialog**: Pre-filled form
   - **Delete Role**: AlertDialog with system role protection (block deletion of system roles)
   - **Expandable Row**: Show assigned policies with assign/remove buttons
   - **Policy Assignment**: Dialog to select and assign policies to a role
3. Use extended `useRoles` hook

#### Task 3.3: Wire RolesTab into Admin Panel

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/admin-code-examples.tsx`

**Steps**:
1. Import `RolesTab`
2. Add `TabsTrigger` with `Shield` icon and "Roles" label
3. Add `TabsContent` wrapping `<RolesTab />`
4. Add code example entry

---

### Priority 4: Policies Management UI (for Tenant Admin)

**Rationale**: Full CRUD API exists at `/api/v1/admin/rbac/policies`. No SDK hook or UI exists.

#### Task 4.1: Create `usePolicies` SDK Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/usePolicies.ts`
- Modify: `packages/agentic-sdk-v2/src/hooks/index.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`

**Steps**:
1. Add endpoint constants:
   ```typescript
   export const POLICY_ENDPOINTS = {
     LIST: '/admin/rbac/policies',
     GET_BY_ID: (id: string) => `/admin/rbac/policies/${id}`,
     CREATE: '/admin/rbac/policies',
     UPDATE: (id: string) => `/admin/rbac/policies/${id}`,
     DELETE: (id: string) => `/admin/rbac/policies/${id}`,
     VALIDATE: '/admin/rbac/policies/validate',
   };
   ```
2. Create `usePolicies` hook with methods: `list`, `get`, `create`, `update`, `remove`, `validate`
3. Export from `hooks/index.ts`

#### Task 4.2: Create `PoliciesTab` Component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/policies-tab.tsx`

**Steps**:
1. Create component following `UsersTab` pattern
2. Features:
   - **Policies Table**: Name, Description, Scope (badge: GLOBAL/TENANT), Status, Actions
   - **Create Policy Dialog**: name, description, scope selector, rules JSON editor
   - **Edit Policy Dialog**: Pre-filled form with rules editor
   - **Delete Policy**: AlertDialog confirmation
   - **Validate Button**: Validate policy rules before saving (uses `/validate` endpoint)
   - **Rules Viewer**: Expandable row showing policy rules in formatted JSON
3. Use `usePolicies` hook

#### Task 4.3: Wire PoliciesTab into Admin Panel

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/admin-code-examples.tsx`

**Steps**:
1. Import `PoliciesTab`
2. Add `TabsTrigger` with `FileKey` icon and "Policies" label
3. Add `TabsContent` wrapping `<PoliciesTab />`

---

### Priority 5: STT Workflows Management UI (for Tenant Admin)

**Rationale**: Full CRUD API exists at `/api/v1/audio/pipelines`. SDK `usePipelines` hook exists but is read-only. No admin UI.

#### Task 5.1: Extend `usePipelines` SDK Hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/usePipelines.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`

**Steps**:
1. Add endpoint constants for write operations:
   ```typescript
   export const PIPELINE_ENDPOINTS = {
     // existing read endpoints...
     CREATE: '/audio/pipelines',
     UPDATE: (id: string) => `/audio/pipelines/${id}`,
     DELETE: (id: string) => `/audio/pipelines/${id}`,
     VALIDATE: '/audio/pipelines/validate',
   };
   ```
2. Add methods to `usePipelines`: `create`, `update`, `remove`, `validateYaml`

#### Task 5.2: Create `PipelinesTab` Component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/pipelines-tab.tsx`

**Steps**:
1. Create component following `UsersTab` pattern
2. Features:
   - **Pipelines Table**: Name, Slug, Description, Status, Actions
   - **Create Pipeline Dialog**: name, slug, description, configYaml (textarea/code editor)
   - **Edit Pipeline Dialog**: Pre-filled form with YAML editor
   - **Delete Pipeline**: AlertDialog confirmation
   - **Enable/Disable Toggle**: Status toggle in table row
   - **Validate YAML Button**: Validate config before saving
   - **YAML Preview**: Expandable row showing formatted YAML config
3. Use extended `usePipelines` hook

#### Task 5.3: Wire PipelinesTab into Admin Panel

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/admin-code-examples.tsx`

**Steps**:
1. Import `PipelinesTab`
2. Add `TabsTrigger` with `AudioWaveform` icon and "STT Workflows" label
3. Add `TabsContent` wrapping `<PipelinesTab />`

---

### Priority 6: Update User Management UI (for Tenant Admin)

**Rationale**: User CRUD partially works but Edit dialog is limited (only username/email), no status toggle, no role assignment UI.

#### Task 6.1: Fix User Edit Dialog

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/users-tab.tsx`

**Steps**:
1. Expand edit dialog fields to include all updateable properties from `UpdateUserRequest` DTO
2. Add `resourceStatus` field as a Select dropdown (ENABLED/DISABLED) in the edit dialog
3. Ensure form properly handles controlled inputs (fix the `browser_fill` / "undefined" bug by using proper `onChange` handlers with `defaultValue`)
4. Add proper error display for validation failures

#### Task 6.2: Add Status Toggle to User Table

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/users-tab.tsx`

**Steps**:
1. Replace the static "ENABLED" text + chevron in the Status column with an interactive `Select` component
2. Options: ENABLED, DISABLED
3. On change, call `users.update(userId, { resourceStatus: newStatus })`
4. Show toast on success/failure
5. Refresh user list after status change

#### Task 6.3: Add Role Assignment UI to User Details

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/users-tab.tsx`

**Steps**:
1. In the expandable "Manage details" row, enhance the Roles section
2. Add "Assign Role" button that opens a Dialog
3. Dialog shows available roles (from `useRoles().listRoles()`) as a selectable list
4. On select, call `useRoles().assignRole(userId, roleId)`
5. Add "Remove" button next to each assigned role
6. On remove, call `useRoles().removeRole(userId, roleId)`
7. Refresh role list after changes

---

### Priority 7: Department Management UI (for Tenant Admin)

**Rationale**: List and Edit work. Create fails with validation errors. No Delete button. No Enable/Disable toggle.

#### Task 7.1: Fix Department Create Validation

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/departments-tab.tsx`

**Steps**:
1. Add client-side validation for `code` field: max 20 characters, display character count
2. Add clear error messages mapping API error codes to user-friendly text
3. Add `description` field to create form (currently missing)
4. Ensure `code` uniqueness error ("Conflict res-469") is displayed as "A department with this code already exists"

#### Task 7.2: Add Department Delete

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/departments-tab.tsx`

**Steps**:
1. Add a Delete button (trash icon) to each department card's action buttons
2. On click, show `ConfirmDialog` with warning message
3. On confirm, call `departments.remove(departmentId)`
4. Refresh department list after deletion
5. Show toast on success/failure

#### Task 7.3: Add Department Enable/Disable

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/departments-tab.tsx`
- Modify: `packages/agentic-sdk-v2/src/hooks/useDepartments.ts` (if `update` doesn't support `resourceStatus`)

**Steps**:
1. Add a status badge (ENABLED/DISABLED) to each department card
2. Add a toggle Switch or dropdown next to the status badge
3. On toggle, call `departments.update(id, { resourceStatus: newStatus })`
4. Show toast on success/failure

---

### Priority 8: Prompt Management UI (for Tenant Admin)

**Rationale**: Create fails with generic "Validation error". No usage statistics.

#### Task 8.1: Fix Prompt Create Form

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/prompts-tab.tsx`

**Steps**:
1. Change Category field from free-text input to a `Select` dropdown with valid enum values: `SYSTEM`, `SUMMARY`, `DNA_ANALYSIS`, `CUSTOM`
2. Add `description` field (optional, max 1000 chars)
3. Add `tags` field (comma-separated input)
4. Add `departmentId` field (optional, dropdown populated from `useDepartments`)
5. Improve error handling: parse API validation errors and display field-level messages
6. Add client-side validation matching API constraints (name max 200, description max 1000)

#### Task 8.2: Add Prompt Delete Button

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/prompts-tab.tsx`

**Steps**:
1. Add Delete button to prompt detail view (or prompt list items)
2. On click, show `ConfirmDialog`
3. On confirm, call `prompts.remove(promptId)`
4. Clear selected prompt and refresh list

#### Task 8.3: Add Prompt Enable/Disable

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/prompts-tab.tsx`

**Steps**:
1. Add status indicator to prompt list items and detail view
2. Add toggle control (Switch or Select)
3. On toggle, call `prompts.update(id, { resourceStatus: newStatus })`

#### Task 8.4: Prompt Usage Statistics (Deferred)

**Note**: This requires backend work — no prompt usage tracking exists in the API. This should be a separate ticket.

**Scope for this task**: Add a placeholder "Usage Statistics" section in the prompt detail view with a "Coming Soon" message, or skip entirely.

---

### Priority 9: Bucket CRUD (for Tenant Admin)

**Rationale**: Bucket listing works. No create/update/delete/enable-disable for buckets. The API only has file-level CRUD, not bucket-level CRUD.

#### Task 9.1: Assess Bucket Management API Gap

**Analysis**: The current storage API (`/api/v1/storage`) only supports:
- Listing buckets (reads from config, not dynamic)
- File operations within buckets

Bucket creation/deletion requires direct MinIO/S3 admin API access, which is not exposed through the NestJS API.

**Options**:
1. **Add bucket CRUD to API**: Create `POST/DELETE /storage/buckets` endpoints that call S3 `CreateBucket`/`DeleteBucket` commands
2. **Config-based**: Manage buckets via tenant configuration (add bucket names to config)
3. **Defer**: Mark as infrastructure-level operation, not admin panel feature

**Recommendation**: Option 1 — Add bucket CRUD endpoints to the storage controller.

#### Task 9.2: Add Bucket CRUD API Endpoints

**Files**:
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `packages/applications/src/services/baseServices/storage/s3/s3.service.ts`
- Modify: `packages/applications/src/services/baseServices/storage/s3/IS3Service.ts`

**Steps**:
1. Add `createBucket(name: string)` method to `IS3Service` and `S3Service`
2. Add `deleteBucket(name: string)` method
3. Add controller endpoints:
   - `POST /storage/buckets` with body `{ name: string }` — `@CanCreate('Storage')`
   - `DELETE /storage/buckets/:name` — `@CanDelete('Storage')`
4. Add validation: bucket name must be lowercase, 3-63 chars, no special chars

#### Task 9.3: Extend SDK `useStorage` Hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useStorage.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`

**Steps**:
1. Add endpoint constants: `CREATE_BUCKET`, `DELETE_BUCKET`
2. Add methods: `createBucket(name: string)`, `deleteBucket(name: string)`

#### Task 9.4: Add Bucket CRUD to Storage Tab UI

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/storage-tab.tsx`

**Steps**:
1. Add "Create Bucket" button above bucket list
2. Add Dialog with bucket name input + validation
3. Add Delete button to each bucket card with ConfirmDialog
4. Refresh bucket list after create/delete

---

### Priority 10: Global Tenants Management UI (for Global Admin)

**Rationale**: Full CRUD API exists at `/api/v1/admin/tenants`. No dedicated admin UI page.

#### Task 10.1: Create `TenantsTab` Component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/tenants-tab.tsx`

**Steps**:
1. Create component following `UsersTab` pattern
2. Features:
   - **Tenants Table**: Name, Key, Description, Status, Created At, Actions
   - **Create Tenant Dialog**: name, key, description
   - **Edit Tenant Dialog**: Pre-filled form
   - **Delete Tenant**: AlertDialog with strong warning
   - **Enable/Disable Toggle**: Status toggle in table
   - **Expandable Row**: Show tenant configs with edit capability
3. Use `useTenants` hook (created in Task 2.1)
4. Only visible to SUPER_ADMIN role users

#### Task 10.2: Wire TenantsTab into Admin Panel (Conditional)

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**Steps**:
1. Import `TenantsTab`
2. Check user role from auth session — only show tab if role includes `SUPER_ADMIN`
3. Add `TabsTrigger` with `Building2` icon and "Tenants" label (conditionally rendered)
4. Add `TabsContent` wrapping `<TenantsTab />`

---

### Priority 11: Usage Statistics (for Global Admin)

**Rationale**: No per-tenant usage breakdown exists. Dashboard shows system-wide metrics only.

#### Task 11.1: Assess Statistics API Gap

**Analysis**: The monitoring module only tracks service health (stt, tts, smr uptime/sessions). There is no:
- Per-tenant usage tracking
- Prompt usage analytics
- User activity metrics
- API call volume per tenant

**Recommendation**: This is a significant backend feature requiring:
1. Event-driven usage collection (audit log events already exist)
2. Aggregation service for per-tenant metrics
3. New API endpoints for statistics queries

**Scope for this task**: Enhance the existing Dashboard page to better display available metrics and add a tenant selector for config viewing.

#### Task 11.2: Enhance Dashboard with Tenant Selector

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/dashboard.tsx`

**Steps**:
1. Replace manual "Enter Tenant ID" input with a dropdown populated from `useTenants().list()`
2. Auto-load config when tenant is selected
3. Display tenant name alongside config data
4. Add "All Tenants" option for session overview

#### Task 11.3: Add Placeholder Statistics Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/dashboard.tsx`

**Steps**:
1. Add a "Tenant Usage" card section
2. Show available data: active sessions per service, total users
3. Add "Per-tenant analytics coming soon" placeholder for future implementation

---

### Priority 12: Storage Service Configuration

**Rationale**: Storage shows "Disconnected (unhealthy)" because S3 config is loaded from `AppSettings` database table, not environment variables.

#### Task 12.1: Verify Storage Configuration

**Steps**:
1. Check if MinIO container is running: `docker ps | grep minio`
2. Check AppSettings table for S3 keys:
   ```sql
   SELECT key, value FROM core."AppSetting" WHERE key LIKE 'S3_%';
   ```
3. If missing, seed the required AppSettings:
   - `S3_ENDPOINT`: `http://localhost:9000`
   - `S3_ACCESS_KEY`: (from docker-compose MINIO_ROOT_USER)
   - `S3_SECRET_KEY`: (from docker-compose MINIO_ROOT_PASSWORD)
   - `S3_PUBLIC_BUCKET`: `hope-public`
   - `S3_PRIVATE_BUCKET`: `hope-private`
   - `S3_FORCE_PATH_STYLE`: `true`
   - `S3_REGION`: `us-east-1`

#### Task 12.2: Add Storage Config to Seed Data

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/` — add or modify AppSettings seed

**Steps**:
1. Add S3 configuration entries to the seed file
2. Ensure `hope-public` and `hope-private` buckets are created in MinIO setup
3. Update `infrastructure/docker/docker-compose.yml` minio-setup to create these buckets

#### Task 12.3: Add Storage Health to Dashboard

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/dashboard.tsx`

**Steps**:
1. Add a "Storage Health" card that calls `useStorage().checkHealth()`
2. Display connection status, configured buckets, and endpoint info
3. Show troubleshooting hints when disconnected

---

## Implementation Order & Dependencies

```
Phase 1 (Cleanup):
  Task 1.1 → 1.2 → 1.3 → 1.4  (UserGroup removal, sequential)

Phase 2 (SDK Hooks — can be parallelized):
  Task 2.1 (useTenants)
  Task 3.1 (extend useRoles)
  Task 4.1 (usePolicies)
  Task 5.1 (extend usePipelines)
  Task 9.3 (extend useStorage)

Phase 3 (API Changes):
  Task 9.2 (Bucket CRUD API)
  Task 12.1 → 12.2 (Storage config)

Phase 4 (UI Components — can be parallelized):
  Task 2.2 (TenantConfigTab)
  Task 3.2 (RolesTab)
  Task 4.2 (PoliciesTab)
  Task 5.2 (PipelinesTab)
  Task 6.1 + 6.2 + 6.3 (User management fixes)
  Task 7.1 + 7.2 + 7.3 (Department management fixes)
  Task 8.1 + 8.2 + 8.3 (Prompt management fixes)
  Task 9.4 (Storage bucket CRUD UI)
  Task 10.1 (TenantsTab)

Phase 5 (Wiring & Integration):
  Task 2.3, 3.3, 4.3, 5.3, 10.2 (Wire all tabs into admin.tsx)
  Task 11.2 + 11.3 (Dashboard enhancements)
  Task 12.3 (Storage health on dashboard)

Phase 6 (E2E Verification):
  Re-run all 68 user stories
```

---

## Estimated Effort

| Priority | Description | Tasks | Est. Hours |
|----------|-------------|-------|------------|
| 1 | Remove UserGroup | 4 | 4-6h |
| 2 | Tenant Management UI | 3 | 6-8h |
| 3 | Roles Management UI | 3 | 6-8h |
| 4 | Policies Management UI | 3 | 6-8h |
| 5 | STT Workflows UI | 3 | 6-8h |
| 6 | User Management Fixes | 3 | 4-6h |
| 7 | Department Management Fixes | 3 | 3-4h |
| 8 | Prompt Management Fixes | 4 | 4-6h |
| 9 | Bucket CRUD | 4 | 6-8h |
| 10 | Global Tenants UI | 2 | 4-6h |
| 11 | Usage Statistics | 3 | 3-4h |
| 12 | Storage Service Config | 3 | 2-3h |
| **Total** | | **38** | **54-75h** |

---

## Change History

| Date | Update | Status |
|------|--------|--------|
| 2026-02-24 | Initial plan created from E2E test results | Pending |
| 2026-02-24 | **Priority 1 COMPLETED**: Removed UserGroup from all layers | Completed |

### Priority 1 Implementation Summary — Remove UserGroup (Cleanup)

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/applications/src/authorization/__tests__/policy.engine.no-usergroup.test.ts` — 4 tests verifying:
  - `invalidateUserGroup` method no longer exists
  - `buildAbility` no longer queries `userGroupRoleAssignment`
  - `invalidateRole` only queries direct assignments
- `packages/domains/src/__tests__/usergroup-removal.test.ts` — 6 tests verifying:
  - `ResourceType` enum no longer contains `UserGroup` or `UserGroupAssignment`
  - `EventTypes` enum no longer contains `UserGroupCreated` or `UserGroupUpdated`
  - Other resource types and events remain intact

#### Files Modified
| Layer | File | Change |
|-------|------|--------|
| **Database** | `packages/database/src/prisma/db_main/user.prisma` | Removed `UserGroupRoleAssignment` model, `UserGroup` model, `UserGroups` relation from `User` |
| **Database** | `packages/database/src/prisma/db_main/rbac.prisma` | Removed `UserGroupRoleAssignments` relation from `Role` |
| **Database** | `packages/database/src/prisma/db_main/audit.prisma` | Removed `UserGroupAssignment` and `UserGroup` from `ResourceType` enum |
| **Database** | `packages/database/src/prisma/db_main/seed/01-policy.ts` | Removed `UserGroup` and `UserGroupRoleAssignment` from policy rules |
| **Domain** | `packages/domains/src/enums/generated/ResourceType.ts` | Removed enum values |
| **Domain** | `packages/domains/src/common/events/eventTypes.ts` | Removed event types |
| **Domain** | `packages/domains/src/entities/generated/core/UserEntity.ts` | Removed `UserGroups` property |
| **Domain** | `packages/domains/src/entities/generated/core/RoleEntity.ts` | Removed `UserGroupAssignments` property |
| **Domain** | `packages/domains/src/entities/generated/core/PermissionEntity.ts` | Removed `UserGroupAssignments` property |
| **Domain** | `packages/domains/src/models/generated/core/UserModel.ts` | Removed `UserGroups` property |
| **Domain** | `packages/domains/src/models/generated/core/RoleModel.ts` | Removed `UserGroupAssignments` property |
| **Domain** | `packages/domains/src/models/generated/core/PermissionModel.ts` | Removed `UserGroupAssignments` property |
| **Domain** | `packages/domains/src/mappers/generated/core/UserEntityMapper.ts` | Removed mapper handler |
| **Domain** | `packages/domains/src/mappers/generated/core/RoleEntityMapper.ts` | Removed mapper handler |
| **Domain** | `packages/domains/src/mappers/generated/core/PermissionEntityMapper.ts` | Removed mapper handler |
| **Domain** | `packages/domains/src/factories/generated/core/UserFactory.ts` | Removed property |
| **Domain** | `packages/domains/src/factories/generated/core/RoleFactory.ts` | Removed property |
| **Domain** | `packages/domains/src/factories/generated/core/PermissionFactory.ts` | Removed property |
| **Domain** | 6 barrel `index.ts` files | Removed exports |
| **Domain** | `packages/domains/src/common/databaseServices/core/core.database.module.ts` | Removed imports and providers |
| **App** | `packages/applications/src/authorization/policy.engine.ts` | Removed group query, group processing, `invalidateUserGroup()` |
| **App** | `packages/applications/src/authorization/__tests__/policy.engine.test.ts` | Updated tests |
| **App** | `packages/applications/src/services/auth/__tests__/auth.service.test.ts` | Removed group references |
| **App** | `packages/applications/src/services/auth/__tests__/auth.dto.mapper.test.ts` | Removed group tests |
| **App** | `packages/applications/src/services/consultation/events/__tests__/consultation.events.test.ts` | Removed event strings |
| **App** | `packages/applications/src/services/user/index.ts` | Removed barrel exports |

#### Files Deleted
| Layer | File/Directory |
|-------|---------------|
| **Domain** | `packages/domains/src/entities/generated/core/UserGroupEntity.ts` |
| **Domain** | `packages/domains/src/entities/generated/core/UserGroupAssignmentEntity.ts` |
| **Domain** | `packages/domains/src/models/generated/core/UserGroupModel.ts` |
| **Domain** | `packages/domains/src/models/generated/core/UserGroupAssignmentModel.ts` |
| **Domain** | `packages/domains/src/mappers/generated/core/UserGroupEntityMapper.ts` |
| **Domain** | `packages/domains/src/mappers/generated/core/UserGroupAssignmentEntityMapper.ts` |
| **Domain** | `packages/domains/src/factories/generated/core/UserGroupFactory.ts` |
| **Domain** | `packages/domains/src/factories/generated/core/UserGroupAssignmentFactory.ts` |
| **Domain** | `packages/domains/src/repositories/generated/core/UserGroupRepository.ts` |
| **Domain** | `packages/domains/src/repositories/generated/core/UserGroupAssignmentRepository.ts` |
| **App** | `packages/applications/src/services/user/userGroup/` (entire directory) |
| **App** | `packages/applications/src/services/user/userGroupAssignment/` (entire directory) |

#### Test Results
- **Full unit test suite**: 9,913 tests pass, 336 files, 0 failures
- **New verification tests**: 10 tests pass (4 policy engine + 6 domain layer)
- **Updated existing tests**: 190 tests pass across 9 affected test files

---

### Priority 2 Implementation Summary — Tenant Management UI

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/agentic-sdk-v2/src/hooks/__tests__/useTenants.test.ts` — 18 tests covering:
  - Initial state (empty tenants, null currentTenant)
  - `list()` with pagination, error handling, paginated response format
  - `get()` by ID
  - `getByCodeName()` by code name
  - `create()` with state update
  - `update()` with array replacement
  - `remove()` with array filtering
  - `getConfigs()` and `updateConfigs()`
  - SDK not initialized error handling
  - Error clearing on success

#### Files Created
| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/src/hooks/useTenants.ts` | SDK hook for tenant CRUD + configs |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useTenants.test.ts` | 18 unit tests for useTenants |
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/tenant-config-tab.tsx` | Full tenant management UI tab |

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Expanded `TENANT_ENDPOINTS` from 2 to 8 keys (LIST, GET, GET_BY_CODE_NAME, CREATE, UPDATE, DELETE, GET_CONFIGS, UPDATE_CONFIGS) |
| `packages/agentic-sdk-v2/src/hooks/index.ts` | Added `useTenants` export |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx` | Added "Tenants" tab with Settings icon |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.ws4.test.ts` | Updated structural guard test for 8 TENANT_ENDPOINTS keys |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` | Updated structural guard test for 8 TENANT_ENDPOINTS keys |

#### TenantConfigTab Features
1. **Tenant Info Card** — displays current tenant details with Edit and Status toggle buttons
2. **Tenants List Table** — paginated table with search, Name/CodeName/Description/Status columns, CRUD actions
3. **Create Tenant Dialog** — form with name, codeName, description
4. **Edit Tenant Dialog** — pre-filled form with name, description, resourceStatus select
5. **Delete Tenant AlertDialog** — confirmation with tenant name
6. **Tenant Configs Dialog** — per-row config viewer with inline editing via sub-table

#### Test Results
- **useTenants hook**: 18 tests pass
- **Full unit test suite**: 9,931 tests pass, 337 files, 0 failures

---

### Priority 3 Implementation Summary — Roles Management UI

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/agentic-sdk-v2/src/hooks/__tests__/useRoles.test.ts` — Extended with 22 new tests covering:
  - `createRole()` POST to ROLE_ENDPOINTS.CREATE, state update, error handling
  - `updateRole()` PUT to ROLE_ENDPOINTS.UPDATE, state replacement
  - `deleteRole()` DELETE to ROLE_ENDPOINTS.DELETE, state filtering
  - `assignPolicy()` POST to ROLE_ENDPOINTS.ASSIGN_POLICY
  - `removePolicy()` DELETE to ROLE_ENDPOINTS.REMOVE_POLICY

#### Files Created
| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/roles-tab.tsx` | Full Roles management UI tab with policy assignment |

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | Added `put<T>()` method for PUT HTTP verb |
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `POLICY_ENDPOINTS` constant block (LIST, GET, CREATE, UPDATE, DELETE, VALIDATE) |
| `packages/agentic-sdk-v2/src/hooks/useRoles.ts` | Extended with `createRole`, `updateRole`, `deleteRole`, `assignPolicy`, `removePolicy` methods |
| `packages/agentic-sdk-v2/src/hooks/usePolicies.ts` | New hook for policy management (used by RolesTab) |
| `packages/agentic-sdk-v2/src/hooks/index.ts` | Added `usePolicies` export |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx` | Added "Roles" tab with ShieldCheck icon |

#### RolesTab Features
1. **Roles List Table** — paginated table with Name, Description, External Name, System Role badge, Status columns
2. **Create Role Dialog** — form with name, description, externalName
3. **Edit Role Dialog** — pre-filled form for updating role details
4. **Delete Role AlertDialog** — confirmation with system role protection (system roles cannot be deleted)
5. **Expandable Policy Section** — click to expand row showing assigned policies
6. **Policy Assignment Dialog** — select from unassigned policies and assign to role
7. **Policy Removal** — unlink button to remove policy from role

#### Test Results
- **useRoles hook**: 22 new tests + existing tests pass
- **Full unit test suite**: 9,951 tests pass, 338 files, 0 failures

---

### Priority 4 Implementation Summary — Policies Management UI

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/agentic-sdk-v2/src/hooks/__tests__/usePolicies.test.ts` — 12 tests covering:
  - Initial state (empty policies, null currentPolicy)
  - `list()` with pagination params
  - `get()` by ID with currentPolicy state update
  - `create()` POST with state array append
  - `update()` PUT to POLICY_ENDPOINTS.UPDATE with state replacement
  - `remove()` DELETE with state filtering
  - `validate()` POST with input data
  - SDK not initialized error handling
  - Error clearing on success

#### Files Created
| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/src/hooks/__tests__/usePolicies.test.ts` | 12 unit tests for usePolicies hook |
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/policies-tab.tsx` | Full Policies management UI with rule builder |

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/hooks/usePolicies.ts` | Fixed `update()` to use PUT instead of PATCH (matching backend controller) |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx` | Added "Policies" tab with ShieldAlert icon after Roles tab |

#### PoliciesTab Features
1. **Policies List Table** — paginated table with search, Name, Description, Scope (GLOBAL/TENANT badges), Rules count, Status columns
2. **View Policy Dialog** — read-only expandable rule cards showing action, subject, ALLOW/DENY badge, conditions (JSON), fields, reason
3. **Create Policy Dialog** — form with name, scope (TENANT/GLOBAL select), description, and interactive Rule Builder
4. **Edit Policy Dialog** — pre-filled form reusing same PolicyFormDialog component
5. **Delete Policy AlertDialog** — confirmation with policy name
6. **Rule Builder** — per-rule row with:
   - Action dropdown (manage, create, read, list, update, delete, archive, export)
   - Subject dropdown (all, User, Role, Policy, Tenant, Department, Consultation, Prompt, Bucket, Pipeline, AuditLog)
   - ALLOW/DENY toggle button
   - Advanced options (expandable): Conditions JSON textarea, Fields comma-separated input, Reason text input
   - Add/Remove rule buttons (minimum 1 rule required)

#### Test Results
- **usePolicies hook**: 12 tests pass
- **Full unit test suite**: 9,951 tests pass, 338 files, 0 failures

---

### Priority 5 Implementation Summary — STT Pipelines Management UI

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/agentic-sdk-v2/src/hooks/__tests__/usePipelines.test.ts` — Extended with 8 new tests covering:
  - `createPipeline()` POST with state array append
  - `updatePipeline()` PATCH with state replacement
  - `deletePipeline()` DELETE with state filtering
  - `validateConfig()` POST with configYaml payload, valid and invalid results

#### Files Created
| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/pipelines-tab.tsx` | Full STT Pipelines management UI with YAML config viewer and validator |

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added CREATE, UPDATE, DELETE endpoints to `PIPELINE_ENDPOINTS` (4→7 keys) |
| `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` | Extended with `createPipeline`, `updatePipeline`, `deletePipeline`, `validateConfig` methods + new interfaces (`CreatePipelineInput`, `UpdatePipelineInput`, `PipelineValidationResult`) |
| `packages/agentic-sdk-v2/src/hooks/index.ts` | Added exports for new Pipeline types |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` | Updated structural guard test for 7 PIPELINE_ENDPOINTS keys |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx` | Added "Pipelines" tab with Workflow icon after Policies |

#### PipelinesTab Features
1. **Pipelines List Table** — paginated table with search, Name, Slug (code badge), Description, Tags (badge list with overflow), Status columns
2. **View Pipeline Dialog** — read-only view showing name, slug, description, tags, and full YAML configuration in monospace pre-formatted block
3. **Create Pipeline Dialog** — form with name, slug (required), description, tags (comma-separated), YAML config editor with inline validation
4. **Edit Pipeline Dialog** — pre-filled form reusing PipelineFormDialog
5. **Delete Pipeline AlertDialog** — confirmation with warning about active transcription jobs
6. **YAML Validation** — "Validate" button triggers `validateConfig()`, displays validation result with success/error styling and per-error list

#### Test Results
- **usePipelines hook**: 20 tests pass (12 existing + 8 new)
- **Full unit test suite**: 9,959 tests pass, 338 files, 0 failures

---

### Priority 6 Implementation Summary — User Management Updates

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written (RED phase)
- `packages/agentic-sdk-v2/src/hooks/__tests__/useUsers.test.ts` — Extended with 5 new tests:
  - `enable()` should PATCH with `{ resourceStatus: 'ENABLED' }` and update array
  - `disable()` should PATCH with `{ resourceStatus: 'DISABLED' }`
  - `update()` should accept `resourceStatus` in input
  - `update()` should accept `isServiceAccount` in input

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/hooks/useUsers.ts` | Extended `UpdateUserInput` with `resourceStatus` and `isServiceAccount`; added `enable(id)` and `disable(id)` convenience methods |
| `packages/applications/src/services/user/user/dto/updateUser.request.ts` | Added `resourceStatus` field with `IsEnum` validator (ENABLED/DISABLED) |
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/users-tab.tsx` | Enhanced Users Tab UI |

#### Users Tab UI Enhancements
1. **Enable/Disable Toggle** — new toggle button (ToggleLeft/ToggleRight icons) in each user row, green when enabled
2. **Expanded Edit Form** — added External ID input and Service Account checkbox to edit dialog
3. **Status Badge Fix** — badge now correctly handles both `active` and `ENABLED` status values
4. **UpdateUserInput Extension** — edit handler now sends `externalId` and `isServiceAccount` to backend

#### Test Results
- **useUsers hook**: 36 tests pass (31 existing + 5 new)
- **Full unit test suite**: 9,964 tests pass, 338 files, 0 failures

---

### Priority 7 Implementation Summary — Department Management

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Tests Written
- `packages/agentic-sdk-v2/src/hooks/__tests__/useDepartments.test.ts` — Extended with 6 new tests:
  - `create()` POST with state array append
  - `remove()` DELETE with state filtering
  - `getByCode()` GET by code
  - `updatePromptConfig()` PATCH prompt config

#### Files Modified
| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/departments-tab.tsx` | Fixed create to use SDK hook instead of `fetch()`, added delete button + AlertDialog, added enable/disable toggle, replaced ConfirmDialog with @arcaai/ui AlertDialog |

#### DepartmentsTab UI Enhancements
1. **Delete Operation** — trash button on each department card, with AlertDialog confirmation using @arcaai/ui components
2. **Enable/Disable Toggle** — ToggleRight/ToggleLeft icon buttons on each card, uses `update()` with `resourceStatus`
3. **SDK Create Hook** — replaced raw `fetch()` call with SDK `create()` method for consistency
4. **Component Library Alignment** — switched from custom ConfirmDialog to @arcaai/ui AlertDialog components

#### Test Results
- **useDepartments hook**: 31 tests pass (25 existing + 6 new)
- **Full unit test suite**: 9,970 tests pass, 338 files, 0 failures

---

### Priority 8 Implementation Summary — Prompt Management (Create + Usage Statistics)

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Backend Changes

| File | Change |
|------|--------|
| `packages/applications/src/services/prompt-management/prompt-management.service.ts` | Added `PromptUsageRecordRepository` dependency; implemented `getUsageStats(templateId)` method returning `{ totalUsages, lastUsedAt }` |
| `apps/api/src/modules/prompt-management/prompt-management.controller.ts` | Added `GET /:id/usage` endpoint exposing usage statistics |

#### SDK Changes

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `USAGE` endpoint to `PROMPT_TEMPLATE_ENDPOINTS` (8→9 keys) |
| `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` | Added `PromptUsageStats` interface and `getUsageStats(id)` method using `useApiOperation` |

#### Tests Written (RED→GREEN)

| Test File | New Tests |
|-----------|-----------|
| `packages/agentic-sdk-v2/src/hooks/__tests__/usePrompts.test.ts` | 2 new tests: `getUsageStats` success path, zero-usage path |
| `packages/applications/src/services/prompt-management/__tests__/prompt-management.service.test.ts` | 3 new tests: usage with records, zero records, missing CreatedAt handling. Also fixed 31 existing tests by adding `PromptUsageRecordRepository` mock to all constructor calls |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.ws4.test.ts` | Updated structural guard: PROMPT_TEMPLATE_ENDPOINTS 8→9 keys |

#### UI Changes

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/prompts-tab.tsx` | Added "Usage" tab with usage statistics display |

#### PromptsTab Usage Statistics Features
1. **Usage Tab** — new tab between "Diff" and "Department" with BarChart3 icon
2. **Load Stats Button** — triggers `getUsageStats()` for the selected prompt, with loading spinner
3. **Stats Cards** — two-column grid showing Total Usages (large number) and Last Used (localized date or "Never used")
4. **State Reset** — usage stats reset when selecting a different prompt to prevent stale data

#### Existing Features (already implemented)
- **Create Prompt Template** — full create form with name, category, content, variables (comma-separated)
- **Edit/Update** — inline content editor with change reason tracking
- **Delete** — confirmation dialog with soft-delete
- **Version History** — version timeline with load button
- **Version Diff** — side-by-side version comparison with DiffViewer
- **Department Assignment** — assign prompt to department field

#### Test Results
- **usePrompts hook**: 22 tests pass (20 existing + 2 new)
- **prompt-management.service**: 42 tests pass (39 existing + 3 new)
- **Full unit test suite**: 9,975 tests pass, 338 files, 0 failures

---

### Priority 9 Implementation Summary — Bucket CRUD

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Backend Changes

| File | Change |
|------|--------|
| `packages/applications/src/services/baseServices/storage/s3/IS3Service.ts` | Added `listAllBuckets()`, `createBucket(name)`, `deleteBucket(name)` to interface |
| `packages/applications/src/services/baseServices/storage/s3/s3.service.ts` | Implemented `listAllBuckets` (ListBucketsCommand), `createBucket` (CreateBucketCommand with name validation), `deleteBucket` (DeleteBucketCommand) |
| `apps/api/src/modules/storage/storage.controller.ts` | Changed `GET /buckets` to use `listAllBuckets()` (dynamic S3 listing instead of hardcoded public/private). Added `POST /buckets` (create bucket) and `DELETE /buckets/:name` (delete bucket) |

#### Tests Written (RED→GREEN)

| Test File | New Tests |
|-----------|-----------|
| `packages/applications/src/services/baseServices/storage/s3/__tests__/s3.service.test.ts` | 6 new tests: listAllBuckets success and empty, createBucket success and invalid name rejection, deleteBucket success and invalid name rejection (44→50 total) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useStorage.test.ts` | 2 new tests: createBucket POST with state append, deleteBucket DELETE with state filtering (20→22 total) |

#### SDK Changes

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `CREATE_BUCKET` and `DELETE_BUCKET` to `STORAGE_ENDPOINTS` (7→9 keys) |
| `packages/agentic-sdk-v2/src/hooks/useStorage.ts` | Added `CreateBucketResult` interface, `createBucket(name, type)` and `deleteBucket(name)` methods with local state management |

#### UI Changes

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/storage-tab.tsx` | Added Create Bucket dialog (name + public/private radio), delete bucket AlertDialog on each bucket item, "+" button in bucket list header |

#### StorageTab UI Enhancements
1. **Create Bucket Dialog** — triggered by "+" button, with bucket name input and public/private radio selection
2. **Delete Bucket** — trash button on each bucket item with AlertDialog confirmation warning about permanent file loss
3. **Dynamic Bucket Listing** — listBuckets now queries S3 API directly instead of returning hardcoded bucket names

#### Test Results
- **S3 service**: 50 tests pass (44 existing + 6 new)
- **useStorage hook**: 22 tests pass (20 existing + 2 new)
- **Full unit test suite**: 9,983 tests pass, 338 files, 0 failures

---

### Priority 10 Implementation Summary — Global Tenants Management UI

**Status**: Completed
**Approach**: Test-Driven Development (TDD — Red-Green-Refactor)

#### Assessment

The existing `TenantConfigTab` component (`packages/agentic-sdk-v2/examples/vite-app/src/components/admin/tenant-config-tab.tsx`) already provides a comprehensive Global Tenants Management UI with:
- Tenant list with search and pagination
- Create tenant dialog (name, codeName, description)
- Edit tenant dialog (name, description, status)
- Delete tenant with AlertDialog confirmation
- Toggle status (enable/disable)
- View/edit tenant configurations (key-value pairs)
- Current tenant info card with quick actions

#### SDK Enhancement

Added `enable(id)` and `disable(id)` convenience methods to `useTenants` hook, mirroring the pattern used in `useUsers` (Priority 6).

#### Tests Written (RED→GREEN)

| Test File | New Tests |
|-----------|-----------|
| `packages/agentic-sdk-v2/src/hooks/__tests__/useTenants.test.ts` | 2 new tests: `enable()` PATCH with ENABLED, `disable()` PATCH with DISABLED (18→20 total) |

#### Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/hooks/useTenants.ts` | Added `enable(id)`, `disable(id)` to `UseTenantsReturn` interface and implementation |
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/tenant-config-tab.tsx` | Updated to use `enableTenant`/`disableTenant` from hook, added `isTenantActive()` helper to handle both `active`/`ENABLED` status values, updated `statusVariant` for case-insensitive status comparison |

#### Test Results
- **useTenants hook**: 20 tests pass (18 existing + 2 new)
- **Full unit test suite**: 9,985 tests pass, 338 files, 0 failures

---

### Priority 11 Implementation Summary — Usage Statistics for Global Admin

**Status**: Completed
**Approach**: Frontend composition of existing hooks — no new backend endpoints needed

#### Files Created

| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/usage-statistics-tab.tsx` | Usage Statistics dashboard composing data from multiple hooks |

#### Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx` | Added "Statistics" tab (BarChart3 icon) with UsageStatisticsTab component |

#### UsageStatisticsTab Features
1. **Summary Cards** — 4-card grid showing Total Tenants, Total Users, Prompt Templates, Active Sessions with icons and descriptions
2. **Service Health Overview** — grid of service cards (STT, TTS, SMR, etc.) with healthy/unhealthy status, uptime duration, and status badges
3. **Tenant Overview** — list of all tenants with name, codeName, and status badges (handles both active/ENABLED status values)
4. **Refresh Button** — parallel reload of all statistics from monitoring, tenants, users, and prompts hooks
5. **Last Updated Timestamp** — displays time of last data refresh

#### Architecture
The tab composes data from existing SDK hooks without requiring new backend endpoints:
- `useMonitoring()` — service uptime, sessions, heartbeats
- `useTenants()` — tenant list and counts
- `useUsers()` — user counts
- `usePrompts()` — prompt template counts

#### Test Results
- **Full unit test suite**: 9,985 tests pass, 338 files, 0 failures

---

### Priority 12 Implementation Summary — Storage Service Issues

**Status**: Completed
**Approach**: Root cause analysis + targeted fix

#### Root Cause Analysis
The "Disconnected (unhealthy)" status was **expected behavior** when MinIO/S3 is not running or not configured. However, the health endpoint lacked detail:
- The `StorageController.checkHealth()` only called `s3Service.testConnection()` which returns a simple `boolean`
- No distinction between "not configured" and "service unreachable"
- The `S3HealthService` already existed with rich health checking (`not-configured` vs `unhealthy` vs `healthy`) but was **not wired into the controller**

#### Fix Applied
Integrated `S3HealthService` into the storage controller for detailed health reporting.

#### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/modules/storage/storage.controller.ts` | Injected `S3HealthService`, replaced simple `testConnection()` health check with comprehensive `S3HealthService.checkHealth()`. Health response now includes: `status`, `connected`, `isMinIO`, `configured`, `endpoint`, `publicBucket`, `privateBucket`, `error` |
| `packages/agentic-sdk-v2/src/hooks/useStorage.ts` | Extended `StorageHealth` interface with `configured`, `isMinIO`, `endpoint`, `publicBucket`, `privateBucket`, `error` fields. Added `'not-configured'` to status union |
| `packages/agentic-sdk-v2/examples/vite-app/src/components/admin/storage-tab.tsx` | Added "Not Configured" state (yellow icon) alongside existing "Connected" and "Disconnected" states. Added error message and endpoint display when available |

#### Health Status States
1. **Connected (green)** — S3/MinIO is running and reachable
2. **Not Configured (yellow)** — S3 settings (endpoint, keys) are missing from AppSettings
3. **Disconnected (red)** — S3 is configured but connection test failed (service down or unreachable)

#### Test Results
- **Full unit test suite**: 9,985 tests pass, 338 files, 0 failures
