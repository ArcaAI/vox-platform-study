# TASK-415 — Hope Admin Console: Capabilities Matrix

- **Date**: 2026-07-04
- **Purpose**: TASK-415 deliverable. The authoritative capability inventory for the planned Next.js Admin Console, feeding (1) UX-UI design (Figma frames in `HOPE-Admin-Console`), (2) frontend route/menu/guard implementation, and (3) API integration. Every endpoint below was verified against its controller in `apps/api/src/modules/`.
- **Sources**: `docs/traceability-matrix.md` (36-row capability inventory), `.cursor/rules/12-design-workflow.mdc` (Figma tier taxonomy), `apps/api/src/modules/**/*.controller.ts` (route + guard verification), `packages/database/src/prisma/db_main/seed/{01-policy.ts,03-role.ts}` (role/policy model).
- **Review**: user review applied 2026-07-04 — `GLOBAL_ADMIN` is the canonical elevated role (merge tracked in TASK-417), AI model registry moved to tier 10–19 (global-admin only), Prisma Studio targeted for production behind a dedicated permission (TASK-419), gaps resolved into follow-up tickets TASK-419/TASK-420 + backlog items. Pre-Phase-2 review same day: section 3 restructured to the approved Figma standards (naming grammar, ranges 01–05/06–09/10–49, groups Foundation / Global admins' / Tenant admins') and the batch design-train process per rule `12-design-workflow.mdc` §2.
- **Convention**: all HTTP paths below are relative to the global prefix `/api/v1`. `*` compresses sibling routes on the same base path.

## 1. Role & Access Model Summary

Two console audiences map onto the implemented role/policy model:

| Audience | Roles | Scope |
|---|---|---|
| Global administrator | `GLOBAL_ADMIN` — canonical and sole elevated role. The legacy `SUPER_ADMIN` was merged into it (TASK-417, shipped): `ELEVATED_ROLES` in `packages/applications/src/common/tenant-guards.ts` is now `['GLOBAL_ADMIN']` | Cross-tenant. Policies `system-full-access` (`manage:all`), `rbac-system-manage`, `global-settings-manage` |
| Tenant administrator | `TENANT_ADMIN` | Own tenant only. Policies `tenant-full-access`, `rbac-tenant-manage`, `rbac-delegate`, `prompt-template-manage`, `audit-log-read`, `user-profile-own` |

**Role consolidation decision (2026-07-04)**: `SUPER_ADMIN` and `GLOBAL_ADMIN` are consolidated into `GLOBAL_ADMIN`; `SUPER_ADMIN` must not be used anywhere going forward. The platform-wide cleanup (seeds, guards, `ELEVATED_ROLES`, existing role assignments, docs and rules) shipped as **TASK-417** (2026-07-05): the seed no longer creates `SUPER_ADMIN`, existing assignments were migrated to `GLOBAL_ADMIN`, and the console accepts only `GLOBAL_ADMIN` as elevated.

Other seeded roles (`DOCTOR`, `NURSE`, `SERVICE_ACCOUNT`, custom `DEPARTMENT_HEAD` / `SENIOR_NURSE`) are end-user roles and never see the console's admin surfaces (deny-by-default).

Mechanics the console must honor:

- **Authorization**: CASL policies evaluated by `PolicyEngine` (`packages/applications/src/authorization/policy.engine.ts`), enforced by the deny-by-default `UnifiedAuthGuard`. Route guards are decorators (`@Authorize(['action','Subject'])`, `@CanManage('X')`, `@CanAny(...)` — `packages/applications/src/authorization/decorators.ts`). Method-level decorators override class-level ones. Global-admin-only routes use `@Authorize(['manage','all'])` (only `system-full-access` grants it).
- **Tenant elevation**: an elevated admin selects a working tenant by sending the `X-Tenant-Id` header (`apps/api/src/interceptors/resolve-active-tenant.ts`); tenant-bound users cannot spoof it (400). The console's tenant picker + "Acting on" banner drive this header.
- **404-over-403**: cross-tenant access always returns 404, never 403 (no existence leak). Console error handling must treat 404 as "not yours", not "missing route".
- **Optimistic concurrency**: admin PATCH routes on versioned rows require the `If-Match` ETag header (`_version`; missing → 428, drift → 412). Edit forms must carry the ETag from the read.
- **Break-glass**: RBAC role/policy DELETE (and multi-role policy edits) require step-up credentials in the body (`BreakGlassDto`, TASK-409). The console needs a re-auth confirmation dialog.
- **Impersonation**: `POST /admin/users/:id/impersonate` (global admin, `manage:all`) plus legacy `POST /auth/impersonate` and `POST /auth/revoke-impersonation`; all impersonated mutations are audit-flagged (`ImpersonationAuditInterceptor`).
- **Session & hydration**: `POST /auth/login|refresh|logout`, `GET /auth/me`; menus and abilities hydrate from `POST /rbac/check/my-permissions`. SSE/WS use single-use 30-second tickets from `POST /auth/stream-ticket`.

