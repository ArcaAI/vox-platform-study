# API Route Catalog & Call-Trees By Module

Total Routes Documented: **818** across **77** modules.

This document details every route, its handling controller method, and the hierarchical service call tree.

---

## Module: `(root)` (1 routes)

### Controller: `PrometheusController`
**File:** [``](file:///Users/apple/repos/VOX/project-hope/apps/api/)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/metrics` | `index` | Public | - | - |

#### Handler Call Trees:

_Handlers in this controller delegate directly or return static/mapped payloads._

---

## Module: `admin-rate-limit` (13 routes)

### Controller: `RateLimitAdminController`
**File:** [`src/modules/admin-rate-limit/rate-limit-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/rate-limit` | `getPolicy` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Get the effective rate-limit policy (global flag, tier baselines, known-route overrides). |
| `PUT` | `/api/v1/admin/rate-limit/enabled` | `setEnabled` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Flip the global rate-limit kill-switch. |
| `GET` | `/api/v1/admin/rate-limit/explain` | `explain` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Explain how a rate limit resolves for one tenant + route. |
| `GET` | `/api/v1/admin/rate-limit/plans` | `listPlans` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | List each subscription plan’s rate limit. |
| `PATCH` | `/api/v1/admin/rate-limit/plans/{plan}` | `setPlan` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Set a subscription plan’s rate limit. |
| `GET` | `/api/v1/admin/rate-limit/routes` | `listRoutes` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | List every gateway route, for picking a rule target. |
| `PUT` | `/api/v1/admin/rate-limit/routes/{routeId}` | `setRoute` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Update a per-endpoint override for a known throttled route (e.g. auth.login). |
| `GET` | `/api/v1/admin/rate-limit/rules` | `listRules` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | List rate-limit rules. |
| `POST` | `/api/v1/admin/rate-limit/rules` | `createRule` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Create a rate-limit rule. |
| `DELETE` | `/api/v1/admin/rate-limit/rules/{id}` | `deleteRule` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Delete a rate-limit rule. |
| `GET` | `/api/v1/admin/rate-limit/rules/{id}` | `getRule` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Get one rate-limit rule. |
| `PATCH` | `/api/v1/admin/rate-limit/rules/{id}` | `updateRule` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | Yes | Update a rate-limit rule. |
| `PUT` | `/api/v1/admin/rate-limit/tiers/{tier}` | `setTier` | Perms: `manage:all`<br/>Svc: `svc:admin:rate-limit:manage` | - | Update a tier baseline (default | strict | heavy | relaxed). |

#### Handler Call Trees:

**`GET /api/v1/admin/rate-limit` → `RateLimitAdminController.getPolicy`**
```text
[GET /api/v1/admin/rate-limit]
  └── Controller: RateLimitAdminController.getPolicy()
        ├── calls: this.rateLimitAdmin.getPolicy()
        │     └─ Service: IRateLimitAdminService [token: IRateLimitAdminService]
```

**`PUT /api/v1/admin/rate-limit/enabled` → `RateLimitAdminController.setEnabled`**
```text
[PUT /api/v1/admin/rate-limit/enabled]
  └── Controller: RateLimitAdminController.setEnabled()
        ├── calls: this.rateLimitAdmin.setEnabled()
        │     └─ Service: IRateLimitAdminService [token: IRateLimitAdminService]
```

**`GET /api/v1/admin/rate-limit/explain` → `RateLimitAdminController.explain`**
```text
[GET /api/v1/admin/rate-limit/explain]
  └── Controller: RateLimitAdminController.explain()
        ├── calls: this.rules.explain()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`GET /api/v1/admin/rate-limit/plans` → `RateLimitAdminController.listPlans`**
```text
[GET /api/v1/admin/rate-limit/plans]
  └── Controller: RateLimitAdminController.listPlans()
        ├── calls: this.entitlements.listPlanEntitlements()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`PATCH /api/v1/admin/rate-limit/plans/{plan}` → `RateLimitAdminController.setPlan`**
```text
[PATCH /api/v1/admin/rate-limit/plans/{plan}]
  └── Controller: RateLimitAdminController.setPlan()
        ├── calls: this.entitlements.updatePlanEntitlement()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`GET /api/v1/admin/rate-limit/routes` → `RateLimitAdminController.listRoutes`**
```text
[GET /api/v1/admin/rate-limit/routes]
  └── Controller: RateLimitAdminController.listRoutes()
        ├── calls: this.routeCatalog.list()
        │     └─ Service: RouteCatalogService
```

**`PUT /api/v1/admin/rate-limit/routes/{routeId}` → `RateLimitAdminController.setRoute`**
```text
[PUT /api/v1/admin/rate-limit/routes/{routeId}]
  └── Controller: RateLimitAdminController.setRoute()
        ├── calls: this.rateLimitAdmin.setRoute()
        │     └─ Service: IRateLimitAdminService [token: IRateLimitAdminService]
```

**`GET /api/v1/admin/rate-limit/rules` → `RateLimitAdminController.listRules`**
```text
[GET /api/v1/admin/rate-limit/rules]
  └── Controller: RateLimitAdminController.listRules()
        ├── calls: this.rules.list()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`POST /api/v1/admin/rate-limit/rules` → `RateLimitAdminController.createRule`**
```text
[POST /api/v1/admin/rate-limit/rules]
  └── Controller: RateLimitAdminController.createRule()
        ├── calls: this.rules.create()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`DELETE /api/v1/admin/rate-limit/rules/{id}` → `RateLimitAdminController.deleteRule`**
```text
[DELETE /api/v1/admin/rate-limit/rules/{id}]
  └── Controller: RateLimitAdminController.deleteRule()
        ├── calls: this.rules.remove()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`GET /api/v1/admin/rate-limit/rules/{id}` → `RateLimitAdminController.getRule`**
```text
[GET /api/v1/admin/rate-limit/rules/{id}]
  └── Controller: RateLimitAdminController.getRule()
        ├── calls: this.rules.getById()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`PATCH /api/v1/admin/rate-limit/rules/{id}` → `RateLimitAdminController.updateRule`**
```text
[PATCH /api/v1/admin/rate-limit/rules/{id}]
  └── Controller: RateLimitAdminController.updateRule()
        ├── calls: this.rules.update()
        │     └─ Service: IRateLimitRuleService [token: IRateLimitRuleService]
```

**`PUT /api/v1/admin/rate-limit/tiers/{tier}` → `RateLimitAdminController.setTier`**
```text
[PUT /api/v1/admin/rate-limit/tiers/{tier}]
  └── Controller: RateLimitAdminController.setTier()
        ├── calls: this.rateLimitAdmin.setTier()
        │     └─ Service: IRateLimitAdminService [token: IRateLimitAdminService]
```

---

## Module: `admin-usage` (6 routes)

### Controller: `AdminUsageController`
**File:** [`src/modules/admin-usage/admin-usage.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/admin-usage/admin-usage.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/usage/cost-per-encounter` | `costPerEncounter` | Perms: `manage:UsageAnalytics`<br/>Svc: `svc:admin:usage:manage` | - | p50/p90/p99 + count of the Σ INTERNAL-basis cost per consultation over a billing period. |
| `GET` | `/api/v1/admin/usage/summary` | `summary` | Perms: `manage:UsageAnalytics`<br/>Svc: `svc:admin:usage:manage` | - | Units + rated cost per capability x provider x model for a billing period. BYOK notional split out. |
| `GET` | `/api/v1/admin/usage/timeseries` | `timeseries` | Perms: `manage:UsageAnalytics`<br/>Svc: `svc:admin:usage:manage` | - | Bounded-range rollup timeseries for one capability x unit (max 92 days daily / 72h hourly). |
| `GET` | `/api/v1/admin/usage/top-tenants` | `topTenants` | Perms: `manage:UsageAnalytics`<br/>Svc: `svc:admin:usage:manage` | - | SUPER_ADMIN-only cross-tenant top-N by rollup cost. Every other route on this controller is tenant-scoped; this one is not. |

#### Handler Call Trees:

**`GET /api/v1/admin/usage/cost-per-encounter` → `AdminUsageController.costPerEncounter`**
```text
[GET /api/v1/admin/usage/cost-per-encounter]
  └── Controller: AdminUsageController.costPerEncounter()
        ├── calls: this.usageAnalytics.getCostPerEncounter()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

**`GET /api/v1/admin/usage/summary` → `AdminUsageController.summary`**
```text
[GET /api/v1/admin/usage/summary]
  └── Controller: AdminUsageController.summary()
        ├── calls: this.usageAnalytics.getUsageSummary()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

**`GET /api/v1/admin/usage/timeseries` → `AdminUsageController.timeseries`**
```text
[GET /api/v1/admin/usage/timeseries]
  └── Controller: AdminUsageController.timeseries()
        ├── calls: this.usageAnalytics.getUsageTimeseries()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

**`GET /api/v1/admin/usage/top-tenants` → `AdminUsageController.topTenants`**
```text
[GET /api/v1/admin/usage/top-tenants]
  └── Controller: AdminUsageController.topTenants()
        ├── calls: this.usageAnalytics.getTopTenants()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

### Controller: `MyUsageController`
**File:** [`src/modules/admin-usage/my-usage.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/admin-usage/my-usage.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me/usage-burndown` | `burndown` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection. Defaults to the current UTC month. |
| `GET` | `/api/v1/tenants/me/usage-summary` | `summary` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | The caller's own tenant's usage summary for a billing period. Defaults to the current UTC month. |

#### Handler Call Trees:

**`GET /api/v1/tenants/me/usage-burndown` → `MyUsageController.burndown`**
```text
[GET /api/v1/tenants/me/usage-burndown]
  └── Controller: MyUsageController.burndown()
        ├── calls: this.usageAnalytics.getBudgetBurndown()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

**`GET /api/v1/tenants/me/usage-summary` → `MyUsageController.summary`**
```text
[GET /api/v1/tenants/me/usage-summary]
  └── Controller: MyUsageController.summary()
        ├── calls: this.usageAnalytics.getUsageSummary()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

---

## Module: `agent` (11 routes)

### Controller: `AgentController`
**File:** [`src/modules/agent/agent.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent/agent.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/agents` | `list` | Auth<br/>API Key: `agent:definition:read`<br/>Svc: `svc:agent:definition:read` | - | List the published agents visible to the tenant (own agents shadow the platform defaults) |
| `GET` | `/api/v1/agents/{slug}` | `get` | Auth<br/>API Key: `agent:definition:read`<br/>Svc: `svc:agent:definition:read` | - | Describe one published agent: its task, version and I/O schemas |
| `POST` | `/api/v1/agents/{slug}/invocations` | `invoke` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Invoke a TEXT_GENERATION agent (blocking JSON, or SSE with ?mode=stream) |
| `POST` | `/api/v1/agents/{slug}/runs` | `startRun` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Start an agent RUN (async): answers 202 { runId, status, links } at once; poll, read the result, or follow its events |
| `GET` | `/api/v1/agents/{slug}/runs/{runId}` | `getRun` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | The status of one agent run |
| `POST` | `/api/v1/agents/{slug}/runs/{runId}/cancel` | `cancelRun` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Cancel an agent run (idempotent) |
| `GET` | `/api/v1/agents/{slug}/runs/{runId}/events` | `runEvents` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Follow an agent run as run protocol v2 over SSE (resumable) |
| `GET` | `/api/v1/agents/{slug}/runs/{runId}/result` | `getRunResult` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | The output a finished agent run produced |
| `POST` | `/api/v1/agents/{slug}/runs/{runId}/stream-ticket` | `issueRunStreamTicket` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Mint a single-use, 30-second ticket for this agent run’s SSE stream |
| `POST` | `/api/v1/agents/{slug}/speech` | `speech` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Synthesize speech with a TEXT_TO_SPEECH agent (streamed audio, the existing speech proxy contract) |
| `POST` | `/api/v1/agents/{slug}/transcriptions` | `transcribe` | Auth<br/>API Key: `agent:invocation:write`<br/>Svc: `svc:agent:invocation:write` | - | Start a batch transcription with a SPEECH_TO_TEXT agent (returns a TranscriptionJob) |

#### Handler Call Trees:

**`GET /api/v1/agents` → `AgentController.list`**
```text
[GET /api/v1/agents]
  └── Controller: AgentController.list()
        ├── calls: this.agentService.listPublished()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/agents/{slug}` → `AgentController.get`**
```text
[GET /api/v1/agents/{slug}]
  └── Controller: AgentController.get()
        ├── calls: this.agentService.getPublishedBySlug()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/agents/{slug}/invocations` → `AgentController.invoke`**
```text
[POST /api/v1/agents/{slug}/invocations]
  └── Controller: AgentController.invoke()
        ├── calls: this.resolver.resolve()
        │     └─ Service: AgentResolverService
```

**`POST /api/v1/agents/{slug}/runs` → `AgentController.startRun`**
```text
[POST /api/v1/agents/{slug}/runs]
  └── Controller: AgentController.startRun()
        ├── calls: this.resolver.resolve()
        │     └─ Service: AgentResolverService
```

**`GET /api/v1/agents/{slug}/runs/{runId}/events` → `AgentController.runEvents`**
```text
[GET /api/v1/agents/{slug}/runs/{runId}/events]
  └── Controller: AgentController.runEvents()
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
```

**`POST /api/v1/agents/{slug}/runs/{runId}/stream-ticket` → `AgentController.issueRunStreamTicket`**
```text
[POST /api/v1/agents/{slug}/runs/{runId}/stream-ticket]
  └── Controller: AgentController.issueRunStreamTicket()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.streamTicketService.issueTicket()
        │     └─ Service: StreamTicketService
        ├── calls: this.runAccess.resolveReader()
        │     └─ Service: RunPrincipalAccessService
```

**`POST /api/v1/agents/{slug}/transcriptions` → `AgentController.transcribe`**
```text
[POST /api/v1/agents/{slug}/transcriptions]
  └── Controller: AgentController.transcribe()
        ├── calls: this.asrResolver.resolve()
        │     └─ Service: AsrAgentResolverService
        ├── calls: this.mediaService.fetchById()
        │     └─ Service: IMediaService [token: IMediaService]
        ├── calls: this.jobService.createBatchJob()
        │     └─ Service: TranscriptionJobService
        ├── calls: this.realtimeService.dispatchDramatiqJob()
        │     └─ Service: TranscriptionRealtimeService
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.jobService.failJob()
        │     └─ Service: TranscriptionJobService
```

---

## Module: `agent-admin` (25 routes)

### Controller: `AgentAdminController`
**File:** [`src/modules/agent-admin/agent-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-admin/agent-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/agents` | `fetchAll` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | List the caller tenant’s agent versions |
| `POST` | `/api/v1/admin/agents` | `create` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Create a new DRAFT agent version for the caller tenant |
| `DELETE` | `/api/v1/admin/agents/{id}` | `remove` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Soft-delete an agent version (refused for the ACTIVE published version — deprecate it first) |
| `GET` | `/api/v1/admin/agents/{id}` | `fetchById` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Get one agent version (own or SYSTEM template) |
| `PATCH` | `/api/v1/admin/agents/{id}` | `update` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | Yes | Update a DRAFT/VALIDATED agent version (If-Match OCC) |
| `POST` | `/api/v1/admin/agents/{id}/activate` | `activate` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Make an already-PUBLISHED version the ACTIVE one for its slug (rollback) |
| `POST` | `/api/v1/admin/agents/{id}/deprecate` | `deprecate` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable |
| `POST` | `/api/v1/admin/agents/{id}/publish` | `publish` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Publish an agent version (fails closed) |
| `POST` | `/api/v1/admin/agents/{id}/test` | `test` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Assemble (and optionally run) a DRAFT agent without publishing it |
| `POST` | `/api/v1/admin/agents/{id}/test/finalize` | `finalizeTest` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Read a finished draft-test generation back from TEXT and record its usage |
| `POST` | `/api/v1/admin/agents/{id}/validate` | `validate` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Run every publish-time check; stores the report and advances to VALIDATED when nothing blocks |
| `GET` | `/api/v1/admin/agents/{id}/versions` | `fetchVersions` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Every version of this agent’s lineage, newest first |
| `POST` | `/api/v1/admin/agents/{id}/versions` | `newVersion` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Branch a new DRAFT version from ANY version (own lineage), or a new tenant lineage from a SYSTEM template |
| `POST` | `/api/v1/admin/agents/{slug}/clone` | `clone` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Clone a SYSTEM template or any visible agent into a NEW lineage |
| `GET` | `/api/v1/admin/agents/{slug}/export` | `exportBySlug` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Export one agent version as a portable JSON bundle |
| `POST` | `/api/v1/admin/agents/{slug}/sync` | `sync` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Push one of the caller’s own agents into other tenants the caller manages |
| `GET` | `/api/v1/admin/agents/{slug}/versions/{versionNumber}/usage` | `fetchVersionUsage` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Published workflows that pin this agent version |
| `POST` | `/api/v1/admin/agents/import` | `importBundle` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Import an exported agent bundle as a DRAFT in the caller tenant |
| `GET` | `/api/v1/admin/agents/lineages` | `fetchLineages` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | List the caller tenant’s agent LINEAGES (one row per slug) |
| `GET` | `/api/v1/admin/agents/tags` | `listTags` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Distinct agent tags with usage counts (autocomplete) |

#### Handler Call Trees:

**`GET /api/v1/admin/agents` → `AgentAdminController.fetchAll`**
```text
[GET /api/v1/admin/agents]
  └── Controller: AgentAdminController.fetchAll()
        ├── calls: this.agentService.list()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents` → `AgentAdminController.create`**
```text
[POST /api/v1/admin/agents]
  └── Controller: AgentAdminController.create()
        ├── calls: this.agentService.create()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`DELETE /api/v1/admin/agents/{id}` → `AgentAdminController.remove`**
```text
[DELETE /api/v1/admin/agents/{id}]
  └── Controller: AgentAdminController.remove()
        ├── calls: this.agentService.deleteById()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/{id}` → `AgentAdminController.fetchById`**
```text
[GET /api/v1/admin/agents/{id}]
  └── Controller: AgentAdminController.fetchById()
        ├── calls: this.agentService.getById()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`PATCH /api/v1/admin/agents/{id}` → `AgentAdminController.update`**
```text
[PATCH /api/v1/admin/agents/{id}]
  └── Controller: AgentAdminController.update()
        ├── calls: this.agentService.update()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/activate` → `AgentAdminController.activate`**
```text
[POST /api/v1/admin/agents/{id}/activate]
  └── Controller: AgentAdminController.activate()
        ├── calls: this.agentService.activate()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/deprecate` → `AgentAdminController.deprecate`**
```text
[POST /api/v1/admin/agents/{id}/deprecate]
  └── Controller: AgentAdminController.deprecate()
        ├── calls: this.agentService.deprecate()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/publish` → `AgentAdminController.publish`**
```text
[POST /api/v1/admin/agents/{id}/publish]
  └── Controller: AgentAdminController.publish()
        ├── calls: this.agentService.publish()
        │     └─ Service: IAgentService [token: IAgentService]
        ├── calls: this.languageCapability.warningsForAgent()
        │     └─ Service: AsrLanguageCapabilityService
```

**`POST /api/v1/admin/agents/{id}/test` → `AgentAdminController.test`**
```text
[POST /api/v1/admin/agents/{id}/test]
  └── Controller: AgentAdminController.test()
        ├── calls: this.agentService.testDraft()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/test/finalize` → `AgentAdminController.finalizeTest`**
```text
[POST /api/v1/admin/agents/{id}/test/finalize]
  └── Controller: AgentAdminController.finalizeTest()
        ├── calls: this.agentService.finalizeDraftTest()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/validate` → `AgentAdminController.validate`**
```text
[POST /api/v1/admin/agents/{id}/validate]
  └── Controller: AgentAdminController.validate()
        ├── calls: this.agentService.validate()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/{id}/versions` → `AgentAdminController.fetchVersions`**
```text
[GET /api/v1/admin/agents/{id}/versions]
  └── Controller: AgentAdminController.fetchVersions()
        ├── calls: this.agentService.listVersions()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{id}/versions` → `AgentAdminController.newVersion`**
```text
[POST /api/v1/admin/agents/{id}/versions]
  └── Controller: AgentAdminController.newVersion()
        ├── calls: this.agentService.newVersion()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{slug}/clone` → `AgentAdminController.clone`**
```text
[POST /api/v1/admin/agents/{slug}/clone]
  └── Controller: AgentAdminController.clone()
        ├── calls: this.agentService.clone()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/{slug}/export` → `AgentAdminController.exportBySlug`**
```text
[GET /api/v1/admin/agents/{slug}/export]
  └── Controller: AgentAdminController.exportBySlug()
        ├── calls: this.agentService.exportBySlug()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`POST /api/v1/admin/agents/{slug}/sync` → `AgentAdminController.sync`**
```text
[POST /api/v1/admin/agents/{slug}/sync]
  └── Controller: AgentAdminController.sync()
        ├── calls: this.agentService.syncToTenants()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/{slug}/versions/{versionNumber}/usage` → `AgentAdminController.fetchVersionUsage`**
```text
[GET /api/v1/admin/agents/{slug}/versions/{versionNumber}/usage]
  └── Controller: AgentAdminController.fetchVersionUsage()
        ├── calls: this.usageService.usage()
        │     └─ Service: AgentUsageService [token: AgentUsageService]
```

**`POST /api/v1/admin/agents/import` → `AgentAdminController.importBundle`**
```text
[POST /api/v1/admin/agents/import]
  └── Controller: AgentAdminController.importBundle()
        ├── calls: this.agentService.importBundle()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/lineages` → `AgentAdminController.fetchLineages`**
```text
[GET /api/v1/admin/agents/lineages]
  └── Controller: AgentAdminController.fetchLineages()
        ├── calls: this.agentService.listLineages()
        │     └─ Service: IAgentService [token: IAgentService]
```

**`GET /api/v1/admin/agents/tags` → `AgentAdminController.listTags`**
```text
[GET /api/v1/admin/agents/tags]
  └── Controller: AgentAdminController.listTags()
        ├── calls: this.agentService.listTagSuggestions()
        │     └─ Service: IAgentService [token: IAgentService]
```

### Controller: `AgentAssignmentAdminController`
**File:** [`src/modules/agent-admin/agent-assignment-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-admin/agent-assignment-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/agent-assignments` | `fetchAll` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | List the caller tenant’s agent assignments (plus SYSTEM’s platform defaults), optionally by task |
| `PATCH` | `/api/v1/admin/agent-assignments` | `update` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | Yes | Re-assign one tier (If-Match OCC) |
| `POST` | `/api/v1/admin/agent-assignments` | `create` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Create the assignment for one (scope, scopeId, task) tier |
| `DELETE` | `/api/v1/admin/agent-assignments/{id}` | `remove` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | Yes | Remove one assignment — the tier reverts to inheriting (WORM change row appended) |
| `GET` | `/api/v1/admin/agent-assignments/{id}` | `fetchById` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Get one agent assignment |

#### Handler Call Trees:

**`GET /api/v1/admin/agent-assignments` → `AgentAssignmentAdminController.fetchAll`**
```text
[GET /api/v1/admin/agent-assignments]
  └── Controller: AgentAssignmentAdminController.fetchAll()
        ├── calls: this.assignments.list()
        │     └─ Service: IAgentAssignmentService [token: IAgentAssignmentService]
```

**`PATCH /api/v1/admin/agent-assignments` → `AgentAssignmentAdminController.update`**
```text
[PATCH /api/v1/admin/agent-assignments]
  └── Controller: AgentAssignmentAdminController.update()
        ├── calls: this.assignments.upsert()
        │     └─ Service: IAgentAssignmentService [token: IAgentAssignmentService]
        ├── calls helper: this.withLanguageWarnings()
        │     ├── calls: this.languageCapability.warningsForAgent()
        │     │     └─ Service: AsrLanguageCapabilityService
```

**`POST /api/v1/admin/agent-assignments` → `AgentAssignmentAdminController.create`**
```text
[POST /api/v1/admin/agent-assignments]
  └── Controller: AgentAssignmentAdminController.create()
        ├── calls: this.assignments.upsert()
        │     └─ Service: IAgentAssignmentService [token: IAgentAssignmentService]
        ├── calls helper: this.withLanguageWarnings()
        │     ├── calls: this.languageCapability.warningsForAgent()
        │     │     └─ Service: AsrLanguageCapabilityService
```

**`DELETE /api/v1/admin/agent-assignments/{id}` → `AgentAssignmentAdminController.remove`**
```text
[DELETE /api/v1/admin/agent-assignments/{id}]
  └── Controller: AgentAssignmentAdminController.remove()
        ├── calls: this.assignments.remove()
        │     └─ Service: IAgentAssignmentService [token: IAgentAssignmentService]
```

**`GET /api/v1/admin/agent-assignments/{id}` → `AgentAssignmentAdminController.fetchById`**
```text
[GET /api/v1/admin/agent-assignments/{id}]
  └── Controller: AgentAssignmentAdminController.fetchById()
        ├── calls: this.assignments.getById()
        │     └─ Service: IAgentAssignmentService [token: IAgentAssignmentService]
```

---

## Module: `agent-promotion` (4 routes)

### Controller: `AgentPromoteToSystemController`
**File:** [`src/modules/agent-promotion/agent-promote-to-system.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-promotion/agent-promote-to-system.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/agents/promote-to-system` | `promoteToSystem` | Perms: `manage:Agent`<br/>Svc: `svc:admin:agent:manage` | - | Promote an agent from the Global build tenant into the SYSTEM reference set |

#### Handler Call Trees:

**`POST /api/v1/admin/agents/promote-to-system` → `AgentPromoteToSystemController.promoteToSystem`**
```text
[POST /api/v1/admin/agents/promote-to-system]
  └── Controller: AgentPromoteToSystemController.promoteToSystem()
        ├── calls: this.service.promoteToSystem()
        │     └─ Service: IAgentPromoteToSystemService [token: IAgentPromoteToSystemService]
```

### Controller: `AgentPromotionController`
**File:** [`src/modules/agent-promotion/agent-promotion.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-promotion/agent-promotion.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/agent-promotions` | `list` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:agent-promotion:manage` | - | List promotions INTO the working tenant |
| `POST` | `/api/v1/admin/agent-promotions` | `promote` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:agent-promotion:manage` | - | Promote a workflow definition version from one tenant to another |
| `GET` | `/api/v1/admin/agent-promotions/{id}` | `getById` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:agent-promotion:manage` | - | Get one promotion record |

#### Handler Call Trees:

**`GET /api/v1/admin/agent-promotions` → `AgentPromotionController.list`**
```text
[GET /api/v1/admin/agent-promotions]
  └── Controller: AgentPromotionController.list()
        ├── calls: this.service.list()
        │     └─ Service: IAgentPromotionService [token: IAgentPromotionService]
```

**`POST /api/v1/admin/agent-promotions` → `AgentPromotionController.promote`**
```text
[POST /api/v1/admin/agent-promotions]
  └── Controller: AgentPromotionController.promote()
        ├── calls: this.service.promote()
        │     └─ Service: IAgentPromotionService [token: IAgentPromotionService]
```

**`GET /api/v1/admin/agent-promotions/{id}` → `AgentPromotionController.getById`**
```text
[GET /api/v1/admin/agent-promotions/{id}]
  └── Controller: AgentPromotionController.getById()
        ├── calls: this.service.getById()
        │     └─ Service: IAgentPromotionService [token: IAgentPromotionService]
```

---

## Module: `agent-trajectory` (3 routes)

### Controller: `AgentTrajectoryController`
**File:** [`src/modules/agent-trajectory/agent-trajectory.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/agent-trajectory/metrics/generation` | `aggregateGenerationStats` | Perms: `read:AgentTrajectory`<br/>Svc: `svc:admin:agent-trajectory:read` | - | Aggregate GenerationStats across LLM_CALL trajectory steps (TTFT median/p95, tok/s avg, stop-reason histogram). Bounded window (default last 7d) + hard row cap. |
| `GET` | `/api/v1/admin/agent-trajectory/sessions` | `listSessions` | Perms: `read:AgentTrajectory`<br/>Svc: `svc:admin:agent-trajectory:read` | - | List distinct agentic working sessions (grouped by kind + sessionId + runId) with step counts + first/last timestamps |
| `GET` | `/api/v1/admin/agent-trajectory/sessions/{sessionId}/steps` | `listSteps` | Perms: `read:AgentTrajectory`<br/>Svc: `svc:admin:agent-trajectory:read` | - | List the ordered steps for a session (seq asc), keyset-paginated. Cross-tenant / nonexistent → 404 (never 403). |

#### Handler Call Trees:

**`GET /api/v1/admin/agent-trajectory/metrics/generation` → `AgentTrajectoryController.aggregateGenerationStats`**
```text
[GET /api/v1/admin/agent-trajectory/metrics/generation]
  └── Controller: AgentTrajectoryController.aggregateGenerationStats()
        ├── calls: this.trajectoryService.aggregateGenerationStats()
        │     └─ Service: IAgentTrajectoryService [token: IAgentTrajectoryService]
```

**`GET /api/v1/admin/agent-trajectory/sessions` → `AgentTrajectoryController.listSessions`**
```text
[GET /api/v1/admin/agent-trajectory/sessions]
  └── Controller: AgentTrajectoryController.listSessions()
        ├── calls: this.trajectoryService.listSessions()
        │     └─ Service: IAgentTrajectoryService [token: IAgentTrajectoryService]
```

**`GET /api/v1/admin/agent-trajectory/sessions/{sessionId}/steps` → `AgentTrajectoryController.listSteps`**
```text
[GET /api/v1/admin/agent-trajectory/sessions/{sessionId}/steps]
  └── Controller: AgentTrajectoryController.listSteps()
        ├── calls: this.trajectoryService.listSteps()
        │     └─ Service: IAgentTrajectoryService [token: IAgentTrajectoryService]
```

---

## Module: `agentic-admin` (1 routes)

### Controller: `AgenticAdminController`
**File:** [`src/modules/agentic-admin/agentic-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agentic-admin/agentic-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/agentic/instructions` | `getInstructions` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:agentic:manage` | - | The effective agentic instruction set for a tenant (prompt tier, judge pin, thresholds, safety criteria) |

#### Handler Call Trees:

**`GET /api/v1/admin/agentic/instructions` → `AgenticAdminController.getInstructions`**
```text
[GET /api/v1/admin/agentic/instructions]
  └── Controller: AgenticAdminController.getInstructions()
        ├── calls: this.agenticInstructionsService.getEffectiveInstructions()
        │     └─ Service: IAgenticInstructionsService [token: IAgenticInstructionsService]
```

---

## Module: `ai-inference` (5 routes)

### Controller: `AiInferenceController`
**File:** [`src/modules/ai-inference/ai-inference.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-inference/ai-inference.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/text-analyses/diagnosis` | `suggestDiagnosis` | Auth<br/>API Key: `ai:inference:write` | - | Derive diagnosis suggestions from the supplied clinical text (proxied to the NLP diagnosis endpoint). |
| `POST` | `/api/v1/text-analyses/entities` | `extractEntities` | Auth<br/>API Key: `ai:inference:write` | - | Extract medical entities (NER) from the supplied text (proxied to the NLP token-classification endpoint). |
| `POST` | `/api/v1/text-analyses/intent` | `classifyIntent` | Auth<br/>API Key: `ai:inference:write` | - | Classify text into one of the caller tenant configured intents (open-taxonomy, delegated by NLP to text). |
| `POST` | `/api/v1/text-analyses/topic` | `classifyTopic` | Auth<br/>API Key: `ai:inference:write` | - | Classify text into one of the caller tenant configured topics (open-taxonomy, delegated by NLP to text). |

#### Handler Call Trees:

**`POST /api/v1/text-analyses/diagnosis` → `AiInferenceController.suggestDiagnosis`**
```text
[POST /api/v1/text-analyses/diagnosis]
  └── Controller: AiInferenceController.suggestDiagnosis()
        ├── calls: this.client.suggestDiagnosis()
        │     └─ Service: AiInferenceClient
```

**`POST /api/v1/text-analyses/entities` → `AiInferenceController.extractEntities`**
```text
[POST /api/v1/text-analyses/entities]
  └── Controller: AiInferenceController.extractEntities()
        ├── calls: this.client.classifyTokens()
        │     └─ Service: AiInferenceClient
```

**`POST /api/v1/text-analyses/intent` → `AiInferenceController.classifyIntent`**
```text
[POST /api/v1/text-analyses/intent]
  └── Controller: AiInferenceController.classifyIntent()
        ├── calls: this.client.classifyIntent()
        │     └─ Service: AiInferenceClient
        ├── calls helper: this.emitDelegatedClassifyUsage()
        │     ├── calls: this.logger.warn()
        │     │     └─ Service: unknown
```

**`POST /api/v1/text-analyses/topic` → `AiInferenceController.classifyTopic`**
```text
[POST /api/v1/text-analyses/topic]
  └── Controller: AiInferenceController.classifyTopic()
        ├── calls: this.client.classifyTopic()
        │     └─ Service: AiInferenceClient
        ├── calls helper: this.emitDelegatedClassifyUsage()
        │     ├── calls: this.logger.warn()
        │     │     └─ Service: unknown
```

### Controller: `SafetyCheckController`
**File:** [`src/modules/ai-inference/safety-check.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-inference/safety-check.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/safety-checks` | `analyzeGuardrail` | Auth<br/>API Key: `ai:inference:write` | - | Run a content-safety / PII / prompt-injection check on the supplied text (proxied to the Guardrail service). |

#### Handler Call Trees:

**`POST /api/v1/safety-checks` → `SafetyCheckController.analyzeGuardrail`**
```text
[POST /api/v1/safety-checks]
  └── Controller: SafetyCheckController.analyzeGuardrail()
        ├── calls: this.client.analyzeGuardrail()
        │     └─ Service: AiInferenceClient
```

---

## Module: `ai-model` (26 routes)

### Controller: `AiModelAdminController`
**File:** [`src/modules/ai-model/ai-model-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-model/ai-model-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai-models` | `fetchAll` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Retrieving multiple ModelResponses |
| `POST` | `/api/v1/admin/ai-models` | `create` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Creating a ModelResponse |
| `DELETE` | `/api/v1/admin/ai-models/{id}` | `delete` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Deleting a ModelResponse by id |
| `GET` | `/api/v1/admin/ai-models/{id}` | `fetchById` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Retrieving a single ModelResponse by id |
| `PATCH` | `/api/v1/admin/ai-models/{id}` | `update` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | Yes | Updating a ModelResponse by id |
| `GET` | `/api/v1/admin/ai-models/{id}/download` | `getDownloadStatus` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Poll the status of the most recent download job for this model. |
| `POST` | `/api/v1/admin/ai-models/{id}/download` | `triggerDownload` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Publish this model's weights into the hope-models bucket (async). |
| `PATCH` | `/api/v1/admin/ai-models/{id}/platform-default` | `setPlatformDefault` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Elect this row as the platform default for one or more tasks |
| `POST` | `/api/v1/admin/ai-models/{id}/unregister` | `unregister` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Unregister a model and delete its weights |
| `GET` | `/api/v1/admin/ai-models/{id}/usage` | `getUsage` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | List what still uses this model |
| `POST` | `/api/v1/admin/ai-models/download-missing` | `downloadMissing` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Download every model whose weights are missing |
| `GET` | `/api/v1/admin/ai-models/hub/preview` | `previewHub` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Preview a Hugging Face model before registering it |
| `GET` | `/api/v1/admin/ai-models/inventory` | `lastInventory` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Read the last model-bucket inventory report |
| `POST` | `/api/v1/admin/ai-models/inventory` | `runInventory` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Run the model-bucket inventory |
| `GET` | `/api/v1/admin/ai-models/list` | `list` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | List the SYSTEM model registry as one paginated page. The whole query object
is bound (`search`, `searchFields`, `filters`, `sort`, `page`, `limit`) so
the grid's parameters reach the service and undeclared ones are rejected by
the global validation pipe; named `@Query('x')` bindings would silently drop
everything but the named keys. |
| `POST` | `/api/v1/admin/ai-models/register-from-hub` | `registerFromHub` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Register a model from a Hugging Face repo and download it |
| `GET` | `/api/v1/admin/ai-models/slug/{slug}` | `fetchBySlug` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Retrieving a single ModelResponse by slug |

#### Handler Call Trees:

**`GET /api/v1/admin/ai-models` → `AiModelAdminController.fetchAll`**
```text
[GET /api/v1/admin/ai-models]
  └── Controller: AiModelAdminController.fetchAll()
        ├── calls: this.aiModelService.getAllForAdmin()
        │     └─ Service: AiModelService
```

**`POST /api/v1/admin/ai-models` → `AiModelAdminController.create`**
```text
[POST /api/v1/admin/ai-models]
  └── Controller: AiModelAdminController.create()
        ├── calls: this.aiModelService.create()
        │     └─ Service: AiModelService
```

**`DELETE /api/v1/admin/ai-models/{id}` → `AiModelAdminController.delete`**
```text
[DELETE /api/v1/admin/ai-models/{id}]
  └── Controller: AiModelAdminController.delete()
        ├── calls: this.aiModelService.delete()
        │     └─ Service: AiModelService
```

**`GET /api/v1/admin/ai-models/{id}` → `AiModelAdminController.fetchById`**
```text
[GET /api/v1/admin/ai-models/{id}]
  └── Controller: AiModelAdminController.fetchById()
        ├── calls: this.aiModelService.getById()
        │     └─ Service: AiModelService
```

**`PATCH /api/v1/admin/ai-models/{id}` → `AiModelAdminController.update`**
```text
[PATCH /api/v1/admin/ai-models/{id}]
  └── Controller: AiModelAdminController.update()
        ├── calls: this.aiModelService.update()
        │     └─ Service: AiModelService
```

**`GET /api/v1/admin/ai-models/{id}/download` → `AiModelAdminController.getDownloadStatus`**
```text
[GET /api/v1/admin/ai-models/{id}/download]
  └── Controller: AiModelAdminController.getDownloadStatus()
        ├── calls: this.aiModelDownloadService.getDownloadStatus()
        │     └─ Service: AiModelDownloadService
```

**`POST /api/v1/admin/ai-models/{id}/download` → `AiModelAdminController.triggerDownload`**
```text
[POST /api/v1/admin/ai-models/{id}/download]
  └── Controller: AiModelAdminController.triggerDownload()
        ├── calls: this.aiModelDownloadService.triggerDownload()
        │     └─ Service: AiModelDownloadService
```

**`PATCH /api/v1/admin/ai-models/{id}/platform-default` → `AiModelAdminController.setPlatformDefault`**
```text
[PATCH /api/v1/admin/ai-models/{id}/platform-default]
  └── Controller: AiModelAdminController.setPlatformDefault()
        ├── calls: this.aiModelService.setPlatformDefaultFor()
        │     └─ Service: AiModelService
```

**`POST /api/v1/admin/ai-models/{id}/unregister` → `AiModelAdminController.unregister`**
```text
[POST /api/v1/admin/ai-models/{id}/unregister]
  └── Controller: AiModelAdminController.unregister()
        ├── calls: this.registryOperations.unregister()
        │     └─ Service: ModelRegistryOperationsService
```

**`GET /api/v1/admin/ai-models/{id}/usage` → `AiModelAdminController.getUsage`**
```text
[GET /api/v1/admin/ai-models/{id}/usage]
  └── Controller: AiModelAdminController.getUsage()
        ├── calls: this.registryOperations.getUsage()
        │     └─ Service: ModelRegistryOperationsService
```

**`POST /api/v1/admin/ai-models/download-missing` → `AiModelAdminController.downloadMissing`**
```text
[POST /api/v1/admin/ai-models/download-missing]
  └── Controller: AiModelAdminController.downloadMissing()
        ├── calls: this.registryOperations.downloadMissing()
        │     └─ Service: ModelRegistryOperationsService
```

**`GET /api/v1/admin/ai-models/hub/preview` → `AiModelAdminController.previewHub`**
```text
[GET /api/v1/admin/ai-models/hub/preview]
  └── Controller: AiModelAdminController.previewHub()
        ├── calls: this.registryOperations.previewHub()
        │     └─ Service: ModelRegistryOperationsService
```

**`GET /api/v1/admin/ai-models/inventory` → `AiModelAdminController.lastInventory`**
```text
[GET /api/v1/admin/ai-models/inventory]
  └── Controller: AiModelAdminController.lastInventory()
        ├── calls: this.modelInventoryService.getLastReport()
        │     └─ Service: ModelInventoryService
```

**`POST /api/v1/admin/ai-models/inventory` → `AiModelAdminController.runInventory`**
```text
[POST /api/v1/admin/ai-models/inventory]
  └── Controller: AiModelAdminController.runInventory()
        ├── calls: this.modelInventoryService.runInventory()
        │     └─ Service: ModelInventoryService
```

**`GET /api/v1/admin/ai-models/list` → `AiModelAdminController.list`**
```text
[GET /api/v1/admin/ai-models/list]
  └── Controller: AiModelAdminController.list()
        ├── calls: this.aiModelService.list()
        │     └─ Service: AiModelService
```

**`POST /api/v1/admin/ai-models/register-from-hub` → `AiModelAdminController.registerFromHub`**
```text
[POST /api/v1/admin/ai-models/register-from-hub]
  └── Controller: AiModelAdminController.registerFromHub()
        ├── calls: this.registryOperations.registerFromHub()
        │     └─ Service: ModelRegistryOperationsService
```

**`GET /api/v1/admin/ai-models/slug/{slug}` → `AiModelAdminController.fetchBySlug`**
```text
[GET /api/v1/admin/ai-models/slug/{slug}]
  └── Controller: AiModelAdminController.fetchBySlug()
        ├── calls: this.aiModelService.getBySlug()
        │     └─ Service: AiModelService
```

### Controller: `AiModelCatalogueController`
**File:** [`src/modules/ai-model/ai-model-catalogue.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-model/ai-model-catalogue.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai-models/access` | `access` | Perms: `read:AiModel`<br/>Svc: `svc:admin:ai-model:manage,svc:admin:ai-model:read` | - | Your access to the model registry |
| `GET` | `/api/v1/admin/ai-models/catalogue` | `catalogue` | Perms: `read:AiModel`<br/>Svc: `svc:admin:ai-model:manage,svc:admin:ai-model:read` | - | The model catalogue this tenant may bind, in picker order |
| `GET` | `/api/v1/admin/ai-models/registry` | `registry` | Perms: `read:AiModel`<br/>Svc: `svc:admin:ai-model:manage,svc:admin:ai-model:read` | - | List the registered models (read-only) |

#### Handler Call Trees:

**`GET /api/v1/admin/ai-models/access` → `AiModelCatalogueController.access`**
```text
[GET /api/v1/admin/ai-models/access]
  └── Controller: AiModelCatalogueController.access()
        ├── calls: this.registryAccess.getAccess()
        │     └─ Service: ModelRegistryAccessService
```

**`GET /api/v1/admin/ai-models/catalogue` → `AiModelCatalogueController.catalogue`**
```text
[GET /api/v1/admin/ai-models/catalogue]
  └── Controller: AiModelCatalogueController.catalogue()
        ├── calls: this.aiModelService.getCatalogue()
        │     └─ Service: AiModelService
```

**`GET /api/v1/admin/ai-models/registry` → `AiModelCatalogueController.registry`**
```text
[GET /api/v1/admin/ai-models/registry]
  └── Controller: AiModelCatalogueController.registry()
        ├── calls: this.aiModelService.listRegistry()
        │     └─ Service: AiModelService
```

### Controller: `AiModelDiscoveryController`
**File:** [`src/modules/ai-model/ai-model-discovery.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-model/ai-model-discovery.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai-models/discovery` | `discover` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Merge the AI model registry with the live engine listings |
| `POST` | `/api/v1/admin/ai-models/discovery/register` | `register` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | DEPRECATED (TASK-860, removed in R3) — register a discovered model |

#### Handler Call Trees:

**`GET /api/v1/admin/ai-models/discovery` → `AiModelDiscoveryController.discover`**
```text
[GET /api/v1/admin/ai-models/discovery]
  └── Controller: AiModelDiscoveryController.discover()
        ├── calls: this.discoveryService.discover()
        │     └─ Service: AiModelDiscoveryService
```

### Controller: `AiModelJobsController`
**File:** [`src/modules/ai-model/ai-model-jobs.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-model/ai-model-jobs.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/ai-models/{id}/download/cancel` | `cancelDownload` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Cancel a model download |
| `GET` | `/api/v1/admin/ai-models/jobs` | `listJobs` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | List recent model-publisher jobs |

#### Handler Call Trees:

**`POST /api/v1/admin/ai-models/{id}/download/cancel` → `AiModelJobsController.cancelDownload`**
```text
[POST /api/v1/admin/ai-models/{id}/download/cancel]
  └── Controller: AiModelJobsController.cancelDownload()
        ├── calls: this.jobs.cancelDownload()
        │     └─ Service: ModelPublisherJobsService
```

**`GET /api/v1/admin/ai-models/jobs` → `AiModelJobsController.listJobs`**
```text
[GET /api/v1/admin/ai-models/jobs]
  └── Controller: AiModelJobsController.listJobs()
        ├── calls: this.jobs.listJobs()
        │     └─ Service: ModelPublisherJobsService
```

### Controller: `AiModelRegistrationController`
**File:** [`src/modules/ai-model/ai-model-registration.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-model/ai-model-registration.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai-models/local/preview` | `previewLocal` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Preview a model already in the models bucket |
| `POST` | `/api/v1/admin/ai-models/register-from-path` | `registerFromPath` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-model:manage` | - | Register a model from a path in the models bucket |

#### Handler Call Trees:

**`GET /api/v1/admin/ai-models/local/preview` → `AiModelRegistrationController.previewLocal`**
```text
[GET /api/v1/admin/ai-models/local/preview]
  └── Controller: AiModelRegistrationController.previewLocal()
        ├── calls: this.pathRegistration.previewLocal()
        │     └─ Service: ModelPathRegistrationService
```

**`POST /api/v1/admin/ai-models/register-from-path` → `AiModelRegistrationController.registerFromPath`**
```text
[POST /api/v1/admin/ai-models/register-from-path]
  └── Controller: AiModelRegistrationController.registerFromPath()
        ├── calls: this.pathRegistration.registerFromPath()
        │     └─ Service: ModelPathRegistrationService
```

---

## Module: `ai-provider-connection` (8 routes)

### Controller: `ProviderConnectionController`
**File:** [`src/modules/ai-provider-connection/ai-provider-connection.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/providers/{service}` | `list` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | List provider connections for one service and the scoped tenant (keys never returned). |
| `DELETE` | `/api/v1/admin/providers/{service}/{slug}` | `remove` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | Soft-delete one provider connection. |
| `GET` | `/api/v1/admin/providers/{service}/{slug}` | `getOne` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | Read one provider connection (key never returned; placeholder when absent). |
| `PUT` | `/api/v1/admin/providers/{service}/{slug}` | `upsert` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | Yes | Create or update one provider connection. |
| `PUT` | `/api/v1/admin/providers/{service}/{slug}/models` | `declareModels` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | Declare the models this tenant's connection serves. |
| `POST` | `/api/v1/admin/providers/{service}/{slug}/reset` | `reset` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | Reset one built-in provider connection to its platform default (super admin only). |
| `POST` | `/api/v1/admin/providers/{service}/{slug}/test` | `testConnection` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | Test a provider connection against the live vendor (ephemeral — never persisted). |
| `GET` | `/api/v1/admin/providers/{service}/platform-defaults` | `listPlatformDefaults` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:ai-provider:manage` | - | The platform defaults this tenant inherits for one service — read-only, masked. |

#### Handler Call Trees:

**`GET /api/v1/admin/providers/{service}` → `ProviderConnectionController.list`**
```text
[GET /api/v1/admin/providers/{service}]
  └── Controller: ProviderConnectionController.list()
        ├── calls: this.connectionService.list()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`DELETE /api/v1/admin/providers/{service}/{slug}` → `ProviderConnectionController.remove`**
```text
[DELETE /api/v1/admin/providers/{service}/{slug}]
  └── Controller: ProviderConnectionController.remove()
        ├── calls: this.connectionService.deleteRow()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`GET /api/v1/admin/providers/{service}/{slug}` → `ProviderConnectionController.getOne`**
```text
[GET /api/v1/admin/providers/{service}/{slug}]
  └── Controller: ProviderConnectionController.getOne()
        ├── calls: this.connectionService.getRow()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`PUT /api/v1/admin/providers/{service}/{slug}` → `ProviderConnectionController.upsert`**
```text
[PUT /api/v1/admin/providers/{service}/{slug}]
  └── Controller: ProviderConnectionController.upsert()
        ├── calls: this.connectionService.upsertRow()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`PUT /api/v1/admin/providers/{service}/{slug}/models` → `ProviderConnectionController.declareModels`**
```text
[PUT /api/v1/admin/providers/{service}/{slug}/models]
  └── Controller: ProviderConnectionController.declareModels()
        ├── calls: this.connectionService.declareModels()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`POST /api/v1/admin/providers/{service}/{slug}/reset` → `ProviderConnectionController.reset`**
```text
[POST /api/v1/admin/providers/{service}/{slug}/reset]
  └── Controller: ProviderConnectionController.reset()
        ├── calls: this.connectionService.resetRow()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

**`POST /api/v1/admin/providers/{service}/{slug}/test` → `ProviderConnectionController.testConnection`**
```text
[POST /api/v1/admin/providers/{service}/{slug}/test]
  └── Controller: ProviderConnectionController.testConnection()
        ├── calls: this.probe.test()
        │     └─ Service: ProviderConnectionProbe
```

**`GET /api/v1/admin/providers/{service}/platform-defaults` → `ProviderConnectionController.listPlatformDefaults`**
```text
[GET /api/v1/admin/providers/{service}/platform-defaults]
  └── Controller: ProviderConnectionController.listPlatformDefaults()
        ├── calls: this.connectionService.listPlatformDefaults()
        │     └─ Service: IProviderConnectionService [token: IProviderConnectionService]
```

---

## Module: `ai-routing-policy` (11 routes)

### Controller: `AiRoutingPolicyAdminController`
**File:** [`src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/routing-policies` | `list` | Perms: `manage:AiRoutingPolicy` | - | List every routing-policy revision owned by one tenant |
| `POST` | `/api/v1/admin/routing-policies` | `create` | Perms: `manage:AiRoutingPolicy` | - | Author a new routing-policy revision (DRAFT) |
| `DELETE` | `/api/v1/admin/routing-policies/{id}` | `deleteById` | Perms: `manage:AiRoutingPolicy` | - | Soft-delete a routing-policy revision |
| `GET` | `/api/v1/admin/routing-policies/{id}` | `getById` | Perms: `manage:AiRoutingPolicy` | - | Get one routing-policy revision |
| `PATCH` | `/api/v1/admin/routing-policies/{id}` | `update` | Perms: `manage:AiRoutingPolicy` | Yes | Update a routing-policy revision under optimistic concurrency |
| `POST` | `/api/v1/admin/routing-policies/{id}/activate` | `activate` | Perms: `manage:AiRoutingPolicy` | Yes | Promote a DRAFT revision to ACTIVE |
| `POST` | `/api/v1/admin/routing-policies/{id}/default` | `setDefault` | Perms: `manage:AiRoutingPolicy` | Yes | Elect this configuration as the default for its task |
| `POST` | `/api/v1/admin/routing-policies/{id}/promote` | `promote` | Perms: `manage:AiRoutingPolicy` | - | Copy a configuration to another tenant |
| `GET` | `/api/v1/admin/routing-policies/effective` | `getEffective` | Perms: `manage:AiRoutingPolicy` | - | Resolve what actually serves a (tenant, task) right now |
| `GET` | `/api/v1/admin/routing-policies/export` | `exportConfigurations` | Perms: `manage:AiRoutingPolicy` | - | Export provider configurations as portable JSON |
| `POST` | `/api/v1/admin/routing-policies/import` | `importConfigurations` | Perms: `manage:AiRoutingPolicy` | - | Import provider configurations from an exported artifact |

#### Handler Call Trees:

**`GET /api/v1/admin/routing-policies` → `AiRoutingPolicyAdminController.list`**
```text
[GET /api/v1/admin/routing-policies]
  └── Controller: AiRoutingPolicyAdminController.list()
        ├── calls: this.routingPolicyService.list()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`POST /api/v1/admin/routing-policies` → `AiRoutingPolicyAdminController.create`**
```text
[POST /api/v1/admin/routing-policies]
  └── Controller: AiRoutingPolicyAdminController.create()
        ├── calls: this.routingPolicyService.create()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`DELETE /api/v1/admin/routing-policies/{id}` → `AiRoutingPolicyAdminController.deleteById`**
```text
[DELETE /api/v1/admin/routing-policies/{id}]
  └── Controller: AiRoutingPolicyAdminController.deleteById()
        ├── calls: this.routingPolicyService.deleteById()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`GET /api/v1/admin/routing-policies/{id}` → `AiRoutingPolicyAdminController.getById`**
```text
[GET /api/v1/admin/routing-policies/{id}]
  └── Controller: AiRoutingPolicyAdminController.getById()
        ├── calls: this.routingPolicyService.getById()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`PATCH /api/v1/admin/routing-policies/{id}` → `AiRoutingPolicyAdminController.update`**
```text
[PATCH /api/v1/admin/routing-policies/{id}]
  └── Controller: AiRoutingPolicyAdminController.update()
        ├── calls: this.routingPolicyService.update()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`POST /api/v1/admin/routing-policies/{id}/activate` → `AiRoutingPolicyAdminController.activate`**
```text
[POST /api/v1/admin/routing-policies/{id}/activate]
  └── Controller: AiRoutingPolicyAdminController.activate()
        ├── calls: this.routingPolicyService.activate()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`POST /api/v1/admin/routing-policies/{id}/default` → `AiRoutingPolicyAdminController.setDefault`**
```text
[POST /api/v1/admin/routing-policies/{id}/default]
  └── Controller: AiRoutingPolicyAdminController.setDefault()
        ├── calls: this.routingPolicyService.setDefault()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`POST /api/v1/admin/routing-policies/{id}/promote` → `AiRoutingPolicyAdminController.promote`**
```text
[POST /api/v1/admin/routing-policies/{id}/promote]
  └── Controller: AiRoutingPolicyAdminController.promote()
        ├── calls: this.routingPolicyService.promote()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`GET /api/v1/admin/routing-policies/effective` → `AiRoutingPolicyAdminController.getEffective`**
```text
[GET /api/v1/admin/routing-policies/effective]
  └── Controller: AiRoutingPolicyAdminController.getEffective()
        ├── calls: this.routingPolicyService.getEffective()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

**`GET /api/v1/admin/routing-policies/export` → `AiRoutingPolicyAdminController.exportConfigurations`**
```text
[GET /api/v1/admin/routing-policies/export]
  └── Controller: AiRoutingPolicyAdminController.exportConfigurations()
        ├── calls: this.routingPolicyService.exportConfigurations()
        │     └─ Service: IAiRoutingPolicyService [token: IAiRoutingPolicyService]
```

---

## Module: `ai-service-admin` (9 routes)

### Controller: `AiServiceAdminController`
**File:** [`src/modules/ai-service-admin/ai-service-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai-services/guardrail/config` | `guardrailConfig` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Guardrail read-only configuration: medical-validation engine settings + supported analysis types. |
| `GET` | `/api/v1/admin/ai-services/guardrail/status` | `guardrailStatus` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Guardrail service health (proxied /api/health): LLM engine, GLiNER, and Redis component checks. |
| `GET` | `/api/v1/admin/ai-services/mlflow/experiments` | `mlflowExperiments` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Search MLflow experiments |
| `GET` | `/api/v1/admin/ai-services/mlflow/model-versions` | `mlflowModelVersions` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Search MLflow model versions |
| `GET` | `/api/v1/admin/ai-services/mlflow/registered-models` | `mlflowRegisteredModels` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Search the MLflow model registry |
| `GET` | `/api/v1/admin/ai-services/mlflow/status` | `mlflowStatus` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | MLflow tracking-server reachability, version and framing posture |
| `GET` | `/api/v1/admin/ai-services/nlp/status` | `nlpStatus` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | NLP service health (proxied /api/v1/health): per-model component checks with load status. |
| `GET` | `/api/v1/admin/ai-services/readiness` | `readiness` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Inference readiness — the platform’s last observation of every engine, service and model |
| `POST` | `/api/v1/admin/ai-services/readiness/refresh` | `refreshReadiness` | Perms: `manage:all`<br/>Svc: `svc:admin:ai-service:manage` | - | Take one readiness observation now |

#### Handler Call Trees:

**`GET /api/v1/admin/ai-services/guardrail/config` → `AiServiceAdminController.guardrailConfig`**
```text
[GET /api/v1/admin/ai-services/guardrail/config]
  └── Controller: AiServiceAdminController.guardrailConfig()
        ├── calls: this.proxyClient.guardrailConfig()
        │     └─ Service: AiServiceProxyClient
```

**`GET /api/v1/admin/ai-services/guardrail/status` → `AiServiceAdminController.guardrailStatus`**
```text
[GET /api/v1/admin/ai-services/guardrail/status]
  └── Controller: AiServiceAdminController.guardrailStatus()
        ├── calls: this.proxyClient.guardrailStatus()
        │     └─ Service: AiServiceProxyClient
```

**`GET /api/v1/admin/ai-services/mlflow/experiments` → `AiServiceAdminController.mlflowExperiments`**
```text
[GET /api/v1/admin/ai-services/mlflow/experiments]
  └── Controller: AiServiceAdminController.mlflowExperiments()
        ├── calls: this.mlflowClient.searchExperiments()
        │     └─ Service: MlflowProxyClient
```

**`GET /api/v1/admin/ai-services/mlflow/model-versions` → `AiServiceAdminController.mlflowModelVersions`**
```text
[GET /api/v1/admin/ai-services/mlflow/model-versions]
  └── Controller: AiServiceAdminController.mlflowModelVersions()
        ├── calls: this.mlflowClient.searchModelVersions()
        │     └─ Service: MlflowProxyClient
```

**`GET /api/v1/admin/ai-services/mlflow/registered-models` → `AiServiceAdminController.mlflowRegisteredModels`**
```text
[GET /api/v1/admin/ai-services/mlflow/registered-models]
  └── Controller: AiServiceAdminController.mlflowRegisteredModels()
        ├── calls: this.mlflowClient.searchRegisteredModels()
        │     └─ Service: MlflowProxyClient
```

**`GET /api/v1/admin/ai-services/mlflow/status` → `AiServiceAdminController.mlflowStatus`**
```text
[GET /api/v1/admin/ai-services/mlflow/status]
  └── Controller: AiServiceAdminController.mlflowStatus()
        ├── calls: this.mlflowClient.status()
        │     └─ Service: MlflowProxyClient
```

**`GET /api/v1/admin/ai-services/nlp/status` → `AiServiceAdminController.nlpStatus`**
```text
[GET /api/v1/admin/ai-services/nlp/status]
  └── Controller: AiServiceAdminController.nlpStatus()
        ├── calls: this.proxyClient.nlpStatus()
        │     └─ Service: AiServiceProxyClient
```

**`GET /api/v1/admin/ai-services/readiness` → `AiServiceAdminController.readiness`**
```text
[GET /api/v1/admin/ai-services/readiness]
  └── Controller: AiServiceAdminController.readiness()
        ├── calls: this.readinessService.getSnapshot()
        │     └─ Service: IInferenceReadinessService [token: IInferenceReadinessService]
```

**`POST /api/v1/admin/ai-services/readiness/refresh` → `AiServiceAdminController.refreshReadiness`**
```text
[POST /api/v1/admin/ai-services/readiness/refresh]
  └── Controller: AiServiceAdminController.refreshReadiness()
        ├── calls: this.readinessService.sweep()
        │     └─ Service: IInferenceReadinessService [token: IInferenceReadinessService]
```

---

## Module: `api-key` (9 routes)

### Controller: `ApiKeyController`
**File:** [`src/modules/api-key/api-key.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/api-key/api-key.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/api-keys` | `fetchAll` | Perms: `read:ApiKey`<br/>Svc: `svc:admin:apikey:read,svc:admin:apikey:write` | - | Retrieving multiple ApiKeyResponses |
| `POST` | `/api/v1/admin/api-keys` | `create` | Perms: `create:ApiKey`<br/>Svc: `svc:admin:apikey:write` | - | AUTH-NOTE: `@CanCreate('ApiKey')` UNDERSTATES the real gate. `ApiKeyService`
additionally enforces a privilege CEILING on the requested `scopes`
(`assertScopeCeiling`): every scope's implied CASL ability must be one the
CALLING principal already holds, so a tenant admin cannot mint a key
carrying `admin:*` or the bare `'*'`. It fails CLOSED when the caller's
compiled ability is unavailable — notably on the API-key-authenticated
minting path, where `UnifiedAuthGuard` deliberately never publishes the
ability to CLS. A refusal is a 403 (privilege boundary), NOT the
cross-tenant 404-over-403 posture this controller's by-id routes use. |
| `DELETE` | `/api/v1/admin/api-keys/{id}` | `delete` | Perms: `delete:ApiKey`<br/>Svc: `svc:admin:apikey:write` | - | Deleting a ApiKeyResponse by id |
| `GET` | `/api/v1/admin/api-keys/{id}` | `fetchById` | Perms: `read:ApiKey`<br/>Svc: `svc:admin:apikey:read,svc:admin:apikey:write` | - | Retrieving a single ApiKeyResponse by id |
| `PATCH` | `/api/v1/admin/api-keys/{id}` | `update` | Perms: `update:ApiKey`<br/>Svc: `svc:admin:apikey:write` | - | AUTH-NOTE: `@CanUpdate('ApiKey')` UNDERSTATES the real gate — the same
scope ceiling as `create` above, applied to the WIDENING DELTA only. A
PATCH is refused (403) when it ADDS a scope whose implied ability the
caller does not hold; renames and narrowing PATCHes are not gated, and a
PATCH that omits `scopes` is not checked at all. |
| `POST` | `/api/v1/admin/api-keys/{id}/revoke` | `revoke` | Perms: `update:ApiKey`<br/>Svc: `svc:admin:apikey:write` | - | Creating a ApiKeyResponse by id |
| `POST` | `/api/v1/admin/api-keys/{id}/rotate` | `rotate` | Perms: `update:ApiKey`<br/>Svc: `svc:admin:apikey:write` | - | Creating a ApiKeyResponse by id |
| `GET` | `/api/v1/admin/api-keys/{id}/usage` | `getUsage` | Perms: `read:ApiKey`<br/>Svc: `svc:admin:apikey:read,svc:admin:apikey:write` | - | Retrieving a single ApiKeyResponse by id |
| `GET` | `/api/v1/admin/api-keys/scopes` | `getAvailableScopes` | Perms: `read:ApiKey`<br/>Svc: `svc:admin:apikey:read,svc:admin:apikey:write` | - | List available API key scopes |

#### Handler Call Trees:

**`GET /api/v1/admin/api-keys` → `ApiKeyController.fetchAll`**
```text
[GET /api/v1/admin/api-keys]
  └── Controller: ApiKeyController.fetchAll()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.apiKeyService.fetchAllByTenantId()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
        ├── calls: this.apiKeyService.fetchAll()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`POST /api/v1/admin/api-keys` → `ApiKeyController.create`**
```text
[POST /api/v1/admin/api-keys]
  └── Controller: ApiKeyController.create()
        ├── calls: this.apiKeyService.create()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`DELETE /api/v1/admin/api-keys/{id}` → `ApiKeyController.delete`**
```text
[DELETE /api/v1/admin/api-keys/{id}]
  └── Controller: ApiKeyController.delete()
        ├── calls: this.apiKeyService.deleteById()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`GET /api/v1/admin/api-keys/{id}` → `ApiKeyController.fetchById`**
```text
[GET /api/v1/admin/api-keys/{id}]
  └── Controller: ApiKeyController.fetchById()
        ├── calls: this.apiKeyService.fetchById()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`PATCH /api/v1/admin/api-keys/{id}` → `ApiKeyController.update`**
```text
[PATCH /api/v1/admin/api-keys/{id}]
  └── Controller: ApiKeyController.update()
        ├── calls: this.apiKeyService.update()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`POST /api/v1/admin/api-keys/{id}/revoke` → `ApiKeyController.revoke`**
```text
[POST /api/v1/admin/api-keys/{id}/revoke]
  └── Controller: ApiKeyController.revoke()
        ├── calls: this.apiKeyService.revokeKey()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`POST /api/v1/admin/api-keys/{id}/rotate` → `ApiKeyController.rotate`**
```text
[POST /api/v1/admin/api-keys/{id}/rotate]
  └── Controller: ApiKeyController.rotate()
        ├── calls: this.apiKeyService.rotateKey()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`GET /api/v1/admin/api-keys/{id}/usage` → `ApiKeyController.getUsage`**
```text
[GET /api/v1/admin/api-keys/{id}/usage]
  └── Controller: ApiKeyController.getUsage()
        ├── calls: this.apiKeyService.fetchById()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

---

## Module: `audit-log` (6 routes)

### Controller: `AuditLogController`
**File:** [`src/modules/audit-log/audit-log.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/audit-log/audit-log.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/audit-logs` | `fetchAll` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Fetch all audit logs |
| `GET` | `/api/v1/admin/audit-logs/{id}` | `fetchById` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Fetch audit log by ID |
| `GET` | `/api/v1/admin/audit-logs/cursor` | `fetchByCursor` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Fetch audit logs (cursor pagination) |
| `GET` | `/api/v1/admin/audit-logs/export` | `exportCsv` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Export audit logs (csv | xlsx | pdf) |
| `GET` | `/api/v1/admin/audit-logs/resource/{resourceType}/{resourceId}` | `fetchByResource` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Fetch audit logs by resource |
| `GET` | `/api/v1/admin/audit-logs/user/{userId}` | `fetchByUser` | Perms: `read:AuditLog`<br/>Svc: `svc:admin:audit:read` | - | Fetch audit logs by user |

#### Handler Call Trees:

**`GET /api/v1/admin/audit-logs` → `AuditLogController.fetchAll`**
```text
[GET /api/v1/admin/audit-logs]
  └── Controller: AuditLogController.fetchAll()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.auditLogService.fetchAllFiltered()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

**`GET /api/v1/admin/audit-logs/{id}` → `AuditLogController.fetchById`**
```text
[GET /api/v1/admin/audit-logs/{id}]
  └── Controller: AuditLogController.fetchById()
        ├── calls: this.auditLogService.fetchById()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

**`GET /api/v1/admin/audit-logs/cursor` → `AuditLogController.fetchByCursor`**
```text
[GET /api/v1/admin/audit-logs/cursor]
  └── Controller: AuditLogController.fetchByCursor()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.auditLogService.fetchPageByCursor()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

**`GET /api/v1/admin/audit-logs/export` → `AuditLogController.exportCsv`**
```text
[GET /api/v1/admin/audit-logs/export]
  └── Controller: AuditLogController.exportCsv()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.auditLogService.exportFiltered()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

**`GET /api/v1/admin/audit-logs/resource/{resourceType}/{resourceId}` → `AuditLogController.fetchByResource`**
```text
[GET /api/v1/admin/audit-logs/resource/{resourceType}/{resourceId}]
  └── Controller: AuditLogController.fetchByResource()
        ├── calls: this.auditLogService.fetchAllByResource()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

**`GET /api/v1/admin/audit-logs/user/{userId}` → `AuditLogController.fetchByUser`**
```text
[GET /api/v1/admin/audit-logs/user/{userId}]
  └── Controller: AuditLogController.fetchByUser()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.auditLogService.fetchAllCreatedByUser()
        │     └─ Service: IAuditLogService [token: IAuditLogService]
```

---

## Module: `auth` (15 routes)

### Controller: `AdminImpersonationController`
**File:** [`src/modules/auth/admin-impersonation.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/admin-impersonation.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/users/{id}/impersonate` | `impersonate` | Perms: `manage:all` | - | Impersonate a user (super-admin only, time-boxed, audited) |

#### Handler Call Trees:

**`POST /api/v1/admin/users/{id}/impersonate` → `AdminImpersonationController.impersonate`**
```text
[POST /api/v1/admin/users/{id}/impersonate]
  └── Controller: AdminImpersonationController.impersonate()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.userRoleAssignmentService.findActiveRolesForUser()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
        ├── calls: this.userRepository.findFirst()
        │     └─ Service: UserRepository
        ├── calls: this.userRoleAssignmentService.findActiveRolesForUser()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
        ├── calls: this.userRoleAssignmentService.findActiveTenantIdsForUser()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
        ├── calls: this.confirmations.assert()
        │     └─ Service: ActionConfirmationService
        ├── calls: this.appSettingsService.getValueWithDefault()
        │     └─ Service: IAppSettingsService [token: IAppSettingsService]
        ├── calls: this.authService.trackAuthentication()
        │     └─ Service: IAuthService [token: IAuthService]
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.userDepartmentService.findActiveDepartmentForUserInTenant()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

### Controller: `AuthController`
**File:** [`src/modules/auth/auth.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/auth.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/auth/impersonate` | `impersonate` | Auth | - | Impersonate another user (admin only) |
| `POST` | `/api/v1/auth/login` | `login` | Public | - | User login |
| `POST` | `/api/v1/auth/logout` | `logout` | Auth | - | User logout |
| `GET` | `/api/v1/auth/me` | `me` | Auth | - | Get current user information |
| `POST` | `/api/v1/auth/refresh` | `refresh` | Public | - | Refresh access token |
| `POST` | `/api/v1/auth/revoke-impersonation` | `revokeImpersonation` | Auth | - | Revoke the current impersonation token |
| `POST` | `/api/v1/auth/stream-ticket` | `issueStreamTicket` | Auth | - | Issue a single-use, 30-second ticket for authenticating SSE streams |

#### Handler Call Trees:

**`POST /api/v1/auth/logout` → `AuthController.logout`**
```text
[POST /api/v1/auth/logout]
  └── Controller: AuthController.logout()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.jwtRevocationService.revoke()
        │     └─ Service: IJwtRevocationService [token: IJwtRevocationService]
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.refreshTokenService.revokeFamily()
        │     └─ Service: IRefreshTokenService [token: IRefreshTokenService]
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.authService.trackAuthentication()
        │     └─ Service: IAuthService [token: IAuthService]
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
```

**`GET /api/v1/auth/me` → `AuthController.me`**
```text
[GET /api/v1/auth/me]
  └── Controller: AuthController.me()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.userRepository.findFirst()
        │     └─ Service: UserRepository
```

**`POST /api/v1/auth/refresh` → `AuthController.refresh`**
```text
[POST /api/v1/auth/refresh]
  └── Controller: AuthController.refresh()
        ├── calls: this.refreshTokenService.consume()
        │     └─ Service: IRefreshTokenService [token: IRefreshTokenService]
        ├── calls: this.userRepository.findFirst()
        │     └─ Service: UserRepository
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.appSettingsService.getValueWithDefault()
        │     └─ Service: IAppSettingsService [token: IAppSettingsService]
        ├── calls: this.refreshTokenService.issue()
        │     └─ Service: IRefreshTokenService [token: IRefreshTokenService]
```

**`POST /api/v1/auth/revoke-impersonation` → `AuthController.revokeImpersonation`**
```text
[POST /api/v1/auth/revoke-impersonation]
  └── Controller: AuthController.revokeImpersonation()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.jwtRevocationService.revoke()
        │     └─ Service: IJwtRevocationService [token: IJwtRevocationService]
        ├── calls: this.authService.trackAuthentication()
        │     └─ Service: IAuthService [token: IAuthService]
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/auth/stream-ticket` → `AuthController.issueStreamTicket`**
```text
[POST /api/v1/auth/stream-ticket]
  └── Controller: AuthController.issueStreamTicket()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.streamTicketService.issueTicket()
        │     └─ Service: StreamTicketService
```

### Controller: `AuthSsoController`
**File:** [`src/modules/auth/auth-sso.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/auth-sso.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/auth/sso/callback` | `callback` | Public | - | Complete the IdP's OIDC callback and mint a HOPE session |
| `POST` | `/api/v1/auth/sso/saml/{tenantKey}/acs` | `samlAcs` | Public | - | Complete the SAML ACS POST (assertion validation, D4) and mint a HOPE session |
| `GET` | `/api/v1/auth/sso/saml/{tenantKey}/metadata` | `samlMetadata` | Public | - | This SP's SAML metadata for the tenant's configured IdP — register with the IdP out-of-band |
| `POST` | `/api/v1/auth/sso/saml/{tenantKey}/start` | `samlStart` | Public | - | Begin a tenant-scoped SAML login (SP-initiated AuthnRequest redirect) |
| `POST` | `/api/v1/auth/sso/start` | `start` | Public | - | Begin a tenant-scoped OIDC login (HRD by email, or explicit tenantKey) |

#### Handler Call Trees:

**`GET /api/v1/auth/sso/callback` → `AuthSsoController.callback`**
```text
[GET /api/v1/auth/sso/callback]
  └── Controller: AuthSsoController.callback()
        ├── calls: this.federatedAuthService.verifyOidcCallback()
        │     └─ Service: FederatedAuthService
        ├── calls helper: this.redirectUri()
        │     ├── calls: this.appSettingsService.getValueWithDefault()
        │     │     └─ Service: IAppSettingsService [token: IAppSettingsService]
```

**`POST /api/v1/auth/sso/saml/{tenantKey}/acs` → `AuthSsoController.samlAcs`**
```text
[POST /api/v1/auth/sso/saml/{tenantKey}/acs]
  └── Controller: AuthSsoController.samlAcs()
        ├── calls: this.federatedAuthService.verifySamlResponse()
        │     └─ Service: FederatedAuthService
        ├── calls helper: this.samlAcsUrl()
        │     ├── calls: this.appSettingsService.getValueWithDefault()
        │     │     └─ Service: IAppSettingsService [token: IAppSettingsService]
```

**`GET /api/v1/auth/sso/saml/{tenantKey}/metadata` → `AuthSsoController.samlMetadata`**
```text
[GET /api/v1/auth/sso/saml/{tenantKey}/metadata]
  └── Controller: AuthSsoController.samlMetadata()
        ├── calls: this.federatedAuthService.getSamlServiceProviderMetadata()
        │     └─ Service: FederatedAuthService
        ├── calls helper: this.samlAcsUrl()
        │     ├── calls: this.appSettingsService.getValueWithDefault()
        │     │     └─ Service: IAppSettingsService [token: IAppSettingsService]
```

**`POST /api/v1/auth/sso/saml/{tenantKey}/start` → `AuthSsoController.samlStart`**
```text
[POST /api/v1/auth/sso/saml/{tenantKey}/start]
  └── Controller: AuthSsoController.samlStart()
        ├── calls: this.federatedAuthService.buildSamlAuthnRequest()
        │     └─ Service: FederatedAuthService
        ├── calls helper: this.samlAcsUrl()
        │     ├── calls: this.appSettingsService.getValueWithDefault()
        │     │     └─ Service: IAppSettingsService [token: IAppSettingsService]
```

**`POST /api/v1/auth/sso/start` → `AuthSsoController.start`**
```text
[POST /api/v1/auth/sso/start]
  └── Controller: AuthSsoController.start()
        ├── calls: this.federatedAuthService.buildAuthorizeUrl()
        │     └─ Service: FederatedAuthService
        ├── calls helper: this.redirectUri()
        │     ├── calls: this.appSettingsService.getValueWithDefault()
        │     │     └─ Service: IAppSettingsService [token: IAppSettingsService]
```

### Controller: `RegisterController`
**File:** [`src/modules/auth/register.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/register.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/auth/register` | `register` | Public | - | Self-service registration — creates an unverified account and emails a verification link |
| `POST` | `/api/v1/auth/register/verify` | `verify` | Public | - | Consume an email-verification token — activates the account and provisions its tenant |

#### Handler Call Trees:

**`POST /api/v1/auth/register/verify` → `RegisterController.verify`**
```text
[POST /api/v1/auth/register/verify]
  └── Controller: RegisterController.verify()
        ├── calls: this.registrationService.verify()
        │     └─ Service: IRegistrationService [token: IRegistrationService]
```

---

## Module: `billing` (13 routes)

### Controller: `BillingAdminController`
**File:** [`src/modules/billing/billing-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/billing/billing-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/billing/invoices` | `list` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | - | One tenant's invoices, newest period first. |
| `GET` | `/api/v1/admin/billing/invoices/{id}` | `get` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | - | Invoice read model: lines, memos against it, BYOK notional spend. Cross-tenant id → 404. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/adjustments` | `addAdjustment` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | - | Issue a credit/debit memo against a FINALIZED invoice — the only correction path for a closed period. SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/finalize` | `finalize` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | Yes | DRAFT → FINALIZED under If-Match OCC. Immutable after; only once the period has ended. SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/void` | `void` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | Yes | DRAFT → VOID under If-Match OCC (one-way; a voided period stays void). SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/invoices/compute-draft` | `computeDraft` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | - | Compute — or idempotently recompute — the DRAFT invoice for one tenant-month. SUPER_ADMIN only. |
| `GET` | `/api/v1/admin/billing/invoices/spend-status` | `spendStatus` | Perms: `manage:BillingInvoice`<br/>Svc: `svc:admin:billing:manage` | - | Month-to-date SELL-rated overage spend vs the tenant's spend limit (D12). |

#### Handler Call Trees:

**`GET /api/v1/admin/billing/invoices` → `BillingAdminController.list`**
```text
[GET /api/v1/admin/billing/invoices]
  └── Controller: BillingAdminController.list()
        ├── calls: this.billing.listInvoices()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`GET /api/v1/admin/billing/invoices/{id}` → `BillingAdminController.get`**
```text
[GET /api/v1/admin/billing/invoices/{id}]
  └── Controller: BillingAdminController.get()
        ├── calls: this.billing.getInvoice()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`POST /api/v1/admin/billing/invoices/{id}/adjustments` → `BillingAdminController.addAdjustment`**
```text
[POST /api/v1/admin/billing/invoices/{id}/adjustments]
  └── Controller: BillingAdminController.addAdjustment()
        ├── calls: this.billing.addAdjustment()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`POST /api/v1/admin/billing/invoices/{id}/finalize` → `BillingAdminController.finalize`**
```text
[POST /api/v1/admin/billing/invoices/{id}/finalize]
  └── Controller: BillingAdminController.finalize()
        ├── calls: this.billing.finalize()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`POST /api/v1/admin/billing/invoices/{id}/void` → `BillingAdminController.void`**
```text
[POST /api/v1/admin/billing/invoices/{id}/void]
  └── Controller: BillingAdminController.void()
        ├── calls: this.billing.voidDraft()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`POST /api/v1/admin/billing/invoices/compute-draft` → `BillingAdminController.computeDraft`**
```text
[POST /api/v1/admin/billing/invoices/compute-draft]
  └── Controller: BillingAdminController.computeDraft()
        ├── calls: this.billing.computeDraft()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`GET /api/v1/admin/billing/invoices/spend-status` → `BillingAdminController.spendStatus`**
```text
[GET /api/v1/admin/billing/invoices/spend-status]
  └── Controller: BillingAdminController.spendStatus()
        ├── calls: this.billing.getSpendStatus()
        │     └─ Service: IBillingService [token: IBillingService]
```

### Controller: `MyBillingController`
**File:** [`src/modules/billing/my-billing.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/billing/my-billing.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me/invoices` | `listMine` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | The caller's own tenant's invoices, newest period first. |
| `GET` | `/api/v1/tenants/me/invoices/{id}` | `getMine` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | One of my invoices (lines, memos, BYOK notional spend). A foreign id → 404. |
| `GET` | `/api/v1/tenants/me/spend` | `spend` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | Month-to-date usage-and-spend snapshot vs my spend limit. Defaults to the current period. |

#### Handler Call Trees:

**`GET /api/v1/tenants/me/invoices` → `MyBillingController.listMine`**
```text
[GET /api/v1/tenants/me/invoices]
  └── Controller: MyBillingController.listMine()
        ├── calls: this.billing.listInvoices()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`GET /api/v1/tenants/me/invoices/{id}` → `MyBillingController.getMine`**
```text
[GET /api/v1/tenants/me/invoices/{id}]
  └── Controller: MyBillingController.getMine()
        ├── calls: this.billing.getInvoice()
        │     └─ Service: IBillingService [token: IBillingService]
```

**`GET /api/v1/tenants/me/spend` → `MyBillingController.spend`**
```text
[GET /api/v1/tenants/me/spend]
  └── Controller: MyBillingController.spend()
        ├── calls: this.billing.getSpendStatus()
        │     └─ Service: IBillingService [token: IBillingService]
```

### Controller: `RateCardAdminController`
**File:** [`src/modules/billing/rate-card-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/billing/rate-card-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/billing/rate-card` | `list` | Perms: `manage:AiPriceBook`<br/>Svc: `svc:admin:billing:manage` | - | List SELL-plane rate rows (platform card by default; ?tenantId= for a negotiated tenant card). Includes superseded history rows. |
| `POST` | `/api/v1/admin/billing/rate-card` | `create` | Perms: `manage:AiPriceBook`<br/>Svc: `svc:admin:billing:manage` | - | Create a new open-ended SELL rate row (overage rate or PLAN_FEE). SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/rate-card/{id}/supersede` | `supersede` | Perms: `manage:AiPriceBook`<br/>Svc: `svc:admin:billing:manage` | Yes | Supersede a rate row: close it at the successor's effectiveFrom and insert the successor — atomic, If-Match OCC on the close. SUPER_ADMIN only. |

#### Handler Call Trees:

**`GET /api/v1/admin/billing/rate-card` → `RateCardAdminController.list`**
```text
[GET /api/v1/admin/billing/rate-card]
  └── Controller: RateCardAdminController.list()
        ├── calls: this.sellRateCard.listSellRates()
        │     └─ Service: ISellRateCardService [token: ISellRateCardService]
```

**`POST /api/v1/admin/billing/rate-card` → `RateCardAdminController.create`**
```text
[POST /api/v1/admin/billing/rate-card]
  └── Controller: RateCardAdminController.create()
        ├── calls: this.sellRateCard.createSellRate()
        │     └─ Service: ISellRateCardService [token: ISellRateCardService]
```

**`POST /api/v1/admin/billing/rate-card/{id}/supersede` → `RateCardAdminController.supersede`**
```text
[POST /api/v1/admin/billing/rate-card/{id}/supersede]
  └── Controller: RateCardAdminController.supersede()
        ├── calls: this.sellRateCard.supersedeSellRate()
        │     └─ Service: ISellRateCardService [token: ISellRateCardService]
```

---

## Module: `changelog` (7 routes)

### Controller: `ChangelogAdminController`
**File:** [`src/modules/changelog/changelog-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/changelog/changelog-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/changelog` | `create` | Perms: `manage:ChangelogEntry`<br/>Svc: `svc:admin:changelog:manage` | - | Create a release note (always DRAFT) |
| `GET` | `/api/v1/admin/changelog/{id}` | `get` | Perms: `manage:ChangelogEntry`<br/>Svc: `svc:admin:changelog:manage` | - | Read a release note for editing (DRAFT included) |
| `PATCH` | `/api/v1/admin/changelog/{id}` | `update` | Perms: `manage:ChangelogEntry`<br/>Svc: `svc:admin:changelog:manage` | Yes | Edit a release note (If-Match OCC) |
| `POST` | `/api/v1/admin/changelog/{id}/publish` | `publish` | Perms: `manage:ChangelogEntry`<br/>Svc: `svc:admin:changelog:manage` | Yes | Publish a release note |

#### Handler Call Trees:

**`POST /api/v1/admin/changelog` → `ChangelogAdminController.create`**
```text
[POST /api/v1/admin/changelog]
  └── Controller: ChangelogAdminController.create()
        ├── calls: this.changelogService.create()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

**`GET /api/v1/admin/changelog/{id}` → `ChangelogAdminController.get`**
```text
[GET /api/v1/admin/changelog/{id}]
  └── Controller: ChangelogAdminController.get()
        ├── calls: this.changelogService.get()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

**`PATCH /api/v1/admin/changelog/{id}` → `ChangelogAdminController.update`**
```text
[PATCH /api/v1/admin/changelog/{id}]
  └── Controller: ChangelogAdminController.update()
        ├── calls: this.changelogService.update()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

**`POST /api/v1/admin/changelog/{id}/publish` → `ChangelogAdminController.publish`**
```text
[POST /api/v1/admin/changelog/{id}/publish]
  └── Controller: ChangelogAdminController.publish()
        ├── calls: this.changelogService.publish()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

### Controller: `ChangelogController`
**File:** [`src/modules/changelog/changelog.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/changelog/changelog.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/changelog` | `list` | Auth<br/>API Key: `platform:changelog:read` | - | List the release notes visible to the caller |
| `POST` | `/api/v1/changelog/acknowledge` | `acknowledge` | Auth<br/>API Key: `platform:changelog:read` | - | Mark entries as seen for the current user |
| `GET` | `/api/v1/changelog/unseen` | `listUnseen` | Auth<br/>API Key: `platform:changelog:read` | - | Entries driving the one-time What's New dialog |

#### Handler Call Trees:

**`GET /api/v1/changelog` → `ChangelogController.list`**
```text
[GET /api/v1/changelog]
  └── Controller: ChangelogController.list()
        ├── calls: this.changelogService.list()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

**`POST /api/v1/changelog/acknowledge` → `ChangelogController.acknowledge`**
```text
[POST /api/v1/changelog/acknowledge]
  └── Controller: ChangelogController.acknowledge()
        ├── calls: this.changelogService.acknowledge()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

**`GET /api/v1/changelog/unseen` → `ChangelogController.listUnseen`**
```text
[GET /api/v1/changelog/unseen]
  └── Controller: ChangelogController.listUnseen()
        ├── calls: this.changelogService.listUnseen()
        │     └─ Service: IChangelogService [token: IChangelogService]
```

---

## Module: `consent` (3 routes)

### Controller: `ConsentGrantController`
**File:** [`src/modules/consent/consent.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consent/consent.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consent-grants` | `list` | Perms: `read:ConsentGrant` | - | List consent grants for the caller tenant |
| `POST` | `/api/v1/admin/consent-grants` | `create` | Perms: `manage:ConsentGrant` | - | Record a consent grant for the caller tenant (clinician/tenant-admin recorded — Q1) |
| `PATCH` | `/api/v1/admin/consent-grants/{id}/revoke` | `revoke` | Perms: `manage:ConsentGrant` | Yes | Revoke a consent grant (If-Match OCC) |

#### Handler Call Trees:

**`GET /api/v1/admin/consent-grants` → `ConsentGrantController.list`**
```text
[GET /api/v1/admin/consent-grants]
  └── Controller: ConsentGrantController.list()
        ├── calls: this.consentGrantService.list()
        │     └─ Service: IConsentGrantService [token: IConsentGrantService]
```

**`POST /api/v1/admin/consent-grants` → `ConsentGrantController.create`**
```text
[POST /api/v1/admin/consent-grants]
  └── Controller: ConsentGrantController.create()
        ├── calls: this.consentGrantService.create()
        │     └─ Service: IConsentGrantService [token: IConsentGrantService]
```

**`PATCH /api/v1/admin/consent-grants/{id}/revoke` → `ConsentGrantController.revoke`**
```text
[PATCH /api/v1/admin/consent-grants/{id}/revoke]
  └── Controller: ConsentGrantController.revoke()
        ├── calls: this.consentGrantService.revoke()
        │     └─ Service: IConsentGrantService [token: IConsentGrantService]
```

---

## Module: `consultation` (109 routes)

### Controller: `AdminConsultationController`
**File:** [`src/modules/consultation/admin-consultation.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/admin-consultation.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consultations` | `list` | Perms: `manage:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Retrieving multiple ConsultationResponses |
| `GET` | `/api/v1/admin/consultations/{id}` | `getById` | Perms: `manage:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Retrieving a single ConsultationResponse by id |
| `GET` | `/api/v1/admin/consultations/aggregate` | `aggregate` | Perms: `manage:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Server-side, zero-filled new/revisit aggregation over a
date range. Scope follows the same model as `list`: a SUPER_ADMIN with
no working tenant aggregates cross-tenant; everyone else is pinned to their
CLS tenant. Declared BEFORE the `:id` route so `GET /aggregate` is not
captured by the `:id` param matcher. |

#### Handler Call Trees:

**`GET /api/v1/admin/consultations` → `AdminConsultationController.list`**
```text
[GET /api/v1/admin/consultations]
  └── Controller: AdminConsultationController.list()
        ├── calls: this.consultationService.listConsultationsForTenant()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

**`GET /api/v1/admin/consultations/{id}` → `AdminConsultationController.getById`**
```text
[GET /api/v1/admin/consultations/{id}]
  └── Controller: AdminConsultationController.getById()
        ├── calls: this.consultationService.getByIdWithRelations()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

**`GET /api/v1/admin/consultations/aggregate` → `AdminConsultationController.aggregate`**
```text
[GET /api/v1/admin/consultations/aggregate]
  └── Controller: AdminConsultationController.aggregate()
        ├── calls: this.consultationService.aggregateConsultationsForTenant()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

### Controller: `AdminFeedbackRollupController`
**File:** [`src/modules/consultation/admin-feedback-rollup.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/admin-feedback-rollup.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/feedback/rollups` | `rollups` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Feedback rollups by day, agent version, model, prompt version, section, entity label, reason or target kind |

#### Handler Call Trees:

**`GET /api/v1/admin/feedback/rollups` → `AdminFeedbackRollupController.rollups`**
```text
[GET /api/v1/admin/feedback/rollups]
  └── Controller: AdminFeedbackRollupController.rollups()
        ├── calls: this.reader.query()
        │     └─ Service: IFeedbackRollupReader [token: IFeedbackRollupReaderToken]
```

### Controller: `ConsentInternalController`
**File:** [`src/modules/consultation/consent-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consent-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/consent/assert` | `assert` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/consent/assert` → `ConsentInternalController.assert`**
```text
[POST /api/v1/internal/consent/assert]
  └── Controller: ConsentInternalController.assert()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consentService.checkConsent()
        │     └─ Service: IConsultationConsentService [token: IConsultationConsentService]
```

### Controller: `ConsultationAttachmentController`
**File:** [`src/modules/consultation/consultation-attachment.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-attachment.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/{id}/attachments` | `list` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | List the consultation attachments |
| `POST` | `/api/v1/consultations/{id}/attachments` | `createIntent` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Declare a file for a consultation and get an upload target |
| `GET` | `/api/v1/consultations/{id}/attachments/{attachmentId}` | `get` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Read one attachment (poll a PROCESSING one) |
| `POST` | `/api/v1/consultations/{id}/attachments/{attachmentId}/complete` | `complete` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Complete an upload |
| `POST` | `/api/v1/consultations/{id}/attachments/{attachmentId}/content` | `uploadContent` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Upload the file through the gateway (fallback when no upload URL was issued) |

#### Handler Call Trees:

**`GET /api/v1/consultations/{id}/attachments` → `ConsultationAttachmentController.list`**
```text
[GET /api/v1/consultations/{id}/attachments]
  └── Controller: ConsultationAttachmentController.list()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.attachments.list()
        │     └─ Service: IConsultationAttachmentService [token: IConsultationAttachmentServiceToken]
```

**`POST /api/v1/consultations/{id}/attachments` → `ConsultationAttachmentController.createIntent`**
```text
[POST /api/v1/consultations/{id}/attachments]
  └── Controller: ConsultationAttachmentController.createIntent()
        ├── calls: this.access.assertWrite()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.attachments.createIntent()
        │     └─ Service: IConsultationAttachmentService [token: IConsultationAttachmentServiceToken]
```

**`GET /api/v1/consultations/{id}/attachments/{attachmentId}` → `ConsultationAttachmentController.get`**
```text
[GET /api/v1/consultations/{id}/attachments/{attachmentId}]
  └── Controller: ConsultationAttachmentController.get()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.attachments.get()
        │     └─ Service: IConsultationAttachmentService [token: IConsultationAttachmentServiceToken]
```

**`POST /api/v1/consultations/{id}/attachments/{attachmentId}/complete` → `ConsultationAttachmentController.complete`**
```text
[POST /api/v1/consultations/{id}/attachments/{attachmentId}/complete]
  └── Controller: ConsultationAttachmentController.complete()
        ├── calls: this.access.assertWrite()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.attachments.complete()
        │     └─ Service: IConsultationAttachmentService [token: IConsultationAttachmentServiceToken]
```

**`POST /api/v1/consultations/{id}/attachments/{attachmentId}/content` → `ConsultationAttachmentController.uploadContent`**
```text
[POST /api/v1/consultations/{id}/attachments/{attachmentId}/content]
  └── Controller: ConsultationAttachmentController.uploadContent()
        ├── calls: this.access.assertWrite()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.attachments.uploadContent()
        │     └─ Service: IConsultationAttachmentService [token: IConsultationAttachmentServiceToken]
```

### Controller: `ConsultationController`
**File:** [`src/modules/consultation/consultation.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations` | `list` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ConsultationResponses |
| `GET` | `/api/v1/consultations/{id}` | `getById` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | Retrieving a single ConsultationResponse by id |
| `PATCH` | `/api/v1/consultations/{id}` | `update` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Updating a ConsultationResponse by id |
| `POST` | `/api/v1/consultations/{id}/approve` | `approve` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Approve the consultation |
| `GET` | `/api/v1/consultations/{id}/chain` | `getChain` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving multiple ConsultationResponses by id |
| `POST` | `/api/v1/consultations/{id}/close` | `close` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Creating a ConsultationResponse by id |
| `GET` | `/api/v1/consultations/{id}/context` | `getContextItems` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving multiple ContextItemResponses by id |
| `POST` | `/api/v1/consultations/{id}/context` | `addContext` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Creating a ContextItemResponse by id |
| `DELETE` | `/api/v1/consultations/{id}/context/{contextId}` | `deleteContext` | Auth<br/>API Key: `consultation:session:write` | - | Deleting a OkResponseDto by id and contextId |
| `PATCH` | `/api/v1/consultations/{id}/context/{contextId}` | `updateContext` | Auth<br/>API Key: `consultation:session:write` | Yes | Updating a ContextItemResponse by id and contextId |
| `GET` | `/api/v1/consultations/{id}/context/{contextId}/versions` | `getContextVersions` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ContextItemVersionResponses by id and contextId |
| `GET` | `/api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}` | `getContextVersion` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving a single ContextItemVersionResponse by id and contextId and versionNumber |
| `GET` | `/api/v1/consultations/{id}/context/case-notes` | `getCaseNotes` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving multiple ContextItemResponses by id |
| `GET` | `/api/v1/consultations/{id}/context/shared` | `getSharedContext` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ContextItemResponses by id |
| `GET` | `/api/v1/consultations/{id}/context/transcriptions` | `getTranscriptions` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving multiple ContextItemResponses by id |
| `GET` | `/api/v1/consultations/{id}/documents/{documentKey}/sections` | `listDocumentSections` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:report:read` | - | Retrieving multiple DocumentSectionResponses by id and documentKey |
| `GET` | `/api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` | `getDocumentSection` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:report:read` | - | Retrieving a single DocumentSectionResponse by id and documentKey and sectionKey |
| `PATCH` | `/api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` | `updateDocumentSection` | Auth<br/>API Key: `consultation:session:write` | Yes | Updating a DocumentSectionResponse by id and documentKey and sectionKey |
| `GET` | `/api/v1/consultations/{id}/documents/sections` | `listAllDocumentSections` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:report:read` | - | Retrieving multiple DocumentSectionResponses by id |
| `GET` | `/api/v1/consultations/{id}/encounters` | `listEncounters` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | The encounters (visits) of a consultation |
| `GET` | `/api/v1/consultations/{id}/harness-assurance/stream` | `streamHarnessAssurance` | Auth<br/>API Key: `consultation:session:write` | - | Stream live harness assurance (per-claim verdicts) for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/harness-progress/stream` | `streamHarnessProgress` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stream live harness draft-generation progress for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/highlights` | `getHighlights` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple HighlightResponses by id |
| `POST` | `/api/v1/consultations/{id}/highlights` | `createHighlight` | Auth<br/>API Key: `consultation:session:write` | - | Creating a HighlightResponse by id |
| `DELETE` | `/api/v1/consultations/{id}/highlights/{highlightId}` | `deleteHighlight` | Auth<br/>API Key: `consultation:session:write` | - | Deleting a OkResponseDto by id and highlightId |
| `GET` | `/api/v1/consultations/{id}/live-assist/stream` | `streamLiveAssist` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stream interpreter suggestions and proposed corrections for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/live-summary/stream` | `streamLiveSummary` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stream the running live summary for an in-progress consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/loop/stream` | `streamLoop` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stream consultation-loop workflow events for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/named-entities` | `getNamedEntities` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving a single AggregateNerResponse by id |
| `POST` | `/api/v1/consultations/{id}/pause` | `pause` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Pause capture |
| `POST` | `/api/v1/consultations/{id}/prime` | `prime` | Auth<br/>API Key: `consultation:session:write` | Yes | Creating a ConsultationResponse by id |
| `GET` | `/api/v1/consultations/{id}/recording` | `getRecording` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | The consultation recording, part by part |
| `POST` | `/api/v1/consultations/{id}/recording/start` | `startRecording` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Creating a RecordingStateResponse by id |
| `POST` | `/api/v1/consultations/{id}/recording/stop` | `stopRecording` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Creating a RecordingStateResponse by id |
| `GET` | `/api/v1/consultations/{id}/recordings` | `getRecordings` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple AudioRecordingResponses by id |
| `POST` | `/api/v1/consultations/{id}/recordings` | `addRecording` | Auth<br/>API Key: `consultation:session:write` | - | Creating a ContextItemResponse by id |
| `POST` | `/api/v1/consultations/{id}/reopen` | `reopen` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Creating a ConsultationResponse by id |
| `POST` | `/api/v1/consultations/{id}/start` | `start` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Start (or resume) capturing audio into a consultation |
| `POST` | `/api/v1/consultations/{id}/stop` | `stop` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stop capture and finalize the transcript |
| `GET` | `/api/v1/consultations/{id}/summary` | `getSummaries` | Auth<br/>API Key: `consultation:report:read`<br/>Svc: `svc:consultation:report:read` | - | Retrieving multiple SummaryResponses by id |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/approve` | `approveSummary` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Creating a SummaryApprovalResponseDto by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/diff` | `diffSummaryVersions` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving a single VersionDiffResponse by id and contextItemId |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/extract-entities` | `extractEntities` | Auth<br/>API Key: `consultation:session:write` | - | Creating a OkResponseDto by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/provenance` | `getSummaryProvenance` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving a single SummaryProvenanceResponse by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags` | `getSummaryTags` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple TagResponses by id and contextItemId |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags` | `tagSummary` | Auth<br/>API Key: `consultation:session:write` | - | Creating a TagResponse by id and contextItemId |
| `DELETE` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags/{tagId}` | `deleteSummaryTag` | Auth<br/>API Key: `consultation:session:write` | - | Deleting a OkResponseDto by id and contextItemId and tagId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/versions` | `getSummaryVersions` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ContextItemVersionResponses by id and contextItemId |
| `PATCH` | `/api/v1/consultations/{id}/summary/{summaryId}` | `updateSummary` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | Yes | Updating a SummaryResponse by id and summaryId |
| `POST` | `/api/v1/consultations/{id}/summary/async` | `generateSummaryAsync` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Creating a AsyncJobResponseDto by id |
| `POST` | `/api/v1/consultations/{id}/summary/comprehensive` | `generateComprehensiveSummary` | Auth<br/>API Key: `consultation:session:write` | - | Creating a ComprehensiveSummaryResponse by id |
| `GET` | `/api/v1/consultations/{id}/summary/latest` | `getLatestSummary` | Auth<br/>API Key: `consultation:report:read`<br/>Svc: `svc:consultation:report:read` | - | Retrieving a single SummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/pre-summary/async` | `generatePreSummaryAsync` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Creating a AsyncJobResponseDto by id |
| `GET` | `/api/v1/consultations/{id}/summary/pre-summary/latest` | `getLatestPreSummary` | Auth<br/>API Key: `consultation:report:read`<br/>Svc: `svc:consultation:report:read` | - | Retrieving a single SummaryResponse by id |
| `GET` | `/api/v1/consultations/{id}/timeline` | `getTimeline` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | Retrieving a single ConsultationTimelineResponse by id |
| `GET` | `/api/v1/consultations/{id}/trajectory/stream` | `streamTrajectory` | Auth<br/>API Key: `consultation:session:write` | - | Stream the ordered agentic-session trajectory for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/workflow` | `getGoverningWorkflow` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | Which engine governs this consultation, and the identity of the tenant-authored workflow when one does. |
| `POST` | `/api/v1/consultations/open` | `open` | Perms: `create:Consultation`<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Creating a ConsultationResponse |
| `GET` | `/api/v1/consultations/patient/{patientId}/date/{date}` | `getByPatientAndDate` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ConsultationResponses by patientId and date |
| `GET` | `/api/v1/consultations/patient/{patientId}/history` | `getPatientHistory` | Auth<br/>API Key: `consultation:session:write` | - | Retrieving multiple ConsultationResponses by patientId |
| `GET` | `/api/v1/consultations/workflows` | `listSelectableWorkflows` | Perms: `create:Consultation`<br/>API Key: `consultation:session:write` | - | The workflows this caller may select when opening a consultation. |

#### Handler Call Trees:

**`GET /api/v1/consultations` → `ConsultationController.list`**
```text
[GET /api/v1/consultations]
  └── Controller: ConsultationController.list()
        ├── calls: this.consultationService.listConsultations()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PATCH /api/v1/consultations/{id}` → `ConsultationController.update`**
```text
[PATCH /api/v1/consultations/{id}]
  └── Controller: ConsultationController.update()
        ├── calls: this.consultationService.updateConsultation()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/approve` → `ConsultationController.approve`**
```text
[POST /api/v1/consultations/{id}/approve]
  └── Controller: ConsultationController.approve()
        ├── calls helper: this.callerOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/chain` → `ConsultationController.getChain`**
```text
[GET /api/v1/consultations/{id}/chain]
  └── Controller: ConsultationController.getChain()
        ├── calls: this.consultationService.getConsultationChain()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/close` → `ConsultationController.close`**
```text
[POST /api/v1/consultations/{id}/close]
  └── Controller: ConsultationController.close()
        ├── calls: this.consultationService.closeConsultation()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.callerOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/context` → `ConsultationController.addContext`**
```text
[POST /api/v1/consultations/{id}/context]
  └── Controller: ConsultationController.addContext()
        ├── calls: this.contextService.addContext()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/consultations/{id}/context/{contextId}` → `ConsultationController.deleteContext`**
```text
[DELETE /api/v1/consultations/{id}/context/{contextId}]
  └── Controller: ConsultationController.deleteContext()
        ├── calls: this.contextService.deleteContext()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PATCH /api/v1/consultations/{id}/context/{contextId}` → `ConsultationController.updateContext`**
```text
[PATCH /api/v1/consultations/{id}/context/{contextId}]
  └── Controller: ConsultationController.updateContext()
        ├── calls: this.contextService.updateContext()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/context/{contextId}/versions` → `ConsultationController.getContextVersions`**
```text
[GET /api/v1/consultations/{id}/context/{contextId}/versions]
  └── Controller: ConsultationController.getContextVersions()
        ├── calls: this.contextService.getVersionHistory()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}` → `ConsultationController.getContextVersion`**
```text
[GET /api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}]
  └── Controller: ConsultationController.getContextVersion()
        ├── calls: this.contextService.getVersion()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/context/case-notes` → `ConsultationController.getCaseNotes`**
```text
[GET /api/v1/consultations/{id}/context/case-notes]
  └── Controller: ConsultationController.getCaseNotes()
        ├── calls: this.contextService.getContextItems()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/context/shared` → `ConsultationController.getSharedContext`**
```text
[GET /api/v1/consultations/{id}/context/shared]
  └── Controller: ConsultationController.getSharedContext()
        ├── calls: this.contextService.getSharedContext()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/context/transcriptions` → `ConsultationController.getTranscriptions`**
```text
[GET /api/v1/consultations/{id}/context/transcriptions]
  └── Controller: ConsultationController.getTranscriptions()
        ├── calls: this.contextService.getTranscriptions()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/documents/{documentKey}/sections` → `ConsultationController.listDocumentSections`**
```text
[GET /api/v1/consultations/{id}/documents/{documentKey}/sections]
  └── Controller: ConsultationController.listDocumentSections()
        ├── calls: this.documentSectionService.listSections()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls: this.documentSectionService.listSections()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` → `ConsultationController.getDocumentSection`**
```text
[GET /api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}]
  └── Controller: ConsultationController.getDocumentSection()
        ├── calls: this.documentSectionService.getSection()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`PATCH /api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` → `ConsultationController.updateDocumentSection`**
```text
[PATCH /api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}]
  └── Controller: ConsultationController.updateDocumentSection()
        ├── calls: this.documentSectionService.updateSectionContent()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/documents/sections` → `ConsultationController.listAllDocumentSections`**
```text
[GET /api/v1/consultations/{id}/documents/sections]
  └── Controller: ConsultationController.listAllDocumentSections()
        ├── calls: this.documentSectionService.listAllSections()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls: this.documentSectionService.listAllSections()
        │     └─ Service: IDocumentSectionService [token: IDocumentSectionService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/encounters` → `ConsultationController.listEncounters`**
```text
[GET /api/v1/consultations/{id}/encounters]
  └── Controller: ConsultationController.listEncounters()
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/harness-assurance/stream` → `ConsultationController.streamHarnessAssurance`**
```text
[GET /api/v1/consultations/{id}/harness-assurance/stream]
  └── Controller: ConsultationController.streamHarnessAssurance()
        ├── calls: this.harnessAssuranceService.subscribeToAssurance()
        │     └─ Service: HarnessAssuranceService
```

**`GET /api/v1/consultations/{id}/harness-progress/stream` → `ConsultationController.streamHarnessProgress`**
```text
[GET /api/v1/consultations/{id}/harness-progress/stream]
  └── Controller: ConsultationController.streamHarnessProgress()
        ├── calls: this.harnessProgressService.subscribeToProgress()
        │     └─ Service: HarnessProgressService
```

**`GET /api/v1/consultations/{id}/highlights` → `ConsultationController.getHighlights`**
```text
[GET /api/v1/consultations/{id}/highlights]
  └── Controller: ConsultationController.getHighlights()
        ├── calls: this.highlightService.getHighlights()
        │     └─ Service: IHighlightService [token: IHighlightService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/highlights` → `ConsultationController.createHighlight`**
```text
[POST /api/v1/consultations/{id}/highlights]
  └── Controller: ConsultationController.createHighlight()
        ├── calls: this.highlightService.createHighlight()
        │     └─ Service: IHighlightService [token: IHighlightService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/consultations/{id}/highlights/{highlightId}` → `ConsultationController.deleteHighlight`**
```text
[DELETE /api/v1/consultations/{id}/highlights/{highlightId}]
  └── Controller: ConsultationController.deleteHighlight()
        ├── calls: this.highlightService.deleteHighlight()
        │     └─ Service: IHighlightService [token: IHighlightService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/live-assist/stream` → `ConsultationController.streamLiveAssist`**
```text
[GET /api/v1/consultations/{id}/live-assist/stream]
  └── Controller: ConsultationController.streamLiveAssist()
        ├── calls: this.harnessLiveAssistService.subscribeToAssist()
        │     └─ Service: HarnessLiveAssistService
```

**`GET /api/v1/consultations/{id}/live-summary/stream` → `ConsultationController.streamLiveSummary`**
```text
[GET /api/v1/consultations/{id}/live-summary/stream]
  └── Controller: ConsultationController.streamLiveSummary()
        ├── calls: this.liveDocumentationService.subscribeToLiveSummary()
        │     └─ Service: LiveDocumentationService
```

**`GET /api/v1/consultations/{id}/named-entities` → `ConsultationController.getNamedEntities`**
```text
[GET /api/v1/consultations/{id}/named-entities]
  └── Controller: ConsultationController.getNamedEntities()
        ├── calls: this.contextService.getAggregateNamedEntities()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/pause` → `ConsultationController.pause`**
```text
[POST /api/v1/consultations/{id}/pause]
  └── Controller: ConsultationController.pause()
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/prime` → `ConsultationController.prime`**
```text
[POST /api/v1/consultations/{id}/prime]
  └── Controller: ConsultationController.prime()
        ├── calls: this.consultationService.primeConsultation()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/recording` → `ConsultationController.getRecording`**
```text
[GET /api/v1/consultations/{id}/recording]
  └── Controller: ConsultationController.getRecording()
        ├── calls: this.contextService.getContextItems()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/recording/start` → `ConsultationController.startRecording`**
```text
[POST /api/v1/consultations/{id}/recording/start]
  └── Controller: ConsultationController.startRecording()
        ├── calls: this.consultationService.startRecording()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

**`POST /api/v1/consultations/{id}/recording/stop` → `ConsultationController.stopRecording`**
```text
[POST /api/v1/consultations/{id}/recording/stop]
  └── Controller: ConsultationController.stopRecording()
        ├── calls: this.liveDocumentationService.markHandoffPending()
        │     └─ Service: LiveDocumentationService
        ├── calls: this.consultationService.stopRecording()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/recordings` → `ConsultationController.getRecordings`**
```text
[GET /api/v1/consultations/{id}/recordings]
  └── Controller: ConsultationController.getRecordings()
        ├── calls: this.contextService.getAudioRecordings()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/recordings` → `ConsultationController.addRecording`**
```text
[POST /api/v1/consultations/{id}/recordings]
  └── Controller: ConsultationController.addRecording()
        ├── calls: this.contextService.addAudioRecording()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/reopen` → `ConsultationController.reopen`**
```text
[POST /api/v1/consultations/{id}/reopen]
  └── Controller: ConsultationController.reopen()
        ├── calls: this.consultationService.reopenConsultation()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls: this.consultationService.reopenConsultation()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.callerOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/stop` → `ConsultationController.stop`**
```text
[POST /api/v1/consultations/{id}/stop]
  └── Controller: ConsultationController.stop()
        ├── calls: this.liveDocumentationService.markHandoffPending()
        │     └─ Service: LiveDocumentationService
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary` → `ConsultationController.getSummaries`**
```text
[GET /api/v1/consultations/{id}/summary]
  └── Controller: ConsultationController.getSummaries()
        ├── calls: this.summaryService.getSummaries()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/summary/{contextItemId}/approve` → `ConsultationController.approveSummary`**
```text
[POST /api/v1/consultations/{id}/summary/{contextItemId}/approve]
  └── Controller: ConsultationController.approveSummary()
        ├── calls helper: this.callerOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary/{contextItemId}/diff` → `ConsultationController.diffSummaryVersions`**
```text
[GET /api/v1/consultations/{id}/summary/{contextItemId}/diff]
  └── Controller: ConsultationController.diffSummaryVersions()
        ├── calls: this.contextService.diffVersions()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/summary/{contextItemId}/extract-entities` → `ConsultationController.extractEntities`**
```text
[POST /api/v1/consultations/{id}/summary/{contextItemId}/extract-entities]
  └── Controller: ConsultationController.extractEntities()
        ├── calls: this.summaryService.extractEntities()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary/{contextItemId}/provenance` → `ConsultationController.getSummaryProvenance`**
```text
[GET /api/v1/consultations/{id}/summary/{contextItemId}/provenance]
  └── Controller: ConsultationController.getSummaryProvenance()
        ├── calls: this.summaryService.getSummaryProvenance()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/summary/{contextItemId}/tags` → `ConsultationController.getSummaryTags`**
```text
[GET /api/v1/consultations/{id}/summary/{contextItemId}/tags]
  └── Controller: ConsultationController.getSummaryTags()
        ├── calls: this.tagService.fetchByResource()
        │     └─ Service: ITagService [token: ITagService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/summary/{contextItemId}/tags` → `ConsultationController.tagSummary`**
```text
[POST /api/v1/consultations/{id}/summary/{contextItemId}/tags]
  └── Controller: ConsultationController.tagSummary()
        ├── calls: this.tagService.create()
        │     └─ Service: ITagService [token: ITagService]
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/consultations/{id}/summary/{contextItemId}/tags/{tagId}` → `ConsultationController.deleteSummaryTag`**
```text
[DELETE /api/v1/consultations/{id}/summary/{contextItemId}/tags/{tagId}]
  └── Controller: ConsultationController.deleteSummaryTag()
        ├── calls: this.tagService.fetchById()
        │     └─ Service: ITagService [token: ITagService]
        ├── calls: this.tagService.deleteById()
        │     └─ Service: ITagService [token: ITagService]
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary/{contextItemId}/versions` → `ConsultationController.getSummaryVersions`**
```text
[GET /api/v1/consultations/{id}/summary/{contextItemId}/versions]
  └── Controller: ConsultationController.getSummaryVersions()
        ├── calls: this.contextService.getVersionHistory()
        │     └─ Service: IContextService [token: IContextService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`PATCH /api/v1/consultations/{id}/summary/{summaryId}` → `ConsultationController.updateSummary`**
```text
[PATCH /api/v1/consultations/{id}/summary/{summaryId}]
  └── Controller: ConsultationController.updateSummary()
        ├── calls: this.summaryService.updateSummary()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.callerOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/consultations/{id}/summary/async` → `ConsultationController.generateSummaryAsync`**
```text
[POST /api/v1/consultations/{id}/summary/async]
  └── Controller: ConsultationController.generateSummaryAsync()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationJobService.runIdempotent()
        │     └─ Service: IConsultationJobService [token: IConsultationJobService]
        ├── calls helper: this.getServiceAccountId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.getJobInitiatorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary/latest` → `ConsultationController.getLatestSummary`**
```text
[GET /api/v1/consultations/{id}/summary/latest]
  └── Controller: ConsultationController.getLatestSummary()
        ├── calls: this.summaryService.getLatestSummary()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/{id}/summary/pre-summary/async` → `ConsultationController.generatePreSummaryAsync`**
```text
[POST /api/v1/consultations/{id}/summary/pre-summary/async]
  └── Controller: ConsultationController.generatePreSummaryAsync()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationJobService.createPreSummaryJob()
        │     └─ Service: IConsultationJobService [token: IConsultationJobService]
        ├── calls helper: this.getJobInitiatorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.verifyConsultationOwnership()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/consultations/{id}/summary/pre-summary/latest` → `ConsultationController.getLatestPreSummary`**
```text
[GET /api/v1/consultations/{id}/summary/pre-summary/latest]
  └── Controller: ConsultationController.getLatestPreSummary()
        ├── calls: this.summaryService.getLatestPreSummary()
        │     └─ Service: ISummaryService [token: ISummaryService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/timeline` → `ConsultationController.getTimeline`**
```text
[GET /api/v1/consultations/{id}/timeline]
  └── Controller: ConsultationController.getTimeline()
        ├── calls: this.timelineService.getTimeline()
        │     └─ Service: TimelineService
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`GET /api/v1/consultations/{id}/workflow` → `ConsultationController.getGoverningWorkflow`**
```text
[GET /api/v1/consultations/{id}/workflow]
  └── Controller: ConsultationController.getGoverningWorkflow()
        ├── calls: this.consultationService.getGoverningWorkflow()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyConsultationAccess()
        │     ├── calls: this.consultationService.getById()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.policyEngine.can()
        │     │     └─ Service: PolicyEngine
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
        │     ├── calls: this.logger.debug()
        │     │     └─ Service: unknown
```

**`POST /api/v1/consultations/open` → `ConsultationController.open`**
```text
[POST /api/v1/consultations/open]
  └── Controller: ConsultationController.open()
        ├── calls: this.consultationService.getOrCreate()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

**`GET /api/v1/consultations/patient/{patientId}/date/{date}` → `ConsultationController.getByPatientAndDate`**
```text
[GET /api/v1/consultations/patient/{patientId}/date/{date}]
  └── Controller: ConsultationController.getByPatientAndDate()
        ├── calls: this.consultationService.getByPatientAndDate()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyPatientAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
```

**`GET /api/v1/consultations/patient/{patientId}/history` → `ConsultationController.getPatientHistory`**
```text
[GET /api/v1/consultations/patient/{patientId}/history]
  └── Controller: ConsultationController.getPatientHistory()
        ├── calls: this.consultationService.getPatientHistoryPaginated()
        │     └─ Service: IConsultationService [token: IConsultationService]
        ├── calls helper: this.verifyPatientAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.consultationService.doctorHasPatientRelationship()
        │     │     └─ Service: IConsultationService [token: IConsultationService]
```

**`GET /api/v1/consultations/workflows` → `ConsultationController.listSelectableWorkflows`**
```text
[GET /api/v1/consultations/workflows]
  └── Controller: ConsultationController.listSelectableWorkflows()
        ├── calls: this.consultationService.listSelectableWorkflows()
        │     └─ Service: IConsultationService [token: IConsultationService]
```

### Controller: `ConsultationFeedbackController`
**File:** [`src/modules/consultation/consultation-feedback.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-feedback.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/{id}/feedback` | `list` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | List consultation feedback (keyset, newest first) |
| `POST` | `/api/v1/consultations/{id}/feedback` | `create` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Record feedback: rating, reasons, comment, media or a correction |
| `GET` | `/api/v1/consultations/feedback/reason-codes` | `reasonCodes` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:read` | - | The effective feedback reason list for the caller tenant |

#### Handler Call Trees:

**`GET /api/v1/consultations/{id}/feedback` → `ConsultationFeedbackController.list`**
```text
[GET /api/v1/consultations/{id}/feedback]
  └── Controller: ConsultationFeedbackController.list()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.feedback.list()
        │     └─ Service: IConsultationFeedbackService [token: IConsultationFeedbackServiceToken]
```

**`POST /api/v1/consultations/{id}/feedback` → `ConsultationFeedbackController.create`**
```text
[POST /api/v1/consultations/{id}/feedback]
  └── Controller: ConsultationFeedbackController.create()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.feedback.create()
        │     └─ Service: IConsultationFeedbackService [token: IConsultationFeedbackServiceToken]
        ├── calls: this.access.callerOf()
        │     └─ Service: ConsultationAccessHelper
```

**`GET /api/v1/consultations/feedback/reason-codes` → `ConsultationFeedbackController.reasonCodes`**
```text
[GET /api/v1/consultations/feedback/reason-codes]
  └── Controller: ConsultationFeedbackController.reasonCodes()
        ├── calls: this.feedback.reasonCodes()
        │     └─ Service: IConsultationFeedbackService [token: IConsultationFeedbackServiceToken]
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

### Controller: `ConsultationJobController`
**File:** [`src/modules/consultation/consultation-job.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-job.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/jobs/{jobId}` | `getJob` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:report:read` | - | Get the current status of an async consultation job |
| `PATCH` | `/api/v1/consultations/jobs/{jobId}/cancel` | `cancelJob` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:write` | - | Cancel a pending or running async consultation job |
| `GET` | `/api/v1/consultations/jobs/{jobId}/stream` | `streamJob` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:report:read` | - | Stream real-time status updates for an async consultation job via SSE |

#### Handler Call Trees:

**`GET /api/v1/consultations/jobs/{jobId}` → `ConsultationJobController.getJob`**
```text
[GET /api/v1/consultations/jobs/{jobId}]
  └── Controller: ConsultationJobController.getJob()
        ├── calls: this.jobService.getJobStatus()
        │     └─ Service: IConsultationJobService [token: IConsultationJobService]
```

**`GET /api/v1/consultations/jobs/{jobId}/stream` → `ConsultationJobController.streamJob`**
```text
[GET /api/v1/consultations/jobs/{jobId}/stream]
  └── Controller: ConsultationJobController.streamJob()
        ├── calls: this.jobService.subscribeToJobUpdates()
        │     └─ Service: IConsultationJobService [token: IConsultationJobService]
```

### Controller: `ConsultationLifecycleEventsController`
**File:** [`src/modules/consultation/consultation-lifecycle-events.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/{id}/events` | `streamEvents` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | - | Stream lifecycle events for a consultation via SSE |

#### Handler Call Trees:

**`GET /api/v1/consultations/{id}/events` → `ConsultationLifecycleEventsController.streamEvents`**
```text
[GET /api/v1/consultations/{id}/events]
  └── Controller: ConsultationLifecycleEventsController.streamEvents()
        ├── calls: this.events.subscribe()
        │     └─ Service: ConsultationLifecycleEventPublisher
```

### Controller: `ConsultationReadInternalController`
**File:** [`src/modules/consultation/consultation-read-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-read-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/consultations/{consultationId}/read` | `read` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/consultations/{consultationId}/read` → `ConsultationReadInternalController.read`**
```text
[POST /api/v1/internal/consultations/{consultationId}/read]
  └── Controller: ConsultationReadInternalController.read()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationReadService.read()
        │     └─ Service: IConsultationReadService [token: IConsultationReadService]
```

### Controller: `ConsultationTelemetryController`
**File:** [`src/modules/consultation/consultation-telemetry.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-telemetry.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consultations/{id}/telemetry` | `getTelemetry` | Perms: `manage:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Per-consultation AI telemetry |

#### Handler Call Trees:

**`GET /api/v1/admin/consultations/{id}/telemetry` → `ConsultationTelemetryController.getTelemetry`**
```text
[GET /api/v1/admin/consultations/{id}/telemetry]
  └── Controller: ConsultationTelemetryController.getTelemetry()
        ├── calls: this.telemetryService.getTelemetry()
        │     └─ Service: IConsultationTelemetryService [token: IConsultationTelemetryService]
```

### Controller: `HarnessInternalController`
**File:** [`src/modules/consultation/harness-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/harness/consultations/{id}/assemble` | `assemble` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/assurance` | `finalizeAssurance` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/assurance-event` | `reportAssuranceClaim` | Public | - | - |
| `GET` | `/api/v1/internal/harness/consultations/{id}/context-items/{contextItemId}/extracted-text` | `getExtractedText` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/draft` | `persistDraft` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/endpoint/feedback` | `captureFeedback` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/endpoint/finalize` | `finalizeDocuments` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/endpoint/session` | `recordSessionEndpoint` | Public | - | - |
| `GET` | `/api/v1/internal/harness/consultations/{id}/entities` | `getEntities` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/entities` | `persistEntities` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/escalation` | `recordEscalation` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/gate-decision` | `recordGateDecision` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/live-assist` | `publishLiveAssist` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/live-documentation/start` | `startLiveDocumentation` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/live-documentation/stop` | `stopLiveDocumentation` | Public | - | - |
| `GET` | `/api/v1/internal/harness/consultations/{id}/live-handoff` | `liveHandoff` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/live-summary` | `publishLiveSummary` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/loop-event` | `reportLoopEvent` | Public | - | - |
| `POST` | `/api/v1/internal/harness/consultations/{id}/progress` | `reportProgress` | Public | - | - |
| `GET` | `/api/v1/internal/harness/loop-config` | `getLoopConfig` | Public | - | - |
| `GET` | `/api/v1/internal/harness/mcp-token` | `resolveMcpToken` | Public | - | - |
| `GET` | `/api/v1/internal/harness/models/resolve` | `resolveRegistryModel` | Public | - | - |
| `GET` | `/api/v1/internal/harness/policy` | `getEffectivePolicy` | Public | - | - |
| `GET` | `/api/v1/internal/harness/prompt-templates/{id}/resolved` | `getResolvedPromptTemplate` | Public | - | - |
| `GET` | `/api/v1/internal/harness/provider-credential` | `resolveProviderCredential` | Public | - | - |
| `POST` | `/api/v1/internal/harness/stt/batch-jobs` | `createSttBatchJob` | Public | - | - |
| `GET` | `/api/v1/internal/harness/stt/batch-jobs/{id}` | `getSttBatchJobStatus` | Public | - | - |
| `POST` | `/api/v1/internal/harness/trajectory` | `reportTrajectory` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/harness/consultations/{id}/assemble` → `HarnessInternalController.assemble`**
```text
[POST /api/v1/internal/harness/consultations/{id}/assemble]
  └── Controller: HarnessInternalController.assemble()
        ├── calls: this.harnessInternalService.assemble()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/assurance` → `HarnessInternalController.finalizeAssurance`**
```text
[POST /api/v1/internal/harness/consultations/{id}/assurance]
  └── Controller: HarnessInternalController.finalizeAssurance()
        ├── calls: this.harnessInternalService.finalizeAssurance()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/assurance-event` → `HarnessInternalController.reportAssuranceClaim`**
```text
[POST /api/v1/internal/harness/consultations/{id}/assurance-event]
  └── Controller: HarnessInternalController.reportAssuranceClaim()
        ├── calls: this.harnessAssuranceService.reportClaim()
        │     └─ Service: HarnessAssuranceService
```

**`GET /api/v1/internal/harness/consultations/{id}/context-items/{contextItemId}/extracted-text` → `HarnessInternalController.getExtractedText`**
```text
[GET /api/v1/internal/harness/consultations/{id}/context-items/{contextItemId}/extracted-text]
  └── Controller: HarnessInternalController.getExtractedText()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.loopContextTextService.resolveExtractedText()
        │     └─ Service: ILoopContextTextService [token: ILoopContextTextService]
```

**`POST /api/v1/internal/harness/consultations/{id}/draft` → `HarnessInternalController.persistDraft`**
```text
[POST /api/v1/internal/harness/consultations/{id}/draft]
  └── Controller: HarnessInternalController.persistDraft()
        ├── calls: this.harnessInternalService.persistDraft()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/endpoint/feedback` → `HarnessInternalController.captureFeedback`**
```text
[POST /api/v1/internal/harness/consultations/{id}/endpoint/feedback]
  └── Controller: HarnessInternalController.captureFeedback()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationEndpointService.captureFeedback()
        │     └─ Service: ConsultationEndpointService
```

**`POST /api/v1/internal/harness/consultations/{id}/endpoint/finalize` → `HarnessInternalController.finalizeDocuments`**
```text
[POST /api/v1/internal/harness/consultations/{id}/endpoint/finalize]
  └── Controller: HarnessInternalController.finalizeDocuments()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationEndpointService.finalizeDocuments()
        │     └─ Service: ConsultationEndpointService
```

**`POST /api/v1/internal/harness/consultations/{id}/endpoint/session` → `HarnessInternalController.recordSessionEndpoint`**
```text
[POST /api/v1/internal/harness/consultations/{id}/endpoint/session]
  └── Controller: HarnessInternalController.recordSessionEndpoint()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.consultationEndpointService.recordSessionEndpoint()
        │     └─ Service: ConsultationEndpointService
```

**`GET /api/v1/internal/harness/consultations/{id}/entities` → `HarnessInternalController.getEntities`**
```text
[GET /api/v1/internal/harness/consultations/{id}/entities]
  └── Controller: HarnessInternalController.getEntities()
        ├── calls: this.harnessInternalService.getEntities()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/entities` → `HarnessInternalController.persistEntities`**
```text
[POST /api/v1/internal/harness/consultations/{id}/entities]
  └── Controller: HarnessInternalController.persistEntities()
        ├── calls: this.harnessInternalService.persistEntities()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/escalation` → `HarnessInternalController.recordEscalation`**
```text
[POST /api/v1/internal/harness/consultations/{id}/escalation]
  └── Controller: HarnessInternalController.recordEscalation()
        ├── calls: this.harnessInternalService.recordEscalation()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/gate-decision` → `HarnessInternalController.recordGateDecision`**
```text
[POST /api/v1/internal/harness/consultations/{id}/gate-decision]
  └── Controller: HarnessInternalController.recordGateDecision()
        ├── calls: this.harnessInternalService.recordGateDecision()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/consultations/{id}/live-assist` → `HarnessInternalController.publishLiveAssist`**
```text
[POST /api/v1/internal/harness/consultations/{id}/live-assist]
  └── Controller: HarnessInternalController.publishLiveAssist()
        ├── calls: this.harnessLiveAssistService.publishAssist()
        │     └─ Service: HarnessLiveAssistService
```

**`POST /api/v1/internal/harness/consultations/{id}/live-documentation/start` → `HarnessInternalController.startLiveDocumentation`**
```text
[POST /api/v1/internal/harness/consultations/{id}/live-documentation/start]
  └── Controller: HarnessInternalController.startLiveDocumentation()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.liveDocumentationService.start()
        │     └─ Service: LiveDocumentationService
```

**`POST /api/v1/internal/harness/consultations/{id}/live-documentation/stop` → `HarnessInternalController.stopLiveDocumentation`**
```text
[POST /api/v1/internal/harness/consultations/{id}/live-documentation/stop]
  └── Controller: HarnessInternalController.stopLiveDocumentation()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.liveDocumentationService.stop()
        │     └─ Service: LiveDocumentationService
```

**`GET /api/v1/internal/harness/consultations/{id}/live-handoff` → `HarnessInternalController.liveHandoff`**
```text
[GET /api/v1/internal/harness/consultations/{id}/live-handoff]
  └── Controller: HarnessInternalController.liveHandoff()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.liveDocumentationService.readLiveHandoff()
        │     └─ Service: LiveDocumentationService
```

**`POST /api/v1/internal/harness/consultations/{id}/live-summary` → `HarnessInternalController.publishLiveSummary`**
```text
[POST /api/v1/internal/harness/consultations/{id}/live-summary]
  └── Controller: HarnessInternalController.publishLiveSummary()
        ├── calls: this.liveDocumentationService.publishInterpreterSummary()
        │     └─ Service: LiveDocumentationService
```

**`POST /api/v1/internal/harness/consultations/{id}/loop-event` → `HarnessInternalController.reportLoopEvent`**
```text
[POST /api/v1/internal/harness/consultations/{id}/loop-event]
  └── Controller: HarnessInternalController.reportLoopEvent()
        ├── calls: this.consultationLoopEventService.publishEvent()
        │     └─ Service: ConsultationLoopEventService
```

**`POST /api/v1/internal/harness/consultations/{id}/progress` → `HarnessInternalController.reportProgress`**
```text
[POST /api/v1/internal/harness/consultations/{id}/progress]
  └── Controller: HarnessInternalController.reportProgress()
        ├── calls: this.harnessInternalService.reportProgress()
        │     └─ Service: HarnessInternalService
```

**`GET /api/v1/internal/harness/loop-config` → `HarnessInternalController.getLoopConfig`**
```text
[GET /api/v1/internal/harness/loop-config]
  └── Controller: HarnessInternalController.getLoopConfig()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.loopConfigService.resolveForConsultation()
        │     └─ Service: ILoopConfigService [token: ILoopConfigService]
```

**`GET /api/v1/internal/harness/models/resolve` → `HarnessInternalController.resolveRegistryModel`**
```text
[GET /api/v1/internal/harness/models/resolve]
  └── Controller: HarnessInternalController.resolveRegistryModel()
        ├── calls: this.harnessInternalService.resolveTaskModel()
        │     └─ Service: HarnessInternalService
        ├── calls: this.harnessInternalService.resolveRegistryModel()
        │     └─ Service: HarnessInternalService
```

**`GET /api/v1/internal/harness/prompt-templates/{id}/resolved` → `HarnessInternalController.getResolvedPromptTemplate`**
```text
[GET /api/v1/internal/harness/prompt-templates/{id}/resolved]
  └── Controller: HarnessInternalController.getResolvedPromptTemplate()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.promptManagementService.getPromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
        ├── calls: this.promptManagementService.getVersions()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/internal/harness/provider-credential` → `HarnessInternalController.resolveProviderCredential`**
```text
[GET /api/v1/internal/harness/provider-credential]
  └── Controller: HarnessInternalController.resolveProviderCredential()
        ├── calls: this.harnessInternalService.resolveProviderCredential()
        │     └─ Service: HarnessInternalService
```

**`POST /api/v1/internal/harness/stt/batch-jobs` → `HarnessInternalController.createSttBatchJob`**
```text
[POST /api/v1/internal/harness/stt/batch-jobs]
  └── Controller: HarnessInternalController.createSttBatchJob()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/internal/harness/stt/batch-jobs/{id}` → `HarnessInternalController.getSttBatchJobStatus`**
```text
[GET /api/v1/internal/harness/stt/batch-jobs/{id}]
  └── Controller: HarnessInternalController.getSttBatchJobStatus()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/internal/harness/trajectory` → `HarnessInternalController.reportTrajectory`**
```text
[POST /api/v1/internal/harness/trajectory]
  └── Controller: HarnessInternalController.reportTrajectory()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.agentTrajectoryService.recordSteps()
        │     └─ Service: IAgentTrajectoryService [token: IAgentTrajectoryService]
        ├── calls: this.agentTrajectoryService.recordComputeSamples()
        │     └─ Service: IAgentTrajectoryService [token: IAgentTrajectoryService]
```

### Controller: `HarnessNotePlanController`
**File:** [`src/modules/consultation/harness-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/consultations/{consultationId}/note-plans/{planId}` | `getNotePlan` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/consultations/{consultationId}/note-plans/{planId}` → `HarnessNotePlanController.getNotePlan`**
```text
[GET /api/v1/internal/consultations/{consultationId}/note-plans/{planId}]
  └── Controller: HarnessNotePlanController.getNotePlan()
        ├── calls: this.harnessInternalService.getNotePlan()
        │     └─ Service: HarnessInternalService
```

---

## Module: `consultation-context-schema` (10 routes)

### Controller: `ConsultationContextSchemaAdminController`
**File:** [`src/modules/consultation-context-schema/consultation-context-schema.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consultation-context-schemas` | `list` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | List the caller tenant's consultation context schemas |
| `POST` | `/api/v1/admin/consultation-context-schemas` | `create` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | Create a DRAFT context schema |
| `DELETE` | `/api/v1/admin/consultation-context-schemas/{id}` | `deleteById` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | Soft-delete a context schema |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}` | `getById` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | Get one context schema by id |
| `PATCH` | `/api/v1/admin/consultation-context-schemas/{id}` | `update` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | Yes | Update schema metadata under optimistic concurrency |
| `POST` | `/api/v1/admin/consultation-context-schemas/{id}/pin` | `pin` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | Move the pin to an already-published version |
| `POST` | `/api/v1/admin/consultation-context-schemas/{id}/publish` | `publish` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | Validate a definition, publish it as a new immutable version, and pin it |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}/usages` | `usages` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | List the workflows and agents bound to a context schema, with a verdict per consumer |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}/versions` | `listVersions` | Perms: `manage:ConsultationContextSchema`<br/>Svc: `svc:admin:consultation-context-schema:manage` | - | List the immutable published versions of a context schema, newest first |

#### Handler Call Trees:

**`GET /api/v1/admin/consultation-context-schemas` → `ConsultationContextSchemaAdminController.list`**
```text
[GET /api/v1/admin/consultation-context-schemas]
  └── Controller: ConsultationContextSchemaAdminController.list()
        ├── calls: this.service.list()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`POST /api/v1/admin/consultation-context-schemas` → `ConsultationContextSchemaAdminController.create`**
```text
[POST /api/v1/admin/consultation-context-schemas]
  └── Controller: ConsultationContextSchemaAdminController.create()
        ├── calls: this.service.create()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`DELETE /api/v1/admin/consultation-context-schemas/{id}` → `ConsultationContextSchemaAdminController.deleteById`**
```text
[DELETE /api/v1/admin/consultation-context-schemas/{id}]
  └── Controller: ConsultationContextSchemaAdminController.deleteById()
        ├── calls: this.service.deleteById()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`GET /api/v1/admin/consultation-context-schemas/{id}` → `ConsultationContextSchemaAdminController.getById`**
```text
[GET /api/v1/admin/consultation-context-schemas/{id}]
  └── Controller: ConsultationContextSchemaAdminController.getById()
        ├── calls: this.service.getById()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`PATCH /api/v1/admin/consultation-context-schemas/{id}` → `ConsultationContextSchemaAdminController.update`**
```text
[PATCH /api/v1/admin/consultation-context-schemas/{id}]
  └── Controller: ConsultationContextSchemaAdminController.update()
        ├── calls: this.service.update()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`POST /api/v1/admin/consultation-context-schemas/{id}/pin` → `ConsultationContextSchemaAdminController.pin`**
```text
[POST /api/v1/admin/consultation-context-schemas/{id}/pin]
  └── Controller: ConsultationContextSchemaAdminController.pin()
        ├── calls: this.service.pin()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`POST /api/v1/admin/consultation-context-schemas/{id}/publish` → `ConsultationContextSchemaAdminController.publish`**
```text
[POST /api/v1/admin/consultation-context-schemas/{id}/publish]
  └── Controller: ConsultationContextSchemaAdminController.publish()
        ├── calls: this.service.publish()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`GET /api/v1/admin/consultation-context-schemas/{id}/usages` → `ConsultationContextSchemaAdminController.usages`**
```text
[GET /api/v1/admin/consultation-context-schemas/{id}/usages]
  └── Controller: ConsultationContextSchemaAdminController.usages()
        ├── calls: this.service.usages()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

**`GET /api/v1/admin/consultation-context-schemas/{id}/versions` → `ConsultationContextSchemaAdminController.listVersions`**
```text
[GET /api/v1/admin/consultation-context-schemas/{id}/versions]
  └── Controller: ConsultationContextSchemaAdminController.listVersions()
        ├── calls: this.service.listVersions()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

### Controller: `MyTenantContextSchemaController`
**File:** [`src/modules/consultation-context-schema/consultation-context-schema.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me/context-schema` | `getEffective` | Auth<br/>API Key: `tenant:context-schema:read`<br/>Svc: `svc:tenant:context-schema:read` | - | Discover the caller tenant's pinned consultation context schema |

#### Handler Call Trees:

**`GET /api/v1/tenants/me/context-schema` → `MyTenantContextSchemaController.getEffective`**
```text
[GET /api/v1/tenants/me/context-schema]
  └── Controller: MyTenantContextSchemaController.getEffective()
        ├── calls: this.service.getEffectiveBundle()
        │     └─ Service: IConsultationContextSchemaService [token: IConsultationContextSchemaService]
```

---

## Module: `consultation-history` (7 routes)

### Controller: `AdminConsultationHistoryController`
**File:** [`src/modules/consultation-history/admin-consultation-history.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consultations/{id}/activity` | `getActivity` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Read a consultation`s activity feed |
| `GET` | `/api/v1/admin/consultations/{id}/items/{itemId}/runs` | `listRuns` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | List the AI runs behind an item version |
| `GET` | `/api/v1/admin/consultations/{id}/items/{itemId}/versions` | `listVersions` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | List an item`s versions |
| `GET` | `/api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}` | `getVersion` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Read one version of an item, decrypted |
| `GET` | `/api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}/diff` | `diff` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Diff two versions of an item |

#### Handler Call Trees:

**`GET /api/v1/admin/consultations/{id}/activity` → `AdminConsultationHistoryController.getActivity`**
```text
[GET /api/v1/admin/consultations/{id}/activity]
  └── Controller: AdminConsultationHistoryController.getActivity()
        ├── calls: this.history.getActivity()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

**`GET /api/v1/admin/consultations/{id}/items/{itemId}/runs` → `AdminConsultationHistoryController.listRuns`**
```text
[GET /api/v1/admin/consultations/{id}/items/{itemId}/runs]
  └── Controller: AdminConsultationHistoryController.listRuns()
        ├── calls: this.history.listItemRuns()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

**`GET /api/v1/admin/consultations/{id}/items/{itemId}/versions` → `AdminConsultationHistoryController.listVersions`**
```text
[GET /api/v1/admin/consultations/{id}/items/{itemId}/versions]
  └── Controller: AdminConsultationHistoryController.listVersions()
        ├── calls: this.history.listItemVersions()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

**`GET /api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}` → `AdminConsultationHistoryController.getVersion`**
```text
[GET /api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}]
  └── Controller: AdminConsultationHistoryController.getVersion()
        ├── calls: this.history.getItemVersion()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

**`GET /api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}/diff` → `AdminConsultationHistoryController.diff`**
```text
[GET /api/v1/admin/consultations/{id}/items/{itemId}/versions/{n}/diff]
  └── Controller: AdminConsultationHistoryController.diff()
        ├── calls: this.history.diffItemVersions()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

### Controller: `ConsultationHistoryController`
**File:** [`src/modules/consultation-history/consultation-history.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation-history/consultation-history.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/{id}/encounters/{seq}/recap` | `getRecap` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | Read the live recap of one encounter |
| `GET` | `/api/v1/consultations/{id}/history` | `getHistory` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | Read a consultation`s history |

#### Handler Call Trees:

**`GET /api/v1/consultations/{id}/encounters/{seq}/recap` → `ConsultationHistoryController.getRecap`**
```text
[GET /api/v1/consultations/{id}/encounters/{seq}/recap]
  └── Controller: ConsultationHistoryController.getRecap()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.history.getRecap()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

**`GET /api/v1/consultations/{id}/history` → `ConsultationHistoryController.getHistory`**
```text
[GET /api/v1/consultations/{id}/history]
  └── Controller: ConsultationHistoryController.getHistory()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.history.getActivity()
        │     └─ Service: IConsultationHistoryService [token: IConsultationHistoryServiceToken]
```

---

## Module: `department` (10 routes)

### Controller: `DepartmentController`
**File:** [`src/modules/department/department.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/department/department.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/departments` | `fetchAll` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Retrieving multiple DepartmentResponses |
| `POST` | `/api/v1/admin/departments` | `create` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Creating a DepartmentResponse |
| `DELETE` | `/api/v1/admin/departments/{id}` | `delete` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Deleting a DepartmentResponse by id |
| `GET` | `/api/v1/admin/departments/{id}` | `fetchById` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Retrieving a single DepartmentResponse by id |
| `PATCH` | `/api/v1/admin/departments/{id}` | `update` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | Yes | Updating a DepartmentResponse by id |
| `GET` | `/api/v1/admin/departments/{id}/children` | `fetchChildren` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Retrieving multiple DepartmentResponses by id |
| `PATCH` | `/api/v1/admin/departments/{id}/prompt-config` | `updatePromptConfig` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | Yes | Updating a DepartmentResponse by id (prompt config) |
| `GET` | `/api/v1/admin/departments/{id}/users` | `fetchUsers` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | List a department's members (users) |
| `GET` | `/api/v1/admin/departments/code/{code}` | `fetchByCode` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Retrieving a single DepartmentResponse by code |
| `GET` | `/api/v1/admin/departments/roots` | `fetchRoots` | Perms: `manage:Department`<br/>Svc: `svc:admin:department:manage` | - | Retrieving multiple DepartmentResponses |

#### Handler Call Trees:

**`GET /api/v1/admin/departments` → `DepartmentController.fetchAll`**
```text
[GET /api/v1/admin/departments]
  └── Controller: DepartmentController.fetchAll()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.departmentService.getAll()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`POST /api/v1/admin/departments` → `DepartmentController.create`**
```text
[POST /api/v1/admin/departments]
  └── Controller: DepartmentController.create()
        ├── calls: this.departmentService.create()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`DELETE /api/v1/admin/departments/{id}` → `DepartmentController.delete`**
```text
[DELETE /api/v1/admin/departments/{id}]
  └── Controller: DepartmentController.delete()
        ├── calls: this.departmentService.deleteById()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`GET /api/v1/admin/departments/{id}` → `DepartmentController.fetchById`**
```text
[GET /api/v1/admin/departments/{id}]
  └── Controller: DepartmentController.fetchById()
        ├── calls: this.departmentService.getById()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`PATCH /api/v1/admin/departments/{id}` → `DepartmentController.update`**
```text
[PATCH /api/v1/admin/departments/{id}]
  └── Controller: DepartmentController.update()
        ├── calls: this.departmentService.update()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`GET /api/v1/admin/departments/{id}/children` → `DepartmentController.fetchChildren`**
```text
[GET /api/v1/admin/departments/{id}/children]
  └── Controller: DepartmentController.fetchChildren()
        ├── calls: this.departmentService.getChildren()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`PATCH /api/v1/admin/departments/{id}/prompt-config` → `DepartmentController.updatePromptConfig`**
```text
[PATCH /api/v1/admin/departments/{id}/prompt-config]
  └── Controller: DepartmentController.updatePromptConfig()
        ├── calls: this.departmentService.updatePromptConfig()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`GET /api/v1/admin/departments/{id}/users` → `DepartmentController.fetchUsers`**
```text
[GET /api/v1/admin/departments/{id}/users]
  └── Controller: DepartmentController.fetchUsers()
        ├── calls: this.departmentService.getDepartmentUsers()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`GET /api/v1/admin/departments/code/{code}` → `DepartmentController.fetchByCode`**
```text
[GET /api/v1/admin/departments/code/{code}]
  └── Controller: DepartmentController.fetchByCode()
        ├── calls: this.departmentService.getByCode()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

**`GET /api/v1/admin/departments/roots` → `DepartmentController.fetchRoots`**
```text
[GET /api/v1/admin/departments/roots]
  └── Controller: DepartmentController.fetchRoots()
        ├── calls: this.departmentService.getRootDepartments()
        │     └─ Service: IDepartmentService [token: IDepartmentService]
```

---

## Module: `dna-writing-style` (31 routes)

### Controller: `DnaWritingStyleAdminController`
**File:** [`src/modules/dna-writing-style/dna-writing-style-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/dna-writing-styles` | `list` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Retrieving multiple DnaReportResponses |
| `PATCH` | `/api/v1/admin/dna-writing-styles/{reportId}` | `update` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | Yes | Updating a DnaReportResponse by reportId |
| `GET` | `/api/v1/admin/dna-writing-styles/{reportId}/versions` | `getVersions` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Retrieving multiple DnaVersionResponses by reportId |
| `GET` | `/api/v1/admin/dna-writing-styles/dashboard` | `getDashboard` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | DNA aggregate dashboard (users with a style, avg versions, recent usage activity) |
| `DELETE` | `/api/v1/admin/dna-writing-styles/doctor/{doctorId}` | `resetDoctorProfile` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Erase a doctor's entire learned DNA writing-style profile (admin) |
| `GET` | `/api/v1/admin/dna-writing-styles/doctor/{doctorId}` | `getReportForDoctor` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Latest DNA writing-style report for a doctor (admin cross-user, tenant-scoped PHI-gated) |
| `POST` | `/api/v1/admin/dna-writing-styles/generate/{doctorId}` | `generateForDoctor` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Creating a DnaJobResponseDto by doctorId |
| `GET` | `/api/v1/admin/dna-writing-styles/jobs/{jobId}` | `getJobStatus` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Get DNA generation job status |
| `GET` | `/api/v1/admin/dna-writing-styles/jobs/{jobId}/stream` | `streamJobStatus` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Stream DNA generation job status via SSE |

#### Handler Call Trees:

**`GET /api/v1/admin/dna-writing-styles` → `DnaWritingStyleAdminController.list`**
```text
[GET /api/v1/admin/dna-writing-styles]
  └── Controller: DnaWritingStyleAdminController.list()
        ├── calls: this.dnaService.listReportsPaginated()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`PATCH /api/v1/admin/dna-writing-styles/{reportId}` → `DnaWritingStyleAdminController.update`**
```text
[PATCH /api/v1/admin/dna-writing-styles/{reportId}]
  └── Controller: DnaWritingStyleAdminController.update()
        ├── calls: this.dnaService.updateDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/admin/dna-writing-styles/{reportId}/versions` → `DnaWritingStyleAdminController.getVersions`**
```text
[GET /api/v1/admin/dna-writing-styles/{reportId}/versions]
  └── Controller: DnaWritingStyleAdminController.getVersions()
        ├── calls: this.dnaService.getVersions()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/admin/dna-writing-styles/dashboard` → `DnaWritingStyleAdminController.getDashboard`**
```text
[GET /api/v1/admin/dna-writing-styles/dashboard]
  └── Controller: DnaWritingStyleAdminController.getDashboard()
        ├── calls: this.dnaService.getDashboard()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`DELETE /api/v1/admin/dna-writing-styles/doctor/{doctorId}` → `DnaWritingStyleAdminController.resetDoctorProfile`**
```text
[DELETE /api/v1/admin/dna-writing-styles/doctor/{doctorId}]
  └── Controller: DnaWritingStyleAdminController.resetDoctorProfile()
        ├── calls: this.dnaService.resetDoctorDnaProfile()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/admin/dna-writing-styles/doctor/{doctorId}` → `DnaWritingStyleAdminController.getReportForDoctor`**
```text
[GET /api/v1/admin/dna-writing-styles/doctor/{doctorId}]
  └── Controller: DnaWritingStyleAdminController.getReportForDoctor()
        ├── calls: this.dnaService.getDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`POST /api/v1/admin/dna-writing-styles/generate/{doctorId}` → `DnaWritingStyleAdminController.generateForDoctor`**
```text
[POST /api/v1/admin/dna-writing-styles/generate/{doctorId}]
  └── Controller: DnaWritingStyleAdminController.generateForDoctor()
        ├── calls: this.dnaService.generateDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/admin/dna-writing-styles/jobs/{jobId}` → `DnaWritingStyleAdminController.getJobStatus`**
```text
[GET /api/v1/admin/dna-writing-styles/jobs/{jobId}]
  └── Controller: DnaWritingStyleAdminController.getJobStatus()
        ├── calls helper: this.jobAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/dna-writing-styles/jobs/{jobId}/stream` → `DnaWritingStyleAdminController.streamJobStatus`**
```text
[GET /api/v1/admin/dna-writing-styles/jobs/{jobId}/stream]
  └── Controller: DnaWritingStyleAdminController.streamJobStatus()
        ├── calls helper: this.jobAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

### Controller: `DnaWritingStyleController`
**File:** [`src/modules/dna-writing-style/dna-writing-style.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `DELETE` | `/api/v1/dna-writing-styles/{reportId}` | `deleteReport` | Auth | - | Erase one of the caller doctor's DNA writing-style reports |
| `PATCH` | `/api/v1/dna-writing-styles/{reportId}` | `update` | Auth | Yes | Updating a DnaReportResponse by reportId |
| `PATCH` | `/api/v1/dna-writing-styles/{reportId}/default` | `setDefault` | Auth | Yes | Updating a DnaReportResponse by reportId |
| `GET` | `/api/v1/dna-writing-styles/{reportId}/versions` | `getVersions` | Auth | - | Retrieving multiple DnaVersionResponses by reportId |
| `GET` | `/api/v1/dna-writing-styles/doctor/{doctorId}` | `getByDoctor` | Auth | - | Retrieving a single DnaReportResponse by doctorId |
| `POST` | `/api/v1/dna-writing-styles/generate` | `generate` | Auth | - | Creating a DnaJobResponseDto |
| `GET` | `/api/v1/dna-writing-styles/jobs/{jobId}` | `getJobStatus` | Auth | - | Get current user DNA generation job status |
| `GET` | `/api/v1/dna-writing-styles/jobs/{jobId}/stream` | `streamJobStatus` | Auth | - | Stream current user DNA generation job status via SSE |
| `GET` | `/api/v1/dna-writing-styles/mine` | `getMine` | Auth | - | Retrieving multiple DnaReportResponses |
| `DELETE` | `/api/v1/dna-writing-styles/my-style` | `resetMyStyle` | Auth | - | Erase the caller doctor's entire learned DNA writing-style profile |
| `GET` | `/api/v1/dna-writing-styles/my-style` | `getMyStyle` | Auth | - | Retrieving a single DnaReportResponse |
| `GET` | `/api/v1/dna-writing-styles/my-style/redaction-rules` | `getMyRedactionRules` | Auth | - | Get the caller doctor's DNA redaction/rewrite rule set |
| `GET` | `/api/v1/dna-writing-styles/settings` | `getSettings` | Auth | - | Get the caller doctor's DNA writing-style on/off settings |
| `PUT` | `/api/v1/dna-writing-styles/settings` | `setSettings` | Auth | Yes | Set the caller doctor's DNA writing-style on/off toggle |

#### Handler Call Trees:

**`DELETE /api/v1/dna-writing-styles/{reportId}` → `DnaWritingStyleController.deleteReport`**
```text
[DELETE /api/v1/dna-writing-styles/{reportId}]
  └── Controller: DnaWritingStyleController.deleteReport()
        ├── calls: this.dnaService.deleteReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.assertActingAsDoctor()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PATCH /api/v1/dna-writing-styles/{reportId}` → `DnaWritingStyleController.update`**
```text
[PATCH /api/v1/dna-writing-styles/{reportId}]
  └── Controller: DnaWritingStyleController.update()
        ├── calls: this.dnaService.updateDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`PATCH /api/v1/dna-writing-styles/{reportId}/default` → `DnaWritingStyleController.setDefault`**
```text
[PATCH /api/v1/dna-writing-styles/{reportId}/default]
  └── Controller: DnaWritingStyleController.setDefault()
        ├── calls: this.dnaService.setDefaultReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/dna-writing-styles/{reportId}/versions` → `DnaWritingStyleController.getVersions`**
```text
[GET /api/v1/dna-writing-styles/{reportId}/versions]
  └── Controller: DnaWritingStyleController.getVersions()
        ├── calls: this.dnaService.getVersionsForDoctor()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/doctor/{doctorId}` → `DnaWritingStyleController.getByDoctor`**
```text
[GET /api/v1/dna-writing-styles/doctor/{doctorId}]
  └── Controller: DnaWritingStyleController.getByDoctor()
        ├── calls: this.dnaService.getDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/dna-writing-styles/generate` → `DnaWritingStyleController.generate`**
```text
[POST /api/v1/dna-writing-styles/generate]
  └── Controller: DnaWritingStyleController.generate()
        ├── calls: this.dnaService.generateDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.assertActingAsDoctor()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/jobs/{jobId}` → `DnaWritingStyleController.getJobStatus`**
```text
[GET /api/v1/dna-writing-styles/jobs/{jobId}]
  └── Controller: DnaWritingStyleController.getJobStatus()
        ├── calls helper: this.jobAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/jobs/{jobId}/stream` → `DnaWritingStyleController.streamJobStatus`**
```text
[GET /api/v1/dna-writing-styles/jobs/{jobId}/stream]
  └── Controller: DnaWritingStyleController.streamJobStatus()
        ├── calls helper: this.jobAccess()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/mine` → `DnaWritingStyleController.getMine`**
```text
[GET /api/v1/dna-writing-styles/mine]
  └── Controller: DnaWritingStyleController.getMine()
        ├── calls: this.dnaService.listReports()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/dna-writing-styles/my-style` → `DnaWritingStyleController.resetMyStyle`**
```text
[DELETE /api/v1/dna-writing-styles/my-style]
  └── Controller: DnaWritingStyleController.resetMyStyle()
        ├── calls: this.dnaService.resetMyDnaProfile()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.assertActingAsDoctor()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/my-style` → `DnaWritingStyleController.getMyStyle`**
```text
[GET /api/v1/dna-writing-styles/my-style]
  └── Controller: DnaWritingStyleController.getMyStyle()
        ├── calls: this.dnaService.getDnaReport()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/my-style/redaction-rules` → `DnaWritingStyleController.getMyRedactionRules`**
```text
[GET /api/v1/dna-writing-styles/my-style/redaction-rules]
  └── Controller: DnaWritingStyleController.getMyRedactionRules()
        ├── calls: this.dnaService.getRedactionRules()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/dna-writing-styles/settings` → `DnaWritingStyleController.getSettings`**
```text
[GET /api/v1/dna-writing-styles/settings]
  └── Controller: DnaWritingStyleController.getSettings()
        ├── calls: this.dnaService.getDnaSettings()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PUT /api/v1/dna-writing-styles/settings` → `DnaWritingStyleController.setSettings`**
```text
[PUT /api/v1/dna-writing-styles/settings]
  └── Controller: DnaWritingStyleController.setSettings()
        ├── calls: this.dnaService.setDnaEnabled()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
        ├── calls helper: this.getDoctorId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.assertActingAsDoctor()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

### Controller: `DnaWritingStyleIngestController`
**File:** [`src/modules/dna-writing-style/dna-writing-style-ingest.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/dna-writing-style/dna-writing-style-ingest.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/dna-writing-styles/ingest` | `ingest` | Auth<br/>API Key: `dna-writing-style:ingest`<br/>Svc: `svc:dna-writing-style:ingest` | - | Ingest a time series of writing samples for a clinician and queue their DNA writing-style analysis |
| `GET` | `/api/v1/dna-writing-styles/ingest/jobs/{jobId}` | `getIngestJob` | Auth<br/>API Key: `dna-writing-style:ingest`<br/>Svc: `svc:dna-writing-style:ingest` | - | Status of an ingest job |

#### Handler Call Trees:

**`POST /api/v1/dna-writing-styles/ingest` → `DnaWritingStyleIngestController.ingest`**
```text
[POST /api/v1/dna-writing-styles/ingest]
  └── Controller: DnaWritingStyleIngestController.ingest()
        ├── calls: this.dnaService.ingestWritingSamples()
        │     └─ Service: IDnaWritingStyleService [token: IDnaWritingStyleService]
```

**`GET /api/v1/dna-writing-styles/ingest/jobs/{jobId}` → `DnaWritingStyleIngestController.getIngestJob`**
```text
[GET /api/v1/dna-writing-styles/ingest/jobs/{jobId}]
  └── Controller: DnaWritingStyleIngestController.getIngestJob()
        ├── calls helper: this.jobAccessOf()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

### Controller: `DnaWritingStyleMemoryAdminController`
**File:** [`src/modules/dna-writing-style/dna-writing-style-memory-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/dna-writing-style/dna-writing-style-memory-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/dna-writing-styles/memory` | `listMemory` | Perms: `read:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | List DNA writing-style memory samples |
| `DELETE` | `/api/v1/admin/dna-writing-styles/memory/{id}` | `deleteMemory` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Delete a DNA writing-style memory sample |
| `GET` | `/api/v1/admin/dna-writing-styles/memory/summary` | `getMemorySummary` | Perms: `read:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | DNA writing-style memory per clinician |
| `GET` | `/api/v1/admin/dna-writing-styles/schedule` | `getSchedule` | Perms: `read:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Weekly DNA regeneration schedule |
| `PUT` | `/api/v1/admin/dna-writing-styles/schedule` | `updateSchedule` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Update the weekly DNA regeneration schedule |
| `POST` | `/api/v1/admin/dna-writing-styles/schedule/run` | `runSchedule` | Perms: `manage:DnaWritingStyleReport`<br/>Svc: `svc:admin:dna-writing-style:manage` | - | Run the DNA regeneration now (this tenant) |

#### Handler Call Trees:

**`GET /api/v1/admin/dna-writing-styles/memory` → `DnaWritingStyleMemoryAdminController.listMemory`**
```text
[GET /api/v1/admin/dna-writing-styles/memory]
  └── Controller: DnaWritingStyleMemoryAdminController.listMemory()
        ├── calls: this.memoryAdmin.listMemory()
        │     └─ Service: DnaMemoryAdminService
```

**`DELETE /api/v1/admin/dna-writing-styles/memory/{id}` → `DnaWritingStyleMemoryAdminController.deleteMemory`**
```text
[DELETE /api/v1/admin/dna-writing-styles/memory/{id}]
  └── Controller: DnaWritingStyleMemoryAdminController.deleteMemory()
        ├── calls: this.memoryAdmin.deleteMemory()
        │     └─ Service: DnaMemoryAdminService
```

**`GET /api/v1/admin/dna-writing-styles/memory/summary` → `DnaWritingStyleMemoryAdminController.getMemorySummary`**
```text
[GET /api/v1/admin/dna-writing-styles/memory/summary]
  └── Controller: DnaWritingStyleMemoryAdminController.getMemorySummary()
        ├── calls: this.memoryAdmin.getMemorySummary()
        │     └─ Service: DnaMemoryAdminService
```

**`GET /api/v1/admin/dna-writing-styles/schedule` → `DnaWritingStyleMemoryAdminController.getSchedule`**
```text
[GET /api/v1/admin/dna-writing-styles/schedule]
  └── Controller: DnaWritingStyleMemoryAdminController.getSchedule()
        ├── calls: this.memoryAdmin.getSchedule()
        │     └─ Service: DnaMemoryAdminService
```

**`PUT /api/v1/admin/dna-writing-styles/schedule` → `DnaWritingStyleMemoryAdminController.updateSchedule`**
```text
[PUT /api/v1/admin/dna-writing-styles/schedule]
  └── Controller: DnaWritingStyleMemoryAdminController.updateSchedule()
        ├── calls: this.memoryAdmin.updateSchedule()
        │     └─ Service: DnaMemoryAdminService
```

**`POST /api/v1/admin/dna-writing-styles/schedule/run` → `DnaWritingStyleMemoryAdminController.runSchedule`**
```text
[POST /api/v1/admin/dna-writing-styles/schedule/run]
  └── Controller: DnaWritingStyleMemoryAdminController.runSchedule()
        ├── calls: this.memoryAdmin.runNow()
        │     └─ Service: DnaMemoryAdminService
```

---

## Module: `document-template` (9 routes)

### Controller: `DocumentTemplateAdminController`
**File:** [`src/modules/document-template/document-template.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/document-template/document-template.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/document-templates` | `list` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | List the caller tenant's document templates |
| `POST` | `/api/v1/admin/document-templates` | `create` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | Create a DRAFT document template |
| `DELETE` | `/api/v1/admin/document-templates/{id}` | `deleteById` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | Soft-delete a document template |
| `GET` | `/api/v1/admin/document-templates/{id}` | `getById` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | Get one document template by id |
| `PATCH` | `/api/v1/admin/document-templates/{id}` | `update` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | Yes | Update template metadata under optimistic concurrency |
| `POST` | `/api/v1/admin/document-templates/{id}/pin` | `pin` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | Move the pin to an already-published version |
| `POST` | `/api/v1/admin/document-templates/{id}/publish` | `publish` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | Validate a shape, compile it, publish both as a new immutable version, and pin it |
| `GET` | `/api/v1/admin/document-templates/{id}/versions` | `listVersions` | Perms: `manage:DocumentTemplate`<br/>Svc: `svc:admin:document-template:manage` | - | List the immutable published versions of a template, newest first |

#### Handler Call Trees:

**`GET /api/v1/admin/document-templates` → `DocumentTemplateAdminController.list`**
```text
[GET /api/v1/admin/document-templates]
  └── Controller: DocumentTemplateAdminController.list()
        ├── calls: this.service.list()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`POST /api/v1/admin/document-templates` → `DocumentTemplateAdminController.create`**
```text
[POST /api/v1/admin/document-templates]
  └── Controller: DocumentTemplateAdminController.create()
        ├── calls: this.service.create()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`DELETE /api/v1/admin/document-templates/{id}` → `DocumentTemplateAdminController.deleteById`**
```text
[DELETE /api/v1/admin/document-templates/{id}]
  └── Controller: DocumentTemplateAdminController.deleteById()
        ├── calls: this.service.deleteById()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`GET /api/v1/admin/document-templates/{id}` → `DocumentTemplateAdminController.getById`**
```text
[GET /api/v1/admin/document-templates/{id}]
  └── Controller: DocumentTemplateAdminController.getById()
        ├── calls: this.service.getById()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`PATCH /api/v1/admin/document-templates/{id}` → `DocumentTemplateAdminController.update`**
```text
[PATCH /api/v1/admin/document-templates/{id}]
  └── Controller: DocumentTemplateAdminController.update()
        ├── calls: this.service.update()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`POST /api/v1/admin/document-templates/{id}/pin` → `DocumentTemplateAdminController.pin`**
```text
[POST /api/v1/admin/document-templates/{id}/pin]
  └── Controller: DocumentTemplateAdminController.pin()
        ├── calls: this.service.pin()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`POST /api/v1/admin/document-templates/{id}/publish` → `DocumentTemplateAdminController.publish`**
```text
[POST /api/v1/admin/document-templates/{id}/publish]
  └── Controller: DocumentTemplateAdminController.publish()
        ├── calls: this.service.publish()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

**`GET /api/v1/admin/document-templates/{id}/versions` → `DocumentTemplateAdminController.listVersions`**
```text
[GET /api/v1/admin/document-templates/{id}/versions]
  └── Controller: DocumentTemplateAdminController.listVersions()
        ├── calls: this.service.listVersions()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

### Controller: `MyTenantDocumentTemplateController`
**File:** [`src/modules/document-template/document-template.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/document-template/document-template.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me/document-template` | `getEffective` | Auth<br/>API Key: `tenant:document-template:read` | - | Discover the caller tenant's pinned document template |

#### Handler Call Trees:

**`GET /api/v1/tenants/me/document-template` → `MyTenantDocumentTemplateController.getEffective`**
```text
[GET /api/v1/tenants/me/document-template]
  └── Controller: MyTenantDocumentTemplateController.getEffective()
        ├── calls: this.service.getEffectiveBundle()
        │     └─ Service: IDocumentTemplateService [token: IDocumentTemplateService]
```

---

## Module: `entitlements` (12 routes)

### Controller: `EntitlementsAdminController`
**File:** [`src/modules/entitlements/entitlements-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/entitlements/entitlements-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/entitlements/enabled` | `getEnabled` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Read the global entitlements enforcement kill-switch (Q9). |
| `PUT` | `/api/v1/admin/entitlements/enabled` | `setEnabled` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Flip the global entitlements enforcement kill-switch (Q9). |
| `GET` | `/api/v1/admin/entitlements/plans` | `listPlans` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | List the per-plan default entitlement matrix. |
| `GET` | `/api/v1/admin/entitlements/plans/{plan}` | `getPlan` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Get a single plan default row. |
| `PATCH` | `/api/v1/admin/entitlements/plans/{plan}` | `updatePlan` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | Yes | Edit a plan default row. |
| `GET` | `/api/v1/admin/entitlements/tenants/{tenantId}` | `getTenantSnapshot` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Capability/usage snapshot for ANY tenant (super-admin view). |
| `POST` | `/api/v1/admin/entitlements/tenants/{tenantId}/downgrade` | `triggerDowngrade` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Downgrade a tenant plan (Q10). Plan change always applies; newest-first soft-disable of overflow rows runs only when enforcement is ON. |
| `DELETE` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | `clearOverride` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Clear a tenant override back to plan inheritance (nulls the row; reversible — never deleted). |
| `GET` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | `getOverride` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Get a tenant's entitlement override (null = inherits the plan default). |
| `PUT` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | `upsertOverride` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | Yes | Create-or-update a tenant override ("increase on demand", Q7). |
| `POST` | `/api/v1/admin/entitlements/trial-expiry/run` | `runTrialExpiry` | Perms: `manage:all`<br/>Svc: `svc:admin:entitlement:manage` | - | Manually run the trial-expiry sweep (Q4): downgrade every expired TRIAL tenant to STARTER, plan-only. |

#### Handler Call Trees:

**`GET /api/v1/admin/entitlements/enabled` → `EntitlementsAdminController.getEnabled`**
```text
[GET /api/v1/admin/entitlements/enabled]
  └── Controller: EntitlementsAdminController.getEnabled()
        ├── calls: this.entitlements.isEnforcementEnabled()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`PUT /api/v1/admin/entitlements/enabled` → `EntitlementsAdminController.setEnabled`**
```text
[PUT /api/v1/admin/entitlements/enabled]
  └── Controller: EntitlementsAdminController.setEnabled()
        ├── calls: this.entitlements.setEnforcementEnabled()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`GET /api/v1/admin/entitlements/plans` → `EntitlementsAdminController.listPlans`**
```text
[GET /api/v1/admin/entitlements/plans]
  └── Controller: EntitlementsAdminController.listPlans()
        ├── calls: this.entitlements.listPlanEntitlements()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`GET /api/v1/admin/entitlements/plans/{plan}` → `EntitlementsAdminController.getPlan`**
```text
[GET /api/v1/admin/entitlements/plans/{plan}]
  └── Controller: EntitlementsAdminController.getPlan()
        ├── calls: this.entitlements.getPlanEntitlement()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`PATCH /api/v1/admin/entitlements/plans/{plan}` → `EntitlementsAdminController.updatePlan`**
```text
[PATCH /api/v1/admin/entitlements/plans/{plan}]
  └── Controller: EntitlementsAdminController.updatePlan()
        ├── calls: this.entitlements.updatePlanEntitlement()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`GET /api/v1/admin/entitlements/tenants/{tenantId}` → `EntitlementsAdminController.getTenantSnapshot`**
```text
[GET /api/v1/admin/entitlements/tenants/{tenantId}]
  └── Controller: EntitlementsAdminController.getTenantSnapshot()
        ├── calls: this.entitlements.getCapabilities()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`POST /api/v1/admin/entitlements/tenants/{tenantId}/downgrade` → `EntitlementsAdminController.triggerDowngrade`**
```text
[POST /api/v1/admin/entitlements/tenants/{tenantId}/downgrade]
  └── Controller: EntitlementsAdminController.triggerDowngrade()
        ├── calls: this.lifecycle.triggerDowngrade()
        │     └─ Service: IEntitlementsLifecycleService [token: IEntitlementsLifecycleService]
```

**`GET /api/v1/admin/entitlements/tenants/{tenantId}/override` → `EntitlementsAdminController.getOverride`**
```text
[GET /api/v1/admin/entitlements/tenants/{tenantId}/override]
  └── Controller: EntitlementsAdminController.getOverride()
        ├── calls: this.entitlements.getTenantEntitlement()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`PUT /api/v1/admin/entitlements/tenants/{tenantId}/override` → `EntitlementsAdminController.upsertOverride`**
```text
[PUT /api/v1/admin/entitlements/tenants/{tenantId}/override]
  └── Controller: EntitlementsAdminController.upsertOverride()
        ├── calls: this.entitlements.upsertTenantEntitlement()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

**`POST /api/v1/admin/entitlements/trial-expiry/run` → `EntitlementsAdminController.runTrialExpiry`**
```text
[POST /api/v1/admin/entitlements/trial-expiry/run]
  └── Controller: EntitlementsAdminController.runTrialExpiry()
        ├── calls: this.lifecycle.expireTrials()
        │     └─ Service: IEntitlementsLifecycleService [token: IEntitlementsLifecycleService]
```

### Controller: `MyEntitlementsController`
**File:** [`src/modules/entitlements/my-entitlements.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/entitlements/my-entitlements.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me/entitlements` | `me` | Perms: `read:Tenant`<br/>API Key: `tenant:account:read` | - | Capability/usage snapshot for the caller's own tenant (limits, usage, meters, features, trial clock). |

#### Handler Call Trees:

**`GET /api/v1/tenants/me/entitlements` → `MyEntitlementsController.me`**
```text
[GET /api/v1/tenants/me/entitlements]
  └── Controller: MyEntitlementsController.me()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.entitlements.getCapabilities()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

---

## Module: `global-setting` (8 routes)

### Controller: `GlobalSettingController`
**File:** [`src/modules/global-setting/global-setting.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/global-setting/global-setting.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/settings` | `fetchAll` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Retrieving multiple GlobalSettingResponses |
| `POST` | `/api/v1/admin/settings` | `create` | Perms: `create:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Creating a GlobalSettingResponse |
| `DELETE` | `/api/v1/admin/settings/{id}` | `delete` | Perms: `delete:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Deleting a GlobalSettingResponse by id |
| `GET` | `/api/v1/admin/settings/{id}` | `fetchById` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Retrieving a single GlobalSettingResponse by id |
| `PATCH` | `/api/v1/admin/settings/{id}` | `update` | Perms: `update:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | Yes | Updating a GlobalSettingResponse by id |
| `POST` | `/api/v1/admin/settings/{id}/reveal` | `reveal` | Perms: `manage:all`<br/>Svc: `svc:admin:settings:manage` | - | Reveal a secret setting (super-admin, step-up re-auth, audited) |
| `POST` | `/api/v1/admin/settings/{id}/rotate` | `rotate` | Perms: `manage:all`<br/>Svc: `svc:admin:settings:manage` | Yes | Rotate a secret setting (super-admin, step-up re-auth, OCC, audited) |
| `GET` | `/api/v1/admin/settings/tenant/{tenantId}` | `fetchByTenant` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | List global settings for a specific tenant |

#### Handler Call Trees:

**`GET /api/v1/admin/settings` → `GlobalSettingController.fetchAll`**
```text
[GET /api/v1/admin/settings]
  └── Controller: GlobalSettingController.fetchAll()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.globalSettingService.fetchAllByTenantId()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
        ├── calls: this.globalSettingService.fetchAll()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`POST /api/v1/admin/settings` → `GlobalSettingController.create`**
```text
[POST /api/v1/admin/settings]
  └── Controller: GlobalSettingController.create()
        ├── calls: this.globalSettingService.create()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`DELETE /api/v1/admin/settings/{id}` → `GlobalSettingController.delete`**
```text
[DELETE /api/v1/admin/settings/{id}]
  └── Controller: GlobalSettingController.delete()
        ├── calls: this.globalSettingService.deleteById()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`GET /api/v1/admin/settings/{id}` → `GlobalSettingController.fetchById`**
```text
[GET /api/v1/admin/settings/{id}]
  └── Controller: GlobalSettingController.fetchById()
        ├── calls: this.globalSettingService.fetchById()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`PATCH /api/v1/admin/settings/{id}` → `GlobalSettingController.update`**
```text
[PATCH /api/v1/admin/settings/{id}]
  └── Controller: GlobalSettingController.update()
        ├── calls: this.globalSettingService.update()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`POST /api/v1/admin/settings/{id}/reveal` → `GlobalSettingController.reveal`**
```text
[POST /api/v1/admin/settings/{id}/reveal]
  └── Controller: GlobalSettingController.reveal()
        ├── calls: this.globalSettingService.revealSecret()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`POST /api/v1/admin/settings/{id}/rotate` → `GlobalSettingController.rotate`**
```text
[POST /api/v1/admin/settings/{id}/rotate]
  └── Controller: GlobalSettingController.rotate()
        ├── calls: this.globalSettingService.rotateSecret()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

**`GET /api/v1/admin/settings/tenant/{tenantId}` → `GlobalSettingController.fetchByTenant`**
```text
[GET /api/v1/admin/settings/tenant/{tenantId}]
  └── Controller: GlobalSettingController.fetchByTenant()
        ├── calls: this.globalSettingService.fetchAllByTenantId()
        │     └─ Service: IGlobalSettingService [token: IGlobalSettingService]
```

---

## Module: `governed-prompt` (1 routes)

### Controller: `GovernedPromptInternalController`
**File:** [`src/modules/governed-prompt/governed-prompt-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/governed-prompt/governed-prompt-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/governed-prompts/verify` | `verify` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/governed-prompts/verify` → `GovernedPromptInternalController.verify`**
```text
[POST /api/v1/internal/governed-prompts/verify]
  └── Controller: GovernedPromptInternalController.verify()
        ├── calls: this.registry.registerPlatformPieces()
        │     └─ Service: IGovernedPromptRegistry [token: IGovernedPromptRegistry]
        ├── calls: this.registry.areGoverned()
        │     └─ Service: IGovernedPromptRegistry [token: IGovernedPromptRegistry]
        ├── calls: this.registry.currentPolicyVersion()
        │     └─ Service: IGovernedPromptRegistry [token: IGovernedPromptRegistry]
```

---

## Module: `guardrail-availability` (4 routes)

### Controller: `GuardrailAvailabilityController`
**File:** [`src/modules/guardrail-availability/guardrail-availability.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-availability/guardrail-availability.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/guardrail/availability` | `list` | Perms: `read:Tenant` | - | List every tenant guardrail-availability row — SUPER_ADMIN only |
| `GET` | `/api/v1/admin/guardrail/availability/{tenantId}` | `getForTenant` | Perms: `read:Tenant` | - | Read one tenant's guardrail availability — SUPER_ADMIN only |
| `PUT` | `/api/v1/admin/guardrail/availability/{tenantId}` | `putForTenant` | Perms: `update:Tenant` | Yes | Replace one tenant's guardrail availability under optimistic concurrency — SUPER_ADMIN only |
| `GET` | `/api/v1/admin/guardrail/availability/catalogue` | `catalogue` | Perms: `read:Tenant` | - | List the selectable guardrail policies — SUPER_ADMIN only |

#### Handler Call Trees:

**`GET /api/v1/admin/guardrail/availability` → `GuardrailAvailabilityController.list`**
```text
[GET /api/v1/admin/guardrail/availability]
  └── Controller: GuardrailAvailabilityController.list()
        ├── calls: this.availabilityService.list()
        │     └─ Service: IGuardrailAvailabilityService [token: IGuardrailAvailabilityService]
```

**`GET /api/v1/admin/guardrail/availability/{tenantId}` → `GuardrailAvailabilityController.getForTenant`**
```text
[GET /api/v1/admin/guardrail/availability/{tenantId}]
  └── Controller: GuardrailAvailabilityController.getForTenant()
        ├── calls: this.availabilityService.getForTenant()
        │     └─ Service: IGuardrailAvailabilityService [token: IGuardrailAvailabilityService]
```

**`PUT /api/v1/admin/guardrail/availability/{tenantId}` → `GuardrailAvailabilityController.putForTenant`**
```text
[PUT /api/v1/admin/guardrail/availability/{tenantId}]
  └── Controller: GuardrailAvailabilityController.putForTenant()
        ├── calls: this.availabilityService.putForTenant()
        │     └─ Service: IGuardrailAvailabilityService [token: IGuardrailAvailabilityService]
```

**`GET /api/v1/admin/guardrail/availability/catalogue` → `GuardrailAvailabilityController.catalogue`**
```text
[GET /api/v1/admin/guardrail/availability/catalogue]
  └── Controller: GuardrailAvailabilityController.catalogue()
        ├── calls: this.availabilityService.catalogue()
        │     └─ Service: IGuardrailAvailabilityService [token: IGuardrailAvailabilityService]
```

---

## Module: `guardrail-evaluation-internal` (1 routes)

### Controller: `GuardrailEvaluationInternalController`
**File:** [`src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/guardrail/evaluations` | `ingest` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/guardrail/evaluations` → `GuardrailEvaluationInternalController.ingest`**
```text
[POST /api/v1/internal/guardrail/evaluations]
  └── Controller: GuardrailEvaluationInternalController.ingest()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.evaluations.ingest()
        │     └─ Service: GuardrailEvaluationIngestService
```

---

## Module: `guardrail-notice` (6 routes)

### Controller: `AdminGuardrailEvaluationController`
**File:** [`src/modules/guardrail-notice/admin-guardrail-evaluation.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-notice/admin-guardrail-evaluation.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/consultations/{id}/guardrail-evaluations` | `list` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | List a consultation`s guardrail evaluations |
| `GET` | `/api/v1/admin/consultations/{id}/guardrail-evaluations/{evaluationId}/withheld` | `withheld` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Read the output an outbound guardrail block withheld, decrypted |
| `GET` | `/api/v1/admin/consultations/{id}/guardrail-notices` | `notices` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | List a consultation`s guardrail notices (admin) |

#### Handler Call Trees:

**`GET /api/v1/admin/consultations/{id}/guardrail-evaluations/{evaluationId}/withheld` → `AdminGuardrailEvaluationController.withheld`**
```text
[GET /api/v1/admin/consultations/{id}/guardrail-evaluations/{evaluationId}/withheld]
  └── Controller: AdminGuardrailEvaluationController.withheld()
        ├── calls: this.evaluations.getWithheld()
        │     └─ Service: GuardrailEvaluationAdminService
```

### Controller: `GuardrailNoticeController`
**File:** [`src/modules/guardrail-notice/guardrail-notice.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-notice/guardrail-notice.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/consultations/{id}/guardrail-hold/resume` | `resume` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Resume a guardrail hold |
| `GET` | `/api/v1/consultations/{id}/guardrail-notices` | `list` | Auth<br/>API Key: `consultation:session:read`<br/>Svc: `svc:consultation:session:read` | - | The consultation`s guardrail notices |
| `POST` | `/api/v1/consultations/{id}/guardrail-notices/{noticeId}/ack` | `acknowledge` | Auth<br/>API Key: `consultation:session:write`<br/>Svc: `svc:consultation:session:write` | Yes | Acknowledge a guardrail notice |

#### Handler Call Trees:

**`POST /api/v1/consultations/{id}/guardrail-hold/resume` → `GuardrailNoticeController.resume`**
```text
[POST /api/v1/consultations/{id}/guardrail-hold/resume]
  └── Controller: GuardrailNoticeController.resume()
        ├── calls: this.access.assertWrite()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.notices.resumeHold()
        │     └─ Service: IGuardrailNoticeService [token: IGuardrailNoticeService]
        ├── calls: this.access.callerOf()
        │     └─ Service: ConsultationAccessHelper
```

**`GET /api/v1/consultations/{id}/guardrail-notices` → `GuardrailNoticeController.list`**
```text
[GET /api/v1/consultations/{id}/guardrail-notices]
  └── Controller: GuardrailNoticeController.list()
        ├── calls: this.access.assertRead()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.notices.list()
        │     └─ Service: IGuardrailNoticeService [token: IGuardrailNoticeService]
```

**`POST /api/v1/consultations/{id}/guardrail-notices/{noticeId}/ack` → `GuardrailNoticeController.acknowledge`**
```text
[POST /api/v1/consultations/{id}/guardrail-notices/{noticeId}/ack]
  └── Controller: GuardrailNoticeController.acknowledge()
        ├── calls: this.access.assertWrite()
        │     └─ Service: ConsultationAccessHelper
        ├── calls: this.notices.acknowledge()
        │     └─ Service: IGuardrailNoticeService [token: IGuardrailNoticeService]
        ├── calls: this.access.callerOf()
        │     └─ Service: ConsultationAccessHelper
```

---

## Module: `guardrail-policy` (17 routes)

### Controller: `GuardrailMetricsController`
**File:** [`src/modules/guardrail-policy/guardrail-metrics.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-policy/guardrail-metrics.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/guardrail/metrics/activity` | `activity` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Guardrail activity across tenants |
| `GET` | `/api/v1/admin/guardrail/metrics/evaluations` | `evaluations` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Guardrail evaluations (drill-down) |
| `GET` | `/api/v1/admin/guardrail/metrics/health` | `health` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Guardrail health |
| `GET` | `/api/v1/admin/guardrail/metrics/performance` | `performance` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Guardrail performance (fixed PromQL) |

#### Handler Call Trees:

**`GET /api/v1/admin/guardrail/metrics/activity` → `GuardrailMetricsController.activity`**
```text
[GET /api/v1/admin/guardrail/metrics/activity]
  └── Controller: GuardrailMetricsController.activity()
        ├── calls: this.service.activity()
        │     └─ Service: IGuardrailMonitoringService [token: IGuardrailMonitoringService]
```

**`GET /api/v1/admin/guardrail/metrics/health` → `GuardrailMetricsController.health`**
```text
[GET /api/v1/admin/guardrail/metrics/health]
  └── Controller: GuardrailMetricsController.health()
        ├── calls: this.service.health()
        │     └─ Service: IGuardrailMonitoringService [token: IGuardrailMonitoringService]
```

### Controller: `GuardrailPolicyController`
**File:** [`src/modules/guardrail-policy/guardrail-policy.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-policy/guardrail-policy.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/guardrail/dry-run` | `dryRun` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Dry-run draft judge configuration on samples against the live judge |
| `GET` | `/api/v1/admin/guardrail/judge-lanes` | `lanes` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | The judge model per safety-judge lane, with the selectable candidates |
| `PUT` | `/api/v1/admin/guardrail/judge-lanes` | `selectLanes` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Select the judge model for one or more lanes |
| `GET` | `/api/v1/admin/guardrail/judge-models/{modelId}/judge-meta` | `getJudgeMeta` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Read a judge model`s declaration and its default |
| `PUT` | `/api/v1/admin/guardrail/judge-models/{modelId}/judge-meta` | `updateJudgeMeta` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | Yes | Change a native guard`s category map and tier mapping |
| `POST` | `/api/v1/admin/guardrail/judge-models/{modelId}/judge-meta/reset` | `resetJudgeMeta` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Reset a native guard`s mapping to its default |
| `GET` | `/api/v1/admin/guardrail/policy-keys` | `list` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | List every governed guardrail policy key, grouped by its model row |
| `GET` | `/api/v1/admin/guardrail/policy-keys/{key}` | `get` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Read one guardrail policy key |
| `PUT` | `/api/v1/admin/guardrail/policy-keys/{key}` | `update` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | Yes | Change one guardrail policy key on its SYSTEM model row |
| `POST` | `/api/v1/admin/guardrail/policy-keys/{key}/reset` | `reset` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Reset one guardrail policy key to its default |
| `GET` | `/api/v1/admin/guardrail/policy-keys/{key}/revisions` | `revisions` | Perms: `read:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | A guardrail policy key`s revision history |
| `POST` | `/api/v1/admin/guardrail/policy-keys/{key}/revisions/{revisionId}/restore` | `restore` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Restore a guardrail policy key to an earlier revision |
| `POST` | `/api/v1/admin/guardrail/policy-keys/reset` | `resetLane` | Perms: `update:AiModel`<br/>Svc: `svc:admin:guardrail:manage` | - | Reset every editable key of one lane (model row) to its default |

#### Handler Call Trees:

**`POST /api/v1/admin/guardrail/dry-run` → `GuardrailPolicyController.dryRun`**
```text
[POST /api/v1/admin/guardrail/dry-run]
  └── Controller: GuardrailPolicyController.dryRun()
        ├── calls: this.service.dryRun()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`GET /api/v1/admin/guardrail/judge-lanes` → `GuardrailPolicyController.lanes`**
```text
[GET /api/v1/admin/guardrail/judge-lanes]
  └── Controller: GuardrailPolicyController.lanes()
        ├── calls: this.service.getJudgeLanes()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`PUT /api/v1/admin/guardrail/judge-lanes` → `GuardrailPolicyController.selectLanes`**
```text
[PUT /api/v1/admin/guardrail/judge-lanes]
  └── Controller: GuardrailPolicyController.selectLanes()
        ├── calls: this.service.updateJudgeLanes()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`GET /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta` → `GuardrailPolicyController.getJudgeMeta`**
```text
[GET /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta]
  └── Controller: GuardrailPolicyController.getJudgeMeta()
        ├── calls: this.service.getJudgeMeta()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`PUT /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta` → `GuardrailPolicyController.updateJudgeMeta`**
```text
[PUT /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta]
  └── Controller: GuardrailPolicyController.updateJudgeMeta()
        ├── calls: this.service.updateJudgeMeta()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`POST /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta/reset` → `GuardrailPolicyController.resetJudgeMeta`**
```text
[POST /api/v1/admin/guardrail/judge-models/{modelId}/judge-meta/reset]
  └── Controller: GuardrailPolicyController.resetJudgeMeta()
        ├── calls: this.service.resetJudgeMeta()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`GET /api/v1/admin/guardrail/policy-keys` → `GuardrailPolicyController.list`**
```text
[GET /api/v1/admin/guardrail/policy-keys]
  └── Controller: GuardrailPolicyController.list()
        ├── calls: this.service.listPolicyKeys()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`GET /api/v1/admin/guardrail/policy-keys/{key}` → `GuardrailPolicyController.get`**
```text
[GET /api/v1/admin/guardrail/policy-keys/{key}]
  └── Controller: GuardrailPolicyController.get()
        ├── calls: this.service.getPolicyKey()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`PUT /api/v1/admin/guardrail/policy-keys/{key}` → `GuardrailPolicyController.update`**
```text
[PUT /api/v1/admin/guardrail/policy-keys/{key}]
  └── Controller: GuardrailPolicyController.update()
        ├── calls: this.service.updatePolicyKey()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`POST /api/v1/admin/guardrail/policy-keys/{key}/reset` → `GuardrailPolicyController.reset`**
```text
[POST /api/v1/admin/guardrail/policy-keys/{key}/reset]
  └── Controller: GuardrailPolicyController.reset()
        ├── calls: this.service.resetPolicyKey()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`GET /api/v1/admin/guardrail/policy-keys/{key}/revisions` → `GuardrailPolicyController.revisions`**
```text
[GET /api/v1/admin/guardrail/policy-keys/{key}/revisions]
  └── Controller: GuardrailPolicyController.revisions()
        ├── calls: this.service.listRevisions()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`POST /api/v1/admin/guardrail/policy-keys/{key}/revisions/{revisionId}/restore` → `GuardrailPolicyController.restore`**
```text
[POST /api/v1/admin/guardrail/policy-keys/{key}/revisions/{revisionId}/restore]
  └── Controller: GuardrailPolicyController.restore()
        ├── calls: this.service.restoreRevision()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

**`POST /api/v1/admin/guardrail/policy-keys/reset` → `GuardrailPolicyController.resetLane`**
```text
[POST /api/v1/admin/guardrail/policy-keys/reset]
  └── Controller: GuardrailPolicyController.resetLane()
        ├── calls: this.service.resetLane()
        │     └─ Service: IGuardrailPolicyService [token: IGuardrailPolicyService]
```

---

## Module: `guardrail-tenant-policy` (3 routes)

### Controller: `GuardrailRuleTestController`
**File:** [`src/modules/guardrail-tenant-policy/guardrail-rule-test.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-tenant-policy/guardrail-rule-test.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/guardrail/screen` | `screen` | Perms: `read:TenantGuardrailPolicy` | - | Screen text under the working tenant's guardrail rules (Test my rules) |

#### Handler Call Trees:

**`POST /api/v1/admin/guardrail/screen` → `GuardrailRuleTestController.screen`**
```text
[POST /api/v1/admin/guardrail/screen]
  └── Controller: GuardrailRuleTestController.screen()
        ├── calls: this.ruleTest.screen()
        │     └─ Service: IGuardrailRuleTestService [token: IGuardrailRuleTestService]
```

### Controller: `GuardrailTenantPolicyController`
**File:** [`src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/guardrail/policy` | `get` | Perms: `read:TenantGuardrailPolicy` | - | Read the working tenant's guardrail rules |
| `PUT` | `/api/v1/admin/guardrail/policy` | `put` | Perms: `manage:TenantGuardrailPolicy` | Yes | Turn the working tenant's guardrail checks and screening directions on or off |

#### Handler Call Trees:

**`GET /api/v1/admin/guardrail/policy` → `GuardrailTenantPolicyController.get`**
```text
[GET /api/v1/admin/guardrail/policy]
  └── Controller: GuardrailTenantPolicyController.get()
        ├── calls: this.policyService.getOwn()
        │     └─ Service: IGuardrailTenantPolicyService [token: IGuardrailTenantPolicyService]
```

**`PUT /api/v1/admin/guardrail/policy` → `GuardrailTenantPolicyController.put`**
```text
[PUT /api/v1/admin/guardrail/policy]
  └── Controller: GuardrailTenantPolicyController.put()
        ├── calls: this.policyService.putOwn()
        │     └─ Service: IGuardrailTenantPolicyService [token: IGuardrailTenantPolicyService]
```

---

## Module: `harness-admin` (29 routes)

### Controller: `HarnessAdminController`
**File:** [`src/modules/harness-admin/harness-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/harness-admin/harness-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/harness/audit` | `listAudit` | Perms: `read:HarnessAudit`<br/>Svc: `svc:admin:harness:manage` | - | List the WORM audit trail (newest-first) + the chain-integrity verdict |
| `GET` | `/api/v1/admin/harness/edit-burden` | `getEditBurden` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Derived clinician edit-burden telemetry for one consultation (edit distance, deferral rate, time-to-sign) |
| `GET` | `/api/v1/admin/harness/eval-runs` | `listEvalRuns` | Perms: `read:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | List eval runs (newest-first) |
| `GET` | `/api/v1/admin/harness/eval-runs/{id}` | `getEvalRun` | Perms: `read:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | Get one eval run with its per-case scores |
| `GET` | `/api/v1/admin/harness/gate-edit-exemplars` | `exportGateEditExemplars` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Export gate-edit exemplar candidates for eval regression-corpus review |
| `PATCH` | `/api/v1/admin/harness/gate-edit-exemplars/{id}/curation` | `curateGateEditExemplar` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Record the human curation verdict on one mined gate-edit exemplar |
| `POST` | `/api/v1/admin/harness/gate-edit-exemplars/{id}/promote-to-golden-set` | `promoteExemplarToGoldenSet` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Promote a curator-APPROVED gate-edit exemplar into a golden case |
| `GET` | `/api/v1/admin/harness/gate-edit-exemplars/fine-tuning-export` | `exportGateEditFineTuningDataset` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Export the curator-APPROVED gate-edit corpus as a JSONL fine-tuning dataset |
| `GET` | `/api/v1/admin/harness/gate-queue` | `gateQueue` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | List consultations awaiting clinician review with SLA/escalation from the effective policy |
| `GET` | `/api/v1/admin/harness/golden-sets` | `listGoldenSets` | Perms: `read:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | List golden sets (newest-first) |
| `POST` | `/api/v1/admin/harness/golden-sets` | `createGoldenSet` | Perms: `manage:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | Create a golden set for the caller tenant |
| `GET` | `/api/v1/admin/harness/golden-sets/{id}` | `getGoldenSet` | Perms: `read:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | Get one golden set |
| `GET` | `/api/v1/admin/harness/golden-sets/{id}/cases` | `listGoldenCases` | Perms: `read:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | List a golden set's cases — PHI-safe metadata only |
| `POST` | `/api/v1/admin/harness/golden-sets/{id}/cases` | `createGoldenCase` | Perms: `manage:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | Add a case to a golden set (PHI encrypted at rest, write-only) |
| `POST` | `/api/v1/admin/harness/golden-sets/{id}/run` | `runGoldenSet` | Perms: `manage:HarnessEval`<br/>Svc: `svc:admin:harness:manage` | - | Run an eval over a golden set now (synchronous) |
| `GET` | `/api/v1/admin/harness/live/capabilities` | `getRealtimeCapabilities` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Read which realtime consultation capabilities are live for a tenant (lane source, definition, per-node state) |
| `GET` | `/api/v1/admin/harness/live/config` | `getLiveConfig` | Perms: `read:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Read the live-documentation engine kill-switch (super-admin / global scope) |
| `PATCH` | `/api/v1/admin/harness/live/config` | `updateLiveConfig` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Toggle the live-documentation engine kill-switch (super-admin / global scope) |
| `GET` | `/api/v1/admin/harness/live/sessions` | `listLiveSessions` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | List the active live-documentation sessions (PHI-safe stats) for the caller tenant |
| `GET` | `/api/v1/admin/harness/live/sessions/{id}` | `getLiveSession` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Get one live-documentation session's latest PHI-safe stats |
| `GET` | `/api/v1/admin/harness/policy` | `getPolicy` | Perms: `read:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Get the caller tenant's effective harness policy (tenant row over global default over code default) |
| `PATCH` | `/api/v1/admin/harness/policy` | `updatePolicy` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | Yes | Update the caller tenant's harness policy (created on first edit) |
| `GET` | `/api/v1/admin/harness/policy/global` | `getGlobalPolicy` | Perms: `read:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | - | Get the platform GLOBAL-DEFAULT harness policy (super-admin only) |
| `PATCH` | `/api/v1/admin/harness/policy/global` | `updateGlobalPolicy` | Perms: `manage:HarnessPolicy`<br/>Svc: `svc:admin:harness:manage` | Yes | Update the platform GLOBAL-DEFAULT harness policy (super-admin only) |
| `GET` | `/api/v1/admin/harness/workflows` | `listWorkflows` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | List harness Temporal document workflows (tenant-filtered) |
| `GET` | `/api/v1/admin/harness/workflows/{id}` | `describeWorkflow` | Perms: `read:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Describe one harness workflow (add ?phase=true for the loop phase) |
| `POST` | `/api/v1/admin/harness/workflows/{id}/cancel` | `cancelWorkflow` | Perms: `manage:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Cancel a harness workflow (graceful). Tenant admins limited to their own tenant. |
| `POST` | `/api/v1/admin/harness/workflows/{id}/signal` | `signalWorkflow` | Perms: `manage:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Send a signal to a harness workflow. Tenant admins limited to their own tenant. |
| `POST` | `/api/v1/admin/harness/workflows/{id}/terminate` | `terminateWorkflow` | Perms: `manage:HarnessWorkflow`<br/>Svc: `svc:admin:harness:manage` | - | Terminate a harness workflow (forceful). Tenant admins limited to their own tenant. |

#### Handler Call Trees:

**`GET /api/v1/admin/harness/audit` → `HarnessAdminController.listAudit`**
```text
[GET /api/v1/admin/harness/audit]
  └── Controller: HarnessAdminController.listAudit()
        ├── calls: this.observabilityService.listAuditEvents()
        │     └─ Service: HarnessObservabilityService
```

**`GET /api/v1/admin/harness/eval-runs` → `HarnessAdminController.listEvalRuns`**
```text
[GET /api/v1/admin/harness/eval-runs]
  └── Controller: HarnessAdminController.listEvalRuns()
        ├── calls: this.observabilityService.listEvalRuns()
        │     └─ Service: HarnessObservabilityService
```

**`GET /api/v1/admin/harness/eval-runs/{id}` → `HarnessAdminController.getEvalRun`**
```text
[GET /api/v1/admin/harness/eval-runs/{id}]
  └── Controller: HarnessAdminController.getEvalRun()
        ├── calls: this.observabilityService.getEvalRun()
        │     └─ Service: HarnessObservabilityService
```

**`GET /api/v1/admin/harness/gate-edit-exemplars` → `HarnessAdminController.exportGateEditExemplars`**
```text
[GET /api/v1/admin/harness/gate-edit-exemplars]
  └── Controller: HarnessAdminController.exportGateEditExemplars()
        ├── calls: this.gateEditMiningService.exportCorpusCandidates()
        │     └─ Service: GateEditMiningService
```

**`PATCH /api/v1/admin/harness/gate-edit-exemplars/{id}/curation` → `HarnessAdminController.curateGateEditExemplar`**
```text
[PATCH /api/v1/admin/harness/gate-edit-exemplars/{id}/curation]
  └── Controller: HarnessAdminController.curateGateEditExemplar()
        ├── calls: this.gateEditMiningService.curateExemplar()
        │     └─ Service: GateEditMiningService
```

**`GET /api/v1/admin/harness/gate-edit-exemplars/fine-tuning-export` → `HarnessAdminController.exportGateEditFineTuningDataset`**
```text
[GET /api/v1/admin/harness/gate-edit-exemplars/fine-tuning-export]
  └── Controller: HarnessAdminController.exportGateEditFineTuningDataset()
        ├── calls: this.gateEditMiningService.exportFineTuningDataset()
        │     └─ Service: GateEditMiningService
        ├── calls: this.gateEditMiningService.toJsonl()
        │     └─ Service: GateEditMiningService
```

**`GET /api/v1/admin/harness/gate-queue` → `HarnessAdminController.gateQueue`**
```text
[GET /api/v1/admin/harness/gate-queue]
  └── Controller: HarnessAdminController.gateQueue()
        ├── calls: this.observabilityService.gateQueue()
        │     └─ Service: HarnessObservabilityService
```

**`GET /api/v1/admin/harness/golden-sets` → `HarnessAdminController.listGoldenSets`**
```text
[GET /api/v1/admin/harness/golden-sets]
  └── Controller: HarnessAdminController.listGoldenSets()
        ├── calls: this.evalService.listGoldenSets()
        │     └─ Service: EvalService
```

**`POST /api/v1/admin/harness/golden-sets` → `HarnessAdminController.createGoldenSet`**
```text
[POST /api/v1/admin/harness/golden-sets]
  └── Controller: HarnessAdminController.createGoldenSet()
        ├── calls: this.evalService.addGoldenSet()
        │     └─ Service: EvalService
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/harness/golden-sets/{id}` → `HarnessAdminController.getGoldenSet`**
```text
[GET /api/v1/admin/harness/golden-sets/{id}]
  └── Controller: HarnessAdminController.getGoldenSet()
        ├── calls: this.evalService.getGoldenSet()
        │     └─ Service: EvalService
```

**`GET /api/v1/admin/harness/golden-sets/{id}/cases` → `HarnessAdminController.listGoldenCases`**
```text
[GET /api/v1/admin/harness/golden-sets/{id}/cases]
  └── Controller: HarnessAdminController.listGoldenCases()
        ├── calls: this.evalService.listGoldenCases()
        │     └─ Service: EvalService
```

**`POST /api/v1/admin/harness/golden-sets/{id}/cases` → `HarnessAdminController.createGoldenCase`**
```text
[POST /api/v1/admin/harness/golden-sets/{id}/cases]
  └── Controller: HarnessAdminController.createGoldenCase()
        ├── calls: this.evalService.addGoldenCase()
        │     └─ Service: EvalService
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/harness/golden-sets/{id}/run` → `HarnessAdminController.runGoldenSet`**
```text
[POST /api/v1/admin/harness/golden-sets/{id}/run]
  └── Controller: HarnessAdminController.runGoldenSet()
        ├── calls: this.evalRunService.runGoldenSet()
        │     └─ Service: EvalRunService
```

**`GET /api/v1/admin/harness/live/capabilities` → `HarnessAdminController.getRealtimeCapabilities`**
```text
[GET /api/v1/admin/harness/live/capabilities]
  └── Controller: HarnessAdminController.getRealtimeCapabilities()
        ├── calls: this.liveDocumentationService.getRealtimeCapabilities()
        │     └─ Service: LiveDocumentationService
```

**`GET /api/v1/admin/harness/live/config` → `HarnessAdminController.getLiveConfig`**
```text
[GET /api/v1/admin/harness/live/config]
  └── Controller: HarnessAdminController.getLiveConfig()
        ├── calls: this.liveDocumentationService.getEngineConfig()
        │     └─ Service: LiveDocumentationService
```

**`PATCH /api/v1/admin/harness/live/config` → `HarnessAdminController.updateLiveConfig`**
```text
[PATCH /api/v1/admin/harness/live/config]
  └── Controller: HarnessAdminController.updateLiveConfig()
        ├── calls: this.liveDocumentationService.setEngineEnabled()
        │     └─ Service: LiveDocumentationService
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/harness/live/sessions` → `HarnessAdminController.listLiveSessions`**
```text
[GET /api/v1/admin/harness/live/sessions]
  └── Controller: HarnessAdminController.listLiveSessions()
        ├── calls: this.liveDocumentationService.getActiveSessions()
        │     └─ Service: LiveDocumentationService
```

**`GET /api/v1/admin/harness/live/sessions/{id}` → `HarnessAdminController.getLiveSession`**
```text
[GET /api/v1/admin/harness/live/sessions/{id}]
  └── Controller: HarnessAdminController.getLiveSession()
        ├── calls: this.liveDocumentationService.getSessionStats()
        │     └─ Service: LiveDocumentationService
```

**`GET /api/v1/admin/harness/policy` → `HarnessAdminController.getPolicy`**
```text
[GET /api/v1/admin/harness/policy]
  └── Controller: HarnessAdminController.getPolicy()
        ├── calls: this.policyService.getEffectivePolicy()
        │     └─ Service: HarnessPolicyService
```

**`PATCH /api/v1/admin/harness/policy` → `HarnessAdminController.updatePolicy`**
```text
[PATCH /api/v1/admin/harness/policy]
  └── Controller: HarnessAdminController.updatePolicy()
        ├── calls: this.policyService.updatePolicy()
        │     └─ Service: HarnessPolicyService
```

**`GET /api/v1/admin/harness/policy/global` → `HarnessAdminController.getGlobalPolicy`**
```text
[GET /api/v1/admin/harness/policy/global]
  └── Controller: HarnessAdminController.getGlobalPolicy()
        ├── calls: this.policyService.getGlobalDefault()
        │     └─ Service: HarnessPolicyService
```

**`PATCH /api/v1/admin/harness/policy/global` → `HarnessAdminController.updateGlobalPolicy`**
```text
[PATCH /api/v1/admin/harness/policy/global]
  └── Controller: HarnessAdminController.updateGlobalPolicy()
        ├── calls: this.policyService.updateGlobalDefault()
        │     └─ Service: HarnessPolicyService
```

**`GET /api/v1/admin/harness/workflows` → `HarnessAdminController.listWorkflows`**
```text
[GET /api/v1/admin/harness/workflows]
  └── Controller: HarnessAdminController.listWorkflows()
        ├── calls: this.opsClient.listWorkflows()
        │     └─ Service: HarnessOpsClient
```

**`GET /api/v1/admin/harness/workflows/{id}` → `HarnessAdminController.describeWorkflow`**
```text
[GET /api/v1/admin/harness/workflows/{id}]
  └── Controller: HarnessAdminController.describeWorkflow()
        ├── calls: this.opsClient.describeWorkflow()
        │     └─ Service: HarnessOpsClient
```

**`POST /api/v1/admin/harness/workflows/{id}/cancel` → `HarnessAdminController.cancelWorkflow`**
```text
[POST /api/v1/admin/harness/workflows/{id}/cancel]
  └── Controller: HarnessAdminController.cancelWorkflow()
        ├── calls: this.opsClient.cancelWorkflow()
        │     └─ Service: HarnessOpsClient
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/harness/workflows/{id}/signal` → `HarnessAdminController.signalWorkflow`**
```text
[POST /api/v1/admin/harness/workflows/{id}/signal]
  └── Controller: HarnessAdminController.signalWorkflow()
        ├── calls: this.opsClient.signalWorkflow()
        │     └─ Service: HarnessOpsClient
```

**`POST /api/v1/admin/harness/workflows/{id}/terminate` → `HarnessAdminController.terminateWorkflow`**
```text
[POST /api/v1/admin/harness/workflows/{id}/terminate]
  └── Controller: HarnessAdminController.terminateWorkflow()
        ├── calls: this.opsClient.terminateWorkflow()
        │     └─ Service: HarnessOpsClient
```

---

## Module: `health` (6 routes)

### Controller: `AdminHealthServicesController`
**File:** [`src/modules/health/admin-health-services.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/health/admin-health-services.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/health/services` | `checkServices` | Perms: `manage:all:read:TenantTelemetry` | - | Consolidated health check for all downstream microservices (admin only) |
| `GET` | `/api/v1/admin/health/services/{serviceKey}` | `checkServiceByKey` | Perms: `manage:all:read:TenantTelemetry` | - | Health check for a single downstream microservice (admin only) |

#### Handler Call Trees:

**`GET /api/v1/admin/health/services` → `AdminHealthServicesController.checkServices`**
```text
[GET /api/v1/admin/health/services]
  └── Controller: AdminHealthServicesController.checkServices()
        ├── calls: this.downstreamServices.map()
        │     └─ Service: unknown
        ├── calls: this.downstreamServices.forEach()
        │     └─ Service: unknown
```

### Controller: `ApiHealthController`
**File:** [`src/modules/health/health.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/health/health.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/health` | `check` | Public | - | Detailed health check |
| `GET` | `/api/v1/health/live` | `liveness` | Public | - | Liveness probe - is the process running? |
| `GET` | `/api/v1/health/ready` | `readiness` | Public | - | Readiness probe - is the service ready for traffic? |
| `GET` | `/api/v1/health/startup` | `startup` | Public | - | Startup probe - has the service finished initialization? |

#### Handler Call Trees:

**`GET /api/v1/health` → `ApiHealthController.check`**
```text
[GET /api/v1/health]
  └── Controller: ApiHealthController.check()
        ├── calls: this.buildInfoService.getBuildInfo()
        │     └─ Service: BuildInfoService
```

---

## Module: `inference-engines` (3 routes)

### Controller: `InferenceEnginesController`
**File:** [`src/modules/inference-engines/inference-engines.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/inference-engines/inference-engines.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/inference-engines/lm-studio/models/{identifier}/unload` | `unload` | Perms: `manage:AiModel`<br/>Svc: `svc:admin:ai-model:manage` | - | Evict one loaded instance (ADVISORY — JIT reloads it) |
| `POST` | `/api/v1/admin/inference-engines/lm-studio/models/{modelKey}/load` | `load` | Perms: `manage:AiModel`<br/>Svc: `svc:admin:ai-model:manage` | - | Load one model on the LM Studio engine (REST v1), or report the instance already holding it |
| `GET` | `/api/v1/admin/inference-engines/lm-studio/runtime` | `runtime` | Perms: `manage:AiModel`<br/>Svc: `svc:admin:ai-model:manage` | - | Read what the LM Studio engine is currently serving, and on what VRAM |

#### Handler Call Trees:

**`POST /api/v1/admin/inference-engines/lm-studio/models/{identifier}/unload` → `InferenceEnginesController.unload`**
```text
[POST /api/v1/admin/inference-engines/lm-studio/models/{identifier}/unload]
  └── Controller: InferenceEnginesController.unload()
        ├── calls: this.service.unload()
        │     └─ Service: IInferenceEngineService [token: IInferenceEngineService]
```

**`POST /api/v1/admin/inference-engines/lm-studio/models/{modelKey}/load` → `InferenceEnginesController.load`**
```text
[POST /api/v1/admin/inference-engines/lm-studio/models/{modelKey}/load]
  └── Controller: InferenceEnginesController.load()
        ├── calls: this.service.load()
        │     └─ Service: IInferenceEngineService [token: IInferenceEngineService]
```

**`GET /api/v1/admin/inference-engines/lm-studio/runtime` → `InferenceEnginesController.runtime`**
```text
[GET /api/v1/admin/inference-engines/lm-studio/runtime]
  └── Controller: InferenceEnginesController.runtime()
        ├── calls: this.service.runtime()
        │     └─ Service: IInferenceEngineService [token: IInferenceEngineService]
```

---

## Module: `internal` (20 routes)

### Controller: `AgentInternalController`
**File:** [`src/modules/internal/agent-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/agent-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/agents/asr-spec` | `asrSpec` | Public | - | - |
| `GET` | `/api/v1/internal/agents/resolve` | `resolve` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/agents/asr-spec` → `AgentInternalController.asrSpec`**
```text
[GET /api/v1/internal/agents/asr-spec]
  └── Controller: AgentInternalController.asrSpec()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/internal/agents/resolve` → `AgentInternalController.resolve`**
```text
[GET /api/v1/internal/agents/resolve]
  └── Controller: AgentInternalController.resolve()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.resolver.resolve()
        │     └─ Service: AgentResolverService
        ├── calls: this.textAgents.resolveFromAgent()
        │     └─ Service: TextAgentResolverService
```

### Controller: `AgentVersionInternalController`
**File:** [`src/modules/internal/agent-version-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/agent-version-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/agents/{slug}/versions/{versionNumber}/resolved` | `resolveVersion` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/agents/{slug}/versions/{versionNumber}/resolved` → `AgentVersionInternalController.resolveVersion`**
```text
[GET /api/v1/internal/agents/{slug}/versions/{versionNumber}/resolved]
  └── Controller: AgentVersionInternalController.resolveVersion()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.versions.resolveVersion()
        │     └─ Service: AgentVersionResolverService
        ├── calls: this.textAgents.resolveFromAgent()
        │     └─ Service: TextAgentResolverService
```

### Controller: `ComposedPromptInternalController`
**File:** [`src/modules/internal/composed-prompt-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/composed-prompt-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/composed-prompts` | `record` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/composed-prompts` → `ComposedPromptInternalController.record`**
```text
[POST /api/v1/internal/composed-prompts]
  └── Controller: ComposedPromptInternalController.record()
        ├── calls: this.composedPrompts.acceptInternal()
        │     └─ Service: IComposedPromptService [token: IComposedPromptService]
```

### Controller: `EffectiveConfigController`
**File:** [`src/modules/internal/effective-config.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/effective-config.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/effective-config` | `getEffectiveConfig` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/effective-config` → `EffectiveConfigController.getEffectiveConfig`**
```text
[GET /api/v1/internal/effective-config]
  └── Controller: EffectiveConfigController.getEffectiveConfig()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.effectiveConfig.resolveForService()
        │     └─ Service: IEffectiveConfigService [token: IEffectiveConfigService]
```

### Controller: `ModelRegistryInternalController`
**File:** [`src/modules/internal/model-registry-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/model-registry-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/model-registry-credential` | `getModelRegistryCredential` | Public | - | - |

#### Handler Call Trees:

_Handlers in this controller delegate directly or return static/mapped payloads._

### Controller: `ModelServingInternalController`
**File:** [`src/modules/internal/model-serving-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/model-serving-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/models/{slug}/serving-spec` | `servingSpec` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/models/{slug}/serving-spec` → `ModelServingInternalController.servingSpec`**
```text
[GET /api/v1/internal/models/{slug}/serving-spec]
  └── Controller: ModelServingInternalController.servingSpec()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.servingSpecs.resolve()
        │     └─ Service: IModelServingSpecService [token: IModelServingSpecService]
```

### Controller: `SttInternalController`
**File:** [`src/modules/internal/stt-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/stt-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/stt/audio-records` | `createAudioRecord` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `PATCH` | `/api/v1/internal/stt/jobs/{id}/complete` | `completeJob` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `PATCH` | `/api/v1/internal/stt/jobs/{id}/fail` | `failJob` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `PATCH` | `/api/v1/internal/stt/jobs/{id}/progress` | `updateProgress` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `PATCH` | `/api/v1/internal/stt/jobs/{id}/start` | `startJob` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `GET` | `/api/v1/internal/stt/jobs/{id}/status` | `getJobStatus` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `POST` | `/api/v1/internal/stt/media` | `createMedia` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `GET` | `/api/v1/internal/stt/model-registry-credential` | `getModelRegistryCredential` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `GET` | `/api/v1/internal/stt/provider-overrides` | `getProviderOverrides` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `POST` | `/api/v1/internal/stt/segments` | `ingestSegments` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `POST` | `/api/v1/internal/stt/streaming/usage` | `recordStreamingUsage` | Auth<br/>API Key: `internal:stt:worker` | - | - |
| `POST` | `/api/v1/internal/stt/transcripts` | `createTranscript` | Auth<br/>API Key: `internal:stt:worker` | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/stt/audio-records` → `SttInternalController.createAudioRecord`**
```text
[POST /api/v1/internal/stt/audio-records]
  └── Controller: SttInternalController.createAudioRecord()
        ├── calls: this.sttInternalService.createAudioRecord()
        │     └─ Service: SttInternalService
```

**`PATCH /api/v1/internal/stt/jobs/{id}/complete` → `SttInternalController.completeJob`**
```text
[PATCH /api/v1/internal/stt/jobs/{id}/complete]
  └── Controller: SttInternalController.completeJob()
        ├── calls: this.sttInternalService.completeJob()
        │     └─ Service: SttInternalService
```

**`PATCH /api/v1/internal/stt/jobs/{id}/fail` → `SttInternalController.failJob`**
```text
[PATCH /api/v1/internal/stt/jobs/{id}/fail]
  └── Controller: SttInternalController.failJob()
        ├── calls: this.sttInternalService.failJob()
        │     └─ Service: SttInternalService
```

**`PATCH /api/v1/internal/stt/jobs/{id}/progress` → `SttInternalController.updateProgress`**
```text
[PATCH /api/v1/internal/stt/jobs/{id}/progress]
  └── Controller: SttInternalController.updateProgress()
        ├── calls: this.sttInternalService.updateProgress()
        │     └─ Service: SttInternalService
```

**`PATCH /api/v1/internal/stt/jobs/{id}/start` → `SttInternalController.startJob`**
```text
[PATCH /api/v1/internal/stt/jobs/{id}/start]
  └── Controller: SttInternalController.startJob()
        ├── calls: this.sttInternalService.startJob()
        │     └─ Service: SttInternalService
```

**`GET /api/v1/internal/stt/jobs/{id}/status` → `SttInternalController.getJobStatus`**
```text
[GET /api/v1/internal/stt/jobs/{id}/status]
  └── Controller: SttInternalController.getJobStatus()
        ├── calls: this.sttInternalService.getJobStatus()
        │     └─ Service: SttInternalService
```

**`POST /api/v1/internal/stt/media` → `SttInternalController.createMedia`**
```text
[POST /api/v1/internal/stt/media]
  └── Controller: SttInternalController.createMedia()
        ├── calls: this.sttInternalService.createMedia()
        │     └─ Service: SttInternalService
```

**`GET /api/v1/internal/stt/provider-overrides` → `SttInternalController.getProviderOverrides`**
```text
[GET /api/v1/internal/stt/provider-overrides]
  └── Controller: SttInternalController.getProviderOverrides()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/internal/stt/transcripts` → `SttInternalController.createTranscript`**
```text
[POST /api/v1/internal/stt/transcripts]
  └── Controller: SttInternalController.createTranscript()
        ├── calls: this.sttInternalService.createTranscript()
        │     └─ Service: SttInternalService
```

### Controller: `SttSessionTranscriptInternalController`
**File:** [`src/modules/internal/stt-session-transcript-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/stt-session-transcript-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/internal/stt/sessions/{sessionId}/transcript` | `transcript` | Public | - | - |

#### Handler Call Trees:

**`GET /api/v1/internal/stt/sessions/{sessionId}/transcript` → `SttSessionTranscriptInternalController.transcript`**
```text
[GET /api/v1/internal/stt/sessions/{sessionId}/transcript]
  └── Controller: SttSessionTranscriptInternalController.transcript()
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.transcripts.read()
        │     └─ Service: RunAudioTranscriptService
```

---

## Module: `knowledge` (5 routes)

### Controller: `KnowledgeController`
**File:** [`src/modules/knowledge/knowledge.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/knowledge/knowledge.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/knowledge/documents` | `list` | Perms: `manage:KnowledgeDocument`<br/>Svc: `svc:admin:knowledge:manage` | - | Paginated list of the caller tenant's institutional-knowledge documents |
| `DELETE` | `/api/v1/admin/knowledge/documents/{id}` | `deleteById` | Perms: `manage:KnowledgeDocument`<br/>Svc: `svc:admin:knowledge:manage` | - | Soft-delete a document and remove its vectors from Qdrant |
| `GET` | `/api/v1/admin/knowledge/documents/{id}` | `getById` | Perms: `manage:KnowledgeDocument`<br/>Svc: `svc:admin:knowledge:manage` | - | Get one knowledge document by id |
| `POST` | `/api/v1/admin/knowledge/documents/{id}/archive` | `archive` | Perms: `manage:KnowledgeDocument`<br/>Svc: `svc:admin:knowledge:manage` | - | Archive a document (status -> ARCHIVED) |
| `GET` | `/api/v1/admin/knowledge/documents/{id}/chunks` | `listChunks` | Perms: `read:KnowledgeDocument`<br/>Svc: `svc:admin:knowledge:manage` | - | Paginated, decrypted chunk content for one document, ordered by chunkIndex |

#### Handler Call Trees:

**`GET /api/v1/admin/knowledge/documents` → `KnowledgeController.list`**
```text
[GET /api/v1/admin/knowledge/documents]
  └── Controller: KnowledgeController.list()
        ├── calls: this.service.listDocuments()
        │     └─ Service: IKnowledgeDocumentService [token: IKnowledgeDocumentService]
```

**`DELETE /api/v1/admin/knowledge/documents/{id}` → `KnowledgeController.deleteById`**
```text
[DELETE /api/v1/admin/knowledge/documents/{id}]
  └── Controller: KnowledgeController.deleteById()
        ├── calls: this.service.deleteDocument()
        │     └─ Service: IKnowledgeDocumentService [token: IKnowledgeDocumentService]
```

**`GET /api/v1/admin/knowledge/documents/{id}` → `KnowledgeController.getById`**
```text
[GET /api/v1/admin/knowledge/documents/{id}]
  └── Controller: KnowledgeController.getById()
        ├── calls: this.service.getDocument()
        │     └─ Service: IKnowledgeDocumentService [token: IKnowledgeDocumentService]
```

**`POST /api/v1/admin/knowledge/documents/{id}/archive` → `KnowledgeController.archive`**
```text
[POST /api/v1/admin/knowledge/documents/{id}/archive]
  └── Controller: KnowledgeController.archive()
        ├── calls: this.service.archiveDocument()
        │     └─ Service: IKnowledgeDocumentService [token: IKnowledgeDocumentService]
```

**`GET /api/v1/admin/knowledge/documents/{id}/chunks` → `KnowledgeController.listChunks`**
```text
[GET /api/v1/admin/knowledge/documents/{id}/chunks]
  └── Controller: KnowledgeController.listChunks()
        ├── calls: this.service.listChunks()
        │     └─ Service: IKnowledgeDocumentService [token: IKnowledgeDocumentService]
```

---

## Module: `mcp-admin` (5 routes)

### Controller: `McpAdminController`
**File:** [`src/modules/mcp-admin/mcp-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/mcp-admin/mcp-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/mcp-servers` | `list` | Perms: `read:McpServer`<br/>Svc: `svc:admin:mcp-server:manage` | - | List registered MCP external-tools servers (registry read — backs the console "Tools & MCP" screen) |
| `POST` | `/api/v1/admin/mcp-servers` | `create` | Perms: `manage:McpServer`<br/>Svc: `svc:admin:mcp-server:manage` | - | Register a new MCP server (own tenant; the SYSTEM registry is GLOBAL-ADMIN only) |
| `DELETE` | `/api/v1/admin/mcp-servers/{id}` | `remove` | Perms: `manage:McpServer`<br/>Svc: `svc:admin:mcp-server:manage` | Yes | Soft-delete a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only) |
| `GET` | `/api/v1/admin/mcp-servers/{id}` | `get` | Perms: `read:McpServer`<br/>Svc: `svc:admin:mcp-server:manage` | - | Get one registered MCP server (registry read) |
| `PATCH` | `/api/v1/admin/mcp-servers/{id}` | `update` | Perms: `manage:McpServer`<br/>Svc: `svc:admin:mcp-server:manage` | Yes | Update a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only) |

#### Handler Call Trees:

**`GET /api/v1/admin/mcp-servers` → `McpAdminController.list`**
```text
[GET /api/v1/admin/mcp-servers]
  └── Controller: McpAdminController.list()
        ├── calls: this.mcpServerService.list()
        │     └─ Service: IMcpServerAdminService [token: IMcpServerAdminService]
```

**`POST /api/v1/admin/mcp-servers` → `McpAdminController.create`**
```text
[POST /api/v1/admin/mcp-servers]
  └── Controller: McpAdminController.create()
        ├── calls: this.mcpServerService.create()
        │     └─ Service: IMcpServerAdminService [token: IMcpServerAdminService]
```

**`DELETE /api/v1/admin/mcp-servers/{id}` → `McpAdminController.remove`**
```text
[DELETE /api/v1/admin/mcp-servers/{id}]
  └── Controller: McpAdminController.remove()
        ├── calls: this.mcpServerService.remove()
        │     └─ Service: IMcpServerAdminService [token: IMcpServerAdminService]
```

**`GET /api/v1/admin/mcp-servers/{id}` → `McpAdminController.get`**
```text
[GET /api/v1/admin/mcp-servers/{id}]
  └── Controller: McpAdminController.get()
        ├── calls: this.mcpServerService.get()
        │     └─ Service: IMcpServerAdminService [token: IMcpServerAdminService]
```

**`PATCH /api/v1/admin/mcp-servers/{id}` → `McpAdminController.update`**
```text
[PATCH /api/v1/admin/mcp-servers/{id}]
  └── Controller: McpAdminController.update()
        ├── calls: this.mcpServerService.update()
        │     └─ Service: IMcpServerAdminService [token: IMcpServerAdminService]
```

---

## Module: `media` (2 routes)

### Controller: `MediaController`
**File:** [`src/modules/media/media.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/media/media.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/media` | `upload` | Perms: `create:Media`<br/>API Key: `media:write`<br/>Svc: `svc:media:write` | - | Upload an attachment or an audio file into the tenant's media store |
| `GET` | `/api/v1/media/{mediaId}` | `getReference` | Perms: `read:Media`<br/>API Key: `media:write`<br/>Svc: `svc:media:write` | - | Read back the reference of one media object |

#### Handler Call Trees:

**`POST /api/v1/media` → `MediaController.upload`**
```text
[POST /api/v1/media]
  └── Controller: MediaController.upload()
        ├── calls: this.uploads.upload()
        │     └─ Service: IMediaUploadService [token: IMediaUploadService]
```

**`GET /api/v1/media/{mediaId}` → `MediaController.getReference`**
```text
[GET /api/v1/media/{mediaId}]
  └── Controller: MediaController.getReference()
        ├── calls: this.uploads.getOwnedReference()
        │     └─ Service: IMediaUploadService [token: IMediaUploadService]
```

---

## Module: `model-residency` (14 routes)

### Controller: `ModelResidencyController`
**File:** [`src/modules/model-residency/model-residency.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/model-residency/model-residency.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/model-residency` | `view` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Read live model residency across stt, nlp and LM Studio |
| `GET` | `/api/v1/admin/model-residency/catalogue` | `catalogue` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Read every loadable model per service, loaded or not, and who uses it |
| `POST` | `/api/v1/admin/model-residency/links` | `link` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Confirm which catalogue model a runtime key is |
| `POST` | `/api/v1/admin/model-residency/load` | `load` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Load a model on stt, nlp or LM Studio (asynchronous) |
| `POST` | `/api/v1/admin/model-residency/load/preview` | `previewLoad` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Preview a model load without doing it (dry-run admission) |
| `GET` | `/api/v1/admin/model-residency/operations/{operationId}` | `operation` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Read the progress of an asynchronous load |
| `PUT` | `/api/v1/admin/model-residency/pins` | `pin` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Pin or unpin a resident model (and set its idle TTL) |
| `GET` | `/api/v1/admin/model-residency/policies` | `listPolicies` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | List the SYSTEM residency policies |
| `POST` | `/api/v1/admin/model-residency/policies` | `createPolicy` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Create a SYSTEM residency policy |
| `DELETE` | `/api/v1/admin/model-residency/policies/{id}` | `deletePolicy` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Delete a SYSTEM residency policy (soft delete) |
| `PATCH` | `/api/v1/admin/model-residency/policies/{id}` | `updatePolicy` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | Yes | Update a SYSTEM residency policy |
| `GET` | `/api/v1/admin/model-residency/readiness` | `readiness` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Read the enforce-readiness checklist |
| `POST` | `/api/v1/admin/model-residency/suggestions/{id}/dismiss` | `dismissSuggestion` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Dismiss a standing residency recommendation |
| `POST` | `/api/v1/admin/model-residency/unload` | `unload` | Perms: `manage:ModelResidencyPolicy`<br/>Svc: `svc:admin:model-residency:manage` | - | Unload a model from stt, nlp or LM Studio |

#### Handler Call Trees:

**`GET /api/v1/admin/model-residency` → `ModelResidencyController.view`**
```text
[GET /api/v1/admin/model-residency]
  └── Controller: ModelResidencyController.view()
        ├── calls: this.service.getView()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`GET /api/v1/admin/model-residency/catalogue` → `ModelResidencyController.catalogue`**
```text
[GET /api/v1/admin/model-residency/catalogue]
  └── Controller: ModelResidencyController.catalogue()
        ├── calls: this.service.getCatalogue()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/links` → `ModelResidencyController.link`**
```text
[POST /api/v1/admin/model-residency/links]
  └── Controller: ModelResidencyController.link()
        ├── calls: this.service.linkRuntimeKey()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/load` → `ModelResidencyController.load`**
```text
[POST /api/v1/admin/model-residency/load]
  └── Controller: ModelResidencyController.load()
        ├── calls: this.service.load()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/load/preview` → `ModelResidencyController.previewLoad`**
```text
[POST /api/v1/admin/model-residency/load/preview]
  └── Controller: ModelResidencyController.previewLoad()
        ├── calls: this.service.previewLoad()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`PUT /api/v1/admin/model-residency/pins` → `ModelResidencyController.pin`**
```text
[PUT /api/v1/admin/model-residency/pins]
  └── Controller: ModelResidencyController.pin()
        ├── calls: this.service.pin()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`GET /api/v1/admin/model-residency/policies` → `ModelResidencyController.listPolicies`**
```text
[GET /api/v1/admin/model-residency/policies]
  └── Controller: ModelResidencyController.listPolicies()
        ├── calls: this.service.listPolicies()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/policies` → `ModelResidencyController.createPolicy`**
```text
[POST /api/v1/admin/model-residency/policies]
  └── Controller: ModelResidencyController.createPolicy()
        ├── calls: this.service.createPolicy()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`DELETE /api/v1/admin/model-residency/policies/{id}` → `ModelResidencyController.deletePolicy`**
```text
[DELETE /api/v1/admin/model-residency/policies/{id}]
  └── Controller: ModelResidencyController.deletePolicy()
        ├── calls: this.service.deletePolicy()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`PATCH /api/v1/admin/model-residency/policies/{id}` → `ModelResidencyController.updatePolicy`**
```text
[PATCH /api/v1/admin/model-residency/policies/{id}]
  └── Controller: ModelResidencyController.updatePolicy()
        ├── calls: this.service.updatePolicy()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`GET /api/v1/admin/model-residency/readiness` → `ModelResidencyController.readiness`**
```text
[GET /api/v1/admin/model-residency/readiness]
  └── Controller: ModelResidencyController.readiness()
        ├── calls: this.service.getReadiness()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/suggestions/{id}/dismiss` → `ModelResidencyController.dismissSuggestion`**
```text
[POST /api/v1/admin/model-residency/suggestions/{id}/dismiss]
  └── Controller: ModelResidencyController.dismissSuggestion()
        ├── calls: this.service.dismissSuggestion()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

**`POST /api/v1/admin/model-residency/unload` → `ModelResidencyController.unload`**
```text
[POST /api/v1/admin/model-residency/unload]
  └── Controller: ModelResidencyController.unload()
        ├── calls: this.service.unload()
        │     └─ Service: IModelResidencyService [token: IModelResidencyService]
```

---

## Module: `monitoring` (4 routes)

### Controller: `MonitoringController`
**File:** [`src/modules/monitoring/monitoring.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/monitoring/monitoring.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/monitoring/heartbeats/{service}` | `getHeartbeats` | Perms: `manage:all:read:TenantTelemetry` | - | Get heartbeat history for a service |
| `GET` | `/api/v1/admin/monitoring/sessions` | `getSessions` | Perms: `manage:all:read:TenantTelemetry` | - | Get active session counts per service |
| `GET` | `/api/v1/admin/monitoring/uptime` | `getUptime` | Perms: `manage:all:read:TenantTelemetry` | - | Get uptime data for all services |
| `GET` | `/api/v1/admin/monitoring/uptime/{service}` | `getServiceUptime` | Perms: `manage:all:read:TenantTelemetry` | - | Get uptime data for a specific service |

#### Handler Call Trees:

**`GET /api/v1/admin/monitoring/heartbeats/{service}` → `MonitoringController.getHeartbeats`**
```text
[GET /api/v1/admin/monitoring/heartbeats/{service}]
  └── Controller: MonitoringController.getHeartbeats()
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
        ├── calls: this.monitoringService.getHeartbeatHistory()
        │     └─ Service: IServiceHealthMonitoringService [token: IServiceHealthMonitoringService]
```

**`GET /api/v1/admin/monitoring/sessions` → `MonitoringController.getSessions`**
```text
[GET /api/v1/admin/monitoring/sessions]
  └── Controller: MonitoringController.getSessions()
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
        ├── calls: this.monitoringService.getSessionCounts()
        │     └─ Service: IServiceHealthMonitoringService [token: IServiceHealthMonitoringService]
```

**`GET /api/v1/admin/monitoring/uptime` → `MonitoringController.getUptime`**
```text
[GET /api/v1/admin/monitoring/uptime]
  └── Controller: MonitoringController.getUptime()
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
        ├── calls: this.monitoringService.getUptime()
        │     └─ Service: IServiceHealthMonitoringService [token: IServiceHealthMonitoringService]
```

**`GET /api/v1/admin/monitoring/uptime/{service}` → `MonitoringController.getServiceUptime`**
```text
[GET /api/v1/admin/monitoring/uptime/{service}]
  └── Controller: MonitoringController.getServiceUptime()
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
        ├── calls: this.monitoringService.getServiceUptime()
        │     └─ Service: IServiceHealthMonitoringService [token: IServiceHealthMonitoringService]
```

---

## Module: `nlp-task-instructions` (2 routes)

### Controller: `NlpTaskInstructionsAdminController`
**File:** [`src/modules/nlp-task-instructions/nlp-task-instructions-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/nlp-task-instructions/nlp-task-instructions-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/nlp-task-instructions/row` | `getRow` | Perms: `read:TenantNlpTaskInstructions`<br/>Svc: `svc:admin:nlp-task-instructions:manage` | - | Get the raw, editable TenantNlpTaskInstructions row for a (tenant, taskKey) |
| `PUT` | `/api/v1/admin/nlp-task-instructions/row` | `upsertRow` | Perms: `manage:TenantNlpTaskInstructions`<br/>Svc: `svc:admin:nlp-task-instructions:manage` | Yes | Create or update the (tenant, taskKey) instructions row under optimistic concurrency |

#### Handler Call Trees:

**`GET /api/v1/admin/nlp-task-instructions/row` → `NlpTaskInstructionsAdminController.getRow`**
```text
[GET /api/v1/admin/nlp-task-instructions/row]
  └── Controller: NlpTaskInstructionsAdminController.getRow()
        ├── calls: this.instructionsService.getRow()
        │     └─ Service: ITenantNlpTaskInstructionsService [token: ITenantNlpTaskInstructionsService]
```

**`PUT /api/v1/admin/nlp-task-instructions/row` → `NlpTaskInstructionsAdminController.upsertRow`**
```text
[PUT /api/v1/admin/nlp-task-instructions/row]
  └── Controller: NlpTaskInstructionsAdminController.upsertRow()
        ├── calls: this.instructionsService.upsertRow()
        │     └─ Service: ITenantNlpTaskInstructionsService [token: ITenantNlpTaskInstructionsService]
```

---

## Module: `notification` (4 routes)

### Controller: `NotificationController`
**File:** [`src/modules/notification/notification.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/notification/notification.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/notifications` | `fetchAll` | Perms: `manage:Notification`<br/>Svc: `svc:admin:notification:manage` | - | List notifications (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=) |
| `DELETE` | `/api/v1/admin/notifications/{id}` | `delete` | Perms: `manage:Notification`<br/>Svc: `svc:admin:notification:manage` | - | Soft-delete a notification |
| `GET` | `/api/v1/admin/notifications/{id}` | `fetchById` | Perms: `manage:Notification`<br/>Svc: `svc:admin:notification:manage` | - | Get one notification |
| `PATCH` | `/api/v1/admin/notifications/{id}` | `update` | Perms: `manage:Notification`<br/>Svc: `svc:admin:notification:manage` | - | Update a notification (sparse patch, e.g. mark read) |

#### Handler Call Trees:

**`GET /api/v1/admin/notifications` → `NotificationController.fetchAll`**
```text
[GET /api/v1/admin/notifications]
  └── Controller: NotificationController.fetchAll()
        ├── calls: this.notificationService.fetchAllByTenantId()
        │     └─ Service: INotificationService [token: INotificationService]
        ├── calls: this.notificationService.fetchAll()
        │     └─ Service: INotificationService [token: INotificationService]
```

**`DELETE /api/v1/admin/notifications/{id}` → `NotificationController.delete`**
```text
[DELETE /api/v1/admin/notifications/{id}]
  └── Controller: NotificationController.delete()
        ├── calls: this.notificationService.deleteById()
        │     └─ Service: INotificationService [token: INotificationService]
```

**`GET /api/v1/admin/notifications/{id}` → `NotificationController.fetchById`**
```text
[GET /api/v1/admin/notifications/{id}]
  └── Controller: NotificationController.fetchById()
        ├── calls: this.notificationService.fetchById()
        │     └─ Service: INotificationService [token: INotificationService]
```

**`PATCH /api/v1/admin/notifications/{id}` → `NotificationController.update`**
```text
[PATCH /api/v1/admin/notifications/{id}]
  └── Controller: NotificationController.update()
        ├── calls: this.notificationService.update()
        │     └─ Service: INotificationService [token: INotificationService]
```

---

## Module: `platform-metrics` (3 routes)

### Controller: `PlatformMetricsController`
**File:** [`src/modules/platform-metrics/platform-metrics.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/platform-metrics/platform-metrics.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/platform/consumption` | `getConsumption` | Perms: `manage:PlatformMetrics`<br/>Svc: `svc:admin:platform-metrics:read` | - | Consumption / usage roll-up (transcription minutes, summaries-24h, storage, consultations) |
| `GET` | `/api/v1/admin/platform/metrics` | `getMetrics` | Perms: `manage:PlatformMetrics`<br/>Svc: `svc:admin:platform-metrics:read` | - | Platform runtime metrics (requests/min, error rate, P95, sockets, models, series) |
| `GET` | `/api/v1/admin/platform/sockets` | `getSockets` | Perms: `manage:PlatformMetrics`<br/>Svc: `svc:admin:platform-metrics:read` | - | Open WebSocket count (live, multi-instance aggregate) |

#### Handler Call Trees:

**`GET /api/v1/admin/platform/consumption` → `PlatformMetricsController.getConsumption`**
```text
[GET /api/v1/admin/platform/consumption]
  └── Controller: PlatformMetricsController.getConsumption()
        ├── calls: this.platformMetricsService.getConsumptionRollup()
        │     └─ Service: IPlatformMetricsService [token: IPlatformMetricsService]
```

**`GET /api/v1/admin/platform/metrics` → `PlatformMetricsController.getMetrics`**
```text
[GET /api/v1/admin/platform/metrics]
  └── Controller: PlatformMetricsController.getMetrics()
        ├── calls: this.platformMetricsService.getPlatformMetrics()
        │     └─ Service: IPlatformMetricsService [token: IPlatformMetricsService]
```

**`GET /api/v1/admin/platform/sockets` → `PlatformMetricsController.getSockets`**
```text
[GET /api/v1/admin/platform/sockets]
  └── Controller: PlatformMetricsController.getSockets()
        ├── calls: this.platformMetricsService.getOpenSockets()
        │     └─ Service: IPlatformMetricsService [token: IPlatformMetricsService]
```

---

## Module: `prompt-inspector` (3 routes)

### Controller: `ComposedPromptAdminController`
**File:** [`src/modules/prompt-inspector/composed-prompt-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-inspector/composed-prompt-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/composed-prompts` | `list` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | List composed-prompt records |
| `GET` | `/api/v1/admin/composed-prompts/{id}` | `getById` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Read one composed-prompt record, decrypted |

#### Handler Call Trees:

**`GET /api/v1/admin/composed-prompts` → `ComposedPromptAdminController.list`**
```text
[GET /api/v1/admin/composed-prompts]
  └── Controller: ComposedPromptAdminController.list()
        ├── calls: this.composedPrompts.list()
        │     └─ Service: IComposedPromptService [token: IComposedPromptService]
```

**`GET /api/v1/admin/composed-prompts/{id}` → `ComposedPromptAdminController.getById`**
```text
[GET /api/v1/admin/composed-prompts/{id}]
  └── Controller: ComposedPromptAdminController.getById()
        ├── calls: this.composedPrompts.getDecrypted()
        │     └─ Service: IComposedPromptService [token: IComposedPromptService]
```

### Controller: `PromptPreviewController`
**File:** [`src/modules/prompt-inspector/prompt-preview.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-inspector/prompt-preview.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/consultations/{consultationId}/prompt-preview` | `preview` | Perms: `read:Consultation`<br/>Svc: `svc:admin:consultation-admin:manage` | - | Preview the prompt a consultation would send |

#### Handler Call Trees:

**`POST /api/v1/admin/consultations/{consultationId}/prompt-preview` → `PromptPreviewController.preview`**
```text
[POST /api/v1/admin/consultations/{consultationId}/prompt-preview]
  └── Controller: PromptPreviewController.preview()
        ├── calls: this.previews.preview()
        │     └─ Service: PromptPreviewService
```

---

## Module: `prompt-management` (22 routes)

### Controller: `PromptManagementController`
**File:** [`src/modules/prompt-management/prompt-management.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-management/prompt-management.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/prompt-templates` | `list` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Retrieving multiple PromptTemplateResponses |
| `POST` | `/api/v1/admin/prompt-templates` | `create` | Perms: `create:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Creating a PromptTemplateResponse |
| `DELETE` | `/api/v1/admin/prompt-templates/{id}` | `remove` | Perms: `delete:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Deleting a PromptTemplateResponse by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}` | `getById` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Retrieving a single PromptTemplateResponse by id |
| `PATCH` | `/api/v1/admin/prompt-templates/{id}` | `update` | Perms: `update:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | Yes | Updating a PromptTemplateResponse by id |
| `POST` | `/api/v1/admin/prompt-templates/{id}/approve` | `approve` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | Yes | Approve a prompt template for clinical use |
| `POST` | `/api/v1/admin/prompt-templates/{id}/test` | `testTemplate` | Perms: `update:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Creating a PromptTestAckResponse by id |
| `POST` | `/api/v1/admin/prompt-templates/{id}/test/finalize` | `finalizeTestTemplate` | Perms: `update:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | Yes | Creating a PromptTestResultResponse by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}/usage` | `getUsageStats` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Get usage statistics for a prompt template |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions` | `getVersions` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Retrieving multiple PromptVersionResponses by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions/{from}/diff/{to}` | `diffVersions` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Diff two versions of a prompt template (server-side) |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions/{versionNumber}` | `getVersion` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Retrieving a single PromptVersionResponse by id and versionNumber |
| `POST` | `/api/v1/admin/prompt-templates/{id}/versions/{versionNumber}/activate` | `activateVersion` | Perms: `update:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Creating a PromptTemplateResponse by id and versionNumber |
| `GET` | `/api/v1/admin/prompt-templates/analytics/usage` | `getUsageAnalytics` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Usage analytics grouped by department / doctor / day |
| `POST` | `/api/v1/admin/prompt-templates/assign-department` | `assignDepartment` | Perms: `update:Department`<br/>Svc: `svc:admin:prompt-template:manage` | - | Assign prompt templates to a department |
| `GET` | `/api/v1/admin/prompt-templates/tags` | `listTags` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Distinct prompt tags with usage counts (autocomplete) |
| `GET` | `/api/v1/admin/prompt-templates/usage-records` | `listUsageRecords` | Perms: `manage:PromptTemplate`<br/>Svc: `svc:admin:prompt-template:manage` | - | Paginated prompt run history (PromptUsageRecord rows), newest first |

#### Handler Call Trees:

**`GET /api/v1/admin/prompt-templates` → `PromptManagementController.list`**
```text
[GET /api/v1/admin/prompt-templates]
  └── Controller: PromptManagementController.list()
        ├── calls: this.promptService.listPromptTemplatesPaginated()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates` → `PromptManagementController.create`**
```text
[POST /api/v1/admin/prompt-templates]
  └── Controller: PromptManagementController.create()
        ├── calls: this.promptService.createPromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`DELETE /api/v1/admin/prompt-templates/{id}` → `PromptManagementController.remove`**
```text
[DELETE /api/v1/admin/prompt-templates/{id}]
  └── Controller: PromptManagementController.remove()
        ├── calls: this.promptService.softDeletePromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/{id}` → `PromptManagementController.getById`**
```text
[GET /api/v1/admin/prompt-templates/{id}]
  └── Controller: PromptManagementController.getById()
        ├── calls: this.promptService.getPromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`PATCH /api/v1/admin/prompt-templates/{id}` → `PromptManagementController.update`**
```text
[PATCH /api/v1/admin/prompt-templates/{id}]
  └── Controller: PromptManagementController.update()
        ├── calls: this.promptService.updatePromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates/{id}/approve` → `PromptManagementController.approve`**
```text
[POST /api/v1/admin/prompt-templates/{id}/approve]
  └── Controller: PromptManagementController.approve()
        ├── calls: this.promptService.approveTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates/{id}/test` → `PromptManagementController.testTemplate`**
```text
[POST /api/v1/admin/prompt-templates/{id}/test]
  └── Controller: PromptManagementController.testTemplate()
        ├── calls: this.promptService.startPromptTemplateTest()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates/{id}/test/finalize` → `PromptManagementController.finalizeTestTemplate`**
```text
[POST /api/v1/admin/prompt-templates/{id}/test/finalize]
  └── Controller: PromptManagementController.finalizeTestTemplate()
        ├── calls: this.promptService.finalizePromptTemplateTest()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/{id}/versions` → `PromptManagementController.getVersions`**
```text
[GET /api/v1/admin/prompt-templates/{id}/versions]
  └── Controller: PromptManagementController.getVersions()
        ├── calls: this.promptService.getVersions()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/{id}/versions/{from}/diff/{to}` → `PromptManagementController.diffVersions`**
```text
[GET /api/v1/admin/prompt-templates/{id}/versions/{from}/diff/{to}]
  └── Controller: PromptManagementController.diffVersions()
        ├── calls: this.promptService.diffVersions()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates/{id}/versions/{versionNumber}/activate` → `PromptManagementController.activateVersion`**
```text
[POST /api/v1/admin/prompt-templates/{id}/versions/{versionNumber}/activate]
  └── Controller: PromptManagementController.activateVersion()
        ├── calls: this.promptService.getPromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
        ├── calls: this.promptService.updatePromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/analytics/usage` → `PromptManagementController.getUsageAnalytics`**
```text
[GET /api/v1/admin/prompt-templates/analytics/usage]
  └── Controller: PromptManagementController.getUsageAnalytics()
        ├── calls: this.promptService.getUsageAnalytics()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`POST /api/v1/admin/prompt-templates/assign-department` → `PromptManagementController.assignDepartment`**
```text
[POST /api/v1/admin/prompt-templates/assign-department]
  └── Controller: PromptManagementController.assignDepartment()
        ├── calls: this.promptService.assignToDepartment()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/tags` → `PromptManagementController.listTags`**
```text
[GET /api/v1/admin/prompt-templates/tags]
  └── Controller: PromptManagementController.listTags()
        ├── calls: this.promptService.listTagSuggestions()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/admin/prompt-templates/usage-records` → `PromptManagementController.listUsageRecords`**
```text
[GET /api/v1/admin/prompt-templates/usage-records]
  └── Controller: PromptManagementController.listUsageRecords()
        ├── calls: this.promptService.listUsageRecords()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

### Controller: `PromptTemplateController`
**File:** [`src/modules/prompt-management/prompt-template.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-management/prompt-template.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/prompt-templates` | `createPersonal` | Perms: `read:PromptTemplate`<br/>API Key: `prompt:template:read` | - | Create a personal prompt template owned by the calling clinician |
| `DELETE` | `/api/v1/prompt-templates/{id}` | `deletePersonal` | Perms: `read:PromptTemplate`<br/>API Key: `prompt:template:read` | - | Soft-delete a personal prompt template the caller owns |
| `PATCH` | `/api/v1/prompt-templates/{id}` | `updatePersonal` | Perms: `read:PromptTemplate`<br/>API Key: `prompt:template:read` | Yes | Update a personal prompt template the caller owns |
| `GET` | `/api/v1/prompt-templates/available` | `available` | Perms: `read:PromptTemplate`<br/>API Key: `prompt:template:read` | - | List the prompt templates the calling clinician may use |
| `PUT` | `/api/v1/prompt-templates/preferred` | `setPreferred` | Perms: `read:PromptTemplate`<br/>API Key: `prompt:template:read` | - | Set or clear the calling clinician's preferred prompt template |

#### Handler Call Trees:

**`POST /api/v1/prompt-templates` → `PromptTemplateController.createPersonal`**
```text
[POST /api/v1/prompt-templates]
  └── Controller: PromptTemplateController.createPersonal()
        ├── calls: this.promptService.createPersonal()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`DELETE /api/v1/prompt-templates/{id}` → `PromptTemplateController.deletePersonal`**
```text
[DELETE /api/v1/prompt-templates/{id}]
  └── Controller: PromptTemplateController.deletePersonal()
        ├── calls: this.promptService.deletePersonal()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`PATCH /api/v1/prompt-templates/{id}` → `PromptTemplateController.updatePersonal`**
```text
[PATCH /api/v1/prompt-templates/{id}]
  └── Controller: PromptTemplateController.updatePersonal()
        ├── calls: this.promptService.updatePersonal()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`GET /api/v1/prompt-templates/available` → `PromptTemplateController.available`**
```text
[GET /api/v1/prompt-templates/available]
  └── Controller: PromptTemplateController.available()
        ├── calls: this.promptService.listAvailableForCaller()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

**`PUT /api/v1/prompt-templates/preferred` → `PromptTemplateController.setPreferred`**
```text
[PUT /api/v1/prompt-templates/preferred]
  └── Controller: PromptTemplateController.setPreferred()
        ├── calls: this.promptService.setPreferredPromptTemplate()
        │     └─ Service: IPromptManagementService [token: IPromptManagementService]
```

---

## Module: `pstudio` (1 routes)

### Controller: `PrismaStudioStatusController`
**File:** [`src/modules/pstudio/pstudio-status.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/pstudio/pstudio-status.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/pstudio/status` | `getStatus` | Perms: `manage:PrismaStudio`<br/>Svc: `svc:admin:pstudio:manage` | - | Report whether the Prisma Studio shell is enabled in this environment. |

#### Handler Call Trees:

_Handlers in this controller delegate directly or return static/mapped payloads._

---

## Module: `queue-admin` (17 routes)

### Controller: `QueueAdminController`
**File:** [`src/modules/queue-admin/queue-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/queue-admin/queue-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/queues` | `listQueues` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | List every registered queue with its stats (counts, paused flag, worker count). |
| `GET` | `/api/v1/admin/queues/{queueName}` | `getQueue` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Get stats for a single queue. |
| `POST` | `/api/v1/admin/queues/{queueName}/clean` | `cleanQueue` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Clean finished (completed/failed) jobs older than a grace period. |
| `GET` | `/api/v1/admin/queues/{queueName}/jobs` | `listJobs` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | List jobs in a queue (paginated, optionally status/name filtered). |
| `DELETE` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}` | `removeJob` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Remove a job from the queue. |
| `GET` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}` | `getJob` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Get a single job with PII-redacted data, options, stacktrace. |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}/promote` | `promoteJob` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Promote a delayed job so it runs immediately. |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}/retry` | `retryJob` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Retry a failed job (re-uses the original payload). |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/bulk` | `bulkJobAction` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Apply a bulk retry/remove action to a set of job ids. |
| `POST` | `/api/v1/admin/queues/{queueName}/pause` | `pauseQueue` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Pause a queue (stops processing new jobs). |
| `POST` | `/api/v1/admin/queues/{queueName}/resume` | `resumeQueue` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Resume a paused queue. |
| `GET` | `/api/v1/admin/queues/health/redis` | `getRedisHealth` | Perms: `manage:all`<br/>Svc: `svc:admin:queue:manage` | - | Redis connection health for the queue infrastructure (PING latency + INFO stats). Never errors. |

#### Handler Call Trees:

**`GET /api/v1/admin/queues` → `QueueAdminController.listQueues`**
```text
[GET /api/v1/admin/queues]
  └── Controller: QueueAdminController.listQueues()
        ├── calls: this.queueService.getAllQueueStats()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

**`GET /api/v1/admin/queues/{queueName}` → `QueueAdminController.getQueue`**
```text
[GET /api/v1/admin/queues/{queueName}]
  └── Controller: QueueAdminController.getQueue()
        ├── calls: this.queueService.getQueueStats()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/clean` → `QueueAdminController.cleanQueue`**
```text
[POST /api/v1/admin/queues/{queueName}/clean]
  └── Controller: QueueAdminController.cleanQueue()
        ├── calls: this.queueService.cleanQueue()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

**`GET /api/v1/admin/queues/{queueName}/jobs` → `QueueAdminController.listJobs`**
```text
[GET /api/v1/admin/queues/{queueName}/jobs]
  └── Controller: QueueAdminController.listJobs()
        ├── calls: this.jobService.listJobs()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`DELETE /api/v1/admin/queues/{queueName}/jobs/{jobId}` → `QueueAdminController.removeJob`**
```text
[DELETE /api/v1/admin/queues/{queueName}/jobs/{jobId}]
  └── Controller: QueueAdminController.removeJob()
        ├── calls: this.jobService.removeJob()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`GET /api/v1/admin/queues/{queueName}/jobs/{jobId}` → `QueueAdminController.getJob`**
```text
[GET /api/v1/admin/queues/{queueName}/jobs/{jobId}]
  └── Controller: QueueAdminController.getJob()
        ├── calls: this.jobService.getJobDetail()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/jobs/{jobId}/promote` → `QueueAdminController.promoteJob`**
```text
[POST /api/v1/admin/queues/{queueName}/jobs/{jobId}/promote]
  └── Controller: QueueAdminController.promoteJob()
        ├── calls: this.jobService.promoteJob()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/jobs/{jobId}/retry` → `QueueAdminController.retryJob`**
```text
[POST /api/v1/admin/queues/{queueName}/jobs/{jobId}/retry]
  └── Controller: QueueAdminController.retryJob()
        ├── calls: this.jobService.retryJob()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/jobs/bulk` → `QueueAdminController.bulkJobAction`**
```text
[POST /api/v1/admin/queues/{queueName}/jobs/bulk]
  └── Controller: QueueAdminController.bulkJobAction()
        ├── calls: this.jobService.bulkAction()
        │     └─ Service: IJobAdminService [token: IJobAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/pause` → `QueueAdminController.pauseQueue`**
```text
[POST /api/v1/admin/queues/{queueName}/pause]
  └── Controller: QueueAdminController.pauseQueue()
        ├── calls: this.queueService.pauseQueue()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

**`POST /api/v1/admin/queues/{queueName}/resume` → `QueueAdminController.resumeQueue`**
```text
[POST /api/v1/admin/queues/{queueName}/resume]
  └── Controller: QueueAdminController.resumeQueue()
        ├── calls: this.queueService.resumeQueue()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

**`GET /api/v1/admin/queues/health/redis` → `QueueAdminController.getRedisHealth`**
```text
[GET /api/v1/admin/queues/health/redis]
  └── Controller: QueueAdminController.getRedisHealth()
        ├── calls: this.queueService.getRedisHealth()
        │     └─ Service: IQueueAdminService [token: IQueueAdminService]
```

### Controller: `SchedulerAdminController`
**File:** [`src/modules/queue-admin/scheduler-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/queue-admin/scheduler-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/schedulers` | `listSchedulers` | Perms: `manage:all`<br/>Svc: `svc:admin:scheduler:manage` | - | List all schedulers (static @Cron + dynamic) with cron/interval/run metadata. |
| `PATCH` | `/api/v1/admin/schedulers/{name}/cron` | `updateCron` | Perms: `manage:all`<br/>Svc: `svc:admin:scheduler:manage` | - | Update a dynamic scheduler cron expression (static schedulers are rejected). |
| `POST` | `/api/v1/admin/schedulers/{name}/pause` | `pauseScheduler` | Perms: `manage:all`<br/>Svc: `svc:admin:scheduler:manage` | - | Pause (stop) a running cron scheduler. |
| `POST` | `/api/v1/admin/schedulers/{name}/resume` | `resumeScheduler` | Perms: `manage:all`<br/>Svc: `svc:admin:scheduler:manage` | - | Resume (start) a paused cron scheduler. |
| `PATCH` | `/api/v1/admin/schedulers/{name}/toggle` | `toggleScheduler` | Perms: `manage:all`<br/>Svc: `svc:admin:scheduler:manage` | - | Enable/disable a dynamic scheduler (static schedulers are rejected). |

#### Handler Call Trees:

**`GET /api/v1/admin/schedulers` → `SchedulerAdminController.listSchedulers`**
```text
[GET /api/v1/admin/schedulers]
  └── Controller: SchedulerAdminController.listSchedulers()
        ├── calls: this.schedulerService.listSchedulers()
        │     └─ Service: ISchedulerAdminService [token: ISchedulerAdminService]
```

**`PATCH /api/v1/admin/schedulers/{name}/cron` → `SchedulerAdminController.updateCron`**
```text
[PATCH /api/v1/admin/schedulers/{name}/cron]
  └── Controller: SchedulerAdminController.updateCron()
        ├── calls: this.schedulerService.updateSchedulerCron()
        │     └─ Service: ISchedulerAdminService [token: ISchedulerAdminService]
```

**`POST /api/v1/admin/schedulers/{name}/pause` → `SchedulerAdminController.pauseScheduler`**
```text
[POST /api/v1/admin/schedulers/{name}/pause]
  └── Controller: SchedulerAdminController.pauseScheduler()
        ├── calls: this.schedulerService.pauseScheduler()
        │     └─ Service: ISchedulerAdminService [token: ISchedulerAdminService]
```

**`POST /api/v1/admin/schedulers/{name}/resume` → `SchedulerAdminController.resumeScheduler`**
```text
[POST /api/v1/admin/schedulers/{name}/resume]
  └── Controller: SchedulerAdminController.resumeScheduler()
        ├── calls: this.schedulerService.resumeScheduler()
        │     └─ Service: ISchedulerAdminService [token: ISchedulerAdminService]
```

**`PATCH /api/v1/admin/schedulers/{name}/toggle` → `SchedulerAdminController.toggleScheduler`**
```text
[PATCH /api/v1/admin/schedulers/{name}/toggle]
  └── Controller: SchedulerAdminController.toggleScheduler()
        ├── calls: this.schedulerService.toggleScheduler()
        │     └─ Service: ISchedulerAdminService [token: ISchedulerAdminService]
```

---

## Module: `rbac` (20 routes)

### Controller: `PermissionCheckController`
**File:** [`src/modules/rbac/permission-check.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/rbac/permission-check.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/users/me/permission-checks` | `getMyPermissions` | Auth<br/>API Key: `user:profile:read` | - | Get current user's effective permissions |

#### Handler Call Trees:

**`POST /api/v1/users/me/permission-checks` → `PermissionCheckController.getMyPermissions`**
```text
[POST /api/v1/users/me/permission-checks]
  └── Controller: PermissionCheckController.getMyPermissions()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.policyEngine.buildAbility()
        │     └─ Service: PolicyEngine
```

### Controller: `PoliciesController`
**File:** [`src/modules/rbac/policies.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/rbac/policies.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/rbac/policies` | `findAll` | Perms: `read:Policy:manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | List all policies |
| `POST` | `/api/v1/admin/rbac/policies` | `create` | Perms: `manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Create a new policy |
| `DELETE` | `/api/v1/admin/rbac/policies/{id}` | `remove` | Perms: `manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Delete a policy (requires break-glass confirmation) |
| `GET` | `/api/v1/admin/rbac/policies/{id}` | `findOne` | Perms: `read:Policy:manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Get policy by ID |
| `PATCH` | `/api/v1/admin/rbac/policies/{id}` | `patch` | Perms: `manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Partially update a policy |
| `PUT` | `/api/v1/admin/rbac/policies/{id}` | `update` | Perms: `manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Update a policy |
| `POST` | `/api/v1/admin/rbac/policies/validate` | `validate` | Perms: `manage:Policy`<br/>Svc: `svc:admin:rbac-policy:write` | - | Validate policy rules |

#### Handler Call Trees:

**`GET /api/v1/admin/rbac/policies` → `PoliciesController.findAll`**
```text
[GET /api/v1/admin/rbac/policies]
  └── Controller: PoliciesController.findAll()
        ├── calls: this.policyService.findAll()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

**`POST /api/v1/admin/rbac/policies` → `PoliciesController.create`**
```text
[POST /api/v1/admin/rbac/policies]
  └── Controller: PoliciesController.create()
        ├── calls: this.policyService.create()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

**`GET /api/v1/admin/rbac/policies/{id}` → `PoliciesController.findOne`**
```text
[GET /api/v1/admin/rbac/policies/{id}]
  └── Controller: PoliciesController.findOne()
        ├── calls: this.policyService.findOne()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

**`PATCH /api/v1/admin/rbac/policies/{id}` → `PoliciesController.patch`**
```text
[PATCH /api/v1/admin/rbac/policies/{id}]
  └── Controller: PoliciesController.patch()
        ├── calls: this.policyService.patch()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

**`PUT /api/v1/admin/rbac/policies/{id}` → `PoliciesController.update`**
```text
[PUT /api/v1/admin/rbac/policies/{id}]
  └── Controller: PoliciesController.update()
        ├── calls: this.policyService.update()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

**`POST /api/v1/admin/rbac/policies/validate` → `PoliciesController.validate`**
```text
[POST /api/v1/admin/rbac/policies/validate]
  └── Controller: PoliciesController.validate()
        ├── calls: this.policyService.validateRules()
        │     └─ Service: IPolicyService [token: IPolicyService]
```

### Controller: `RolesController`
**File:** [`src/modules/rbac/roles.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/rbac/roles.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/rbac/roles` | `findAll` | Perms: `read:Role:manage:Role`<br/>Svc: `svc:admin:role:read,svc:admin:role:write` | - | List all roles |
| `POST` | `/api/v1/admin/rbac/roles` | `create` | Perms: `manage:Role`<br/>Svc: `svc:admin:role:write` | - | Create a new role |
| `DELETE` | `/api/v1/admin/rbac/roles/{id}` | `remove` | Perms: `delete:Role:manage:Role`<br/>Svc: `svc:admin:role:write` | - | Delete a role (requires break-glass confirmation) |
| `GET` | `/api/v1/admin/rbac/roles/{id}` | `findOne` | Perms: `read:Role:manage:Role`<br/>Svc: `svc:admin:role:read,svc:admin:role:write` | - | Get role by ID |
| `PATCH` | `/api/v1/admin/rbac/roles/{id}` | `patch` | Perms: `update:Role:manage:Role`<br/>Svc: `svc:admin:role:write` | - | Partially update a role |
| `PUT` | `/api/v1/admin/rbac/roles/{id}` | `update` | Perms: `update:Role:manage:Role`<br/>Svc: `svc:admin:role:write` | - | Update a role |
| `POST` | `/api/v1/admin/rbac/roles/{id}/clone` | `clone` | Perms: `create:Role`<br/>Svc: `svc:admin:role:write` | - | Clone a role (SYSTEM or CUSTOM) into a new CUSTOM role, copying its policies |
| `GET` | `/api/v1/admin/rbac/roles/{id}/members` | `listMembers` | Perms: `read:Role:manage:Role`<br/>Svc: `svc:admin:role:read,svc:admin:role:write` | - | List users assigned this role (paginated, tenant-scoped) |
| `DELETE` | `/api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` | `removePolicy` | Perms: `manage:RolePolicy`<br/>Svc: `svc:admin:role:write` | - | Remove a policy from a role (requires break-glass confirmation) |
| `POST` | `/api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` | `assignPolicy` | Perms: `manage:RolePolicy`<br/>Svc: `svc:admin:role:write` | - | Assign a policy to a role |

#### Handler Call Trees:

**`GET /api/v1/admin/rbac/roles` → `RolesController.findAll`**
```text
[GET /api/v1/admin/rbac/roles]
  └── Controller: RolesController.findAll()
        ├── calls: this.roleService.findAll()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`POST /api/v1/admin/rbac/roles` → `RolesController.create`**
```text
[POST /api/v1/admin/rbac/roles]
  └── Controller: RolesController.create()
        ├── calls: this.roleService.create()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`DELETE /api/v1/admin/rbac/roles/{id}` → `RolesController.remove`**
```text
[DELETE /api/v1/admin/rbac/roles/{id}]
  └── Controller: RolesController.remove()
        ├── calls: this.roleService.softDelete()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`GET /api/v1/admin/rbac/roles/{id}` → `RolesController.findOne`**
```text
[GET /api/v1/admin/rbac/roles/{id}]
  └── Controller: RolesController.findOne()
        ├── calls: this.roleService.findOne()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`PATCH /api/v1/admin/rbac/roles/{id}` → `RolesController.patch`**
```text
[PATCH /api/v1/admin/rbac/roles/{id}]
  └── Controller: RolesController.patch()
        ├── calls: this.roleService.patch()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`PUT /api/v1/admin/rbac/roles/{id}` → `RolesController.update`**
```text
[PUT /api/v1/admin/rbac/roles/{id}]
  └── Controller: RolesController.update()
        ├── calls: this.roleService.update()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`POST /api/v1/admin/rbac/roles/{id}/clone` → `RolesController.clone`**
```text
[POST /api/v1/admin/rbac/roles/{id}/clone]
  └── Controller: RolesController.clone()
        ├── calls: this.roleService.clone()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`GET /api/v1/admin/rbac/roles/{id}/members` → `RolesController.listMembers`**
```text
[GET /api/v1/admin/rbac/roles/{id}/members]
  └── Controller: RolesController.listMembers()
        ├── calls: this.roleService.findOne()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
        ├── calls: this.userRoleAssignmentService.fetchAllByRoleId()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
```

**`DELETE /api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` → `RolesController.removePolicy`**
```text
[DELETE /api/v1/admin/rbac/roles/{roleId}/policies/{policyId}]
  └── Controller: RolesController.removePolicy()
        ├── calls: this.roleService.removePolicy()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

**`POST /api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` → `RolesController.assignPolicy`**
```text
[POST /api/v1/admin/rbac/roles/{roleId}/policies/{policyId}]
  └── Controller: RolesController.assignPolicy()
        ├── calls: this.roleService.assignPolicy()
        │     └─ Service: IRbacRoleService [token: IRbacRoleService]
```

### Controller: `UserPermissionCheckController`
**File:** [`src/modules/rbac/permission-check.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/rbac/permission-check.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/users/{id}/permission-checks` | `checkPermission` | Auth<br/>API Key: `user:profile:read` | - | Check if a user has a specific permission |
| `POST` | `/api/v1/users/{id}/permission-checks/bulk` | `checkPermissionsBulk` | Auth<br/>API Key: `user:profile:read` | - | Check multiple permissions at once |

#### Handler Call Trees:

**`POST /api/v1/users/{id}/permission-checks` → `UserPermissionCheckController.checkPermission`**
```text
[POST /api/v1/users/{id}/permission-checks]
  └── Controller: UserPermissionCheckController.checkPermission()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.policyEngine.buildAbility()
        │     └─ Service: PolicyEngine
        ├── calls: this.policyEngine.buildAbility()
        │     └─ Service: PolicyEngine
        ├── calls: this.policyEngine.can()
        │     └─ Service: PolicyEngine
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
```

**`POST /api/v1/users/{id}/permission-checks/bulk` → `UserPermissionCheckController.checkPermissionsBulk`**
```text
[POST /api/v1/users/{id}/permission-checks/bulk]
  └── Controller: UserPermissionCheckController.checkPermissionsBulk()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.policyEngine.buildAbility()
        │     └─ Service: PolicyEngine
        ├── calls: this.policyEngine.buildAbility()
        │     └─ Service: PolicyEngine
        ├── calls: this.policyEngine.can()
        │     └─ Service: PolicyEngine
        ├── calls: this.logger.debug()
        │     └─ Service: unknown
```

---

## Module: `resource-subscription` (6 routes)

### Controller: `ResourceSubscriptionController`
**File:** [`src/modules/resource-subscription/resource-subscription.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/resource-subscription/resource-subscription.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/resource-subscriptions` | `fetchAll` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | List resource subscriptions (tenant-scoped) |
| `POST` | `/api/v1/admin/resource-subscriptions` | `create` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | Create a resource subscription |
| `DELETE` | `/api/v1/admin/resource-subscriptions/{id}` | `delete` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | Soft-delete a resource subscription |
| `GET` | `/api/v1/admin/resource-subscriptions/{id}` | `fetchById` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | Get one resource subscription |
| `PATCH` | `/api/v1/admin/resource-subscriptions/{id}` | `update` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | Update a resource subscription (sparse patch) |
| `POST` | `/api/v1/admin/resource-subscriptions/{id}/toggle` | `toggle` | Perms: `manage:ResourceSubscription`<br/>Svc: `svc:admin:resource-subscription:manage` | - | Toggle a subscription ENABLED↔DISABLED |

#### Handler Call Trees:

**`GET /api/v1/admin/resource-subscriptions` → `ResourceSubscriptionController.fetchAll`**
```text
[GET /api/v1/admin/resource-subscriptions]
  └── Controller: ResourceSubscriptionController.fetchAll()
        ├── calls: this.resourceSubscriptionService.fetchAll()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

**`POST /api/v1/admin/resource-subscriptions` → `ResourceSubscriptionController.create`**
```text
[POST /api/v1/admin/resource-subscriptions]
  └── Controller: ResourceSubscriptionController.create()
        ├── calls: this.resourceSubscriptionService.create()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

**`DELETE /api/v1/admin/resource-subscriptions/{id}` → `ResourceSubscriptionController.delete`**
```text
[DELETE /api/v1/admin/resource-subscriptions/{id}]
  └── Controller: ResourceSubscriptionController.delete()
        ├── calls: this.resourceSubscriptionService.deleteById()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

**`GET /api/v1/admin/resource-subscriptions/{id}` → `ResourceSubscriptionController.fetchById`**
```text
[GET /api/v1/admin/resource-subscriptions/{id}]
  └── Controller: ResourceSubscriptionController.fetchById()
        ├── calls: this.resourceSubscriptionService.fetchById()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

**`PATCH /api/v1/admin/resource-subscriptions/{id}` → `ResourceSubscriptionController.update`**
```text
[PATCH /api/v1/admin/resource-subscriptions/{id}]
  └── Controller: ResourceSubscriptionController.update()
        ├── calls: this.resourceSubscriptionService.update()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

**`POST /api/v1/admin/resource-subscriptions/{id}/toggle` → `ResourceSubscriptionController.toggle`**
```text
[POST /api/v1/admin/resource-subscriptions/{id}/toggle]
  └── Controller: ResourceSubscriptionController.toggle()
        ├── calls: this.resourceSubscriptionService.toggleSubscriptionById()
        │     └─ Service: IResourceSubscriptionService [token: IResourceSubscriptionService]
```

---

## Module: `security-policy` (2 routes)

### Controller: `SecurityPolicyController`
**File:** [`src/modules/security-policy/security-policy.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/security-policy/security-policy.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/security/policy` | `getPolicy` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Read the platform credential policy. |
| `PUT` | `/api/v1/admin/security/policy` | `updatePolicy` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Update the platform credential policy (partial). |

#### Handler Call Trees:

**`GET /api/v1/admin/security/policy` → `SecurityPolicyController.getPolicy`**
```text
[GET /api/v1/admin/security/policy]
  └── Controller: SecurityPolicyController.getPolicy()
        ├── calls: this.service.getPolicy()
        │     └─ Service: ISecurityPolicyService [token: ISecurityPolicyService]
```

**`PUT /api/v1/admin/security/policy` → `SecurityPolicyController.updatePolicy`**
```text
[PUT /api/v1/admin/security/policy]
  └── Controller: SecurityPolicyController.updatePolicy()
        ├── calls: this.service.updatePolicy()
        │     └─ Service: ISecurityPolicyService [token: ISecurityPolicyService]
```

---

## Module: `service-account` (8 routes)

### Controller: `ServiceAccountController`
**File:** [`src/modules/service-account/service-account.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/service-account/service-account.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/service-accounts` | `getAll` | Perms: `read:ServiceAccount` | - | List service accounts in scope |
| `POST` | `/api/v1/admin/service-accounts` | `create` | Perms: `manage:ServiceAccount` | - | Issue a service account (SUPER_ADMIN only) |
| `DELETE` | `/api/v1/admin/service-accounts/{id}` | `revoke` | Perms: `manage:ServiceAccount` | - | Revoke a service account (SUPER_ADMIN only) |
| `GET` | `/api/v1/admin/service-accounts/{id}` | `getById` | Perms: `read:ServiceAccount` | - | Read one service account. Never returns credential material. |
| `PATCH` | `/api/v1/admin/service-accounts/{id}` | `update` | Perms: `manage:ServiceAccount` | Yes | Update a service account (SUPER_ADMIN only) |
| `POST` | `/api/v1/admin/service-accounts/{id}/rotate` | `rotate` | Perms: `manage:ServiceAccount` | - | Rotate the client secret (SUPER_ADMIN only) |
| `GET` | `/api/v1/admin/service-accounts/scopes` | `getAvailableScopes` | Perms: `read:ServiceAccount` | - | List available svc:* service-account scopes |

#### Handler Call Trees:

**`GET /api/v1/admin/service-accounts` → `ServiceAccountController.getAll`**
```text
[GET /api/v1/admin/service-accounts]
  └── Controller: ServiceAccountController.getAll()
        ├── calls: this.serviceAccounts.getAll()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

**`POST /api/v1/admin/service-accounts` → `ServiceAccountController.create`**
```text
[POST /api/v1/admin/service-accounts]
  └── Controller: ServiceAccountController.create()
        ├── calls: this.serviceAccounts.create()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

**`DELETE /api/v1/admin/service-accounts/{id}` → `ServiceAccountController.revoke`**
```text
[DELETE /api/v1/admin/service-accounts/{id}]
  └── Controller: ServiceAccountController.revoke()
        ├── calls: this.serviceAccounts.revoke()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

**`GET /api/v1/admin/service-accounts/{id}` → `ServiceAccountController.getById`**
```text
[GET /api/v1/admin/service-accounts/{id}]
  └── Controller: ServiceAccountController.getById()
        ├── calls: this.serviceAccounts.getById()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

**`PATCH /api/v1/admin/service-accounts/{id}` → `ServiceAccountController.update`**
```text
[PATCH /api/v1/admin/service-accounts/{id}]
  └── Controller: ServiceAccountController.update()
        ├── calls: this.serviceAccounts.update()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

**`POST /api/v1/admin/service-accounts/{id}/rotate` → `ServiceAccountController.rotate`**
```text
[POST /api/v1/admin/service-accounts/{id}/rotate]
  └── Controller: ServiceAccountController.rotate()
        ├── calls: this.serviceAccounts.rotate()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

### Controller: `ServiceAccountTokenController`
**File:** [`src/modules/service-account/service-account-token.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/service-account/service-account-token.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/auth/service-token` | `exchange` | Public | - | Exchange a service-account client secret for a short-lived access token |

#### Handler Call Trees:

**`POST /api/v1/auth/service-token` → `ServiceAccountTokenController.exchange`**
```text
[POST /api/v1/auth/service-token]
  └── Controller: ServiceAccountTokenController.exchange()
        ├── calls: this.serviceAccounts.exchangeToken()
        │     └─ Service: IServiceAccountService [token: IServiceAccountService]
```

---

## Module: `service-release` (5 routes)

### Controller: `ServiceReleaseAdminController`
**File:** [`src/modules/service-release/service-release-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/service-release/service-release-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/service-releases` | `list` | Perms: `manage:all:read:TenantTelemetry`<br/>Svc: `svc:admin:service-release:manage` | - | Release history across all services, newest build first |
| `GET` | `/api/v1/admin/service-releases/{serviceName}/history` | `history` | Perms: `manage:all:read:TenantTelemetry`<br/>Svc: `svc:admin:service-release:manage` | - | Release timeline for one service, newest first |
| `GET` | `/api/v1/admin/service-releases/current` | `current` | Perms: `manage:all:read:TenantTelemetry`<br/>Svc: `svc:admin:service-release:manage` | - | What is running right now, one row per service |

#### Handler Call Trees:

**`GET /api/v1/admin/service-releases` → `ServiceReleaseAdminController.list`**
```text
[GET /api/v1/admin/service-releases]
  └── Controller: ServiceReleaseAdminController.list()
        ├── calls: this.serviceReleaseService.listReleases()
        │     └─ Service: IServiceReleaseService [token: IServiceReleaseService]
```

**`GET /api/v1/admin/service-releases/{serviceName}/history` → `ServiceReleaseAdminController.history`**
```text
[GET /api/v1/admin/service-releases/{serviceName}/history]
  └── Controller: ServiceReleaseAdminController.history()
        ├── calls: this.serviceReleaseService.getHistory()
        │     └─ Service: IServiceReleaseService [token: IServiceReleaseService]
```

**`GET /api/v1/admin/service-releases/current` → `ServiceReleaseAdminController.current`**
```text
[GET /api/v1/admin/service-releases/current]
  └── Controller: ServiceReleaseAdminController.current()
        ├── calls: this.serviceReleaseService.listCurrent()
        │     └─ Service: IServiceReleaseService [token: IServiceReleaseService]
```

### Controller: `ServiceReleaseInternalController`
**File:** [`src/modules/service-release/service-release-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/service-release/service-release-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/service-releases` | `register` | Public | - | - |
| `POST` | `/api/v1/internal/service-releases/digest` | `attachDigest` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/service-releases` → `ServiceReleaseInternalController.register`**
```text
[POST /api/v1/internal/service-releases]
  └── Controller: ServiceReleaseInternalController.register()
        ├── calls: this.serviceReleaseService.registerInstance()
        │     └─ Service: IServiceReleaseService [token: IServiceReleaseService]
```

**`POST /api/v1/internal/service-releases/digest` → `ServiceReleaseInternalController.attachDigest`**
```text
[POST /api/v1/internal/service-releases/digest]
  └── Controller: ServiceReleaseInternalController.attachDigest()
        ├── calls: this.serviceReleaseService.attachDigest()
        │     └─ Service: IServiceReleaseService [token: IServiceReleaseService]
```

---

## Module: `settings-catalog` (11 routes)

### Controller: `SettingsActionConfirmationsController`
**File:** [`src/modules/settings-catalog/settings-action-confirmations.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/settings-catalog/settings-action-confirmations.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/settings/action-confirmations` | `getPlatform` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | The platform action-confirmation policy: every catalogue row with its mode and version. |
| `PUT` | `/api/v1/admin/settings/action-confirmations` | `putPlatform` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Apply a batch of action-confirmation mode edits. |
| `GET` | `/api/v1/admin/settings/action-confirmations/effective` | `getEffective` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Resolve the confirmation requirement of every confirmable admin action. |

#### Handler Call Trees:

**`GET /api/v1/admin/settings/action-confirmations` → `SettingsActionConfirmationsController.getPlatform`**
```text
[GET /api/v1/admin/settings/action-confirmations]
  └── Controller: SettingsActionConfirmationsController.getPlatform()
        ├── calls: this.confirmations.readPlatform()
        │     └─ Service: ActionConfirmationService
```

**`PUT /api/v1/admin/settings/action-confirmations` → `SettingsActionConfirmationsController.putPlatform`**
```text
[PUT /api/v1/admin/settings/action-confirmations]
  └── Controller: SettingsActionConfirmationsController.putPlatform()
        ├── calls: this.confirmations.applyPlatform()
        │     └─ Service: ActionConfirmationService
```

**`GET /api/v1/admin/settings/action-confirmations/effective` → `SettingsActionConfirmationsController.getEffective`**
```text
[GET /api/v1/admin/settings/action-confirmations/effective]
  └── Controller: SettingsActionConfirmationsController.getEffective()
        ├── calls: this.confirmations.effective()
        │     └─ Service: ActionConfirmationService
```

### Controller: `SettingsCatalogController`
**File:** [`src/modules/settings-catalog/settings-catalog.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/settings-catalog/settings-catalog.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/settings/catalog` | `getCatalog` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | List the capability/settings catalog (RBAC-filtered metadata). |
| `GET` | `/api/v1/admin/settings/effective` | `getEffective` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Resolve the effective value of one non-secret setting for a context (with cascade trace). |

#### Handler Call Trees:

**`GET /api/v1/admin/settings/catalog` → `SettingsCatalogController.getCatalog`**
```text
[GET /api/v1/admin/settings/catalog]
  └── Controller: SettingsCatalogController.getCatalog()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.platformStorage.dedicatedRowValues()
        │     └─ Service: PlatformStorageSettingsResolver
```

**`GET /api/v1/admin/settings/effective` → `SettingsCatalogController.getEffective`**
```text
[GET /api/v1/admin/settings/effective]
  └── Controller: SettingsCatalogController.getEffective()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.effective.resolveEffective()
        │     └─ Service: EffectiveSettingsService
```

### Controller: `SettingsFeaturesController`
**File:** [`src/modules/settings-catalog/settings-features.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/settings-catalog/settings-features.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/settings/features/effective` | `getEffectiveFeatures` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Resolve every feature-availability gate for the calling context. |
| `GET` | `/api/v1/admin/settings/features/matrix` | `getFeatureMatrix` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | The cross-tenant feature matrix: the platform default beside every tenant’s override. |
| `PUT` | `/api/v1/admin/settings/features/matrix` | `putFeatureMatrix` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Apply a batch of feature-matrix edits. |

#### Handler Call Trees:

**`GET /api/v1/admin/settings/features/effective` → `SettingsFeaturesController.getEffectiveFeatures`**
```text
[GET /api/v1/admin/settings/features/effective]
  └── Controller: SettingsFeaturesController.getEffectiveFeatures()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.features.resolveEffectiveForTenant()
        │     └─ Service: FeatureAvailabilityService
```

**`GET /api/v1/admin/settings/features/matrix` → `SettingsFeaturesController.getFeatureMatrix`**
```text
[GET /api/v1/admin/settings/features/matrix]
  └── Controller: SettingsFeaturesController.getFeatureMatrix()
        ├── calls: this.features.readMatrix()
        │     └─ Service: FeatureAvailabilityService
```

**`PUT /api/v1/admin/settings/features/matrix` → `SettingsFeaturesController.putFeatureMatrix`**
```text
[PUT /api/v1/admin/settings/features/matrix]
  └── Controller: SettingsFeaturesController.putFeatureMatrix()
        ├── calls: this.features.applyMatrix()
        │     └─ Service: FeatureAvailabilityService
```

### Controller: `SettingsRegistryWriteController`
**File:** [`src/modules/settings-catalog/settings-registry-write.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/settings-catalog/settings-registry-write.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `DELETE` | `/api/v1/admin/settings/registry/{key}` | `resetSetting` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Reset one TENANT override so the key resumes inheriting the platform default. |
| `GET` | `/api/v1/admin/settings/registry/{key}` | `getSetting` | Perms: `read:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Read one registry setting: its descriptor metadata plus the effective value and cascade trace. |
| `PUT` | `/api/v1/admin/settings/registry/{key}` | `putSetting` | Perms: `manage:GlobalSetting`<br/>Svc: `svc:admin:settings:manage` | - | Write one registry setting through the single descriptor-driven enforcement point. |

#### Handler Call Trees:

**`DELETE /api/v1/admin/settings/registry/{key}` → `SettingsRegistryWriteController.resetSetting`**
```text
[DELETE /api/v1/admin/settings/registry/{key}]
  └── Controller: SettingsRegistryWriteController.resetSetting()
        ├── calls: this.writeService.reset()
        │     └─ Service: SettingsRegistryWriteService
```

**`GET /api/v1/admin/settings/registry/{key}` → `SettingsRegistryWriteController.getSetting`**
```text
[GET /api/v1/admin/settings/registry/{key}]
  └── Controller: SettingsRegistryWriteController.getSetting()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.effective.resolveEffective()
        │     └─ Service: EffectiveSettingsService
        ├── calls: this.writeService.getBackingRowVersion()
        │     └─ Service: SettingsRegistryWriteService
```

**`PUT /api/v1/admin/settings/registry/{key}` → `SettingsRegistryWriteController.putSetting`**
```text
[PUT /api/v1/admin/settings/registry/{key}]
  └── Controller: SettingsRegistryWriteController.putSetting()
        ├── calls: this.writeService.write()
        │     └─ Service: SettingsRegistryWriteService
```

---

## Module: `speech` (3 routes)

### Controller: `HarnessTtsInternalController`
**File:** [`src/modules/speech/harness-tts-internal.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/harness-tts-internal.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/internal/harness/tts/synthesize` | `synthesize` | Public | - | - |

#### Handler Call Trees:

**`POST /api/v1/internal/harness/tts/synthesize` → `HarnessTtsInternalController.synthesize`**
```text
[POST /api/v1/internal/harness/tts/synthesize]
  └── Controller: HarnessTtsInternalController.synthesize()
        ├── calls: this.configService.getConfigValue()
        │     └─ Service: IConfigService [token: IConfigService]
        ├── calls: this.cls.run()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.set()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.entitlementsService.assertMeterQuota()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
```

### Controller: `SpeechProxyController`
**File:** [`src/modules/speech/speech-proxy.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/speech-proxy.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/speech/synthesize` | `synthesize` | Auth<br/>API Key: `tts:speech:write` | - | Synthesize speech via TTS (batch audio, streamed audio, or SSE) |
| `GET` | `/api/v1/speech/voices` | `voices` | Auth<br/>API Key: `tts:speech:write` | - | List available TTS voices (stable internal ids + providers) |

#### Handler Call Trees:

**`POST /api/v1/speech/synthesize` → `SpeechProxyController.synthesize`**
```text
[POST /api/v1/speech/synthesize]
  └── Controller: SpeechProxyController.synthesize()
        ├── calls: this.entitlementsService.assertMeterQuota()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.usageLedger.recordUsage()
        │     └─ Service: IUsageLedgerService [token: IUsageLedgerService]
        ├── calls: this.usageLedger.recordUsage()
        │     └─ Service: IUsageLedgerService [token: IUsageLedgerService]
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls helper: this.getTtsBaseUrl()
        │     ├── calls: this.configService.getConfigValue()
        │     │     └─ Service: IConfigService [token: IConfigService]
```

---

## Module: `storage` (10 routes)

### Controller: `StorageController`
**File:** [`src/modules/storage/storage.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/storage/storage.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/storage/buckets` | `listBuckets` | Perms: `read:Storage`<br/>API Key: `media:file:write` | - | List all storage buckets |
| `POST` | `/api/v1/storage/buckets` | `createBucket` | Perms: `create:Storage`<br/>API Key: `media:file:write` | - | Create a new storage bucket |
| `DELETE` | `/api/v1/storage/buckets/{name}` | `deleteBucket` | Perms: `delete:Storage`<br/>API Key: `media:file:write` | - | Delete a storage bucket |
| `GET` | `/api/v1/storage/buckets/{name}` | `getBucket` | Perms: `read:Storage`<br/>API Key: `media:file:write` | - | Get bucket info |
| `PATCH` | `/api/v1/storage/buckets/{name}` | `updateBucket` | Perms: `update:Storage`<br/>API Key: `media:file:write` | - | Update bucket metadata |
| `GET` | `/api/v1/storage/buckets/{name}/files` | `listFiles` | Perms: `read:Storage`<br/>API Key: `media:file:write` | - | List files in bucket |
| `POST` | `/api/v1/storage/buckets/{name}/files` | `uploadFile` | Perms: `create:Storage`<br/>API Key: `media:file:write` | - | Upload file to bucket |
| `DELETE` | `/api/v1/storage/buckets/{name}/files/{key}` | `deleteFile` | Perms: `delete:Storage`<br/>API Key: `media:file:write` | - | Delete file from bucket |
| `GET` | `/api/v1/storage/buckets/{name}/files/{key}` | `getFileInfo` | Perms: `read:Storage`<br/>API Key: `media:file:write` | - | Get file info with presigned download URL |
| `GET` | `/api/v1/storage/health` | `checkHealth` | Perms: `read:Storage`<br/>API Key: `media:file:write` | - | Check storage service health (detailed) |

#### Handler Call Trees:

**`GET /api/v1/storage/buckets` → `StorageController.listBuckets`**
```text
[GET /api/v1/storage/buckets]
  └── Controller: StorageController.listBuckets()
        ├── calls: this.tenantBucketService.listBucketsCrossTenantWithPhysical()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
        ├── calls: this.tenantBucketService.listBuckets()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`POST /api/v1/storage/buckets` → `StorageController.createBucket`**
```text
[POST /api/v1/storage/buckets]
  └── Controller: StorageController.createBucket()
        ├── calls: this.blobStorage.createBucket()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
        ├── calls: this.tenantBucketService.registerBucket()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`DELETE /api/v1/storage/buckets/{name}` → `StorageController.deleteBucket`**
```text
[DELETE /api/v1/storage/buckets/{name}]
  └── Controller: StorageController.deleteBucket()
        ├── calls: this.blobStorage.deleteBucket()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
```

**`GET /api/v1/storage/buckets/{name}` → `StorageController.getBucket`**
```text
[GET /api/v1/storage/buckets/{name}]
  └── Controller: StorageController.getBucket()
        ├── calls: this.blobStorage.listObjects()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
```

**`PATCH /api/v1/storage/buckets/{name}` → `StorageController.updateBucket`**
```text
[PATCH /api/v1/storage/buckets/{name}]
  └── Controller: StorageController.updateBucket()
        ├── calls: this.s3Service.updateBucket()
        │     └─ Service: IS3Service [token: IS3Service]
```

**`GET /api/v1/storage/buckets/{name}/files` → `StorageController.listFiles`**
```text
[GET /api/v1/storage/buckets/{name}/files]
  └── Controller: StorageController.listFiles()
        ├── calls: this.blobStorage.listObjects()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
```

**`POST /api/v1/storage/buckets/{name}/files` → `StorageController.uploadFile`**
```text
[POST /api/v1/storage/buckets/{name}/files]
  └── Controller: StorageController.uploadFile()
        ├── calls: this.tenantBucketService.getBucketByName()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
        ├── calls: this.blobStorage.putObject()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
        ├── calls: this.imageThumbnailService.generateWebpThumbnail()
        │     └─ Service: ImageThumbnailService
        ├── calls: this.blobStorage.putObject()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.mediaService.create()
        │     └─ Service: IMediaService [token: IMediaService]
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
```

**`DELETE /api/v1/storage/buckets/{name}/files/{key}` → `StorageController.deleteFile`**
```text
[DELETE /api/v1/storage/buckets/{name}/files/{key}]
  └── Controller: StorageController.deleteFile()
        ├── calls: this.blobStorage.deleteObject()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
```

**`GET /api/v1/storage/buckets/{name}/files/{key}` → `StorageController.getFileInfo`**
```text
[GET /api/v1/storage/buckets/{name}/files/{key}]
  └── Controller: StorageController.getFileInfo()
        ├── calls: this.blobStorage.presignGet()
        │     └─ Service: IBlobStorageService [token: IBlobStorageService]
```

**`GET /api/v1/storage/health` → `StorageController.checkHealth`**
```text
[GET /api/v1/storage/health]
  └── Controller: StorageController.checkHealth()
        ├── calls: this.s3HealthService.checkHealth()
        │     └─ Service: S3HealthService
```

---

## Module: `storage-access-key` (3 routes)

### Controller: `StorageAccessKeyController`
**File:** [`src/modules/storage-access-key/storage-access-key.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/storage-access-key/storage-access-key.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenants/storage/keys` | `listKeys` | Perms: `read:Storage`<br/>Svc: `svc:admin:storage-key:manage` | - | List all storage access keys for current tenant |
| `POST` | `/api/v1/admin/tenants/storage/keys` | `generateKey` | Perms: `create:Storage`<br/>Svc: `svc:admin:storage-key:manage` | - | Generate a new storage access key |
| `DELETE` | `/api/v1/admin/tenants/storage/keys/{id}` | `revokeKey` | Perms: `delete:Storage`<br/>Svc: `svc:admin:storage-key:manage` | - | Revoke a storage access key |

#### Handler Call Trees:

**`GET /api/v1/admin/tenants/storage/keys` → `StorageAccessKeyController.listKeys`**
```text
[GET /api/v1/admin/tenants/storage/keys]
  └── Controller: StorageAccessKeyController.listKeys()
        ├── calls: this.storageAccessKeyService.listKeys()
        │     └─ Service: IStorageAccessKeyService [token: IStorageAccessKeyService]
```

**`POST /api/v1/admin/tenants/storage/keys` → `StorageAccessKeyController.generateKey`**
```text
[POST /api/v1/admin/tenants/storage/keys]
  └── Controller: StorageAccessKeyController.generateKey()
        ├── calls: this.storageAccessKeyService.generateKey()
        │     └─ Service: IStorageAccessKeyService [token: IStorageAccessKeyService]
```

**`DELETE /api/v1/admin/tenants/storage/keys/{id}` → `StorageAccessKeyController.revokeKey`**
```text
[DELETE /api/v1/admin/tenants/storage/keys/{id}]
  └── Controller: StorageAccessKeyController.revokeKey()
        ├── calls: this.storageAccessKeyService.revokeKey()
        │     └─ Service: IStorageAccessKeyService [token: IStorageAccessKeyService]
```

---

## Module: `streaming` (31 routes)

### Controller: `AdminTranscriptionJobController`
**File:** [`src/modules/streaming/admin-transcription-job.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/admin-transcription-job.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/audio/transcription-jobs` | `list` | Perms: `read:TranscriptionJob`<br/>Svc: `svc:admin:transcription-job:read` | - | List ALL transcription jobs in the tenant (paginated) |
| `GET` | `/api/v1/admin/audio/transcription-jobs/stats` | `getStats` | Perms: `read:TranscriptionJob`<br/>Svc: `svc:admin:transcription-job:read` | - | Get tenant-wide transcription job status counts |
| `GET` | `/api/v1/admin/audio/transcription-jobs/status/{status}` | `getByStatus` | Perms: `read:TranscriptionJob`<br/>Svc: `svc:admin:transcription-job:read` | - | Get tenant-wide transcription jobs by status |

#### Handler Call Trees:

**`GET /api/v1/admin/audio/transcription-jobs` → `AdminTranscriptionJobController.list`**
```text
[GET /api/v1/admin/audio/transcription-jobs]
  └── Controller: AdminTranscriptionJobController.list()
        ├── calls: this.jobService.list()
        │     └─ Service: TranscriptionJobService
```

**`GET /api/v1/admin/audio/transcription-jobs/stats` → `AdminTranscriptionJobController.getStats`**
```text
[GET /api/v1/admin/audio/transcription-jobs/stats]
  └── Controller: AdminTranscriptionJobController.getStats()
        ├── calls: this.jobService.getStatusCounts()
        │     └─ Service: TranscriptionJobService
```

**`GET /api/v1/admin/audio/transcription-jobs/status/{status}` → `AdminTranscriptionJobController.getByStatus`**
```text
[GET /api/v1/admin/audio/transcription-jobs/status/{status}]
  └── Controller: AdminTranscriptionJobController.getByStatus()
        ├── calls: this.jobService.getByStatus()
        │     └─ Service: TranscriptionJobService
```

### Controller: `TextGenerationAdminController`
**File:** [`src/modules/streaming/text-generation-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-generation-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/text-generations/generate` | `generate` | Perms: `manage:all` | - | Generate text on a pinned provider and model (platform LLM playground) |
| `POST` | `/api/v1/admin/text-generations/generate/assembled` | `generateAssembled` | Perms: `manage:all` | - | Generate text with server-side prompt assembly on a pinned provider and model (platform LLM playground) |

#### Handler Call Trees:

_Handlers in this controller delegate directly or return static/mapped payloads._

### Controller: `TextProxyController`
**File:** [`src/modules/streaming/text-proxy.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/text-generations/generate` | `generate` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | - |
| `POST` | `/api/v1/text-generations/generate/assembled` | `generateAssembled` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Generate text with server-side prompt assembly (debug mode) |
| `GET` | `/api/v1/text-generations/guardrail-providers` | `getGuardrailProviders` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | List Guardrail LLM providers/models from the AiModel registry (ENABLED GUARDRAIL rows), the effective guardrail.validate default marked. SUPER_ADMINs may explicitly target the GLOBAL tenant with ?tenantKey=__GLOBAL__. |
| `GET` | `/api/v1/text-generations/providers` | `getProviders` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | List LLM providers/models from the AiModel registry (ENABLED TEXT_GENERATION/SUMMARIZATION rows), with a live TEXT probe fallback when the registry is empty. SUPER_ADMINs may explicitly target the GLOBAL tenant with ?tenantKey=__GLOBAL__. |
| `GET` | `/api/v1/text-generations/tasks/{taskId}` | `getTaskStatus` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Get task status from TEXT |
| `POST` | `/api/v1/text-generations/tasks/{taskId}/cancel` | `cancelTask` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Cancel a running TEXT task |
| `GET` | `/api/v1/text-generations/tasks/{taskId}/stream` | `streamTaskEvents` | Auth<br/>API Key: `consultation:report:write`<br/>Svc: `svc:consultation:report:write` | - | Stream task chunks via SSE from TEXT |

#### Handler Call Trees:

**`GET /api/v1/text-generations/guardrail-providers` → `TextProxyController.getGuardrailProviders`**
```text
[GET /api/v1/text-generations/guardrail-providers]
  └── Controller: TextProxyController.getGuardrailProviders()
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls helper: this.resolveTenantId()
        │     ├── calls: this.clsService.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.tenantService.fetchByCodeName()
        │     │     └─ Service: ITenantService [token: ITenantService]
        │     ├── calls: this.clsService.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.fetchRegistryModels()
        │     ├── calls: this.logger.warn()
        │     │     └─ Service: unknown
```

**`GET /api/v1/text-generations/providers` → `TextProxyController.getProviders`**
```text
[GET /api/v1/text-generations/providers]
  └── Controller: TextProxyController.getProviders()
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls helper: this.getTextBaseUrl()
        │     ├── calls: this.configService.getConfigValue()
        │     │     └─ Service: IConfigService [token: IConfigService]
        ├── calls helper: this.fetchRegistryModels()
        │     ├── calls: this.logger.warn()
        │     │     └─ Service: unknown
        ├── calls helper: this.resolveTenantId()
        │     ├── calls: this.clsService.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.tenantService.fetchByCodeName()
        │     │     └─ Service: ITenantService [token: ITenantService]
        │     ├── calls: this.clsService.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/text-generations/tasks/{taskId}` → `TextProxyController.getTaskStatus`**
```text
[GET /api/v1/text-generations/tasks/{taskId}]
  └── Controller: TextProxyController.getTaskStatus()
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls helper: this.buildUpstreamException()
        │     ├── calls: this.logger.error()
        │     │     └─ Service: unknown
        │     ├── calls: this.clsService.getId()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.getTextBaseUrl()
        │     ├── calls: this.configService.getConfigValue()
        │     │     └─ Service: IConfigService [token: IConfigService]
```

**`POST /api/v1/text-generations/tasks/{taskId}/cancel` → `TextProxyController.cancelTask`**
```text
[POST /api/v1/text-generations/tasks/{taskId}/cancel]
  └── Controller: TextProxyController.cancelTask()
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls helper: this.buildUpstreamException()
        │     ├── calls: this.logger.error()
        │     │     └─ Service: unknown
        │     ├── calls: this.clsService.getId()
        │     │     └─ Service: ClsService<IActiveUserContext>
        ├── calls helper: this.getTextBaseUrl()
        │     ├── calls: this.configService.getConfigValue()
        │     │     └─ Service: IConfigService [token: IConfigService]
```

**`GET /api/v1/text-generations/tasks/{taskId}/stream` → `TextProxyController.streamTaskEvents`**
```text
[GET /api/v1/text-generations/tasks/{taskId}/stream]
  └── Controller: TextProxyController.streamTaskEvents()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls: this.logger.error()
        │     └─ Service: unknown
        ├── calls helper: this.getTextBaseUrl()
        │     ├── calls: this.configService.getConfigValue()
        │     │     └─ Service: IConfigService [token: IConfigService]
```

### Controller: `TranscriptionJobController`
**File:** [`src/modules/streaming/transcription-job.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/audio/transcription-jobs` | `list` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | List transcription jobs (paginated, caller-owned jobs) |
| `POST` | `/api/v1/audio/transcription-jobs` | `create` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Create a transcription job |
| `GET` | `/api/v1/audio/transcription-jobs/{id}` | `getById` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Get transcription job by ID |
| `POST` | `/api/v1/audio/transcription-jobs/{id}/cancel` | `cancel` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Cancel a transcription job |
| `POST` | `/api/v1/audio/transcription-jobs/{id}/retry` | `retry` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Retry a failed transcription job |
| `GET` | `/api/v1/audio/transcription-jobs/{id}/stream` | `streamJob` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Stream transcription job events via SSE |
| `POST` | `/api/v1/audio/transcription-jobs/batch` | `createBatch` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Create a batch transcription job |
| `GET` | `/api/v1/audio/transcription-jobs/consultation/{consultationId}` | `getByConsultation` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Get transcription jobs by consultation (caller-owned jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/language-modes` | `getLanguageModes` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | List selectable spoken-language modes, judged against an ASR agent’s engine chain |
| `GET` | `/api/v1/audio/transcription-jobs/limits` | `getBatchLimits` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Batch upload ceilings (recordings per batch, minutes per recording, size, in-flight jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/stats` | `getStats` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Get transcription job status counts (caller-owned jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/status/{status}` | `getByStatus` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Get transcription jobs by status (caller-owned jobs) |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session` | `createStreamSession` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Create a WebSocket streaming session |
| `DELETE` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}` | `closeStreamSession` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Close a WebSocket streaming session |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/refresh-ticket` | `refreshStreamTicket` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Refresh the stream ticket for a live streaming session |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/switch-to-fallback` | `switchStreamSessionToFallback` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Switch a live streaming session to its ASR agent's fallback engine |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/switch-to-primary` | `switchStreamSessionToPrimary` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Switch a live streaming session back to its primary pipeline |
| `POST` | `/api/v1/audio/transcription-jobs/streaming` | `createStreaming` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Create a streaming transcription job |
| `POST` | `/api/v1/audio/transcription-jobs/transcribe` | `transcribeFile` | Auth<br/>API Key: `stt:transcription:write`<br/>Svc: `svc:stt:transcription:write` | - | Upload audio file for batch transcription via worker |

#### Handler Call Trees:

**`GET /api/v1/audio/transcription-jobs` → `TranscriptionJobController.list`**
```text
[GET /api/v1/audio/transcription-jobs]
  └── Controller: TranscriptionJobController.list()
        ├── calls: this.jobService.listForOwner()
        │     └─ Service: TranscriptionJobService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/audio/transcription-jobs` → `TranscriptionJobController.create`**
```text
[POST /api/v1/audio/transcription-jobs]
  └── Controller: TranscriptionJobController.create()
        ├── calls: this.jobService.create()
        │     └─ Service: TranscriptionJobService
```

**`GET /api/v1/audio/transcription-jobs/{id}` → `TranscriptionJobController.getById`**
```text
[GET /api/v1/audio/transcription-jobs/{id}]
  └── Controller: TranscriptionJobController.getById()
        ├── calls: this.jobService.getById()
        │     └─ Service: TranscriptionJobService
```

**`POST /api/v1/audio/transcription-jobs/{id}/cancel` → `TranscriptionJobController.cancel`**
```text
[POST /api/v1/audio/transcription-jobs/{id}/cancel]
  └── Controller: TranscriptionJobController.cancel()
        ├── calls: this.jobService.cancelJobForOwner()
        │     └─ Service: TranscriptionJobService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/audio/transcription-jobs/{id}/retry` → `TranscriptionJobController.retry`**
```text
[POST /api/v1/audio/transcription-jobs/{id}/retry]
  └── Controller: TranscriptionJobController.retry()
        ├── calls: this.realtimeService.retryAndDispatch()
        │     └─ Service: TranscriptionRealtimeService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/audio/transcription-jobs/{id}/stream` → `TranscriptionJobController.streamJob`**
```text
[GET /api/v1/audio/transcription-jobs/{id}/stream]
  └── Controller: TranscriptionJobController.streamJob()
        ├── calls: this.realtimeService.subscribeToJob()
        │     └─ Service: TranscriptionRealtimeService
```

**`POST /api/v1/audio/transcription-jobs/batch` → `TranscriptionJobController.createBatch`**
```text
[POST /api/v1/audio/transcription-jobs/batch]
  └── Controller: TranscriptionJobController.createBatch()
        ├── calls: this.jobService.createBatchJob()
        │     └─ Service: TranscriptionJobService
```

**`GET /api/v1/audio/transcription-jobs/consultation/{consultationId}` → `TranscriptionJobController.getByConsultation`**
```text
[GET /api/v1/audio/transcription-jobs/consultation/{consultationId}]
  └── Controller: TranscriptionJobController.getByConsultation()
        ├── calls: this.jobService.getByConsultationForOwner()
        │     └─ Service: TranscriptionJobService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/audio/transcription-jobs/language-modes` → `TranscriptionJobController.getLanguageModes`**
```text
[GET /api/v1/audio/transcription-jobs/language-modes]
  └── Controller: TranscriptionJobController.getLanguageModes()
        ├── calls: this.sessionService.getLanguageModes()
        │     └─ Service: StreamingSessionService
        ├── calls: this.languageCapability.catalogFor()
        │     └─ Service: AsrLanguageCapabilityService
```

**`GET /api/v1/audio/transcription-jobs/stats` → `TranscriptionJobController.getStats`**
```text
[GET /api/v1/audio/transcription-jobs/stats]
  └── Controller: TranscriptionJobController.getStats()
        ├── calls: this.jobService.getStatusCountsForOwner()
        │     └─ Service: TranscriptionJobService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/audio/transcription-jobs/status/{status}` → `TranscriptionJobController.getByStatus`**
```text
[GET /api/v1/audio/transcription-jobs/status/{status}]
  └── Controller: TranscriptionJobController.getByStatus()
        ├── calls: this.jobService.getByStatusForOwner()
        │     └─ Service: TranscriptionJobService
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/audio/transcription-jobs/stream/session` → `TranscriptionJobController.createStreamSession`**
```text
[POST /api/v1/audio/transcription-jobs/stream/session]
  └── Controller: TranscriptionJobController.createStreamSession()
        ├── calls: this.entitlements.assertConcurrencyQuota()
        │     └─ Service: IEntitlementsService [token: IEntitlementsService]
        ├── calls: this.tenantBucketService.getBucketByPurpose()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
        ├── calls: this.tenantBucketService.getBucketBySlug()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
        ├── calls: this.tenantBucketService.getBucketBySlug()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
        ├── calls: this.blobStorage.resolveDescriptor()
        │     └─ Service: IBlobStorageServiceType [token: IBlobStorageService]
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
        ├── calls: this.logger.log()
        │     └─ Service: unknown
        ├── calls: this.sessionService.createSession()
        │     └─ Service: StreamingSessionService
        ├── calls: this.streamTicketService.issueTicket()
        │     └─ Service: StreamTicketService
        ├── calls: this.streamSessionTenantBinding.bind()
        │     └─ Service: StreamSessionTenantBindingService
        ├── calls: this.streamSessionTenantBinding.bindSessionMeta()
        │     └─ Service: StreamSessionTenantBindingService
        ├── calls: this.sessionService.removeSession()
        │     └─ Service: StreamingSessionService
        ├── calls: this.streamSessionTenantBinding.clear()
        │     └─ Service: StreamSessionTenantBindingService
        ├── calls helper: this.resolveAsrAgent()
        │     ├── calls: this.asrResolver.resolve()
        │     │     └─ Service: AsrAgentResolverService
        ├── calls helper: this.resolveStreamOwnerId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/audio/transcription-jobs/stream/session/{sessionId}` → `TranscriptionJobController.closeStreamSession`**
```text
[DELETE /api/v1/audio/transcription-jobs/stream/session/{sessionId}]
  └── Controller: TranscriptionJobController.closeStreamSession()
        ├── calls: this.sessionService.removeSession()
        │     └─ Service: StreamingSessionService
        ├── calls: this.streamSessionTenantBinding.clear()
        │     └─ Service: StreamSessionTenantBindingService
```

**`POST /api/v1/audio/transcription-jobs/streaming` → `TranscriptionJobController.createStreaming`**
```text
[POST /api/v1/audio/transcription-jobs/streaming]
  └── Controller: TranscriptionJobController.createStreaming()
        ├── calls: this.jobService.createStreamingJob()
        │     └─ Service: TranscriptionJobService
```

**`POST /api/v1/audio/transcription-jobs/transcribe` → `TranscriptionJobController.transcribeFile`**
```text
[POST /api/v1/audio/transcription-jobs/transcribe]
  └── Controller: TranscriptionJobController.transcribeFile()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.jobIdempotency.run()
        │     └─ Service: JobIdempotencyService
```

---

## Module: `tenant` (20 routes)

### Controller: `MyTenantController`
**File:** [`src/modules/tenant/my-tenant.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant/my-tenant.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/tenants/me` | `me` | Auth<br/>API Key: `tenant:profile:read` | - | Get current tenant information |
| `GET` | `/api/v1/tenants/me/config` | `myConfig` | Auth<br/>API Key: `tenant:profile:read` | - | Get current tenant configuration |
| `PATCH` | `/api/v1/tenants/me/config` | `updateMyConfig` | Perms: `update:Tenant`<br/>API Key: `tenant:profile:write` | Yes | Update current tenant configuration |

#### Handler Call Trees:

**`GET /api/v1/tenants/me` → `MyTenantController.me`**
```text
[GET /api/v1/tenants/me]
  └── Controller: MyTenantController.me()
        ├── calls: this.tenantService.fetchById()
        │     └─ Service: ITenantService [token: ITenantService]
```

**`GET /api/v1/tenants/me/config` → `MyTenantController.myConfig`**
```text
[GET /api/v1/tenants/me/config]
  └── Controller: MyTenantController.myConfig()
        ├── calls: this.tenantService.fetchTenantConfigs()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls: this.tenantFrontendConfigService.resolveEffectiveLocalRawCapture()
        │     └─ Service: ITenantFrontendConfigService [token: ITenantFrontendConfigService]
```

**`PATCH /api/v1/tenants/me/config` → `MyTenantController.updateMyConfig`**
```text
[PATCH /api/v1/tenants/me/config]
  └── Controller: MyTenantController.updateMyConfig()
        ├── calls: this.tenantService.updateTenantConfigs()
        │     └─ Service: ITenantService [token: ITenantService]
```

### Controller: `TenantController`
**File:** [`src/modules/tenant/tenant.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant/tenant.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenants` | `fetchAll` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Retrieving multiple TenantResponses |
| `POST` | `/api/v1/admin/tenants` | `create` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Creating a TenantResponse |
| `DELETE` | `/api/v1/admin/tenants/{id}` | `delete` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Deleting a TenantResponse by id |
| `GET` | `/api/v1/admin/tenants/{id}` | `fetchById` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Retrieving a single TenantResponse by id |
| `PATCH` | `/api/v1/admin/tenants/{id}` | `update` | Perms: `manage:Tenant:update:Tenant`<br/>Svc: `svc:admin:tenant:write` | Yes | Updating a TenantResponse by id |
| `POST` | `/api/v1/admin/tenants/{id}/archive` | `archive` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Archive a tenant (recoverable cold state) |
| `POST` | `/api/v1/admin/tenants/{id}/restore` | `restore` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Restore a suspended, archived or deleted tenant to ENABLED |
| `POST` | `/api/v1/admin/tenants/{id}/suspend` | `suspend` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Suspend a tenant (reversible operator hold) |
| `GET` | `/api/v1/admin/tenants/{id}/tags` | `getTags` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Read a tenant's tags |
| `PUT` | `/api/v1/admin/tenants/{id}/tags` | `setTags` | Perms: `manage:Tenant:update:Tenant`<br/>Svc: `svc:admin:tenant:write` | Yes | Replace a tenant's full tag set (idempotent set-semantics) |
| `GET` | `/api/v1/admin/tenants/{id}/usage` | `getUsage` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Get tenant usage statistics |
| `GET` | `/api/v1/admin/tenants/code-name/{codeName}` | `fetchByCodeName` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Retrieving a single TenantResponse by code-name |
| `GET` | `/api/v1/admin/tenants/configs/{identifier}` | `fetchTenantConfigs` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Retrieving multiple PaginatedTenantConfigResponses by identifier |
| `PATCH` | `/api/v1/admin/tenants/configs/{identifier}` | `updateTenantConfigs` | Perms: `manage:Tenant:update:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Updating a PaginatedTenantConfigResponse by identifier |
| `GET` | `/api/v1/admin/tenants/user/{userId}` | `fetchByUserId` | Perms: `manage:Tenant:update:Tenant:read:AdminTenantDirectory`<br/>Svc: `svc:admin:tenant:read,svc:admin:tenant:write` | - | Retrieving multiple TenantResponses by createdByUserId |

#### Handler Call Trees:

**`GET /api/v1/admin/tenants` → `TenantController.fetchAll`**
```text
[GET /api/v1/admin/tenants]
  └── Controller: TenantController.fetchAll()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.tenantService.fetchById()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls: this.tenantService.fetchAll()
        │     └─ Service: ITenantService [token: ITenantService]
```

**`POST /api/v1/admin/tenants` → `TenantController.create`**
```text
[POST /api/v1/admin/tenants]
  └── Controller: TenantController.create()
        ├── calls: this.tenantService.create()
        │     └─ Service: ITenantService [token: ITenantService]
```

**`DELETE /api/v1/admin/tenants/{id}` → `TenantController.delete`**
```text
[DELETE /api/v1/admin/tenants/{id}]
  └── Controller: TenantController.delete()
        ├── calls: this.tenantService.deleteById()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PATCH /api/v1/admin/tenants/{id}` → `TenantController.update`**
```text
[PATCH /api/v1/admin/tenants/{id}]
  └── Controller: TenantController.update()
        ├── calls: this.tenantService.update()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{id}/archive` → `TenantController.archive`**
```text
[POST /api/v1/admin/tenants/{id}/archive]
  └── Controller: TenantController.archive()
        ├── calls: this.tenantService.archive()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{id}/restore` → `TenantController.restore`**
```text
[POST /api/v1/admin/tenants/{id}/restore]
  └── Controller: TenantController.restore()
        ├── calls: this.tenantService.restore()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{id}/suspend` → `TenantController.suspend`**
```text
[POST /api/v1/admin/tenants/{id}/suspend]
  └── Controller: TenantController.suspend()
        ├── calls: this.tenantService.suspend()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PUT /api/v1/admin/tenants/{id}/tags` → `TenantController.setTags`**
```text
[PUT /api/v1/admin/tenants/{id}/tags]
  └── Controller: TenantController.setTags()
        ├── calls: this.tenantService.setTags()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/{id}/usage` → `TenantController.getUsage`**
```text
[GET /api/v1/admin/tenants/{id}/usage]
  └── Controller: TenantController.getUsage()
        ├── calls: this.tenantService.getUsageStats()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/code-name/{codeName}` → `TenantController.fetchByCodeName`**
```text
[GET /api/v1/admin/tenants/code-name/{codeName}]
  └── Controller: TenantController.fetchByCodeName()
        ├── calls: this.tenantService.fetchByCodeName()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertTenantInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/configs/{identifier}` → `TenantController.fetchTenantConfigs`**
```text
[GET /api/v1/admin/tenants/configs/{identifier}]
  └── Controller: TenantController.fetchTenantConfigs()
        ├── calls: this.tenantService.fetchTenantConfigs()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertConfigInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`PATCH /api/v1/admin/tenants/configs/{identifier}` → `TenantController.updateTenantConfigs`**
```text
[PATCH /api/v1/admin/tenants/configs/{identifier}]
  └── Controller: TenantController.updateTenantConfigs()
        ├── calls: this.tenantService.updateTenantConfigs()
        │     └─ Service: ITenantService [token: ITenantService]
        ├── calls helper: this.assertConfigInScope()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/user/{userId}` → `TenantController.fetchByUserId`**
```text
[GET /api/v1/admin/tenants/user/{userId}]
  └── Controller: TenantController.fetchByUserId()
        ├── calls: this.tenantService.fetchAllCreatedByUser()
        │     └─ Service: ITenantService [token: ITenantService]
```

### Controller: `TenantProvisionController`
**File:** [`src/modules/tenant/tenant-provision.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant/tenant-provision.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/tenants/provision` | `provision` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Creating a TenantProvisionResponse |

#### Handler Call Trees:

**`POST /api/v1/admin/tenants/provision` → `TenantProvisionController.provision`**
```text
[POST /api/v1/admin/tenants/provision]
  └── Controller: TenantProvisionController.provision()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.tenantOnboardingService.provisionTenantWithAdmin()
        │     └─ Service: ITenantOnboardingService [token: ITenantOnboardingService]
```

### Controller: `TenantReferenceSetController`
**File:** [`src/modules/tenant/tenant-reference-set.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant/tenant-reference-set.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/tenants/{id}/reference-set/sync` | `sync` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant:write` | - | Re-provision a tenant from the platform's SYSTEM reference set |

#### Handler Call Trees:

**`POST /api/v1/admin/tenants/{id}/reference-set/sync` → `TenantReferenceSetController.sync`**
```text
[POST /api/v1/admin/tenants/{id}/reference-set/sync]
  └── Controller: TenantReferenceSetController.sync()
        ├── calls: this.referenceSet.resync()
        │     └─ Service: ITenantReferenceSetService [token: ITenantReferenceSetService]
```

---

## Module: `tenant-allowed-origin` (6 routes)

### Controller: `TenantAllowedOriginController`
**File:** [`src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/allowed-origins` | `getAll` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | - | List the caller tenant's allowed-origin rows |
| `POST` | `/api/v1/admin/allowed-origins` | `create` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | - | Register a new allowed origin |
| `DELETE` | `/api/v1/admin/allowed-origins/{id}` | `deleteById` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | - | Soft-delete an allowed-origin row |
| `GET` | `/api/v1/admin/allowed-origins/{id}` | `getById` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | - | Get one allowed-origin row by id |
| `PATCH` | `/api/v1/admin/allowed-origins/{id}` | `update` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | Yes | Update an allowed-origin row under optimistic concurrency |
| `GET` | `/api/v1/admin/allowed-origins/posture` | `getPosture` | Perms: `manage:TenantAllowedOrigin`<br/>Svc: `svc:admin:allowed-origin:manage` | - | Report whether origin enforcement is currently ON, platform-wide (FR-4). |

#### Handler Call Trees:

**`GET /api/v1/admin/allowed-origins` → `TenantAllowedOriginController.getAll`**
```text
[GET /api/v1/admin/allowed-origins]
  └── Controller: TenantAllowedOriginController.getAll()
        ├── calls: this.tenantAllowedOriginService.getAll()
        │     └─ Service: ITenantAllowedOriginService [token: ITenantAllowedOriginService]
```

**`POST /api/v1/admin/allowed-origins` → `TenantAllowedOriginController.create`**
```text
[POST /api/v1/admin/allowed-origins]
  └── Controller: TenantAllowedOriginController.create()
        ├── calls: this.tenantAllowedOriginService.create()
        │     └─ Service: ITenantAllowedOriginService [token: ITenantAllowedOriginService]
```

**`DELETE /api/v1/admin/allowed-origins/{id}` → `TenantAllowedOriginController.deleteById`**
```text
[DELETE /api/v1/admin/allowed-origins/{id}]
  └── Controller: TenantAllowedOriginController.deleteById()
        ├── calls: this.tenantAllowedOriginService.deleteById()
        │     └─ Service: ITenantAllowedOriginService [token: ITenantAllowedOriginService]
```

**`GET /api/v1/admin/allowed-origins/{id}` → `TenantAllowedOriginController.getById`**
```text
[GET /api/v1/admin/allowed-origins/{id}]
  └── Controller: TenantAllowedOriginController.getById()
        ├── calls: this.tenantAllowedOriginService.getById()
        │     └─ Service: ITenantAllowedOriginService [token: ITenantAllowedOriginService]
```

**`PATCH /api/v1/admin/allowed-origins/{id}` → `TenantAllowedOriginController.update`**
```text
[PATCH /api/v1/admin/allowed-origins/{id}]
  └── Controller: TenantAllowedOriginController.update()
        ├── calls: this.tenantAllowedOriginService.update()
        │     └─ Service: ITenantAllowedOriginService [token: ITenantAllowedOriginService]
```

---

## Module: `tenant-bucket` (13 routes)

### Controller: `TenantBucketController`
**File:** [`src/modules/tenant-bucket/tenant-bucket.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenants/storage/buckets` | `listBuckets` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | List all storage buckets for current tenant |
| `POST` | `/api/v1/admin/tenants/storage/buckets` | `createBucket` | Perms: `create:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Create a custom storage bucket |
| `DELETE` | `/api/v1/admin/tenants/storage/buckets/{id}` | `deleteBucket` | Perms: `delete:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Delete a custom storage bucket (system buckets cannot be deleted) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}` | `getBucket` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Get bucket by ID |
| `DELETE` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | `deleteObject` | Perms: `delete:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Delete a single object from a tenant bucket (storage-provider operation) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | `listObjects` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | List objects in a tenant bucket (storage-provider operation) |
| `POST` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | `uploadObject` | Perms: `create:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Upload a single object into a tenant bucket (storage-provider operation) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/presigned-url` | `getPresignedUrl` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Get presigned download URL for a file in a tenant bucket |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/tree` | `getBucketTree` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Get bucket folder/file tree for UI tree view |
| `GET` | `/api/v1/admin/tenants/storage/buckets/defaults` | `getDefaultBuckets` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Get the default bucket for each purpose (audio / attachments / misc) |
| `PUT` | `/api/v1/admin/tenants/storage/buckets/defaults` | `setDefaultBuckets` | Perms: `update:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Configure the default bucket for audio / attachments / misc |
| `POST` | `/api/v1/admin/tenants/storage/buckets/provision/{tenantId}` | `provisionSystemBuckets` | Perms: `manage:Tenant`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Provision system buckets for a tenant (admin only) |
| `POST` | `/api/v1/admin/tenants/storage/buckets/register` | `adoptBucket` | Perms: `create:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Adopt an existing physical bucket into a tenant |

#### Handler Call Trees:

**`GET /api/v1/admin/tenants/storage/buckets` → `TenantBucketController.listBuckets`**
```text
[GET /api/v1/admin/tenants/storage/buckets]
  └── Controller: TenantBucketController.listBuckets()
        ├── calls: this.tenantBucketService.listBuckets()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`POST /api/v1/admin/tenants/storage/buckets` → `TenantBucketController.createBucket`**
```text
[POST /api/v1/admin/tenants/storage/buckets]
  └── Controller: TenantBucketController.createBucket()
        ├── calls: this.tenantBucketService.createCustomBucket()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`DELETE /api/v1/admin/tenants/storage/buckets/{id}` → `TenantBucketController.deleteBucket`**
```text
[DELETE /api/v1/admin/tenants/storage/buckets/{id}]
  └── Controller: TenantBucketController.deleteBucket()
        ├── calls: this.tenantBucketService.deleteBucket()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`GET /api/v1/admin/tenants/storage/buckets/{id}` → `TenantBucketController.getBucket`**
```text
[GET /api/v1/admin/tenants/storage/buckets/{id}]
  └── Controller: TenantBucketController.getBucket()
        ├── calls: this.tenantBucketService.getBucketById()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`DELETE /api/v1/admin/tenants/storage/buckets/{id}/objects` → `TenantBucketController.deleteObject`**
```text
[DELETE /api/v1/admin/tenants/storage/buckets/{id}/objects]
  └── Controller: TenantBucketController.deleteObject()
        ├── calls: this.tenantBucketService.deleteObject()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`GET /api/v1/admin/tenants/storage/buckets/{id}/objects` → `TenantBucketController.listObjects`**
```text
[GET /api/v1/admin/tenants/storage/buckets/{id}/objects]
  └── Controller: TenantBucketController.listObjects()
        ├── calls: this.tenantBucketService.listObjects()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`POST /api/v1/admin/tenants/storage/buckets/{id}/objects` → `TenantBucketController.uploadObject`**
```text
[POST /api/v1/admin/tenants/storage/buckets/{id}/objects]
  └── Controller: TenantBucketController.uploadObject()
        ├── calls: this.tenantBucketService.uploadObject()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`GET /api/v1/admin/tenants/storage/buckets/{id}/tree` → `TenantBucketController.getBucketTree`**
```text
[GET /api/v1/admin/tenants/storage/buckets/{id}/tree]
  └── Controller: TenantBucketController.getBucketTree()
        ├── calls: this.tenantBucketService.getBucketTree()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`GET /api/v1/admin/tenants/storage/buckets/defaults` → `TenantBucketController.getDefaultBuckets`**
```text
[GET /api/v1/admin/tenants/storage/buckets/defaults]
  └── Controller: TenantBucketController.getDefaultBuckets()
        ├── calls: this.tenantBucketService.getDefaultBuckets()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`PUT /api/v1/admin/tenants/storage/buckets/defaults` → `TenantBucketController.setDefaultBuckets`**
```text
[PUT /api/v1/admin/tenants/storage/buckets/defaults]
  └── Controller: TenantBucketController.setDefaultBuckets()
        ├── calls: this.tenantBucketService.setDefaultBuckets()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`POST /api/v1/admin/tenants/storage/buckets/provision/{tenantId}` → `TenantBucketController.provisionSystemBuckets`**
```text
[POST /api/v1/admin/tenants/storage/buckets/provision/{tenantId}]
  └── Controller: TenantBucketController.provisionSystemBuckets()
        ├── calls: this.tenantBucketService.provisionSystemBuckets()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

**`POST /api/v1/admin/tenants/storage/buckets/register` → `TenantBucketController.adoptBucket`**
```text
[POST /api/v1/admin/tenants/storage/buckets/register]
  └── Controller: TenantBucketController.adoptBucket()
        ├── calls: this.tenantBucketService.adoptPhysicalBucket()
        │     └─ Service: ITenantBucketService [token: ITenantBucketService]
```

---

## Module: `tenant-checkpoint` (12 routes)

### Controller: `TenantCheckpointController`
**File:** [`src/modules/tenant-checkpoint/tenant-checkpoint.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-checkpoint/tenant-checkpoint.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenants/{tenantId}/checkpoints` | `list` | Perms: `read:TenantCheckpoint` | - | List a tenant's checkpoints |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints` | `create` | Perms: `create:TenantCheckpoint` | - | Create a checkpoint |
| `DELETE` | `/api/v1/admin/tenants/{tenantId}/checkpoints/{id}` | `remove` | Perms: `delete:TenantCheckpoint` | - | Delete a checkpoint |
| `GET` | `/api/v1/admin/tenants/{tenantId}/checkpoints/{id}` | `get` | Perms: `read:TenantCheckpoint` | - | Get one checkpoint |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/{id}/cancel` | `cancel` | Perms: `update:TenantCheckpoint` | - | Cancel a running checkpoint export |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/{id}/download-url` | `downloadUrl` | Perms: `read:TenantCheckpoint` | - | Issue a download URL |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/{id}/restore` | `restore` | Perms: `manage:TenantCheckpoint` | - | Restore a tenant from a checkpoint |
| `GET` | `/api/v1/admin/tenants/{tenantId}/checkpoints/restores` | `listRestores` | Perms: `read:TenantCheckpoint` | - | List a tenant's checkpoint restores |
| `GET` | `/api/v1/admin/tenants/{tenantId}/checkpoints/restores/{restoreId}` | `getRestore` | Perms: `read:TenantCheckpoint` | - | Get one checkpoint restore |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/uploads` | `initUpload` | Perms: `create:TenantCheckpoint` | - | Start a checkpoint upload |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/abort` | `abortUpload` | Perms: `create:TenantCheckpoint` | - | Abort a checkpoint upload |
| `POST` | `/api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/complete` | `completeUpload` | Perms: `create:TenantCheckpoint` | - | Complete a checkpoint upload |

#### Handler Call Trees:

**`GET /api/v1/admin/tenants/{tenantId}/checkpoints` → `TenantCheckpointController.list`**
```text
[GET /api/v1/admin/tenants/{tenantId}/checkpoints]
  └── Controller: TenantCheckpointController.list()
        ├── calls: this.service.list()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints` → `TenantCheckpointController.create`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints]
  └── Controller: TenantCheckpointController.create()
        ├── calls: this.service.create()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`DELETE /api/v1/admin/tenants/{tenantId}/checkpoints/{id}` → `TenantCheckpointController.remove`**
```text
[DELETE /api/v1/admin/tenants/{tenantId}/checkpoints/{id}]
  └── Controller: TenantCheckpointController.remove()
        ├── calls: this.service.delete()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/cancel` → `TenantCheckpointController.cancel`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/cancel]
  └── Controller: TenantCheckpointController.cancel()
        ├── calls: this.service.cancel()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/download-url` → `TenantCheckpointController.downloadUrl`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/download-url]
  └── Controller: TenantCheckpointController.downloadUrl()
        ├── calls: this.service.downloadUrl()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/restore` → `TenantCheckpointController.restore`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/{id}/restore]
  └── Controller: TenantCheckpointController.restore()
        ├── calls: this.service.restore()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/{tenantId}/checkpoints/restores` → `TenantCheckpointController.listRestores`**
```text
[GET /api/v1/admin/tenants/{tenantId}/checkpoints/restores]
  └── Controller: TenantCheckpointController.listRestores()
        ├── calls: this.service.listRestores()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`GET /api/v1/admin/tenants/{tenantId}/checkpoints/restores/{restoreId}` → `TenantCheckpointController.getRestore`**
```text
[GET /api/v1/admin/tenants/{tenantId}/checkpoints/restores/{restoreId}]
  └── Controller: TenantCheckpointController.getRestore()
        ├── calls: this.service.getRestore()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads` → `TenantCheckpointController.initUpload`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads]
  └── Controller: TenantCheckpointController.initUpload()
        ├── calls: this.service.initUpload()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/abort` → `TenantCheckpointController.abortUpload`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/abort]
  └── Controller: TenantCheckpointController.abortUpload()
        ├── calls: this.service.abortUpload()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

**`POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/complete` → `TenantCheckpointController.completeUpload`**
```text
[POST /api/v1/admin/tenants/{tenantId}/checkpoints/uploads/{id}/complete]
  └── Controller: TenantCheckpointController.completeUpload()
        ├── calls: this.service.completeUpload()
        │     └─ Service: ITenantCheckpointService [token: ITenantCheckpointService]
        ├── calls helper: this.pin()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService<IActiveUserContext>
```

---

## Module: `tenant-frontend-config` (2 routes)

### Controller: `TenantFrontendConfigAdminController`
**File:** [`src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenant-frontend-config` | `get` | Perms: `manage:Tenant:update:Tenant`<br/>Svc: `svc:admin:tenant-frontend-config:manage` | - | Get the tenant's frontend pipeline config (null when not yet configured) |
| `PUT` | `/api/v1/admin/tenant-frontend-config` | `upsert` | Perms: `manage:Tenant:update:Tenant`<br/>Svc: `svc:admin:tenant-frontend-config:manage` | - | Create or update the tenant frontend pipeline config |

#### Handler Call Trees:

**`GET /api/v1/admin/tenant-frontend-config` → `TenantFrontendConfigAdminController.get`**
```text
[GET /api/v1/admin/tenant-frontend-config]
  └── Controller: TenantFrontendConfigAdminController.get()
        ├── calls: this.frontendConfigService.getByTenant()
        │     └─ Service: ITenantFrontendConfigService [token: ITenantFrontendConfigService]
```

**`PUT /api/v1/admin/tenant-frontend-config` → `TenantFrontendConfigAdminController.upsert`**
```text
[PUT /api/v1/admin/tenant-frontend-config]
  └── Controller: TenantFrontendConfigAdminController.upsert()
        ├── calls: this.frontendConfigService.upsert()
        │     └─ Service: ITenantFrontendConfigService [token: ITenantFrontendConfigService]
```

---

## Module: `tenant-idp-config` (8 routes)

### Controller: `TenantIdpConfigAdminController`
**File:** [`src/modules/tenant-idp-config/tenant-idp-config-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-idp-config/tenant-idp-config-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenant-idp-config` | `list` | Perms: `read:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | List a tenant's configured external identity providers |
| `POST` | `/api/v1/admin/tenant-idp-config` | `create` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | Configure a new external OIDC identity provider (starts DRAFT — D7, no self-lockout) |
| `DELETE` | `/api/v1/admin/tenant-idp-config/{id}` | `remove` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | Remove an identity provider config |
| `GET` | `/api/v1/admin/tenant-idp-config/{id}` | `getById` | Perms: `read:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | Get one identity provider config |
| `PUT` | `/api/v1/admin/tenant-idp-config/{id}` | `update` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | Yes | Update an identity provider config under optimistic concurrency |
| `PUT` | `/api/v1/admin/tenant-idp-config/{id}/directory-credentials` | `setDirectoryCredentials` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | Yes | Seal a directory-API credential bundle for admin-triggered sync (P3) |
| `POST` | `/api/v1/admin/tenant-idp-config/{id}/sync` | `syncDirectory` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | Bulk-pull the provider's directory (MS Graph / Google) and pre-provision users (P3) |
| `POST` | `/api/v1/admin/tenant-idp-config/{id}/test` | `testConnection` | Perms: `manage:TenantIdentityProvider`<br/>Svc: `svc:admin:tenant-idp-config:manage` | - | Test connection — OIDC discovery + client construction (D7) |

#### Handler Call Trees:

**`GET /api/v1/admin/tenant-idp-config` → `TenantIdpConfigAdminController.list`**
```text
[GET /api/v1/admin/tenant-idp-config]
  └── Controller: TenantIdpConfigAdminController.list()
        ├── calls: this.configService.list()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`POST /api/v1/admin/tenant-idp-config` → `TenantIdpConfigAdminController.create`**
```text
[POST /api/v1/admin/tenant-idp-config]
  └── Controller: TenantIdpConfigAdminController.create()
        ├── calls: this.configService.create()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`DELETE /api/v1/admin/tenant-idp-config/{id}` → `TenantIdpConfigAdminController.remove`**
```text
[DELETE /api/v1/admin/tenant-idp-config/{id}]
  └── Controller: TenantIdpConfigAdminController.remove()
        ├── calls: this.configService.remove()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`GET /api/v1/admin/tenant-idp-config/{id}` → `TenantIdpConfigAdminController.getById`**
```text
[GET /api/v1/admin/tenant-idp-config/{id}]
  └── Controller: TenantIdpConfigAdminController.getById()
        ├── calls: this.configService.getById()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`PUT /api/v1/admin/tenant-idp-config/{id}` → `TenantIdpConfigAdminController.update`**
```text
[PUT /api/v1/admin/tenant-idp-config/{id}]
  └── Controller: TenantIdpConfigAdminController.update()
        ├── calls: this.configService.update()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`PUT /api/v1/admin/tenant-idp-config/{id}/directory-credentials` → `TenantIdpConfigAdminController.setDirectoryCredentials`**
```text
[PUT /api/v1/admin/tenant-idp-config/{id}/directory-credentials]
  └── Controller: TenantIdpConfigAdminController.setDirectoryCredentials()
        ├── calls: this.configService.setDirectoryCredentials()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

**`POST /api/v1/admin/tenant-idp-config/{id}/sync` → `TenantIdpConfigAdminController.syncDirectory`**
```text
[POST /api/v1/admin/tenant-idp-config/{id}/sync]
  └── Controller: TenantIdpConfigAdminController.syncDirectory()
        ├── calls: this.directorySyncService.enqueueSync()
        │     └─ Service: DirectorySyncService
```

**`POST /api/v1/admin/tenant-idp-config/{id}/test` → `TenantIdpConfigAdminController.testConnection`**
```text
[POST /api/v1/admin/tenant-idp-config/{id}/test]
  └── Controller: TenantIdpConfigAdminController.testConnection()
        ├── calls: this.configService.testConnection()
        │     └─ Service: ITenantIdpConfigService [token: ITenantIdpConfigService]
```

---

## Module: `tenant-storage-config` (6 routes)

### Controller: `TenantStorageConfigAdminController`
**File:** [`src/modules/tenant-storage-config/tenant-storage-config-admin.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-storage-config/tenant-storage-config-admin.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/tenants/storage/config` | `listConfigs` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | List storage configs for the current tenant (default + per-bucket overrides) |
| `PUT` | `/api/v1/admin/tenants/storage/config` | `upsertConfig` | Perms: `update:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Create or update a storage config (keyed by bucketId; omit for the tenant default) |
| `DELETE` | `/api/v1/admin/tenants/storage/config/{id}` | `deleteConfig` | Perms: `delete:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Delete a storage config (reverts that scope to the next-broader config / global) |
| `GET` | `/api/v1/admin/tenants/storage/config/effective` | `getEffectiveConfig` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Resolve the effective config for a bucket (per-bucket override → tenant default → SYSTEM default) |
| `GET` | `/api/v1/admin/tenants/storage/config/platform` | `getPlatformDefault` | Perms: `read:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | - | Read the platform-default storage config (SYSTEM row) — SUPER_ADMIN only |
| `PUT` | `/api/v1/admin/tenants/storage/config/platform` | `upsertPlatformDefault` | Perms: `update:Storage`<br/>Svc: `svc:admin:tenant-storage:manage` | Yes | Create or update the platform-default storage config under optimistic concurrency — SUPER_ADMIN only |

#### Handler Call Trees:

**`GET /api/v1/admin/tenants/storage/config` → `TenantStorageConfigAdminController.listConfigs`**
```text
[GET /api/v1/admin/tenants/storage/config]
  └── Controller: TenantStorageConfigAdminController.listConfigs()
        ├── calls: this.storageConfigService.listConfigs()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

**`PUT /api/v1/admin/tenants/storage/config` → `TenantStorageConfigAdminController.upsertConfig`**
```text
[PUT /api/v1/admin/tenants/storage/config]
  └── Controller: TenantStorageConfigAdminController.upsertConfig()
        ├── calls: this.storageConfigService.upsertConfig()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

**`DELETE /api/v1/admin/tenants/storage/config/{id}` → `TenantStorageConfigAdminController.deleteConfig`**
```text
[DELETE /api/v1/admin/tenants/storage/config/{id}]
  └── Controller: TenantStorageConfigAdminController.deleteConfig()
        ├── calls: this.storageConfigService.deleteConfig()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

**`GET /api/v1/admin/tenants/storage/config/effective` → `TenantStorageConfigAdminController.getEffectiveConfig`**
```text
[GET /api/v1/admin/tenants/storage/config/effective]
  └── Controller: TenantStorageConfigAdminController.getEffectiveConfig()
        ├── calls: this.storageConfigService.getEffectiveConfig()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

**`GET /api/v1/admin/tenants/storage/config/platform` → `TenantStorageConfigAdminController.getPlatformDefault`**
```text
[GET /api/v1/admin/tenants/storage/config/platform]
  └── Controller: TenantStorageConfigAdminController.getPlatformDefault()
        ├── calls: this.storageConfigService.getPlatformDefault()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

**`PUT /api/v1/admin/tenants/storage/config/platform` → `TenantStorageConfigAdminController.upsertPlatformDefault`**
```text
[PUT /api/v1/admin/tenants/storage/config/platform]
  └── Controller: TenantStorageConfigAdminController.upsertPlatformDefault()
        ├── calls: this.storageConfigService.upsertPlatformDefault()
        │     └─ Service: ITenantStorageConfigService [token: ITenantStorageConfigService]
```

---

## Module: `user` (33 routes)

### Controller: `ForgotPasswordController`
**File:** [`src/modules/user/controllers/forgot-password.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/forgot-password.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/auth/forgot-password` | `request` | Public | - | Request a self-service password reset link (always 202) |

#### Handler Call Trees:

**`POST /api/v1/auth/forgot-password` → `ForgotPasswordController.request`**
```text
[POST /api/v1/auth/forgot-password]
  └── Controller: ForgotPasswordController.request()
        ├── calls: this.userPasswordService.requestSelfServiceReset()
        │     └─ Service: UserPasswordService
        ├── calls: this.logger.warn()
        │     └─ Service: unknown
```

### Controller: `PasswordResetController`
**File:** [`src/modules/user/controllers/password-reset.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/password-reset.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/users/password-reset/complete` | `complete` | Public | - | Complete a password reset using a single-use token |

#### Handler Call Trees:

**`POST /api/v1/users/password-reset/complete` → `PasswordResetController.complete`**
```text
[POST /api/v1/users/password-reset/complete]
  └── Controller: PasswordResetController.complete()
        ├── calls: this.userPasswordService.completeReset()
        │     └─ Service: UserPasswordService
```

### Controller: `UserController`
**File:** [`src/modules/user/user.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/user.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/users` | `fetchAll` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Retrieving multiple UserResponses |
| `POST` | `/api/v1/admin/users` | `create` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Creating a UserResponse |
| `DELETE` | `/api/v1/admin/users/{id}` | `delete` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Deleting a UserResponse by id |
| `GET` | `/api/v1/admin/users/{id}` | `fetchById` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Retrieving a single UserResponse by id |
| `PATCH` | `/api/v1/admin/users/{id}` | `update` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Updating a UserResponse by id |
| `GET` | `/api/v1/admin/users/{id}/api-keys` | `fetchUserApiKeys` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Retrieving multiple PaginatedApiKeyResponses by userId |
| `PATCH` | `/api/v1/admin/users/{id}/departments` | `setDepartments` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Set a user's department memberships (bulk reconcile) |
| `GET` | `/api/v1/admin/users/{id}/profile` | `fetchUserProfile` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Get a user's profile (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/profile` | `updateUserProfile` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Create or update a user's profile, incl. preferred prompt template (admin) |
| `POST` | `/api/v1/admin/users/{id}/reset-password` | `resetPassword` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Reset a user password (admin): set a temporary password OR mint an emailed reset link |
| `GET` | `/api/v1/admin/users/{id}/roles` | `fetchUserRoleAssignments` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Retrieving multiple UserRoleAssignmentResponses by userId |
| `POST` | `/api/v1/admin/users/{id}/roles` | `assignRole` | Perms: `manage:UserRoleAssignment`<br/>Svc: `svc:admin:user:write` | - | Assign a role to a user |
| `DELETE` | `/api/v1/admin/users/{id}/roles/{assignmentId}` | `removeRole` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Remove a role assignment from a user |
| `GET` | `/api/v1/admin/users/{id}/settings` | `fetchUserSettings` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Get all settings for a specific user (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/settings/{namespace}/{key}` | `updateUserSetting` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Upsert a setting for a specific user (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/status` | `updateStatus` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Updating a UserResponse by id (enable/disable) |
| `GET` | `/api/v1/admin/users/{id}/voice-profiles` | `fetchUserVoiceProfiles` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | List a user's enrolled voice profiles (admin, read-only) |
| `DELETE` | `/api/v1/admin/users/bulk` | `bulkDelete` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Delete many users in one call (partial-failure envelope) |
| `POST` | `/api/v1/admin/users/bulk-actions` | `bulkActions` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Apply a bulk action (enable/disable/delete/assign-departments/assign-role) to many users |
| `GET` | `/api/v1/admin/users/export` | `exportUsers` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Export users (csv | xlsx | pdf) |
| `GET` | `/api/v1/admin/users/tenant/{tenantId}` | `fetchByTenant` | Perms: `manage:User:read:AdminUserDirectory`<br/>Svc: `svc:admin:user:read,svc:admin:user:write` | - | Retrieving multiple UserResponses by tenantId |

#### Handler Call Trees:

**`GET /api/v1/admin/users` → `UserController.fetchAll`**
```text
[GET /api/v1/admin/users]
  └── Controller: UserController.fetchAll()
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.userService.fetchAllByTenantId()
        │     └─ Service: IUserService [token: IUserService]
        ├── calls: this.userService.fetchAllByTenantId()
        │     └─ Service: IUserService [token: IUserService]
        ├── calls: this.userService.fetchAll()
        │     └─ Service: IUserService [token: IUserService]
```

**`POST /api/v1/admin/users` → `UserController.create`**
```text
[POST /api/v1/admin/users]
  └── Controller: UserController.create()
        ├── calls: this.userService.create()
        │     └─ Service: IUserService [token: IUserService]
```

**`PATCH /api/v1/admin/users/{id}` → `UserController.update`**
```text
[PATCH /api/v1/admin/users/{id}]
  └── Controller: UserController.update()
        ├── calls: this.userService.update()
        │     └─ Service: IUserService [token: IUserService]
```

**`GET /api/v1/admin/users/{id}/api-keys` → `UserController.fetchUserApiKeys`**
```text
[GET /api/v1/admin/users/{id}/api-keys]
  └── Controller: UserController.fetchUserApiKeys()
        ├── calls: this.apiKeyService.fetchAllByUserId()
        │     └─ Service: IApiKeyService [token: IApiKeyService]
```

**`PATCH /api/v1/admin/users/{id}/departments` → `UserController.setDepartments`**
```text
[PATCH /api/v1/admin/users/{id}/departments]
  └── Controller: UserController.setDepartments()
        ├── calls: this.userDepartmentService.setDepartments()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
        ├── calls: this.userService.fetchById()
        │     └─ Service: IUserService [token: IUserService]
```

**`GET /api/v1/admin/users/{id}/profile` → `UserController.fetchUserProfile`**
```text
[GET /api/v1/admin/users/{id}/profile]
  └── Controller: UserController.fetchUserProfile()
        ├── calls: this.userProfileService.getByUserId()
        │     └─ Service: IUserProfileService [token: IUserProfileService]
```

**`PATCH /api/v1/admin/users/{id}/profile` → `UserController.updateUserProfile`**
```text
[PATCH /api/v1/admin/users/{id}/profile]
  └── Controller: UserController.updateUserProfile()
        ├── calls: this.userProfileService.upsertByUserId()
        │     └─ Service: IUserProfileService [token: IUserProfileService]
```

**`POST /api/v1/admin/users/{id}/reset-password` → `UserController.resetPassword`**
```text
[POST /api/v1/admin/users/{id}/reset-password]
  └── Controller: UserController.resetPassword()
        ├── calls: this.userPasswordService.setTemporaryPassword()
        │     └─ Service: UserPasswordService
        ├── calls: this.userPasswordService.createResetLink()
        │     └─ Service: UserPasswordService
```

**`GET /api/v1/admin/users/{id}/roles` → `UserController.fetchUserRoleAssignments`**
```text
[GET /api/v1/admin/users/{id}/roles]
  └── Controller: UserController.fetchUserRoleAssignments()
        ├── calls: this.userRoleAssignmentService.fetchAllByUserId()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
```

**`POST /api/v1/admin/users/{id}/roles` → `UserController.assignRole`**
```text
[POST /api/v1/admin/users/{id}/roles]
  └── Controller: UserController.assignRole()
        ├── calls: this.userRoleAssignmentService.create()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
```

**`DELETE /api/v1/admin/users/{id}/roles/{assignmentId}` → `UserController.removeRole`**
```text
[DELETE /api/v1/admin/users/{id}/roles/{assignmentId}]
  └── Controller: UserController.removeRole()
        ├── calls: this.userRoleAssignmentService.deleteById()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
```

**`GET /api/v1/admin/users/{id}/settings` → `UserController.fetchUserSettings`**
```text
[GET /api/v1/admin/users/{id}/settings]
  └── Controller: UserController.fetchUserSettings()
        ├── calls: this.userSettingsService.fetchAllByUserId()
        │     └─ Service: IUserSettingsService [token: IUserSettingsService]
```

**`PATCH /api/v1/admin/users/{id}/settings/{namespace}/{key}` → `UserController.updateUserSetting`**
```text
[PATCH /api/v1/admin/users/{id}/settings/{namespace}/{key}]
  └── Controller: UserController.updateUserSetting()
        ├── calls: this.userSettingsService.upsertByUserKeyNamespace()
        │     └─ Service: IUserSettingsService [token: IUserSettingsService]
```

**`PATCH /api/v1/admin/users/{id}/status` → `UserController.updateStatus`**
```text
[PATCH /api/v1/admin/users/{id}/status]
  └── Controller: UserController.updateStatus()
        ├── calls: this.userService.update()
        │     └─ Service: IUserService [token: IUserService]
```

**`GET /api/v1/admin/users/{id}/voice-profiles` → `UserController.fetchUserVoiceProfiles`**
```text
[GET /api/v1/admin/users/{id}/voice-profiles]
  └── Controller: UserController.fetchUserVoiceProfiles()
        ├── calls: this.voiceProfileService.listByUserId()
        │     └─ Service: IVoiceProfileService [token: IVoiceProfileService]
```

**`DELETE /api/v1/admin/users/bulk` → `UserController.bulkDelete`**
```text
[DELETE /api/v1/admin/users/bulk]
  └── Controller: UserController.bulkDelete()
        ├── calls: this.userService.deleteById()
        │     └─ Service: IUserService [token: IUserService]
```

**`GET /api/v1/admin/users/export` → `UserController.exportUsers`**
```text
[GET /api/v1/admin/users/export]
  └── Controller: UserController.exportUsers()
        ├── calls: this.userExportService.build()
        │     └─ Service: UserExportService
```

**`GET /api/v1/admin/users/tenant/{tenantId}` → `UserController.fetchByTenant`**
```text
[GET /api/v1/admin/users/tenant/{tenantId}]
  └── Controller: UserController.fetchByTenant()
        ├── calls: this.userService.fetchAllByTenantId()
        │     └─ Service: IUserService [token: IUserService]
```

### Controller: `UserDepartmentsController`
**File:** [`src/modules/user/controllers/user-departments.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/user-departments.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/users/{id}/departments` | `list` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | List a user's department assignments (tenant-scoped) |
| `POST` | `/api/v1/admin/users/{id}/departments` | `assign` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Assign a user to a department |
| `DELETE` | `/api/v1/admin/users/{id}/departments/{assignmentId}` | `unassign` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | - | Unassign a user from a department (soft delete) |
| `PATCH` | `/api/v1/admin/users/{id}/departments/{assignmentId}` | `update` | Perms: `manage:User`<br/>Svc: `svc:admin:user:write` | Yes | Update a user-department assignment (e.g. toggle primary) |

#### Handler Call Trees:

**`GET /api/v1/admin/users/{id}/departments` → `UserDepartmentsController.list`**
```text
[GET /api/v1/admin/users/{id}/departments]
  └── Controller: UserDepartmentsController.list()
        ├── calls: this.userDepartmentService.getByUser()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

**`POST /api/v1/admin/users/{id}/departments` → `UserDepartmentsController.assign`**
```text
[POST /api/v1/admin/users/{id}/departments]
  └── Controller: UserDepartmentsController.assign()
        ├── calls: this.userDepartmentService.assign()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

**`DELETE /api/v1/admin/users/{id}/departments/{assignmentId}` → `UserDepartmentsController.unassign`**
```text
[DELETE /api/v1/admin/users/{id}/departments/{assignmentId}]
  └── Controller: UserDepartmentsController.unassign()
        ├── calls: this.userDepartmentService.unassign()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

**`PATCH /api/v1/admin/users/{id}/departments/{assignmentId}` → `UserDepartmentsController.update`**
```text
[PATCH /api/v1/admin/users/{id}/departments/{assignmentId}]
  └── Controller: UserDepartmentsController.update()
        ├── calls: this.userDepartmentService.update()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

### Controller: `UserDepartmentsMeController`
**File:** [`src/modules/user/controllers/user-departments-me.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/user-departments-me.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/users/me/departments` | `myDepartments` | Auth<br/>API Key: `user:profile:read` | - | List the caller's own department assignments (tenant-scoped) |

#### Handler Call Trees:

**`GET /api/v1/users/me/departments` → `UserDepartmentsMeController.myDepartments`**
```text
[GET /api/v1/users/me/departments]
  └── Controller: UserDepartmentsMeController.myDepartments()
        ├── calls: this.userDepartmentService.getByUser()
        │     └─ Service: IUserDepartmentService [token: IUserDepartmentService]
```

### Controller: `UserPreferencesController`
**File:** [`src/modules/user/controllers/user-preferences.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/user-preferences.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/users/me/preferences` | `getPreferences` | Auth<br/>API Key: `user:preferences:write` | - | Get current user preferences |
| `PATCH` | `/api/v1/users/me/preferences` | `updatePreferences` | Auth<br/>API Key: `user:preferences:write` | - | Update current user preferences (partial) |

#### Handler Call Trees:

**`GET /api/v1/users/me/preferences` → `UserPreferencesController.getPreferences`**
```text
[GET /api/v1/users/me/preferences]
  └── Controller: UserPreferencesController.getPreferences()
        ├── calls: this.userPreferencesService.getPreferences()
        │     └─ Service: IUserPreferencesService [token: IUserPreferencesService]
```

**`PATCH /api/v1/users/me/preferences` → `UserPreferencesController.updatePreferences`**
```text
[PATCH /api/v1/users/me/preferences]
  └── Controller: UserPreferencesController.updatePreferences()
        ├── calls: this.userPreferencesService.updatePreferences()
        │     └─ Service: IUserPreferencesService [token: IUserPreferencesService]
```

### Controller: `UserRolesController`
**File:** [`src/modules/user/controllers/user-roles.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/user-roles.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/users/{id}/roles` | `listMyRoleAssignments` | Auth<br/>API Key: `user:profile:read` | - | List roles assigned to the current user (self-only) |

#### Handler Call Trees:

**`GET /api/v1/users/{id}/roles` → `UserRolesController.listMyRoleAssignments`**
```text
[GET /api/v1/users/{id}/roles]
  └── Controller: UserRolesController.listMyRoleAssignments()
        ├── calls: this.clsService.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.userRoleAssignmentService.fetchAllByUserId()
        │     └─ Service: IUserRoleAssignmentService [token: IUserRoleAssignmentService]
```

### Controller: `UserSettingsController`
**File:** [`src/modules/user/controllers/user-settings.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/controllers/user-settings.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/users/me/settings` | `getMySettings` | Auth<br/>API Key: `user:settings:read` | - | Get all settings for current user |
| `PATCH` | `/api/v1/users/me/settings/{namespace}/{key}` | `updateSetting` | Auth<br/>API Key: `user:settings:write` | - | Update a specific setting by namespace and key |

#### Handler Call Trees:

**`GET /api/v1/users/me/settings` → `UserSettingsController.getMySettings`**
```text
[GET /api/v1/users/me/settings]
  └── Controller: UserSettingsController.getMySettings()
        ├── calls: this.userSettingsService.fetchAllByUserId()
        │     └─ Service: IUserSettingsService [token: IUserSettingsService]
```

**`PATCH /api/v1/users/me/settings/{namespace}/{key}` → `UserSettingsController.updateSetting`**
```text
[PATCH /api/v1/users/me/settings/{namespace}/{key}]
  └── Controller: UserSettingsController.updateSetting()
        ├── calls: this.userSettingsService.upsertByUserKeyNamespace()
        │     └─ Service: IUserSettingsService [token: IUserSettingsService]
```

---

## Module: `voice-profile` (6 routes)

### Controller: `VoiceProfileController`
**File:** [`src/modules/voice-profile/voice-profile.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/voice-profile/voice-profile.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/voice-profiles` | `list` | Perms: `read:UserVoiceProfile` | - | List voice profiles for current user |
| `DELETE` | `/api/v1/voice-profiles/{id}` | `deleteById` | Perms: `delete:UserVoiceProfile` | - | Delete a voice profile |
| `PATCH` | `/api/v1/voice-profiles/{id}/activate` | `activate` | Perms: `update:UserVoiceProfile` | - | Activate a voice profile |
| `PATCH` | `/api/v1/voice-profiles/{id}/deactivate` | `deactivate` | Perms: `update:UserVoiceProfile` | - | Deactivate a voice profile |
| `POST` | `/api/v1/voice-profiles/enroll` | `enroll` | Perms: `create:UserVoiceProfile` | - | Enroll a voice profile from audio samples |
| `GET` | `/api/v1/voice-profiles/enrollment-target` | `enrollmentTarget` | Perms: `read:UserVoiceProfile` | - | The embedding model a new enrollment would use |

#### Handler Call Trees:

**`GET /api/v1/voice-profiles` → `VoiceProfileController.list`**
```text
[GET /api/v1/voice-profiles]
  └── Controller: VoiceProfileController.list()
        ├── calls: this.voiceProfileService.listByUserId()
        │     └─ Service: IVoiceProfileService [token: IVoiceProfileService]
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService
```

**`DELETE /api/v1/voice-profiles/{id}` → `VoiceProfileController.deleteById`**
```text
[DELETE /api/v1/voice-profiles/{id}]
  └── Controller: VoiceProfileController.deleteById()
        ├── calls: this.voiceProfileService.deleteById()
        │     └─ Service: IVoiceProfileService [token: IVoiceProfileService]
```

**`POST /api/v1/voice-profiles/enroll` → `VoiceProfileController.enroll`**
```text
[POST /api/v1/voice-profiles/enroll]
  └── Controller: VoiceProfileController.enroll()
        ├── calls: this.voiceProfileService.enroll()
        │     └─ Service: IVoiceProfileService [token: IVoiceProfileService]
        ├── calls helper: this.getUserId()
        │     ├── calls: this.cls.get()
        │     │     └─ Service: ClsService
```

**`GET /api/v1/voice-profiles/enrollment-target` → `VoiceProfileController.enrollmentTarget`**
```text
[GET /api/v1/voice-profiles/enrollment-target]
  └── Controller: VoiceProfileController.enrollmentTarget()
        ├── calls: this.voiceProfileService.enrollmentTarget()
        │     └─ Service: IVoiceProfileService [token: IVoiceProfileService]
```

---

## Module: `webhook` (7 routes)

### Controller: `WebhookController`
**File:** [`src/modules/webhook/webhook.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/webhook/webhook.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/webhooks` | `fetchAll` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | - | List webhooks (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=) |
| `POST` | `/api/v1/admin/webhooks` | `create` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | - | Create a webhook for the caller tenant. The signing secret is server-generated and returned only once. |
| `DELETE` | `/api/v1/admin/webhooks/{id}` | `delete` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | - | Soft-delete a webhook |
| `GET` | `/api/v1/admin/webhooks/{id}` | `fetchById` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | - | Get one webhook |
| `PATCH` | `/api/v1/admin/webhooks/{id}` | `update` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | Yes | Update a webhook (If-Match OCC) |
| `GET` | `/api/v1/admin/webhooks/{id}/deliveries` | `fetchDeliveries` | Perms: `read:WebhookRunHistory`<br/>Svc: `svc:webhook:event:read,svc:webhook:event:write` | - | List a webhook's delivery log (newest-first) |
| `POST` | `/api/v1/admin/webhooks/{id}/rotate-secret` | `rotateSecret` | Perms: `manage:Webhook`<br/>Svc: `svc:webhook:event:write` | Yes | Rotate a webhook signing secret (If-Match OCC) |

#### Handler Call Trees:

**`GET /api/v1/admin/webhooks` → `WebhookController.fetchAll`**
```text
[GET /api/v1/admin/webhooks]
  └── Controller: WebhookController.fetchAll()
        ├── calls: this.webhookService.fetchAllByTenantId()
        │     └─ Service: IWebhookService [token: IWebhookService]
        ├── calls: this.webhookService.fetchAll()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`POST /api/v1/admin/webhooks` → `WebhookController.create`**
```text
[POST /api/v1/admin/webhooks]
  └── Controller: WebhookController.create()
        ├── calls: this.webhookService.create()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`DELETE /api/v1/admin/webhooks/{id}` → `WebhookController.delete`**
```text
[DELETE /api/v1/admin/webhooks/{id}]
  └── Controller: WebhookController.delete()
        ├── calls: this.webhookService.deleteById()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`GET /api/v1/admin/webhooks/{id}` → `WebhookController.fetchById`**
```text
[GET /api/v1/admin/webhooks/{id}]
  └── Controller: WebhookController.fetchById()
        ├── calls: this.webhookService.fetchById()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`PATCH /api/v1/admin/webhooks/{id}` → `WebhookController.update`**
```text
[PATCH /api/v1/admin/webhooks/{id}]
  └── Controller: WebhookController.update()
        ├── calls: this.webhookService.update()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`GET /api/v1/admin/webhooks/{id}/deliveries` → `WebhookController.fetchDeliveries`**
```text
[GET /api/v1/admin/webhooks/{id}/deliveries]
  └── Controller: WebhookController.fetchDeliveries()
        ├── calls: this.webhookService.fetchRunHistory()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

**`POST /api/v1/admin/webhooks/{id}/rotate-secret` → `WebhookController.rotateSecret`**
```text
[POST /api/v1/admin/webhooks/{id}/rotate-secret]
  └── Controller: WebhookController.rotateSecret()
        ├── calls: this.webhookService.rotateSecret()
        │     └─ Service: IWebhookService [token: IWebhookService]
```

---

## Module: `workflow-assignment` (5 routes)

### Controller: `WorkflowAssignmentController`
**File:** [`src/modules/workflow-assignment/workflow-assignment.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-assignments` | `fetchAll` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | List the caller tenant’s workflow assignments for one palette |
| `PATCH` | `/api/v1/admin/workflow-assignments` | `update` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | Yes | Re-assign one tier |
| `POST` | `/api/v1/admin/workflow-assignments` | `create` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Create the assignment for one (scope, scopeId, palette) tier |
| `DELETE` | `/api/v1/admin/workflow-assignments/{id}` | `remove` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | Yes | Remove one assignment — the tier reverts to inheriting |
| `GET` | `/api/v1/admin/workflow-assignments/{id}` | `fetchById` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Get one workflow assignment |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-assignments` → `WorkflowAssignmentController.fetchAll`**
```text
[GET /api/v1/admin/workflow-assignments]
  └── Controller: WorkflowAssignmentController.fetchAll()
        ├── calls: this.workflowAssignmentService.listForPalette()
        │     └─ Service: IWorkflowAssignmentService [token: IWorkflowAssignmentService]
```

**`PATCH /api/v1/admin/workflow-assignments` → `WorkflowAssignmentController.update`**
```text
[PATCH /api/v1/admin/workflow-assignments]
  └── Controller: WorkflowAssignmentController.update()
        ├── calls: this.workflowAssignmentService.upsert()
        │     └─ Service: IWorkflowAssignmentService [token: IWorkflowAssignmentService]
```

**`POST /api/v1/admin/workflow-assignments` → `WorkflowAssignmentController.create`**
```text
[POST /api/v1/admin/workflow-assignments]
  └── Controller: WorkflowAssignmentController.create()
        ├── calls: this.workflowAssignmentService.upsert()
        │     └─ Service: IWorkflowAssignmentService [token: IWorkflowAssignmentService]
```

**`DELETE /api/v1/admin/workflow-assignments/{id}` → `WorkflowAssignmentController.remove`**
```text
[DELETE /api/v1/admin/workflow-assignments/{id}]
  └── Controller: WorkflowAssignmentController.remove()
        ├── calls: this.workflowAssignmentService.remove()
        │     └─ Service: IWorkflowAssignmentService [token: IWorkflowAssignmentService]
```

**`GET /api/v1/admin/workflow-assignments/{id}` → `WorkflowAssignmentController.fetchById`**
```text
[GET /api/v1/admin/workflow-assignments/{id}]
  └── Controller: WorkflowAssignmentController.fetchById()
        ├── calls: this.workflowAssignmentService.getById()
        │     └─ Service: IWorkflowAssignmentService [token: IWorkflowAssignmentService]
```

---

## Module: `workflow-definition` (22 routes)

### Controller: `WorkflowDefinitionController`
**File:** [`src/modules/workflow-definition/workflow-definition.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-definition/workflow-definition.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-definitions` | `fetchAll` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | List the caller tenant’s workflow definition versions |
| `POST` | `/api/v1/admin/workflow-definitions` | `create` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Create a new DRAFT workflow definition for the caller tenant |
| `DELETE` | `/api/v1/admin/workflow-definitions/{id}` | `delete` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Soft-delete a workflow definition version (refused for the ACTIVE published version — deprecate it first) |
| `GET` | `/api/v1/admin/workflow-definitions/{id}` | `fetchById` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Get one workflow definition version |
| `PATCH` | `/api/v1/admin/workflow-definitions/{id}` | `update` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | Yes | Update a DRAFT workflow definition version (If-Match OCC) |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/activate` | `activate` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Make an already-PUBLISHED version the ACTIVE one for its slug (rollback) |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/clone` | `clone` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Clone an existing workflow (or a platform template) into a NEW draft workflow |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/deprecate` | `deprecate` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/draft` | `createDraft` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Edit a published (or deprecated) workflow version as a NEW draft version of the same workflow |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/export` | `export` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Export one workflow version as a portable JSON bundle |
| `PUT` | `/api/v1/admin/workflow-definitions/{id}/nodes/{nodeId}/prompt` | `updateNodePrompt` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | Yes | Edit a node’s prompt from within the node: mint a new version if the content changed, and move this node’s pin |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/prompt-bindings` | `listPromptBindings` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Which prompt version each node is pinned to, and whether a newer one exists |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/publish` | `publish` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Compile the graph and publish this version |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/validate` | `validate` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Re-run shape + engine + DRAFT rule-catalogue validation and persist the report |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/versions` | `fetchVersions` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | List every version row in this definition’s (tenantId, slug) lineage, most recent first |
| `POST` | `/api/v1/admin/workflow-definitions/import` | `import` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Import a workflow bundle as a new DRAFT workflow |
| `GET` | `/api/v1/admin/workflow-definitions/lineages` | `fetchLineages` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | List the caller tenant’s workflow LINEAGES (one row per slug) |
| `POST` | `/api/v1/admin/workflow-definitions/promote-to-system` | `promoteToSystem` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Promote a workflow from the Global build tenant into the SYSTEM template library |
| `POST` | `/api/v1/admin/workflow-definitions/slug/{slug}/sync` | `sync` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Sync one workflow version into other tenants you manage |
| `POST` | `/api/v1/admin/workflow-definitions/slug/{slug}/webhook-secret` | `rotateWebhookSecret` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Issue or rotate the inbound webhook secret for a workflow lineage (returned exactly once) |
| `GET` | `/api/v1/admin/workflow-definitions/tags` | `listTags` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Distinct workflow tags with usage counts (autocomplete) |
| `GET` | `/api/v1/admin/workflow-definitions/templates` | `fetchTemplates` | Perms: `manage:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-definition:manage` | - | List the platform workflow template library a tenant can clone from |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-definitions` → `WorkflowDefinitionController.fetchAll`**
```text
[GET /api/v1/admin/workflow-definitions]
  └── Controller: WorkflowDefinitionController.fetchAll()
        ├── calls: this.workflowDefinitionService.list()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions` → `WorkflowDefinitionController.create`**
```text
[POST /api/v1/admin/workflow-definitions]
  └── Controller: WorkflowDefinitionController.create()
        ├── calls: this.workflowDefinitionService.create()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`DELETE /api/v1/admin/workflow-definitions/{id}` → `WorkflowDefinitionController.delete`**
```text
[DELETE /api/v1/admin/workflow-definitions/{id}]
  └── Controller: WorkflowDefinitionController.delete()
        ├── calls: this.workflowDefinitionService.deleteById()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/{id}` → `WorkflowDefinitionController.fetchById`**
```text
[GET /api/v1/admin/workflow-definitions/{id}]
  └── Controller: WorkflowDefinitionController.fetchById()
        ├── calls: this.workflowDefinitionService.getById()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`PATCH /api/v1/admin/workflow-definitions/{id}` → `WorkflowDefinitionController.update`**
```text
[PATCH /api/v1/admin/workflow-definitions/{id}]
  └── Controller: WorkflowDefinitionController.update()
        ├── calls: this.workflowDefinitionService.update()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/{id}/activate` → `WorkflowDefinitionController.activate`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/activate]
  └── Controller: WorkflowDefinitionController.activate()
        ├── calls: this.workflowDefinitionService.activate()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/{id}/clone` → `WorkflowDefinitionController.clone`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/clone]
  └── Controller: WorkflowDefinitionController.clone()
        ├── calls: this.workflowDefinitionService.clone()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/{id}/deprecate` → `WorkflowDefinitionController.deprecate`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/deprecate]
  └── Controller: WorkflowDefinitionController.deprecate()
        ├── calls: this.workflowDefinitionService.deprecate()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/{id}/draft` → `WorkflowDefinitionController.createDraft`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/draft]
  └── Controller: WorkflowDefinitionController.createDraft()
        ├── calls: this.workflowDefinitionService.createDraft()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/{id}/export` → `WorkflowDefinitionController.export`**
```text
[GET /api/v1/admin/workflow-definitions/{id}/export]
  └── Controller: WorkflowDefinitionController.export()
        ├── calls: this.workflowDefinitionService.exportDefinition()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`PUT /api/v1/admin/workflow-definitions/{id}/nodes/{nodeId}/prompt` → `WorkflowDefinitionController.updateNodePrompt`**
```text
[PUT /api/v1/admin/workflow-definitions/{id}/nodes/{nodeId}/prompt]
  └── Controller: WorkflowDefinitionController.updateNodePrompt()
        ├── calls: this.workflowDefinitionService.updateNodePrompt()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/{id}/prompt-bindings` → `WorkflowDefinitionController.listPromptBindings`**
```text
[GET /api/v1/admin/workflow-definitions/{id}/prompt-bindings]
  └── Controller: WorkflowDefinitionController.listPromptBindings()
        ├── calls: this.workflowDefinitionService.listPromptBindings()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/{id}/publish` → `WorkflowDefinitionController.publish`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/publish]
  └── Controller: WorkflowDefinitionController.publish()
        ├── calls: this.workflowDefinitionService.publish()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
        ├── calls: this.languageCapability.warningsForWorkflow()
        │     └─ Service: AsrLanguageCapabilityService
```

**`POST /api/v1/admin/workflow-definitions/{id}/validate` → `WorkflowDefinitionController.validate`**
```text
[POST /api/v1/admin/workflow-definitions/{id}/validate]
  └── Controller: WorkflowDefinitionController.validate()
        ├── calls: this.workflowDefinitionService.validate()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/{id}/versions` → `WorkflowDefinitionController.fetchVersions`**
```text
[GET /api/v1/admin/workflow-definitions/{id}/versions]
  └── Controller: WorkflowDefinitionController.fetchVersions()
        ├── calls: this.workflowDefinitionService.listVersions()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/import` → `WorkflowDefinitionController.import`**
```text
[POST /api/v1/admin/workflow-definitions/import]
  └── Controller: WorkflowDefinitionController.import()
        ├── calls: this.workflowDefinitionService.importDefinition()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/lineages` → `WorkflowDefinitionController.fetchLineages`**
```text
[GET /api/v1/admin/workflow-definitions/lineages]
  └── Controller: WorkflowDefinitionController.fetchLineages()
        ├── calls: this.workflowDefinitionService.listLineages()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/promote-to-system` → `WorkflowDefinitionController.promoteToSystem`**
```text
[POST /api/v1/admin/workflow-definitions/promote-to-system]
  └── Controller: WorkflowDefinitionController.promoteToSystem()
        ├── calls: this.workflowDefinitionService.promoteToSystem()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/slug/{slug}/sync` → `WorkflowDefinitionController.sync`**
```text
[POST /api/v1/admin/workflow-definitions/slug/{slug}/sync]
  └── Controller: WorkflowDefinitionController.sync()
        ├── calls: this.workflowDefinitionService.syncToTenants()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`POST /api/v1/admin/workflow-definitions/slug/{slug}/webhook-secret` → `WorkflowDefinitionController.rotateWebhookSecret`**
```text
[POST /api/v1/admin/workflow-definitions/slug/{slug}/webhook-secret]
  └── Controller: WorkflowDefinitionController.rotateWebhookSecret()
        ├── calls: this.workflowExposureService.rotateWebhookSecret()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`GET /api/v1/admin/workflow-definitions/tags` → `WorkflowDefinitionController.listTags`**
```text
[GET /api/v1/admin/workflow-definitions/tags]
  └── Controller: WorkflowDefinitionController.listTags()
        ├── calls: this.workflowDefinitionService.listTagSuggestions()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

**`GET /api/v1/admin/workflow-definitions/templates` → `WorkflowDefinitionController.fetchTemplates`**
```text
[GET /api/v1/admin/workflow-definitions/templates]
  └── Controller: WorkflowDefinitionController.fetchTemplates()
        ├── calls: this.workflowDefinitionService.listTemplates()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

---

## Module: `workflow-invariant-rule` (5 routes)

### Controller: `WorkflowInvariantRuleController`
**File:** [`src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-invariant-rules` | `fetchAll` | Perms: `manage:WorkflowInvariantRule` | - | List the caller tenant's own rules UNION the SYSTEM platform register |
| `POST` | `/api/v1/admin/workflow-invariant-rules` | `create` | Perms: `manage:WorkflowInvariantRule` | - | Author a workflow invariant rule for the caller tenant |
| `DELETE` | `/api/v1/admin/workflow-invariant-rules/{id}` | `delete` | Perms: `manage:WorkflowInvariantRule` | - | Soft-delete a rule |
| `GET` | `/api/v1/admin/workflow-invariant-rules/{id}` | `fetchById` | Perms: `manage:WorkflowInvariantRule` | - | Get one rule — the caller tenant’s own, or a SYSTEM register row |
| `PATCH` | `/api/v1/admin/workflow-invariant-rules/{id}` | `update` | Perms: `manage:WorkflowInvariantRule` | Yes | Update a rule (If-Match OCC) |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-invariant-rules` → `WorkflowInvariantRuleController.fetchAll`**
```text
[GET /api/v1/admin/workflow-invariant-rules]
  └── Controller: WorkflowInvariantRuleController.fetchAll()
        ├── calls: this.workflowInvariantRuleService.list()
        │     └─ Service: IWorkflowInvariantRuleService [token: IWorkflowInvariantRuleService]
```

**`POST /api/v1/admin/workflow-invariant-rules` → `WorkflowInvariantRuleController.create`**
```text
[POST /api/v1/admin/workflow-invariant-rules]
  └── Controller: WorkflowInvariantRuleController.create()
        ├── calls: this.workflowInvariantRuleService.create()
        │     └─ Service: IWorkflowInvariantRuleService [token: IWorkflowInvariantRuleService]
```

**`DELETE /api/v1/admin/workflow-invariant-rules/{id}` → `WorkflowInvariantRuleController.delete`**
```text
[DELETE /api/v1/admin/workflow-invariant-rules/{id}]
  └── Controller: WorkflowInvariantRuleController.delete()
        ├── calls: this.workflowInvariantRuleService.deleteById()
        │     └─ Service: IWorkflowInvariantRuleService [token: IWorkflowInvariantRuleService]
```

**`GET /api/v1/admin/workflow-invariant-rules/{id}` → `WorkflowInvariantRuleController.fetchById`**
```text
[GET /api/v1/admin/workflow-invariant-rules/{id}]
  └── Controller: WorkflowInvariantRuleController.fetchById()
        ├── calls: this.workflowInvariantRuleService.getById()
        │     └─ Service: IWorkflowInvariantRuleService [token: IWorkflowInvariantRuleService]
```

**`PATCH /api/v1/admin/workflow-invariant-rules/{id}` → `WorkflowInvariantRuleController.update`**
```text
[PATCH /api/v1/admin/workflow-invariant-rules/{id}]
  └── Controller: WorkflowInvariantRuleController.update()
        ├── calls: this.workflowInvariantRuleService.update()
        │     └─ Service: IWorkflowInvariantRuleService [token: IWorkflowInvariantRuleService]
```

---

## Module: `workflow-node` (1 routes)

### Controller: `WorkflowNodeController`
**File:** [`src/modules/workflow-node/workflow-node.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-node/workflow-node.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-nodes` | `fetchAll` | Perms: `read:WorkflowDefinition`<br/>Svc: `svc:admin:workflow-node:read` | - | List the code-owned workflow node-type registry (the Studio’s node palette source) |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-nodes` → `WorkflowNodeController.fetchAll`**
```text
[GET /api/v1/admin/workflow-nodes]
  └── Controller: WorkflowNodeController.fetchAll()
        ├── calls: this.workflowDefinitionService.listNodes()
        │     └─ Service: IWorkflowDefinitionService [token: IWorkflowDefinitionService]
```

---

## Module: `workflow-run` (5 routes)

### Controller: `WorkflowRunController`
**File:** [`src/modules/workflow-run/workflow-run.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-run/workflow-run.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-runs` | `listRuns` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-run:read` | - | Tenant-scoped, keyset-paginated, filterable list of workflow-substrate runs. Sandbox runs excluded by default. |
| `GET` | `/api/v1/admin/workflow-runs/{runId}` | `getRun` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-run:read` | - | A single run, with the worker CPU it consumed. Cross-tenant / nonexistent id → 404 (never 403). |
| `GET` | `/api/v1/admin/workflow-runs/{runId}/gate` | `getRunGate` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-run:read` | - | Live state of the run's human-approval gate, read from the gate child workflow. Cross-tenant / nonexistent id → 404. |
| `POST` | `/api/v1/admin/workflow-runs/{runId}/gate/approve` | `approveRunGate` | Perms: `update:Consultation`<br/>Svc: `svc:admin:workflow-run:read` | - | Release the run's human-approval gate with a clinician decision. |
| `GET` | `/api/v1/admin/workflow-runs/{runId}/trace` | `getRunTrace` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-run:read` | - | The CQRS-lite read shape: the run row plus its per-node rollup, assembled from ONE bounded trajectory read. Cross-tenant / nonexistent id → 404. |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-runs` → `WorkflowRunController.listRuns`**
```text
[GET /api/v1/admin/workflow-runs]
  └── Controller: WorkflowRunController.listRuns()
        ├── calls: this.workflowRunService.listRuns()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
```

**`GET /api/v1/admin/workflow-runs/{runId}` → `WorkflowRunController.getRun`**
```text
[GET /api/v1/admin/workflow-runs/{runId}]
  └── Controller: WorkflowRunController.getRun()
        ├── calls: this.workflowRunService.getRun()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
        ├── calls: this.usageAnalytics.getWorkflowRunCpuSeconds()
        │     └─ Service: IUsageAnalyticsService [token: IUsageAnalyticsService]
```

**`GET /api/v1/admin/workflow-runs/{runId}/gate` → `WorkflowRunController.getRunGate`**
```text
[GET /api/v1/admin/workflow-runs/{runId}/gate]
  └── Controller: WorkflowRunController.getRunGate()
        ├── calls: this.workflowRunService.getRunGate()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
```

**`POST /api/v1/admin/workflow-runs/{runId}/gate/approve` → `WorkflowRunController.approveRunGate`**
```text
[POST /api/v1/admin/workflow-runs/{runId}/gate/approve]
  └── Controller: WorkflowRunController.approveRunGate()
        ├── calls: this.workflowRunService.approveRunGate()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
```

**`GET /api/v1/admin/workflow-runs/{runId}/trace` → `WorkflowRunController.getRunTrace`**
```text
[GET /api/v1/admin/workflow-runs/{runId}/trace]
  └── Controller: WorkflowRunController.getRunTrace()
        ├── calls: this.workflowRunService.getRunTrace()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
```

---

## Module: `workflow-sandbox-run` (4 routes)

### Controller: `WorkflowSandboxRunController`
**File:** [`src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs` | `start` | Perms: `create:WorkflowRun`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Start a sandbox run of the CURRENT graph of :definitionId — DRAFT or published, never writes external artifacts. |
| `GET` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}` | `getStatus` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Live run status + stages (queried from the interpreter dispatcher). |
| `POST` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/cancel` | `cancel` | Perms: `update:WorkflowRun`<br/>Svc: `svc:admin:workflow-definition:manage` | - | Cancel a sandbox run — the interpreter's allow-listed cancel signal, never a caller-supplied signal name. |
| `GET` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/stream` | `stream` | Perms: `read:WorkflowRun`<br/>Svc: `svc:admin:workflow-definition:manage` | - | SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`). |

#### Handler Call Trees:

**`POST /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs` → `WorkflowSandboxRunController.start`**
```text
[POST /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs]
  └── Controller: WorkflowSandboxRunController.start()
        ├── calls: this.workflowSandboxRunService.startRun()
        │     └─ Service: IWorkflowSandboxRunService [token: IWorkflowSandboxRunService]
```

**`GET /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}` → `WorkflowSandboxRunController.getStatus`**
```text
[GET /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}]
  └── Controller: WorkflowSandboxRunController.getStatus()
        ├── calls: this.workflowSandboxRunService.getRunStatus()
        │     └─ Service: IWorkflowSandboxRunService [token: IWorkflowSandboxRunService]
```

**`POST /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/cancel` → `WorkflowSandboxRunController.cancel`**
```text
[POST /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/cancel]
  └── Controller: WorkflowSandboxRunController.cancel()
        ├── calls: this.workflowSandboxRunService.cancelRun()
        │     └─ Service: IWorkflowSandboxRunService [token: IWorkflowSandboxRunService]
```

**`GET /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/stream` → `WorkflowSandboxRunController.stream`**
```text
[GET /api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/stream]
  └── Controller: WorkflowSandboxRunController.stream()
        ├── calls: this.workflowSandboxStreamService.stream()
        │     └─ Service: WorkflowSandboxStreamService
```

---

## Module: `workflow-test-fixture` (5 routes)

### Controller: `WorkflowTestFixtureController`
**File:** [`src/modules/workflow-test-fixture/workflow-test-fixture.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflow-test-fixture/workflow-test-fixture.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-test-fixtures` | `fetchAll` | Perms: `manage:WorkflowTestFixture`<br/>Svc: `svc:admin:workflow-test-fixture:manage` | - | List the caller tenant’s saved fixtures |
| `POST` | `/api/v1/admin/workflow-test-fixtures` | `create` | Perms: `manage:WorkflowTestFixture`<br/>Svc: `svc:admin:workflow-test-fixture:manage` | - | Create a synthetic Workbench test fixture for the caller tenant |
| `DELETE` | `/api/v1/admin/workflow-test-fixtures/{id}` | `delete` | Perms: `manage:WorkflowTestFixture`<br/>Svc: `svc:admin:workflow-test-fixture:manage` | - | Soft-delete a fixture |
| `GET` | `/api/v1/admin/workflow-test-fixtures/{id}` | `fetchById` | Perms: `manage:WorkflowTestFixture`<br/>Svc: `svc:admin:workflow-test-fixture:manage` | - | Get one fixture |
| `PATCH` | `/api/v1/admin/workflow-test-fixtures/{id}` | `update` | Perms: `manage:WorkflowTestFixture`<br/>Svc: `svc:admin:workflow-test-fixture:manage` | Yes | Update a fixture (If-Match OCC) |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-test-fixtures` → `WorkflowTestFixtureController.fetchAll`**
```text
[GET /api/v1/admin/workflow-test-fixtures]
  └── Controller: WorkflowTestFixtureController.fetchAll()
        ├── calls: this.workflowTestFixtureService.findAll()
        │     └─ Service: IWorkflowTestFixtureService [token: IWorkflowTestFixtureService]
```

**`POST /api/v1/admin/workflow-test-fixtures` → `WorkflowTestFixtureController.create`**
```text
[POST /api/v1/admin/workflow-test-fixtures]
  └── Controller: WorkflowTestFixtureController.create()
        ├── calls: this.workflowTestFixtureService.create()
        │     └─ Service: IWorkflowTestFixtureService [token: IWorkflowTestFixtureService]
```

**`DELETE /api/v1/admin/workflow-test-fixtures/{id}` → `WorkflowTestFixtureController.delete`**
```text
[DELETE /api/v1/admin/workflow-test-fixtures/{id}]
  └── Controller: WorkflowTestFixtureController.delete()
        ├── calls: this.workflowTestFixtureService.deleteById()
        │     └─ Service: IWorkflowTestFixtureService [token: IWorkflowTestFixtureService]
```

**`GET /api/v1/admin/workflow-test-fixtures/{id}` → `WorkflowTestFixtureController.fetchById`**
```text
[GET /api/v1/admin/workflow-test-fixtures/{id}]
  └── Controller: WorkflowTestFixtureController.fetchById()
        ├── calls: this.workflowTestFixtureService.findById()
        │     └─ Service: IWorkflowTestFixtureService [token: IWorkflowTestFixtureService]
```

**`PATCH /api/v1/admin/workflow-test-fixtures/{id}` → `WorkflowTestFixtureController.update`**
```text
[PATCH /api/v1/admin/workflow-test-fixtures/{id}]
  └── Controller: WorkflowTestFixtureController.update()
        ├── calls: this.workflowTestFixtureService.update()
        │     └─ Service: IWorkflowTestFixtureService [token: IWorkflowTestFixtureService]
```

---

## Module: `workflows` (15 routes)

### Controller: `ConsultationWorkflowRunsController`
**File:** [`src/modules/workflows/consultation-workflow-runs.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflows/consultation-workflow-runs.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/consultations/{consultationId}/workflows` | `list` | Perms: `execute:ConsultationWorkflow`<br/>API Key: `workflows:execute`<br/>Svc: `svc:workflows:execute` | - | The published workflows runnable AGAINST a consultation. |
| `POST` | `/api/v1/consultations/{consultationId}/workflows/{slug}/runs` | `startRun` | Perms: `execute:ConsultationWorkflow`<br/>API Key: `workflows:execute`<br/>Svc: `svc:workflows:execute` | - | Run a published workflow against THIS consultation. |

#### Handler Call Trees:

**`GET /api/v1/consultations/{consultationId}/workflows` → `ConsultationWorkflowRunsController.list`**
```text
[GET /api/v1/consultations/{consultationId}/workflows]
  └── Controller: ConsultationWorkflowRunsController.list()
        ├── calls: this.workflowExposureService.list()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`POST /api/v1/consultations/{consultationId}/workflows/{slug}/runs` → `ConsultationWorkflowRunsController.startRun`**
```text
[POST /api/v1/consultations/{consultationId}/workflows/{slug}/runs]
  └── Controller: ConsultationWorkflowRunsController.startRun()
        ├── calls: this.workflowExposureService.invoke()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

### Controller: `WorkflowHooksController`
**File:** [`src/modules/workflows/workflow-hooks.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflows/workflow-hooks.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `POST` | `/api/v1/hooks/workflows/{hookId}` | `trigger` | Public | - | Start a run from an external system (inbound webhook trigger). Body = the trigger payload; authenticated by HMAC over the raw body. |

#### Handler Call Trees:

**`POST /api/v1/hooks/workflows/{hookId}` → `WorkflowHooksController.trigger`**
```text
[POST /api/v1/hooks/workflows/{hookId}]
  └── Controller: WorkflowHooksController.trigger()
        ├── calls: this.workflowExposureService.triggerByWebhook()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

### Controller: `WorkflowRunTraceController`
**File:** [`src/modules/workflows/workflow-run-trace.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflows/workflow-run-trace.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/workflow-runs/{runId}/trace/stream` | `streamTrace` | Perms: `read:WorkflowRun` | - | SSE: the admin trace of a run — every run protocol v2 event (debug events, all node outputs), with resume. |

#### Handler Call Trees:

**`GET /api/v1/admin/workflow-runs/{runId}/trace/stream` → `WorkflowRunTraceController.streamTrace`**
```text
[GET /api/v1/admin/workflow-runs/{runId}/trace/stream]
  └── Controller: WorkflowRunTraceController.streamTrace()
        ├── calls: this.traceAccess.assertCanTrace()
        │     └─ Service: WorkflowRunTraceAccessService
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.workflowStreamService.streamRun()
        │     └─ Service: WorkflowStreamService
        ├── calls: this.workflowRunService.getRun()
        │     └─ Service: IWorkflowRunService [token: IWorkflowRunService]
```

### Controller: `WorkflowsController`
**File:** [`src/modules/workflows/workflows.controller.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflows/workflows.controller.ts)

| Method | Path | Handler | Auth & Scopes | OCC | Summary |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflows` | `list` | Perms: `list:WorkflowDefinition`<br/>API Key: `workflow:definition:read`<br/>Svc: `svc:workflow:definition:read` | - | The tenant's published + active, invokable workflows (slug + identity — no per-definition input schema exists yet). |
| `POST` | `/api/v1/workflows/{slug}/invoke` | `invoke` | Perms: `create:WorkflowRun`<br/>API Key: `workflow:run:write`<br/>Svc: `svc:workflow:run:write` | - | DEPRECATED alias of POST :slug/runs. Start a run of the tenant's active published version of :slug. |
| `POST` | `/api/v1/workflows/{slug}/runs` | `startRun` | Perms: `create:WorkflowRun`<br/>API Key: `workflow:run:write`<br/>Svc: `svc:workflow:run:write` | - | Start a run of the tenant's active published version of :slug. The canonical invocation entry point. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}` | `getRunStatus` | Perms: `read:WorkflowRun`<br/>API Key: `workflow:run:read`<br/>Svc: `svc:workflow:run:read` | - | Live run status + result (queried from the interpreter dispatcher). |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/cancel` | `cancelRun` | Perms: `update:WorkflowRun`<br/>API Key: `workflow:run:write`<br/>Svc: `svc:workflow:run:write` | - | Cancel a run — sends the interpreter's allow-listed cancel signal, never a caller-supplied signal name. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}/result` | `getRunResult` | Perms: `read:WorkflowRun`<br/>API Key: `workflow:run:read`<br/>Svc: `svc:workflow:run:read` | - | The result a finished run delivered: the JSON value inline, or a short-lived signed URL for a large result. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}` | `getReview` | Perms: `read:WorkflowRun`<br/>API Key: `workflow:run:read`<br/>Svc: `svc:workflow:run:read` | - | The live state of one Human-review node of a run: whether it is waiting, how many times it has escalated, and the decision if one was made. |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}/decide` | `decideReview` | Perms: `update:WorkflowRun`<br/>API Key: `workflow:run:write`<br/>Svc: `svc:workflow:run:write` | - | Release a Human-review node with a decision — the graph resumes down the `approved` or `rejected` handle. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}/stream` | `streamRunStatus` | Perms: `read:WorkflowRun`<br/>API Key: `workflow:run:read`<br/>Svc: `svc:workflow:run:read` | - | SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`). |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/stream-ticket` | `issueRunStreamTicket` | Perms: `read:WorkflowRun`<br/>API Key: `workflow:run:read`<br/>Svc: `svc:workflow:run:read` | - | Mint a single-use, 30-second ticket for this run’s WebSocket stream. |
| `GET` | `/api/v1/workflows/{slug}/schema` | `getSchema` | Perms: `read:WorkflowDefinition`<br/>API Key: `workflow:definition:read`<br/>Svc: `svc:workflow:definition:read` | - | The published definition`s generated contract: input/output component schemas, trigger kinds, protocols, admitted modes, and an AsyncAPI fragment for its run events (TASK-864). |

#### Handler Call Trees:

**`GET /api/v1/workflows` → `WorkflowsController.list`**
```text
[GET /api/v1/workflows]
  └── Controller: WorkflowsController.list()
        ├── calls: this.workflowExposureService.list()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`POST /api/v1/workflows/{slug}/runs` → `WorkflowsController.startRun`**
```text
[POST /api/v1/workflows/{slug}/runs]
  └── Controller: WorkflowsController.startRun()
        ├── calls: this.workflowExposureService.invoke()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`GET /api/v1/workflows/{slug}/runs/{runId}` → `WorkflowsController.getRunStatus`**
```text
[GET /api/v1/workflows/{slug}/runs/{runId}]
  └── Controller: WorkflowsController.getRunStatus()
        ├── calls: this.workflowExposureService.getRunStatus()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`POST /api/v1/workflows/{slug}/runs/{runId}/cancel` → `WorkflowsController.cancelRun`**
```text
[POST /api/v1/workflows/{slug}/runs/{runId}/cancel]
  └── Controller: WorkflowsController.cancelRun()
        ├── calls: this.workflowExposureService.cancelRun()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`GET /api/v1/workflows/{slug}/runs/{runId}/result` → `WorkflowsController.getRunResult`**
```text
[GET /api/v1/workflows/{slug}/runs/{runId}/result]
  └── Controller: WorkflowsController.getRunResult()
        ├── calls: this.workflowExposureService.getRunResult()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`GET /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}` → `WorkflowsController.getReview`**
```text
[GET /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}]
  └── Controller: WorkflowsController.getReview()
        ├── calls: this.workflowExposureService.getReview()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`POST /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}/decide` → `WorkflowsController.decideReview`**
```text
[POST /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}/decide]
  └── Controller: WorkflowsController.decideReview()
        ├── calls: this.workflowExposureService.decideReview()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

**`GET /api/v1/workflows/{slug}/runs/{runId}/stream` → `WorkflowsController.streamRunStatus`**
```text
[GET /api/v1/workflows/{slug}/runs/{runId}/stream]
  └── Controller: WorkflowsController.streamRunStatus()
        ├── calls: this.workflowExposureService.getRunStatus()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
        ├── calls: this.entryGate.assertEntryAllowed()
        │     └─ Service: WorkflowEntryGateService
        ├── calls: this.workflowStreamService.stream()
        │     └─ Service: WorkflowStreamService
```

**`POST /api/v1/workflows/{slug}/runs/{runId}/stream-ticket` → `WorkflowsController.issueRunStreamTicket`**
```text
[POST /api/v1/workflows/{slug}/runs/{runId}/stream-ticket]
  └── Controller: WorkflowsController.issueRunStreamTicket()
        ├── calls: this.workflowExposureService.getRunStatus()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.cls.get()
        │     └─ Service: ClsService<IActiveUserContext>
        ├── calls: this.streamTicketService.issueTicket()
        │     └─ Service: StreamTicketService
```

**`GET /api/v1/workflows/{slug}/schema` → `WorkflowsController.getSchema`**
```text
[GET /api/v1/workflows/{slug}/schema]
  └── Controller: WorkflowsController.getSchema()
        ├── calls: this.workflowExposureService.describe()
        │     └─ Service: IWorkflowExposureService [token: IWorkflowExposureService]
```

---
