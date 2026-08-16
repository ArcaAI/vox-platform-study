# Admin Console — Capabilities Matrix & Figma Frame Ledger

Extracted 2026-08-16 from the TASK-415 ticket (`docs/archive/TASK-415-Hope-Admin-Console/capabilities-matrix.md`,
dated 2026-07-04) into a live location, because `docs/archive/**` is off-limits to this sprint's
tooling (see `.claude/settings.local.json`) and several rules (`12-design-workflow.md` §3,
`13-nextjs-apps.md` §Routing) point agents here for it.

**What this still is:** the authoritative ledger of which Figma frame numbers (01–40) are already
allocated and to what, per the naming grammar in `12-design-workflow.md` §3. New screens take the
next unused number in their tier range — never renumber or reuse one of these.

**What this is NOT:** an exhaustive or current route list. It predates the TASK-532
governance-console IA expansion and everything shipped after 2026-07-04 (AI operations, billing,
releases, tools & MCP, agentic policy, DB studio, playground, etc.). For the current, authoritative
route inventory, read `apps/admin-console/src/shared/navigation/nav-config.ts` (per
`apps/admin-console/README.md`: "43 routes across four tiers ... the authoritative route
inventory").

## Capabilities Matrix (tiers 10–49, as of 2026-07-04 — 33 rows)

### Tier 10–19 — Global admin only (cross-tenant; never require a selected tenant)

| # | Capability | Planned route | Notes |
|---|---|---|---|
| 1 | Platform dashboard | `/dashboard` | |
| 2 | System status & monitoring | `/monitoring` | |
| 3 | Tenant management | `/tenants`, `/tenants/[id]` | |
| 4 | Entitlements & plans | `/entitlements` | |
| 5 | Tenant storage administration | `/tenants/storage` | |
| 6 | Tenant frontend pipeline config | `/tenants/[id]` → Frontend-config tab | Folded into tenant detail |
| 7 | Rate limits | `/rate-limits` | |
| 8 | Queue & job administration | `/queues`, `/queues/[name]` | |
| 9 | Scheduler administration | `/schedulers` | |
| 10 | Audit logs | `/audit-logs` | Also renders tenant-scoped |
| 11 | AI model registry | `/ai-models` | |
| 12 | Prisma Studio | `/pstudio` | |

### Tier 20–29 — Shared (global admin cross-tenant or tenant-scoped; tenant admin own tenant)

| # | Capability | Planned route | Notes |
|---|---|---|---|
| 13 | Users directory & lifecycle | `/users` | |
| 14 | User role & department assignment | `/users/[id]` (Roles / Departments tabs) | |
| 15 | User account operations | `/users/[id]` (Settings / Profile / Security tabs) | |
| 16 | Impersonation | `/users/[id]` action + global banner | |
| 17 | RBAC roles | `/rbac/roles` | |
| 18 | RBAC policies | `/rbac/policies` | |
| 19 | Permission checks & ability hydration | (internal; no screen) | Console bootstrap |
| 20 | API keys | `/api-keys` | |
| 21 | Global settings & secrets | `/settings` | |
| 22 | Tenant & account self-service | `/tenant-profile`, `/account` | |

### Tier 30–49 — Tenant-admin scope (global admin must select a working tenant)

| # | Capability | Planned route | Notes |
|---|---|---|---|
| 23 | Department management | `/departments` | |
| 24 | Storage browser (tenant data plane) | `/storage` | |
| 25 | Prompt templates / agents | `/agents` | |
| 26 | DNA writing style administration | `/dna-writing-styles` | |
| 27 | Audio (ASR) pipelines | `/audio/pipelines` | |
| 28 | Transcription jobs (admin view) | `/audio/transcription-jobs` | |
| 29 | Harness policy & live config | `/harness/policy` | Global-default row is global-admin only |
| 30 | Harness observability | `/harness/observability` | |
| 31 | Harness workflow operations | `/harness/workflows` | |
| 32 | Realtime pipeline policy (cascade) | `/harness/pipeline-policy` | |
| 33 | Consultations (admin view) | `/consultations` | |

## Figma Frame Map — allocated frames 01–40

Frames live in the Figma file `HOPE-Admin-Console`, named per `<NN>[.<sub>][-<device>] - <Name>`.

### Group: Foundation (01–09) — referenced by every screen, never redrawn

| Frame | Name |
|---|---|
| 01 | `01 - Color Palette & Tokens` |
| 02 | `02 - Typography & Iconography` |
| 03 | `03 - Spacing, Radius & Elevation` |
| 04 | `04 - Accessibility Standards` |
| 05 | `05 - Interaction & Feedback States` |
| 06 | `06 - Core Components` |
| 07 | `07 - App Shell & Navigation` |
| 08 | `08 - Layouts & Data Patterns` |
| 09 | `09 - Screen Templates` |

### Group: Global admins' (10–29)

| Frame | Name | Route | Matrix rows |
|---|---|---|---|
| 10 | `10 - Platform Dashboard` | `/dashboard` | 1 |
| 11 | `11 - Monitoring & System Status` | `/monitoring` | 2 |
| 12 | `12 - Tenants List` · `12.1 - Tenant Detail` | `/tenants`, `/tenants/[id]` | 3, 6 |
| 13 | `13 - Entitlements & Plans` | `/entitlements` | 4 |
| 14 | `14 - Tenant Storage Administration` | `/tenants/storage` | 5 |
| 15 | `15 - AI Model Registry` | `/ai-models` | 11 |
| 16 | `16 - Rate Limits` | `/rate-limits` | 7 |
| 17 | `17 - Queues & Jobs` · `17.1 - Schedulers` | `/queues`, `/queues/[name]`, `/schedulers` | 8, 9 |
| 18 | `18 - Audit Logs` | `/audit-logs` | 10 |
| 19 | `19 - Prisma Studio` | `/pstudio` | 12 |
| 20 | `20 - Users` · `20.1 - User Detail` | `/users`, `/users/[id]` | 13, 14, 15, 16 |
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

**Frames 41+ are not recorded here** — everything shipped after 2026-07-04 (governance-console IA,
playground, etc.) allocated its own frame numbers directly in Figma without updating this ledger.
Before assigning a new frame, check the live Figma file `HOPE-Admin-Console` for the actual
highest-used number rather than trusting "40" as current.

Frames 50–59 (Playground) are SHIPPED — see `13-nextjs-apps.md` §Routing for their route layout.
