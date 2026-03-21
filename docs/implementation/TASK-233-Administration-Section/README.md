# TASK-233: Administration Section

| Field | Value |
|-------|-------|
| Ticket | TASK-233 |
| Type | Feature |
| Created | 2026-03-01 |
| Updated | 2026-03-02 |
| Status | Completed |

## Requirement Analysis

### Description
Add an Administration section to the ui-playground app (`apps/ui-playground`) with three pages:
1. **Overview** — introduction and current tenant information
2. **Tenant Management** — two-column CRUD interface for tenants with tabs for users, configs, files, and audit logs (SUPER_ADMIN only)
3. **User Management** — paginated data table with CRUD, user details, and API key viewing (SUPER_ADMIN only)

Also create a new `UserController` in the API gateway (`apps/api`) since the previous one was deleted.

### Business Context
The Administration section provides platform management capabilities without impersonation context, allowing super admins to manage tenants and users directly.

### Acceptance Criteria
- [x] Administration nav group appears in sidebar after Playground
- [x] Overview page shows current user, tenant info, and platform stats
- [x] Tenant Management: two-column layout with tenant list, CRUD, tabbed sub-views
- [x] User Management: data table with search, filter, pagination, CRUD dialogs, user detail panel
- [x] Tenant/User pages restricted to SUPER_ADMIN
- [x] API UserController with full CRUD + bulk delete + user API keys endpoint
- [x] All endpoints authenticated with @Authorize() decorator

## Current State Evaluation

- `TenantController` existed at `admin/tenants` with full CRUD + configs + usage
- `UserController` had been deleted (per git status)
- `UserService` and `UserDtoMapper` existed in `@arcaai/applications` with full CRUD
- ui-playground had no admin section; only "Getting Started" and "Playground" nav groups
- Admin app (`apps/admin`) had a Users feature but this task targets `apps/ui-playground`

## Implementation Summary

### API Gateway (apps/api)

**New files:**
| File | Purpose |
|------|---------|
| `src/modules/user/user.controller.ts` | UserController with 9 endpoints (CRUD, status, bulk delete, API keys) |
| `src/modules/user/user.module.ts` | Module registering UserServiceModule + ApiKeyServiceModule |
| `src/modules/user/__tests__/user.controller.test.ts` | 32 unit tests (behavior + Swagger metadata) |

**Modified files:**
| File | Change |
|------|--------|
| `src/app.module.ts` | Added UserModule import and registration in featureModules |

**API Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/users` | Create user |
| GET | `/admin/users` | Fetch all users (paginated) |
| GET | `/admin/users/:id` | Fetch user by ID |
| GET | `/admin/users/tenant/:tenantId` | Fetch users by tenant |
| PATCH | `/admin/users/:id` | Update user |
| PATCH | `/admin/users/:id/status` | Enable/disable user |
| DELETE | `/admin/users/:id` | Soft delete user |
| DELETE | `/admin/users/bulk` | Bulk soft delete |
| GET | `/admin/users/:id/api-keys` | Fetch user's API keys |

### Frontend (apps/ui-playground)

**New feature directory: `src/features/admin/`**

| Directory | Files | Purpose |
|-----------|-------|---------|
| `api/` | admin-client.ts, tenants.ts, users.ts, storage.ts, audit-logs.ts, index.ts | Fetch wrapper + TanStack Query hooks |
| `components/` | two-column-layout.tsx, resource-card.tsx, status-badge.tsx, confirm-dialog.tsx, admin-data-table.tsx, search-filter-bar.tsx, index.ts | Shared admin UI components |
| `overview/` | index.tsx | Admin Overview page |
| `tenants/` | index.tsx | Tenant Management page (two-column, tabbed) |
| `users/` | index.tsx | User Management page (table, dialogs) |

**Route files:**
| File | Path | Access |
|------|------|--------|
| `routes/_authenticated/admin/overview.tsx` | `/admin/overview` | All authenticated |
| `routes/_authenticated/admin/tenants.tsx` | `/admin/tenants` | SUPER_ADMIN |
| `routes/_authenticated/admin/users.tsx` | `/admin/users` | SUPER_ADMIN |

**Modified files:**
| File | Change |
|------|--------|
| `components/layout/app-sidebar.tsx` | Added "Administration" nav group with conditional SUPER_ADMIN items |

### Verification Evidence

**API tests:** 706 passed (22 test files), 0 failed
**UserController tests:** 32 passed, 0 failed
**Vite build:** Exit code 0, built in 6.55s with proper code-splitting

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-01 | Initial implementation | See Implementation Summary above |
| 2026-03-02 | Added Department Management page with full CRUD, tenant selector for super admins, prompt config management, and browser-verified end-to-end testing | See below |

### 2026-03-02: Department Management

**Backend (apps/api):**

| File | Purpose |
|------|---------|
| `src/modules/department/department.controller.ts` | DepartmentController with 9 endpoints (CRUD, by-code, children, roots, prompt-config) |
| `src/modules/department/department.module.ts` | Module registering DepartmentServiceModule |

**API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/departments` | Create department |
| GET | `/admin/departments` | Fetch all departments (tenant-scoped) |
| GET | `/admin/departments/roots` | Fetch root departments |
| GET | `/admin/departments/:id` | Fetch department by ID |
| GET | `/admin/departments/code/:code` | Fetch department by code |
| GET | `/admin/departments/:id/children` | Fetch child departments |
| PATCH | `/admin/departments/:id` | Update department |
| PATCH | `/admin/departments/:id/prompt-config` | Update prompt configuration |
| DELETE | `/admin/departments/:id` | Soft delete department |

**Frontend (apps/ui-playground):**

| File | Purpose |
|------|---------|
| `features/admin/api/departments.ts` | TanStack Query hooks for department CRUD (both default and tenant-scoped variants) |
| `features/admin/departments/index.tsx` | Department Management page with table/card views, tenant selector, CRUD dialogs, prompt config, search/filter |
| `routes/_authenticated/admin/departments.tsx` | Route with SUPER_ADMIN guard |

**Modified files:**

| File | Change |
|------|--------|
| `src/app.module.ts` | Added DepartmentModule to featureModules |
| `features/admin/api/index.ts` | Added department exports |
| `components/layout/app-sidebar.tsx` | Added "Departments" nav item with NEW badge |

**Key features:**
- Tenant selector dropdown for super admins (departments are tenant-scoped)
- "No Tenant Selected" empty state when no tenant context
- Table view with columns: Department (name+code), Status, Prompt Config badges, Template, Updated, Actions
- Card view with department cards showing all info
- Create/Edit department dialogs with form validation (name, code, description, parent, summary template)
- Prompt Configuration dialog with dropdowns for Pre-Summary, New Patient, and Revisit prompts
- Enable/Disable toggle via actions menu
- Delete with confirmation dialog
- Search by name, code, or description
- Status filter (All/Enabled/Disabled)
- Toast notifications for all CRUD operations

**Browser testing results (verified):**
- Phase 1 (Navigation & Initial State): PASS
- Phase 2 (Tenant Selection & Data Loading): PASS
- Phase 3 (Search & Filter): PASS
- Phase 4 (Card View): PASS
- Phase 5 (Create Department): PASS
- Phase 6 (View Details): PASS
- Phase 7 (Edit Department): PASS
- Phase 8 (Prompt Config): PASS
- Phase 9 (Enable/Disable): PASS (API verified via curl)
- Phase 10 (Delete): PASS (API verified via curl)