### Foundations (frames 01–09) — console-wide auth surfaces

Not a menu section; these back the login shell and session plumbing every screen depends on.

| Concern | Backend endpoints | Notes |
|---|---|---|
| Login / session | `POST /auth/login` (public, throttled 5/min), `POST /auth/refresh` (public), `POST /auth/logout`, `GET /auth/me` | `apps/api/src/modules/auth/auth.controller.ts` |
| Password recovery | `POST /auth/forgot-password` (public, throttled), `POST /users/password-reset/complete` | `apps/api/src/modules/user/controllers/{forgot-password,password-reset}.controller.ts` |
| Stream tickets | `POST /auth/stream-ticket` | Single-use, 30 s TTL, scope-bound per stream |
| Ability hydration | `POST /rbac/check/my-permissions` (also `POST /rbac/check`, `POST /rbac/check/bulk`) | `@Authorize()` — any authenticated user; drives menu tiers |

## 2. Capabilities Matrix

### Tier 10–19 — Global admin only (cross-tenant; never require a selected tenant)

| # | Capability | Backend endpoints | Guard | Global admin | Tenant admin | Planned route | Screens & key UI | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Platform dashboard | `GET /admin/platform/{metrics,sockets,consumption}` | `manage:PlatformMetrics` (class; only `manage:all` satisfies it) | Full platform KPIs; `consumption?tenantId=` targets one tenant | No access | `/dashboard` | KPI cards, 30-min time-series charts, per-service/per-model breakdown tables | `apps/api/src/modules/platform-metrics/platform-metrics.controller.ts` |
| 2 | System status & monitoring | `GET /health`, `GET /health/services[/:serviceKey]`, `GET /monitoring/{uptime,uptime/:service,heartbeats/:service,sessions}`, `GET /admin/queues/health/redis` | `/health` root + `live/ready/startup` probes `@Public`; services + monitoring `CanAny(manage:all, read:TenantTelemetry)`; redis health `manage:all` | All services, cross-tenant | Partial: holds tenant-scoped `read:TenantTelemetry`, so service health/uptime/sessions render tenant-scoped | `/monitoring` | Status board, uptime sparklines, heartbeat history, live session counts | Discrepancy vs taxonomy: not strictly global-admin-only — a tenant-scoped read exists (TASK-386 #21) |
| 3 | Tenant management | `GET/POST /admin/tenants`, `GET :id`, `GET code-name/:code-name`, `GET user/:userId`, `PATCH :id` (If-Match), `DELETE :id`, `POST :id/{suspend,archive,restore}`, `GET :id/usage`, `GET/PUT :id/tags`, `GET/PATCH configs/:identifier` | Class `CanAny(manage:Tenant, update:Tenant)`; create/delete/suspend/archive/restore method-pinned `manage:Tenant` | Full CRUD + lifecycle + usage + tags + configs, cross-tenant | Read/update/tags/configs of OWN tenant only (per-row scope assert); list collapses to own row | `/tenants`, `/tenants/[id]` | Data-grid with status/tag filters, detail tabs (overview, usage, configs, tags, frontend config), lifecycle confirm dialogs, create wizard | Lifecycle ops block the SYSTEM tenant. Tenant self-service also exists at `/tenant/me` (tier 20–29) |
| 4 | Entitlements & plans | `GET/PUT /admin/entitlements/enabled` (kill-switch), `GET /admin/entitlements/plans`, `GET/PATCH plans/:plan` (OCC), `GET tenants/:tenantId` (snapshot), `GET/PUT/DELETE tenants/:tenantId/override`, `POST tenants/:tenantId/downgrade`, `POST trial-expiry/run` | `manage:all` (class) | Full: plan matrix, per-tenant override, downgrade, trial-expiry sweep, kill-switch | No access (own snapshot via `GET /entitlements/me`, tier 20–29) | `/entitlements` | Plan-matrix editable grid, per-tenant override form, kill-switch toggle with confirm, downgrade wizard | `DELETE override` clears back to plan inheritance (row nulled, never deleted) |
| 5 | Tenant storage administration | `GET /admin/tenants/storage/buckets`, `GET buckets/defaults`, `PUT buckets/defaults`, `GET buckets/:id[/tree,/objects,/presigned-url]`, `POST buckets`, `DELETE buckets/:id`, `POST/DELETE buckets/:id/objects`, `POST buckets/provision/:tenantId`; `GET /admin/tenants/storage/config[/effective]`, `PUT /admin/tenants/storage/config`, `DELETE config/:id`; `GET/POST /admin/tenants/storage/keys`, `DELETE keys/:id` | Buckets/keys class `CanManage('Tenant')`, reads method-overridden `read:Storage`; config class `CanAny(manage:Tenant, update:Tenant)` | Full: provision system buckets, create/delete buckets and objects, manage access keys, defaults | Reads of bucket/config/key lists (via `read:Storage` / `update:Tenant`); config PUT/DELETE allowed; bucket/object writes and key create/delete are global-admin (`manage:Tenant`) | `/tenants/storage` | Bucket data-grid, object tree browser, provision wizard, storage-config form, access-key list with reveal-once | Discrepancy: reads are NOT global-admin-only; write posture differs per sub-surface (see Guard) |
| 6 | Tenant frontend pipeline config | `GET /admin/tenant-frontend-config[?tenantId=]`, `PUT /admin/tenant-frontend-config` | `CanAny(manage:Tenant, update:Tenant)` (class) | Any tenant via `?tenantId=` | Own tenant (query param ignored) | `/tenants/[id]` → Frontend-config tab | SDK pipeline defaults form (VAD, noise filter, STT options) inside the tenant detail | Folded into the Tenant management detail (frame 12) — it is per-tenant config and tier 10–19 has no free frame slot. Effective config surfaces to tenants via `GET /tenant/me/config` |
| 7 | Rate limits | `GET /admin/rate-limit`, `PUT /admin/rate-limit/enabled`, `PUT tiers/:tier`, `PUT routes/:routeId` | `manage:all` (class) | Full: global toggle, per-tier and per-route overrides | No access | `/rate-limits` | Tier table with inline edit, per-route override list, master toggle | `apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts` |
| 8 | Queue & job administration | `GET /admin/queues`, `GET :queueName`, `POST :queueName/{pause,resume,clean}`, `GET :queueName/jobs`, `GET :queueName/jobs/:jobId`, `POST :queueName/jobs/bulk`, `POST :queueName/jobs/:jobId/{retry,promote}`, `DELETE :queueName/jobs/:jobId` | `manage:all` (class) | Full BullMQ ops | No access | `/queues`, `/queues/[name]` | Queue stats cards, paginated job data-grid with status filter, job detail drawer (PII-redacted payload, stacktrace), bulk retry/delete | Job data is PII-redacted server-side |
| 9 | Scheduler administration | `GET /admin/schedulers`, `POST :name/{pause,resume}`, `PATCH :name/{cron,toggle}` | `manage:all` (class) | Full: pause/resume, cron edit, enable/disable | No access | `/schedulers` | Scheduler list with next-run, cron editor with validation | `apps/api/src/modules/queue-admin/scheduler-admin.controller.ts` |
| 10 | Audit logs | `GET /admin/audit-logs`, `GET export`, `GET cursor`, `GET :id`, `GET resource/:resourceType/:resourceId`, `GET user/:userId` | `read:AuditLog` (class + methods) | Cross-tenant reads; export | Tenant-scoped reads and export (holds `audit-log-read`); non-elevated callers without tenant context get 403 | `/audit-logs` | Filterable data-grid (date range, action, resourceType, userId), cursor pagination for deep scans, CSV export, detail drawer | Taxonomy places Logs in 10–19, but the screen MUST also work tenant-scoped — `TENANT_ADMIN` legitimately reads its own trail. Read-only by design |
| 11 | AI model registry | `POST /admin/ai-models`, `GET /admin/ai-models`, `GET list` (paginated), `GET :id`, `GET slug/:slug`, `PATCH :id`, `DELETE :id` | `manage:all` (class) — **re-pinned in TASK-419 item 5** per the 2026-07-04 global-admin-only decision; the tenant-scoped `manage:AiModel` grant no longer opens the controller | Full catalog management; per-tenant clones of the SYSTEM catalog managed via the working-tenant selector | No access (console and backend) | `/ai-models` | Model data-grid (all statuses), create/edit form (slug, provider, params), disable/re-enable toggle | Moved from tier 30–49 per user review 2026-07-04. Admin list shows ENABLED + DISABLED for the working tenant |
| 12 | Prisma Studio | `GET/POST /admin/pstudio`, `GET /admin/pstudio/status` | `manage:PrismaStudio` (all routes, incl. `/status`) — dedicated subject landed in TASK-419 item 4; `manage:all` still passes via the CASL wildcard | Embedded DB browser; status probe always registered | No access | `/pstudio` | Embedded iframe shell + truthful enabled/disabled card from `/status` | **Production-capable since TASK-419 item 4**: module registers when `ENABLE_PRISMA_STUDIO=true` (NODE_ENV no longer consulted, fail-closed when unset) AND the caller holds `manage:PrismaStudio` (seeded to the GLOBAL_ADMIN policy set as `prisma-studio-manage`). The screen's status card behavior is unchanged |

### Tier 20–29 — Shared (global admin cross-tenant or tenant-scoped; tenant admin own tenant)

| # | Capability | Backend endpoints | Guard | Global admin | Tenant admin | Planned route | Screens & key UI | Notes |
|---|---|---|---|---|---|---|---|---|
| 13 | Users directory & lifecycle | `GET/POST /admin/users`, `GET export`, `GET :id`, `GET tenant/:tenantId`, `PATCH :id`, `PATCH :id/status`, `DELETE :id`, `DELETE bulk`, `POST bulk-actions` | `manage:User` (class) | Cross-tenant list (or tenant-scoped when `X-Tenant-Id` selected); all lifecycle ops | Own tenant only (list auto-pinned; per-id scope assert → cross-tenant 404) | `/users` | Data-grid with CSV filters/sort/search, create dialog, bulk action bar (enable/disable/delete/assign), export (csv/xlsx/pdf) | `bulk-actions` assign-role arm additionally requires `manage:UserRoleAssignment` |
| 14 | User role & department assignment | `GET/POST /admin/users/:id/roles`, `DELETE :id/roles/:assignmentId`; `GET/POST /admin/users/:id/departments`, `PATCH/DELETE :id/departments/:assignmentId`, `PATCH :id/departments` (bulk reconcile); `GET /users/:id/roles` | Class `manage:User`; `POST :id/roles` method-pinned `manage:UserRoleAssignment` | Any tenant's users | Own tenant; custom-role delegation via `rbac-tenant-manage` + `rbac-delegate` | `/users/[id]` (Roles / Departments tabs) | Assignment lists with add/remove, primary-department picker, role picker filtered by assignable tier | Role tier guards run in the service; `GET /users/:id/roles` is the self-readable variant (`@Authorize()`) |
| 15 | User account operations | `GET /admin/users/:id/settings`, `PATCH :id/settings/:namespace/:key`, `GET/PATCH :id/profile`, `POST :id/reset-password`, `GET :id/api-keys`, `GET :id/voice-profiles` | `manage:User` (class) | Any tenant's users | Own tenant | `/users/[id]` (Settings / Profile / Security tabs) | Namespaced settings editor, profile form, reset-password confirm (temporary password + emailed link), read-only API-key and voice-profile lists | Reset flow: TASK-388 #8; end-user counterparts live at `/user/me/*` |
| 16 | Impersonation | `POST /admin/users/:id/impersonate`; legacy `POST /auth/impersonate`, `POST /auth/revoke-impersonation` | `manage:all` (method) | Impersonate any user; revoke | No access (admin route); legacy route is `@Authorize()` + service-level checks | `/users/[id]` action + global banner | Confirm dialog with reason field, persistent "Impersonating" banner with revoke | All impersonated writes audit-flagged |
| 17 | RBAC roles | `GET /admin/rbac/roles`, `GET :id`, `POST`, `PUT :id`, `PATCH :id`, `DELETE :id` (break-glass), `POST :roleId/policies/:policyId`, `DELETE :roleId/policies/:policyId` | Class `manage:Role`; reads `CanAny(read:Role, manage:Role)`; policy attach/detach `manage:RolePolicy` | All roles incl. system roles | Custom (non-system) roles only; reads system roles for reference (`rbac-tenant-manage` conditions) | `/rbac/roles` | Role list with system-role badges, role editor, policy attach picker, break-glass step-up dialog on delete | System roles are delete-protected in the service |
| 18 | RBAC policies | `GET /admin/rbac/policies`, `GET :id`, `POST`, `PUT :id`, `PATCH :id`, `DELETE :id` (break-glass), `POST validate` | Class `manage:Policy`; reads `CanAny(read:Policy, manage:Policy)` | Full policy authoring | Read for assignment; tenant-scope manage per `rbac-tenant-manage` conditions | `/rbac/policies` | Policy list, JSON rule editor with `POST validate` preflight, break-glass dialog | Multi-role rule edits also demand step-up (TASK-409) |
| 19 | Permission checks & ability hydration | `POST /rbac/check`, `POST /rbac/check/bulk`, `POST /rbac/check/my-permissions` | `@Authorize()` (any authenticated) | Same | Same | (internal; no screen) | Console bootstrap: hydrate CASL ability + menu visibility from `my-permissions` | Both audiences use it; drives tier-based menu rendering |
| 20 | API keys | `GET/POST /admin/api-keys`, `GET scopes`, `GET :id`, `PATCH :id`, `DELETE :id`, `POST :id/revoke`, `POST :id/rotate`, `GET :id/usage` | Class `manage:ApiKey`; per-method `create/read/update/delete:ApiKey` | Cross-tenant | Own tenant (`tenant-full-access` grants tenant-scoped `manage:ApiKey`) | `/api-keys` | Key data-grid with scope chips, create/rotate dialogs (raw key shown exactly once), usage stats panel, revoke confirm | Rotate keeps old key valid for a 24h grace window |
| 21 | Global settings & secrets | `POST /admin/settings`, `GET /admin/settings`, `GET tenant/:tenantId`, `GET :id`, `PATCH :id`, `DELETE :id`, `POST :id/reveal` | Class `manage:GlobalSetting`; `reveal` method-pinned `manage:all` | All settings; secret reveal | Tenant-scoped settings rows (`tenant-full-access` grants tenant-conditioned `manage:GlobalSetting`); NO reveal | `/settings` | Settings data-grid grouped by namespace, edit form, masked secret values with global-admin-only reveal action | Reveal is the only place secret material is returned |
| 22 | Tenant & account self-service | `GET /tenant/me`, `GET /tenant/me/config`, `PATCH /tenant/me/config` (If-Match); `GET /entitlements/me`; `GET/PATCH /user/me/settings[/:namespace/:key]`, `GET/PATCH /user/me/preferences` | `@Authorize()`; `/entitlements/me` `read:Tenant` | Works under an elevated tenant selection | Own tenant profile, effective SDK config, entitlement/usage snapshot, own settings | `/tenant-profile`, `/account` | Read-only tenant card, effective-config form with ETag handling, quota/usage meters, personal preference forms | `/entitlements/me` is the tenant-visible counterpart of tier row 4 |

### Tier 30–49 — Tenant-admin scope (global admin must select a working tenant; "Acting on" banner on mutations)

| # | Capability | Backend endpoints | Guard | Global admin | Tenant admin | Planned route | Screens & key UI | Notes |
|---|---|---|---|---|---|---|---|---|
| 23 | Department management | `GET/POST /admin/departments`, `GET roots`, `GET :id`, `GET code/:code`, `GET :id/children`, `GET :id/users`, `PATCH :id` (If-Match), `PATCH :id/prompt-config`, `DELETE :id` | `manage:Department` (class + prompt-config method) | Any tenant after selection | Own tenant (`tenant-full-access`) | `/departments` | Tree/hierarchy view (roots + children), member data-grid, edit form with ETag, prompt-config panel | Prompt-config bridges to the Agents surface (row 25) |
| 24 | Storage browser (tenant data plane) | `GET/POST /storage/buckets`, `GET buckets/:name`, `PATCH buckets/:name`, `DELETE buckets/:name`, `GET buckets/:name/files`, `POST buckets/:name/files`, `GET/DELETE buckets/:name/files/:key`, `GET /storage/health` | Per-method `read/create/update/delete:Storage` | Selected tenant's buckets | Own tenant buckets/objects (`manage:Storage`) | `/storage` | Bucket list, file browser with upload (multipart, thumbnails), presigned download links, delete confirms | Tenant-scoped listing only (never physical cross-tenant buckets). Cross-tenant admin plane is tier row 5 |
| 25 | Prompt templates / agents | `POST /admin/prompt-templates`, `GET /admin/prompt-templates`, `GET analytics/usage`, `GET usage-records`, `GET :id`, `PATCH :id`, `DELETE :id`, `GET :id/versions[/:versionNumber]`, `GET :id/versions/:from/diff/:to`, `GET :id/usage`, `POST :id/test`, `POST :id/versions/:versionNumber/activate`, `POST assign-department` | Class `manage:PromptTemplate`; per-method `create/update/delete:PromptTemplate`; `assign-department` pinned `manage:Department` | Selected tenant | Own tenant (`prompt-template-manage`) | `/agents` | Template data-grid, version history with side-by-side diff view, test-run playground panel, activate confirm, department-assignment dialog, usage analytics charts | End-user read surface `/prompt-templates/{available,preferred}` feeds clinician selectors, not the console |
| 26 | DNA writing style administration | `GET /admin/dna-writing-styles` (list, `?tenantId` `?doctorId`), `GET dashboard`, `GET doctor/:doctorId`, `PATCH :reportId` (If-Match), `POST generate/:doctorId`, `GET :reportId/versions`, `GET jobs/:jobId`, `GET jobs/:jobId/stream` (SSE) | `manage:DnaWritingStyleReport` (class) | Selected tenant; dashboard/list accept `?tenantId=` (all-tenant roll-up when omitted) | Own tenant (query param ignored); PHI guard pins doctor reads to tenant even for global admins | `/dna-writing-styles` | Aggregate dashboard cards, report data-grid, per-doctor detail with version timeline, generate action with SSE job progress | Discrepancy vs seed: no "activate" route here (that is prompts); generation is per-doctor |
| 27 | Audio (ASR) pipelines | `POST /admin/audio/pipelines`, `GET /admin/audio/pipelines[,/list]`, `GET :id`, `GET slug/:slug`, `PATCH :id`, `DELETE :id`, `POST validate`, `POST :id/assign-tenant`, `POST :id/set-default`, `PATCH :id/toggle`, `GET :id/versions[/:versionNumber]`; public read `GET /audio/pipelines` | Admin `manage:AsrPipeline` (class); public read `@Authorize()` | Selected tenant; cross-tenant assignment via `assign-tenant` | Own tenant (`tenant-full-access`) | `/audio/pipelines` | Pipeline data-grid, config editor with `validate` preflight, version history, default/toggle actions, tenant-assignment dialog | Public read backs SDK/clinician pipeline pickers |
| 28 | Transcription jobs (admin view) | `GET /admin/audio/transcription-jobs`, `GET stats`, `GET status/:status` | Class `CanManage('Tenant')`; each read method-pinned `read:AsrPipeline` | Selected tenant | Own tenant (via `manage:AsrPipeline`) | `/audio/transcription-jobs` | Job data-grid with status filter, stats cards (queued/running/failed), link to per-job SSE stream | Read-only ops surface; job creation is the SDK/playground plane (`/audio/transcription-jobs*`, tier 50–59) |
| 29 | Harness policy & live config | `GET /admin/harness/policy`, `PATCH policy` (If-Match), `GET policy/global`, `PATCH policy/global` (If-Match), `GET live/config`, `PATCH live/config` | `read:HarnessPolicy` / `manage:HarnessPolicy`; `policy/global` additionally asserts platform admin in code | Tenant policy after selection + the GLOBAL-DEFAULT row (global admin only) | Own tenant policy + live config (`tenant-full-access`) | `/harness/policy` | Effective-policy form (tenant row over global default), OCC-aware save, WORM change note, global-default editor gated to global admins | Every edit appends a `HarnessPolicyChange` WORM row |
| 30 | Harness observability | `GET /admin/harness/audit` (`?tenantId` platform-only), `GET eval-runs`, `GET eval-runs/:id`, `GET gate-queue` | `read:HarnessAudit`, `read:HarnessEval`, `read:HarnessWorkflow` | Cross-tenant via `?tenantId=` after selection | Own tenant | `/harness/observability` | WORM audit trail table with chain-integrity verdict badge, eval-run list + per-case scores detail, clinician gate-queue board | Read-only |
| 31 | Harness workflow operations | `GET /admin/harness/workflows`, `GET workflows/:id`, `POST workflows/:id/{signal,cancel,terminate}`, `GET live/sessions[/:id]` | `read:HarnessWorkflow` / `manage:HarnessWorkflow` | Selected tenant | Own tenant | `/harness/workflows` | Temporal workflow data-grid, detail drawer with history, signal (approve/edit) dialog, cancel/terminate confirms, live-session monitor | Backed by `apps/harness` admin endpoints via the gateway |
| 32 | Realtime pipeline policy (cascade) | `GET /admin/harness/pipeline-policy`, `GET row`, `PUT row` | `read:PipelinePolicy` / `manage:PipelinePolicy` | Selected tenant | Own tenant | `/harness/pipeline-policy` | Cascade matrix (auto-summary / auto-NER / harness-vs-legacy routing) with scope-level rows and effective-value preview | Separate subject from `HarnessPolicy` by design |
| 33 | Consultations (admin view) | `GET /admin/consultations` (filters: patientId, doctorId, departmentId, status), `GET aggregate?from&to[&granularity]`, `GET :id` | `manage:Consultation` (class) | Cross-tenant aggregate with NO tenant selected; tenant-pinned otherwise | Own tenant | `/consultations` | Data-grid with clinical filters, new/revisit aggregate chart (day/month buckets), read-only detail view with relations | A plain DOCTOR never passes the guard (owner-scoped list/read only) |

## 3. Proposed Navigation & Figma Frame Map

Menu visibility mirrors the number-range prefixes (rule `12-design-workflow.mdc` §3): the sidebar renders a section only when `POST /rbac/check/my-permissions` grants at least one ability behind it. Frames live in the Figma file `HOPE-Admin-Console`, organized into exactly three groups — **Foundation**, **Global admins'**, **Tenant admins'** — and named per the grammar `<NN>[.<sub>][-<device>] - <Name>` (device omitted = desktop 1440; sub-numbers for detail/sub-screens, e.g. `12.1 - Tenant Detail`).

### Group: Foundation (01–09) — referenced by every screen, never redrawn

| Frame | Name | Contents |
|---|---|---|
| 01 | `01 - Color Palette & Tokens` | Calm Clinical Teal semantic tokens from `packages/ui/src/styles/globals.css`, light + dark, contrast-verified pairs |
| 02 | `02 - Typography & Iconography` | Type scale, heading hierarchy, lucide icon usage, mono for IDs/code |
| 03 | `03 - Spacing, Radius & Elevation` | 8-pt grid, roundness scale, borders, shadows/elevation |
| 04 | `04 - Accessibility Standards` | Focus rings, landmarks, touch-target sizes, reduced-motion, color-independence rules (WCAG 2.2 AA) |
| 05 | `05 - Interaction & Feedback States` | Hover/active/disabled/loading states, toasts, confirms, destructive patterns, skeleton rules |
| 06 | `06 - Core Components` | `@arcaai/ui` primitives as published Figma components (buttons, inputs, badges, dialogs, data-grid, charts) |
| 07 | `07 - App Shell & Navigation` | Sidebar (tier-grouped), topbar, working-tenant switcher + "Acting on" banner, command palette, theme toggle |
| 08 | `08 - Layouts & Data Patterns` | Page layouts, form patterns (incl. If-Match/ETag save), filter bars, pagination, detail tabs |
| 09 | `09 - Screen Templates` | List/data-grid template, detail template, dashboard template, empty/error/NoTenant/404 states, login shell |

### Group: Global admins' (10–29) — global-only 10–19 + shared-audience 20–29

| Frame | Name | Route | Matrix rows |
|---|---|---|---|
| 10 | `10 - Platform Dashboard` | `/dashboard` | 1 |
| 11 | `11 - Monitoring & System Status` | `/monitoring` | 2 |
| 12 | `12 - Tenants List` · `12.1 - Tenant Detail` (tabs incl. frontend config) | `/tenants`, `/tenants/[id]` | 3, 6 |
| 13 | `13 - Entitlements & Plans` | `/entitlements` | 4 |
| 14 | `14 - Tenant Storage Administration` | `/tenants/storage` | 5 |
| 15 | `15 - AI Model Registry` | `/ai-models` | 11 |
| 16 | `16 - Rate Limits` | `/rate-limits` | 7 |
| 17 | `17 - Queues & Jobs` · `17.1 - Schedulers` | `/queues`, `/queues/[name]`, `/schedulers` | 8, 9 |
| 18 | `18 - Audit Logs` | `/audit-logs` | 10 (also renders tenant-scoped) |
| 19 | `19 - Prisma Studio` | `/pstudio` | 12 |
| 20 | `20 - Users` · `20.1 - User Detail` (tabs) | `/users`, `/users/[id]` | 13, 14, 15, 16 |
| 21 | `21 - RBAC Roles` | `/rbac/roles` | 17 |
| 22 | `22 - RBAC Policies` | `/rbac/policies` | 18 |
| 23 | `23 - API Keys` | `/api-keys` | 20 |
| 24 | `24 - Settings & Secrets` | `/settings` | 21 |
| 25 | `25 - Tenant Profile & Account` | `/tenant-profile`, `/account` | 22 |

### Group: Tenant admins' (30–49)

| Frame | Name | Route | Matrix rows |
|---|---|---|---|
| 30 | `30 - Departments` | `/departments` | 23 |
| 31 | `31 - Storage Browser` | `/storage` | 24 |
| 32 | `32 - Agents & Prompt Templates` | `/agents` | 25 |
| 33 | `33 - DNA Writing Styles` | `/dna-writing-styles` | 26 |
| 34 | `34 - Audio Pipelines` | `/audio/pipelines` | 27 |
| 35 | `35 - Transcription Jobs` | `/audio/transcription-jobs` | 28 |
| 36 | `36 - Harness Policy & Live Config` | `/harness/policy` | 29 |
| 37 | `37 - Harness Observability` | `/harness/observability` | 30 |
| 38 | `38 - Harness Workflows` | `/harness/workflows` | 31 |
| 39 | `39 - Realtime Pipeline Policy` | `/harness/pipeline-policy` | 32 |
| 40 | `40 - Consultations` | `/consultations` | 33 |

Row 19 of section 2 (ability hydration) is bootstrap plumbing, not a screen. Frames 50–59 (Playground) are reserved and deferred to TASK-420 — see section 6. Shared-audience frames 20–29 sit in the Global admins' group (global admins are the superset persona); each carries a Dev Mode annotation of its tenant-scoped rendering. For range 30–49, global admins see a NoTenant empty state until a working tenant is selected; every mutation shows the "Acting on: «Tenant»" banner. Every screen frame must include default + loading + empty + error states in both themes before it counts as "fully available" for the approval gate (rule 12 §2).

## 4. Dashboard Data Sources

| Endpoint | Data | Audience |
|---|---|---|
| `GET /admin/platform/metrics` | Requests/min, error rate, P95 latency, open sockets, per-service and per-model breakdowns, 30-min series | Global-admin dashboard |
| `GET /admin/platform/sockets` | Live WebSocket count (multi-instance aggregate) | Global-admin dashboard |
| `GET /admin/platform/consumption[?tenantId=]` | Transcription minutes, summaries last 24h, storage used vs quota, consultation counts; platform-wide or one tenant | Global-admin dashboard; tenant drill-down |
| `GET /admin/tenants/:id/usage` | Per-tenant usage statistics | Global-admin tenant detail; tenant admin (own tenant) |
| `GET /entitlements/me` | Capability/quota snapshot for the caller's tenant | Tenant dashboard |
| `GET /admin/consultations/aggregate?from&to` | Zero-filled new/revisit consultation series (day/month) | Both (tenant-pinned unless a global admin with no selection) |
| `GET /monitoring/uptime`, `GET /monitoring/sessions` | Service uptime history, active session counts per service | Global admin; tenant-scoped via `read:TenantTelemetry` |
| `GET /health/services` | Consolidated downstream service health | Global admin; tenant-scoped via `read:TenantTelemetry` |
| `GET /admin/queues` + `GET /admin/queues/health/redis` | Queue depths, worker counts, Redis health | Global-admin dashboard |
| `GET /admin/dna-writing-styles/dashboard[?tenantId=]` | Users with a style, average versions, recent usage activity | Tenant dashboard; global-admin roll-up |

## 5. Realtime Surfaces (SSE / WS)

Auth pattern: every SSE route accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=` minted by `POST /auth/stream-ticket` (30-second TTL, scope-bound per stream, e.g. `consultation_harness_progress:<id>`). The `TenantOwnedResourceSseGuard` asserts tenant ownership before the stream opens.

| Stream | Endpoint | Console use |
|---|---|---|
| DNA job progress (admin) | `GET /admin/dna-writing-styles/jobs/:jobId/stream` | Generate-report progress on the DNA screen |
| DNA job progress (self) | `GET /dna-writing-styles/jobs/:jobId/stream` | Playground (deferred, TASK-420) |
| Harness progress | `GET /consultations/:id/harness-progress/stream` | Stage-by-stage documentation progress (no PHI) |
| Harness assurance | `GET /consultations/:id/harness-assurance/stream` | Claim-verdict feed + gate decision |
| Live summary | `GET /consultations/:id/live-summary/stream` | Running SOAP snapshot during recording |
| Consultation jobs | `GET /consultations/jobs/:jobId/stream` | Async summary/comprehensive job progress |
| Transcription job | `GET /audio/transcription-jobs/:id/stream` | Batch job progress from the jobs admin screen |
| SMR task stream | `GET /text/tasks/:taskId/stream` | Playground LLM streaming (deferred, TASK-420) |
| Live STT | WS `/ws/stt/stream` (session via `POST /audio/transcription-jobs/stream/session`) | Playground live transcription (deferred, TASK-420) |

## 6. Gaps & Deferred — resolutions from the 2026-07-04 review

Honest inventory of what the console cannot build against yet, with the agreed resolution for each:

| Gap | Detail | Resolution |
|---|---|---|
| Evaluation golden sets/runs | `packages/applications/src/services/eval` is service-layer only, no dedicated controller. Read-only exposure exists solely through `GET /admin/harness/eval-runs`* (row 30) | **Follow-up ticket TASK-419** (admin API surface gaps) |
| Notifications, resource subscriptions, webhooks | `services/{notification,resourceSubscription,webhook}`: services + Prisma models exist, no public controllers. A webhook management screen needs new API work first | **Follow-up ticket TASK-419** |
| Guardrail / NLP services | No gateway admin surface (configuration lives inside the Python services); only indirect exposure via summaries/entities | **Follow-up ticket TASK-419** |
| Prisma Studio in production | Backend module is fail-closed dev-only; the review decided it must run in production behind a dedicated permission | **Follow-up ticket TASK-419** |
| AI model registry guard | Backend guard is tenant-scoped `manage:AiModel`; review decided global-admin only | **Follow-up ticket TASK-419** (guard re-pin) |
| Knowledge / RAG ingestion | Harness `POST /api/v1/knowledge/ingest` is internal-service-token only; no gateway REST surface for a knowledge screen | **Backlog** — discuss later |
| Federated learning | Prisma models only (`FedlClient`, `FedlRound`, ...), no app or endpoints | **Backlog** — discuss later |
| Tier 50–59 Playground | SDK-based clinical consultation demo (`@arcaai/vox` capture → transcribe → document), live transcription (WS streaming session), voice profile enrollment (`/voice-profile/*`), DNA writing style self-service (`/dna-writing-styles/*`), summarization/LLM demos (`/text/generate`*, task streams, providers) | **Follow-up ticket TASK-420** (Admin Console Playground) |

## 7. Capability Count Summary

| Tier | Audience | Capabilities |
|---|---|---|
| 10–19 | Global admin only | 12 (rows 1–12) |
| 20–29 | Shared | 10 (rows 13–22) |
| 30–49 | Tenant-admin scope | 11 (rows 23–33) |
| **Total** | | **33** |

Within the shared tier, two abilities remain global-admin-only at method level: impersonation (row 16) and secret reveal (row 21).

**Coverage note**: every admin-relevant row of `docs/traceability-matrix.md` is represented. Traceability rows 1–9, 11, 13 (admin view), 20, 21, 24–28, 30–34 appear as capability rows above; row 19's SSE surfaces are in section 5; rows 10, 14, 15, 35 (SDK/playground planes) are deferred with tier 50–59 (TASK-420); row 16 (live documentation SSE) is covered in section 5; row 12 (media persistence) is browsed via rows 24/33; rows 17–18 (NLP/guardrail), 22–23 (knowledge/eval), 29 (notifications/webhooks) and 36 (FedL) are recorded in section 6 rather than invented as screens.
