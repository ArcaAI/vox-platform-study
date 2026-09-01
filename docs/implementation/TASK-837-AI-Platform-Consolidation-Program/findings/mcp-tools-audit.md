# MCP Connectors & Tools — Audit (hope-v2, branch dev-2.2)

Read-only audit. All paths absolute-relative to repo root
`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`. Every claim below is cited file:line.

Product-owner target (assessed against, not implemented):
- ONE screen manages MCP connectors and tools.
- MCP connectors = interfaces to external MCP services; a **tenant admin** configures one or
  more for agents to use.
- Tools = functions an agent can call.
- Agent nodes in a consultation workflow can be given tools to call.

---

## A. WHAT EXISTS

### A.1 — Frontend screen (REAL, not a stub)

- Route: `apps/admin-console/src/app/(console)/(global)/tools-mcp/page.tsx:1-9` — note the
  route group: **`(global)`**, i.e. tier 10-19 (super-admin, cross-tenant, never requires a
  selected tenant — see `.claude/rules/13-nextjs-apps.md` §Routing and
  `.claude/rules/12-design-workflow.md` §3 number ranges). Its own comment says so explicitly:
  `page.tsx:6` `/** screen 5 — agentic tool / MCP registry, full CRUD under If-Match OCC (tier 10-19). */`
- `loading.tsx:1-19` — real skeleton (`.claude/rules/10-skeleton-loading.md` compliant), not a
  spinner/placeholder.
- Feature module: `apps/admin-console/src/features/tools-mcp/` — full vertical slice:
  - `api/types.ts:1-59` — wire types (`McpServer`, `CreateMcpServerRequest`,
    `UpdateMcpServerRequest`, `McpServerListResponse`).
  - `api/client.ts:1-40` — `listMcpServers`, `getMcpServer`, `createMcpServer`,
    `updateMcpServer` (If-Match OCC via `patchWithEtag`), `deleteMcpServer` (If-Match OCC).
    Base path `admin/mcp-servers` (`client.ts:12`).
  - `api/hooks.ts:1-47` — TanStack Query hooks, cache-key invalidation on mutation.
  - `components/tools-mcp-screen.tsx:1-249` — full CRUD UI: table (name / base URL / PHI
    boundary / allowlist / auth-presence / enabled / actions), create/edit dialog, delete
    confirm dialog, empty/error/loading states.
  - `components/mcp-server-form-dialog.tsx` — create/edit form (name, description, baseUrl,
    authRef, toolAllowlist, phiBoundary, enabled), OCC-conflict handling
    (`OccConflictAlert`).
  - `components/__tests__/tools-mcp-screen.test.tsx:1-35+` — real TDD suite: CRUD, OCC,
    SUPER_ADMIN gate (explicit `TENANT_ADMIN_SESSION` fixture, `:31-36`), empty/error/loading,
    axe 0-violations.
- **Explicit SUPER_ADMIN gate baked into the component itself**
  (`tools-mcp-screen.tsx:66-91`): the screen checks `session.data?.isElevated`; when false it
  renders an `EmptyState` titled **"Super Admins only"** with description *"The MCP
  external-tools registry is managed by super administrators. Tenant admins cannot register
  or mutate servers."* (`tools-mcp-screen.tsx:78-88`). This is a UI-layer redundant gate on
  top of the nav-tier gate and the backend 403 (defense in depth) — three independent layers
  all say the same thing: tenant admins are locked out.
- Nav entry: `apps/admin-console/src/shared/navigation/nav-config.ts:405-412` — route
  `/tools-mcp`, `tier: '10-19'`, `required: [['manage', 'all']]` (super-admin catch-all
  ability, the strictest gate in the nav-config vocabulary).

**Verdict: real, working, tested screen — but built and gated for the WRONG audience per the
requirement.**

### A.2 — Backend: gateway module

- `apps/api/src/modules/mcp-admin/mcp-admin.controller.ts:1-161` — `McpAdminController`,
  `@Controller('admin/mcp-servers')` (→ `/api/v1/admin/mcp-servers`).
  - `GET /` (`:49-62`) `@CanRead('McpServer')` — list.
  - `GET /:id` (`:64-73`) `@CanRead('McpServer')` — get.
  - `POST /` (`:75-89`) `@CanManage('McpServer')` — create, summary literally says
    **"GLOBAL-ADMIN only"** (`:78`).
  - `PATCH /:id` (`:91-120`) `@CanManage('McpServer')` + `@RequiresIfMatch()` — OCC update,
    **"GLOBAL-ADMIN only"** (`:95`).
  - `DELETE /:id` (`:122-148`) `@CanManage('McpServer')` + `@RequiresIfMatch()` — OCC
    soft-delete, **"GLOBAL-ADMIN only"** (`:126`).
  - Controller-level `@ForbidApiKey()` + `@RequiredSvcScopes('svc:admin:mcp-server:manage')`
    (`:39-40`) — API keys can never reach this surface at all; service accounts need the
    dedicated scope.
- `apps/api/src/modules/mcp-admin/mcp-admin.module.ts:1-15` — mounts the controller, imports
  `McpServerAdminServiceModule` from `@arcaai/applications`.
- Registered in `apps/api/src/app.module.ts:515` —
  `// /admin/mcp-servers/* (MCP external-tools registry; super-admin CRUD + registry read).`
- Confirmed in the generated authz oracle `apps/api/route-manifest.json` (regenerated via
  `pnpm api:route-manifest`): all 5 routes carry `apiKeyForbidden: true`,
  `svcScopes: ["svc:admin:mcp-server:manage"]`, and `requiredPermissions` of
  `[["read","McpServer"]]` (list/get) or `[["manage","McpServer"]]` (create/update/remove);
  update/remove also carry `requiresIfMatch: true`.

### A.3 — Backend: application service

- `packages/applications/src/services/mcp-server/mcp-server-admin.service.ts:1-196` —
  `McpServerAdminService implements IMcpServerAdminService`, extends `BaseService`.
  - `list()` (`:41-50`) / `get()` (`:52-61`) — open to any caller holding `read:McpServer`;
    cross-tenant miss → 404 (`:56-59`), no existence leak.
  - `create()` (`:63-95`), `update()` (`:97-137`), `remove()` (`:139-161`) — **each begins
    with `this.assertSuperAdmin();`** (`:64`, `:98`, `:140`).
  - `assertSuperAdmin()` (`:165-170`):
    ```ts
    private assertSuperAdmin(): void {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('The MCP server registry is managed by super administrators only.');
      }
    }
    ```
  - Registry rows are SYSTEM-tenant-owned by default (`SYSTEM_TENANT_ID`, `:67`, `:99`,
    `:141`); a super admin may explicitly target another tenant via `?tenantId=`, but nothing
    in this service lets a *tenant admin* write even to their own tenant's rows.
- `packages/applications/src/services/mcp-server/IMcpServerAdminService.ts:1-22` — interface +
  DI symbol; doc comment: *"WRITES (create/update/remove) are SUPER_ADMIN-ONLY — a
  tenant-admin write gets a `ForbiddenException` (403), the guardrail.* privilege-boundary
  precedent."*
- `packages/applications/src/services/mcp-server/__tests__/mcp-server-admin.service.test.ts` —
  explicit tests: *"a tenant admin creating a server gets 403"* (`:51-54`), *"...updating...
  gets 403"* (`:57-60`), *"...deleting... gets 403"* (`:62-65`).
- DTOs: `dto/create-mcp-server.request.ts:1-63` (`name`, `description?`, `baseUrl`,
  `transport?`, `authRef?` — Vault-path-shaped via `@Matches(/^[^\s]+$/)`, `toolAllowlist?`,
  `phiBoundary?`, `enabled?` default false), `dto/update-mcp-server.request.ts`,
  `dto/mcp-server.response.ts`.

### A.4 — Backend: Prisma model

`packages/database/src/prisma/db_main/mcp-server.prisma:31-79` — `model McpServer`:

```prisma
model McpServer {
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  tenantId String                                   // multi-tenant

  name        String
  description String? @db.Text
  baseUrl     String                                 // MCP root URL (streamable-HTTP)
  transport   String  @default("streamable-http")    // only "streamable-http" supported
  authRef     String?                                // Vault PATH ONLY, never a secret
  toolAllowlist Json? @db.JsonB                       // per-server tool allow-list
  phiBoundary String  @default("external")           // "external" | "in-boundary"
  enabled     Boolean @default(false)                // per-server kill-switch, default OFF

  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?
  createdBy               String?            @default("60000000-0000-0000-0000-000000000000")
  updatedBy               String?
  createdAt               DateTime           @default(now())
  updatedAt               DateTime           @updatedAt

  @@unique([tenantId, name], name: "McpServer_tenant_name_unique")
  @@schema("core")
}
```

Full field list (13 business/meta fields + 6 audit fields): `metaData`, `version`, `id`,
`tenantId`, `name`, `description`, `baseUrl`, `transport`, `authRef`, `toolAllowlist`,
`phiBoundary`, `enabled`, `resourceStatus`, `resourceStatusUpdatedAt`,
`resourceStatusUpdatedBy`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`.

Header comment (`mcp-server.prisma:1-29`) states the design explicitly: *"Agentic SOTA
Program, Phase 5: MCP external-tools registry"*; *"SYSTEM-tenant rows only, initially:
servers are registered by a global admin under the reserved SYSTEM tenant"*; *"WRITES stay
SYSTEM-only (super-admin, enforced at the service layer)"*.

**Tenant scoping (allow-lists, both entries present and consistent):**
- `packages/database/src/extensions/tenant-scope.ts:200` — `'McpServer'` in
  `TENANT_SCOPED_MODELS` (comment `:195-199`: *"A STANDARD tenant-scoped config model...
  SYSTEM-tenant rows are the shared registry every tenant's harness run READS... WRITES stay
  SYSTEM-only"*).
- `packages/database/src/extensions/tenant-scope.ts:458` — `'McpServer'` ALSO in
  `SYSTEM_SHARED_READ_MODELS` (comment `:452-457`: reads widen to `[caller, SYSTEM]`; writes
  are NOT widened — *"registry mutation is super-admin only at the service layer"*).

So the model is architecturally READY for per-tenant rows (it has `tenantId`, and a super
admin can already create a row under a different `tenantId` via `?tenantId=`) — the missing
piece is purely authorization: nothing lets the OWNING tenant's own admin write their own row.

Related enum entry: `ResourceType.McpServer` exists in the audit enum, used by
`McpServerAdminService`'s `broadcastSysEvent` calls (`mcp-server-admin.service.ts:89`, `:132`,
`:156`).

### A.5 — Other MCP-adjacent grep hits (breadth check per instruction #2)

- `mcp`, `Mcp`, `MCP` — concentrated in: the registry (above), the harness runtime client
  (§C), and the seed/policy files (§B).
- `connector` — **no hits** anywhere in the repo for an "MCP connector" concept distinct from
  `McpServer`; `McpServer` *is* the connector model, just not named that.
- `toolRegistry` / `ToolRegistry` — **no hits**.
- `ToolDefinition` — **no hits**.
- `tool_call` / `function_call` — only as provider **finish-reason** normalization constants
  (`apps/text/src/text/models/stats.py:44-45`: `"tool_calls": "tool_call"`,
  `"function_call": "tool_call"`; `apps/text/src/text/providers/vertex.py:59`:
  `"malformed_function_call": "tool_call"`) and in `apps/guardrail/src/guardrail/providers/stats.py`
  — these are stats/telemetry label maps, not an execution path.
- `tools` (generic) — the one adjacent-but-distinct hit is
  `packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts`
  (§D) — a **config-driven internal orchestration layer** for the live-flush (NLP
  entity/vitals extraction + guardrail groundedness), explicitly documented as NOT
  model-initiated tool-calling and NOT related to MCP (`live-tool-registry.ts:1-30`, esp.
  `:10-16`: *"WHAT THIS IS NOT (OD-5(b), not (a)). There is NO model-initiated tool-calling
  loop here, and no `tools` field is added to the TEXT payload."*).

---

## B. TIER CONFLICT — quantified

**Requirement:** a TENANT ADMIN configures one or more MCP connectors.

**Current state — three independent, redundant gates, all SUPER_ADMIN-only:**

1. **Route/nav tier**: `/tools-mcp` lives under `(console)/(global)/` (`apps/admin-console/src/app/(console)/(global)/tools-mcp/page.tsx`) and is registered at `tier: '10-19'` with `required: [['manage', 'all']]` in `nav-config.ts:405-412` — the global/super-admin-only tier per `.claude/rules/12-design-workflow.md` §3 (10-19 = "Global-only screens; never require a selected tenant"). A tenant admin never sees this nav item and (per `13-nextjs-apps.md`'s `(global)` route-group layout tier guard) is redirected/blocked at the layout level before the screen even mounts.
2. **UI component gate**: `ToolsMcpScreen` itself checks `session.data?.isElevated` and renders a hard "Super Admins only" empty state otherwise (`tools-mcp-screen.tsx:66-91`) — belt-and-braces even if a tenant admin somehow reached the route.
3. **API/service imperative gate**: `McpServerAdminService.assertSuperAdmin()` throws `ForbiddenException` on `create`/`update`/`remove` (`mcp-server-admin.service.ts:63-64, 97-98, 139-140, 165-170`), enforced regardless of what the caller's CASL grant says.

**Declarative permission is a red herring — the imperative check overrides it.** The seeded
tenant-admin roles (both `harness-platform-manage`, scope PLATFORM, and
`harness-tenant-manage`, scope TENANT) are explicitly granted
`{ action: 'manage', subject: 'McpServer', conditions: { tenantId: ... } }` —
`packages/database/src/prisma/db_main/seed/01-policy.ts:224-225` and `:630` (tenant-scoped),
`:602` (platform-scoped) — with an explicit comment at `:216-223`:
> *"MCP WRITES remain super-admin-only regardless — `McpServerAdminService` throws 403 for a
> tenant admin (defense in depth), so `manage` here buys the registry READ this role already
> had."*

So a tenant admin can hold `manage:McpServer` in CASL and STILL get 403 on every write. This
is the exact pattern documented in `.claude/rules/05-nestjs-api.md` §Imperative Privilege
Checks, row *"Super-admin-only action on a tenant-manageable resource"*, which literally lists
**"MCP writes"** as one of the three canonical examples (alongside `SUPER_ADMIN_ONLY_TASK_PREFIXES`
for `AiTaskDefault` and `SUPER_ADMIN_ONLY_POLICY_KEYS` for `HarnessPolicy`) — quoted verbatim:

> | **Super-admin-only action on a tenant-manageable resource** | `SUPER_ADMIN_ONLY_TASK_PREFIXES`
> (AiTaskDefault), `SUPER_ADMIN_ONLY_POLICY_KEYS` (HarnessPolicy), the `globalOnly` descriptor
> lock (PipelinePolicy), **MCP writes** | There is no "super admin" subject; tenant admins
> legitimately hold `manage` on the resource for every OTHER operation |
> (`.claude/rules/05-nestjs-api.md:46`)

**A second, compounding gate**: even the platform-wide *master switch* for the whole MCP
feature, `HarnessPolicy.mcpToolsEnabled`, is ALSO on the super-admin-only knob list —
`SUPER_ADMIN_ONLY_POLICY_KEYS` in `packages/applications/src/services/harness-policy/harness-policy.service.ts:169-185`,
with `'mcpToolsEnabled'` explicitly listed at `:184` and the comment `:182-183`: *"MCP calls
OUT of the platform boundary, so arming it is super-admin governance, never a tenant-level
switch."* So even if a tenant admin could register a server, the platform-wide arming switch
is still out of reach. (Note: `HarnessPolicy.toolAllowlist`, the per-tenant narrowing list, is
**NOT** on that list — a tenant admin CAN narrow the allowlist via the policy API — but the
console screen that would expose that (`/agentic-policy`) is ALSO `(global)`-tier
(`nav-config.ts:291-299`, comment `:291`: *"Phase 3B agentic super-admin console (all
SUPER_ADMIN-only)"*), so there is no UI path to it today either.)

**Quantified conflict:**
| Gate | Current | Requirement |
|---|---|---|
| Screen route group | `(global)`, tier 10-19 | must be reachable to a TENANT_ADMIN |
| Screen component | hard-blocks non-elevated sessions | must render for tenant admins |
| `POST/PATCH/DELETE /admin/mcp-servers*` | `assertSuperAdmin()` → 403 for anyone not `isSuperAdmin` | must allow a tenant admin to write **their own tenant's** rows |
| `HarnessPolicy.mcpToolsEnabled` master switch | super-admin-only patch | arguably should stay platform-governed (egress risk), but currently blocks even a fully-configured tenant connector from ever running |
| `manage:McpServer` CASL grant | already held by tenant-admin roles, but **overridden** by the imperative check | is currently inert — a wasted grant |

Net: **4 independent layers** (route tier, UI component, service imperative check, and the
`mcpToolsEnabled` platform switch) all currently say "super-admin only," and all 4 would need
to change (or be explicitly re-scoped to "tenant admin manages own-tenant rows; the master
switch stays platform-governed") to satisfy the requirement. This is a deliberate,
well-documented design decision (not an oversight) — see `mcp-server.prisma:10-17` and the
service/controller doc-comments — so changing it is a genuine product decision, not a bug fix.

---

## C. RUNTIME VERDICT — does anything actually speak MCP today?

**YES — a real MCP client exists and is wired into one Temporal workflow**, but it is narrow,
single-purpose, and orthogonal to any "agent decides to call a tool" model.

- `apps/harness/src/harness/tools/mcp_client.py:1-178` — `McpToolClient`, a genuine
  streamable-HTTP MCP client wrapping the **official `mcp` Python SDK**
  (`from mcp import ClientSession`, `from mcp.client.streamable_http import
  streamable_http_client`, `mcp_client.py:131-132`). It does a real
  `session.initialize()` + `session.call_tool(tool, arguments=args)` round-trip
  (`mcp_client.py:150-152`).
  - The SDK is an **optional extra** (`harness[mcp-tools]`, `apps/harness/pyproject.toml:113-115`,
    `mcp>=2.0.0`), lazily imported inside a `try/except ImportError` (`mcp_client.py:129-134`),
    so the base install and the hermetic CI test suite never touch it
    (`apps/harness/pyproject.toml:222-226` mypy override comment confirms this).
  - Bounded retry (max 2 attempts, 4xx never retried), coarse secret-free error normalization
    (`McpClientError`), and a 20s default timeout (`mcp_client.py:78-119`).
- Invoked from exactly one Temporal activity: `call_mcp_tool` —
  `apps/harness/src/harness/temporal/activities.py:1033-1200+`. Enforcement order documented
  and enforced in code: (0) server-disabled short-circuit → (0.5) consent check (TASK-712) →
  (1) allowlist (`policy_tool_allowlist ∩ server.tool_allowlist`, deny-all default) → (2) PHI
  egress guard (fail-closed for `phiBoundary="external"`) → (3) the bounded MCP call → (4)
  size-cap/claim-check.
- Invoked from exactly one place in the workflow: `apps/harness/src/harness/temporal/workflows.py:643-687`
  — **ONE hardcoded tool**, `MCP_TERMINOLOGY_TOOL = "validate_codes"`
  (`workflows.py:208`, comment `:207`: *"The first MCP integration: FHIR terminology
  validation of the extracted entity codes."*). Server selection
  (`_select_mcp_server`, `workflows.py:211-220`) is a **deterministic, pure function** — first
  enabled server whose static allowlist contains the one hardcoded tool name. This is gated by
  `mcp_tools_enabled` (from `HarnessPolicy.mcpToolsEnabled`, default OFF) AND a
  `workflow.patched("task-516-mcp-tools")` Temporal replay-compatibility marker
  (`workflows.py:655`).
- Credential resolution is real and gateway-mediated (never a harness-side Vault client) — see
  §F below.

**What this is NOT**: there is no generic "call any tool by name with arbitrary args, chosen
by an LLM at runtime" loop anywhere. It is one fixed pipeline step (terminology-code
validation) triggered deterministically after NER extraction, not an agent decision.

**Provider-level "function calling" passthrough — checked and it is narrower than the audit
brief anticipated.** `apps/text/src/text/providers/bedrock.py:177-186` builds a Bedrock
`toolConfig`/`tools` block, but only to **force structured JSON output** via a single
synthetic tool matching the requested `response_format.json_schema`
(`toolChoice: { tool: { name: schema.title } }`, `:186`) — it is a JSON-mode trick, not a
general tools-array passthrough exposing arbitrary agent tools to the model. No other provider
file in `apps/text/src/text/providers/` builds a `tools`/`tool_calls` request field for
general-purpose function calling.

---

## D. TOOL EXECUTION VERDICT — what runs a tool call today?

Two entirely separate, non-interoperating "tool" mechanisms exist:

1. **MCP tool execution (external, agent-facing per the requirement's definition)**: the
   `call_mcp_tool` Temporal activity (`apps/harness/src/harness/temporal/activities.py:1033`)
   is the only executor. It is invoked from exactly one call site
   (`workflows.py:659-684`), for exactly one tool (`validate_codes`), never chosen by an LLM —
   the workflow code chooses it deterministically after NER runs. No "agent node" concept
   invokes it; it predates and is independent of the `workflow-studio` graph/node system (§E).

2. **"Live tool" execution (internal, misleadingly similarly-named)**:
   `packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts`
   — a `LiveToolRegistry` of `LiveToolExecutor`s (`ner`/`vitals` → one NLP `classify/tokens`
   call, `groundedness` → a guardrail check), selected by a frozen `ResolvedToolPlan` computed
   once per session, NOT by a model decision (`live-tool-registry.ts:1-30`, explicit "WHAT
   THIS IS NOT" section at `:10-16`). This has nothing to do with MCP or with external
   connectors — it is a config-driven internal step-execution seam for the live-flush
   pipeline, and its own doc comment states the model-initiated version (OD-5(a)) does not
   exist yet, only the descriptor shape that would let it arrive later
   (`LiveToolDescriptor`, `:48-64`).

**Neither mechanism lets an "agent node" in a `workflow-studio` graph declare "I can call
tools X, Y, Z."** See §E.

---

## E. Agent nodes and tool assignment — the missing link

`workflow-studio` (`apps/admin-console/src/features/workflow-studio/`) is the real graph
editor for consultation workflows (palette, node inspector, prompt bindings, graph
list-editor, publish flow, assignment matrix). Its palette is **registry-driven with zero
hard-coded node types** (`palette-rail.tsx:1-9` doc comment). The registry is
`WORKFLOW_NODE_REGISTRY` in `packages/workflow-contract/src/node-registry.ts`, which DOES
define real `agent.*` node types — `agent.transcription`, `agent.normalization`, `agent.ner`,
`agent.grammar`, `agent.important_findings`, `agent.presummarization`, `agent.summarization`,
`agent.discharge_summary`, `agent.retrieval`, `agent.feedback`, `agent.dna_redaction`
(`node-registry.ts:924-1183`, per-entry keys).

**The node descriptor contract (`WorkflowNodeDescriptor`, `node-registry.ts:41-146`) has NO
field for tools or MCP servers.** Its fields are: `key`, `implemented`, `activityName`,
`classes`, `paletteKey`, `critical`, `externalWrite`, `defaultTimeoutSeconds`,
`defaultMaxAttempts`, `entitlementKey`, `configSchema?`, `inputs`, `outputs`, `trigger`,
`lane`, `requires` (guard-attachment keys only, e.g. `guard.groundedness`, `guard.phi` — NOT
tool bindings), `idempotent`, `schemaVersion`, `evalGate?`. None of these is a tool/MCP-server
reference. Confirmed by grep: no `tool`/`mcp` field anywhere in this interface or in the
`agent.*` entries themselves (only comment-level references explaining that each `agent.*`
entry delegates to a Python interpreter activity, `node-registry.ts:901-916`).

Checked the two most recent, most relevant tickets for any planned tool-binding work on nodes:
`docs/implementation/TASK-809-Workflow-Node-Contract/README.md` (the ticket that literally
defined the current `WorkflowNodeDescriptor` shape) and
`docs/implementation/TASK-806-Consultation-Workflow-Substrate-Unification/README.md` — **zero**
mentions of `mcp` or tool-calling in either.

**Conclusion: today, an "agent node" placed on a workflow-studio graph has no mechanism —
schema, UI, or runtime — to be given MCP tools to call.** The one MCP tool call that exists
(`validate_codes`) is entirely outside the workflow-studio node/graph system: it's a hardcoded
step inside the (older, pre-`workflow-contract`) `ConsultationLoopWorkflow`'s Python
`workflows.py`, unrelated to any node the tenant can see or configure in the graph editor.

---

## F. Credentials / auth for an outbound MCP connector

**Storage model exists and is real, gateway-mediated, and matches the platform's Vault
posture.**

- `McpServer.authRef` (`mcp-server.prisma:49-52`) is a **Vault PATH only** (e.g.
  `"secret/data/mcp/terminology"`), never secret bytes — enforced at the DTO layer
  (`create-mcp-server.request.ts:40-45`: `@Matches(/^[^\s]+$/, ...)` plus the doc comment
  banning whitespace/secret-shaped values).
- Resolution flow (the actual credential is fetched, never persisted, on each call):
  1. Harness worker calls `GET /internal/harness/mcp-token?authRef=...` —
     `apps/api/src/modules/consultation/harness-internal.controller.ts:461-468`.
  2. Gateway service `HarnessInternalService.resolveMcpToken(authRef)` —
     `packages/applications/src/services/consultation/harness/harness-internal.service.ts:280-299`
     — **allowlists** the ref against registered, ENABLED `McpServer` rows scoped to the
     SYSTEM tenant only (`findAll({ where: { tenantId: SYSTEM_TENANT_ID } })`, `:286`) before
     calling `this.secretsService.getSecret(authRef)` (`:292`). An unregistered/disabled ref,
     an unwired backend, or any failure returns `null` (never throws, never logs the secret;
     `:294-298`).
  3. `apps/harness/src/harness/temporal/activities.py:_resolve_mcp_token` (`:722-747`) calls
     that gateway endpoint from INSIDE the activity, uses the token only as the `Authorization`
     bearer header on the MCP call, and discards it — explicitly never put into workflow
     state, activity inputs, or Temporal heartbeats (Temporal history is durable storage).
  4. **The harness deliberately has NO Vault client of its own** — by design, so secret
     material never crosses into the Python worker process's own storage boundary
     (`harness-internal.service.ts:262-263`, `mcp_client.py` module doc `:8-11`).

**Config tier, per `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers:**
- The `authRef` VALUE itself is `db-config` (non-secret per-tenant/per-SYSTEM-row config,
  living in the `McpServer` table).
- The credential it POINTS TO is `vault-kv` (or, precisely, whatever `SecretsService.getSecret`
  resolves — a Vault kv-v2-backed secret), matching the tier's rule: *"Never put a credential in
  a DB column in plaintext... Storage credentials live in Vault behind a `credentialsRef`."* This
  is exactly that pattern, just for MCP server bearer tokens instead of storage credentials.
- No `env`-tier fallback exists for MCP credentials (no `MCP_*_TOKEN` env var anywhere in the
  repo) — consistent with the "no hardcoded configuration" owner rule.

---

## G. Related tickets (docs/implementation grep for "MCP")

No ticket directory is named for MCP itself; the registry/runtime landed inside broader
tickets. Ordered by relevance:

- **TASK-731 — Palette-Consultation** (`docs/implementation/TASK-731-Palette-Consultation/README.md`)
  is the most detailed record of the runtime wiring: cites `_select_mcp_server`
  (`workflows.py:199-209`), the `"1a) MCP terminology validation"` call site
  (`workflows.py:633-662`), the `workflow.patched("task-516-mcp-tools")` opt-in gate, and the
  degrade-only contract (`README.md:375-384`). Confirms the feature is **opt-in and
  non-gating** — a failed/blocked MCP call degrades assurance, never blocks the clinical loop.
- **TASK-712 — Consent-Abac** (`docs/implementation/TASK-712-Consent-Abac/README.md`) added
  the consent gate (step 0.5) in front of the pre-existing `call_mcp_tool` activity
  (`README.md:27`, `:45`, `:152`, `:564-573`, Change History entry `:1564` — "Pass 3" dated
  2026-08-16, describing the consent-gating build in detail). This is downstream of the
  original registry build, not the origin ticket.
- The Prisma model's header comment attributes the registry to **"Agentic SOTA Program, Phase
  5"** (`mcp-server.prisma:2`) — no matching `docs/implementation/TASK-*` directory name was
  found; `git log --diff-filter=A -- packages/database/src/prisma/db_main/mcp-server.prisma`
  shows it was added in a commit titled *"feat(admin-console, api): add agentic policy
  management features"* whose message has had its ticket number scrubbed (repo convention
  post-release-cleanup — see `.claude/rules/05-nestjs-api.md`'s note on `AUTH-NOTE` markers
  having ticket ids removed). **UNKNOWN** exact origin ticket number.
- **TASK-806 / TASK-809** (workflow-contract node registry / node contract) — checked
  explicitly for any planned tool-binding on `agent.*` nodes; **zero** mentions of MCP or
  tool-calling in either README (§E above). No roadmap ticket currently addresses the gap this
  audit identifies.
- No ticket discusses making the MCP registry tenant-admin-writable; the design intent
  documented at the time (`mcp-server.prisma:10-17`, controller/service doc-comments) is
  explicitly SYSTEM/super-admin-only "initially" — implying it was anticipated as a future
  widening, but no ticket currently plans it.

---

## Summary answers (return contract)

**A. WHAT EXISTS**: A real, tested, full-CRUD admin screen
(`apps/admin-console/src/features/tools-mcp/`) backed by a real Prisma model (`McpServer`,
`packages/database/src/prisma/db_main/mcp-server.prisma:31-79`) and a real gateway surface
(`apps/api/src/modules/mcp-admin/mcp-admin.controller.ts`, 5 routes under
`/admin/mcp-servers`). A real MCP protocol client also exists
(`apps/harness/src/harness/tools/mcp_client.py`) and is wired to exactly one hardcoded tool
call (`validate_codes`) inside one Temporal workflow.

**B. TIER CONFLICT**: Screen is `(global)`/tier 10-19, gated three times over (route group,
UI component, service `assertSuperAdmin()`) plus a fourth gate on the platform-wide
`HarnessPolicy.mcpToolsEnabled` switch. Seeded tenant-admin roles already hold
`manage:McpServer` in CASL but are overridden by the imperative check — `.claude/rules/05-nestjs-api.md:46`
lists "MCP writes" by name as a deliberate super-admin-only exception. 4 independent gates
would need explicit re-scoping to satisfy the requirement.

**C. RUNTIME VERDICT**: **Yes** — real MCP protocol (streamable-HTTP, official `mcp` Python
SDK) is spoken, but only from one Temporal activity (`call_mcp_tool`,
`apps/harness/src/harness/temporal/activities.py:1033`) for one hardcoded tool name. It is
feature-flagged off by default at two levels (`HarnessPolicy.mcpToolsEnabled` AND
`McpServer.enabled`). Provider-level "function calling" in `apps/text` is narrower than a
general passthrough — it exists only as a JSON-schema-forcing trick in the Bedrock provider,
not as agent tool exposure.

**D. TOOL EXECUTION VERDICT**: The `call_mcp_tool` Temporal activity is the only thing that
executes an MCP tool call, and it runs a single hardcoded tool chosen deterministically by
workflow code — never by an LLM/agent decision. A separate, unrelated "live tool registry"
(`live-tool-registry.ts`) runs internal NLP/guardrail steps for the live-flush pipeline and
explicitly documents that it is NOT model-initiated tool-calling.

**E. GAP TABLE**:

| Requirement | Current state | Missing component |
|---|---|---|
| Tenant admin configures MCP connectors | Super-admin-only at 3 layers (route/UI/service) despite tenant admins already holding the CASL grant | Re-scope `assertSuperAdmin()` in `McpServerAdminService` to allow a tenant admin to write rows where `tenantId === caller's own tenant`; move the screen out of `(global)` into a tier that tenant admins can reach (e.g. 30-49) or dual-render it in both tiers like the `20-29` shared-audience pattern |
| Tools = functions an agent can call, tenant-configured | `McpServer.toolAllowlist` exists (JSON array of tool ids) but is populated by hand-typed strings in the admin form (`mcp-server-form-dialog.tsx`), not discovered from the live server | No `tools/list` MCP discovery call anywhere — the client only ever calls `session.call_tool`, never lists a server's advertised tools; the allowlist is authored blind |
| Agent nodes given tools to call | `agent.*` node types exist in `WORKFLOW_NODE_REGISTRY` but `WorkflowNodeDescriptor` has no tool/MCP field; the one live MCP call is hardcoded outside the node/graph system entirely | A `tools`/`mcpServerRefs` field on `WorkflowNodeDescriptor` (or a per-node-instance config schema field, following the `configSchema` precedent) plus an interpreter dispatch path (`registry.py`) that turns it into `call_mcp_tool` invocations, replacing the single hardcoded `MCP_TERMINOLOGY_TOOL` call site |
| One screen for connectors AND tools | One screen exists for connectors (with a bolted-on `toolAllowlist` string field) but there is no "Tools" concept independent of a connector (no `ToolDefinition` model, no per-tool metadata beyond a bare string in a JSON array) | A first-class tool catalogue (discovered from `tools/list` and/or hand-registered) distinct from the connector row, so a tool can be assigned to an agent node without re-typing its id |

**F. THE 3 SMALLEST ADDITIONS** to make a tenant-configurable MCP connector real, ordered by
leverage:

1. **Loosen the imperative gate, own-tenant only.** In
   `packages/applications/src/services/mcp-server/mcp-server-admin.service.ts`, replace the
   unconditional `this.assertSuperAdmin()` in `create`/`update`/`remove` with a check that
   allows the call when `(scopedTenantId === this.tenantId && caller holds manage:McpServer)`,
   still requiring `isSuperAdmin()` only when `scopedTenantId` differs from the caller's own
   tenant (i.e., only cross-tenant / SYSTEM-registry writes stay super-admin-only). This is a
   ~10-line change to one file and immediately makes the existing screen, existing DTOs,
   existing OCC machinery, and existing tests (mostly) usable by a tenant admin once the next
   two items land.
2. **Move (or dual-render) the screen out of `(global)`.** Relocate
   `apps/admin-console/src/app/(console)/(global)/tools-mcp/` to a `30-49` tenant-scoped route
   (mirroring the `WorkingTenantGate` pattern documented in `.claude/rules/13-nextjs-apps.md`
   §Routing "Sub-pattern") or duplicate the nav entry into a `20-29` shared-audience slot per
   `.claude/rules/12-design-workflow.md` §3, and drop the `isElevated`-only branch in
   `tools-mcp-screen.tsx:66-91` in favor of a tenant-scoped read (the client already supports
   `?tenantId=` server-side; the frontend `client.ts` currently never sends it — add it, or
   default to the caller's own tenant when a tenant admin is signed in).
3. **Give the platform-wide `HarnessPolicy.mcpToolsEnabled` switch a tenant-admin-reachable
   companion, or explicitly re-affirm it stays super-admin-only.** Whichever direction is
   chosen, it must be a deliberate decision (not a silent side effect) because
   `harness-policy.service.ts:182-183` already documents the *current* reasoning ("MCP calls
   OUT of the platform boundary, so arming it is super-admin governance") — a tenant-configured
   connector that a tenant admin cannot ever arm is a screen with no effect, so this decision
   has to be made explicitly alongside items 1-2, not deferred.

Everything beyond these three (tools/list discovery, a first-class Tool model, agent-node tool
binding in `WorkflowNodeDescriptor` + the Python interpreter dispatch) is real, separately
scoped follow-on work — not part of "make the connector real," which is what was asked.

---

## UNKNOWNs

- Exact origin ticket number for the `McpServer` model / `McpAdminController` (git history has
  the ticket id scrubbed from the commit message per repo convention).
- Whether an `MCP tools/list` discovery call was ever prototyped and removed — grep found no
  trace of it in current source or git log search terms tried (`tools/list`, `list_tools`,
  `ListTools`).
- Whether product intends the master `HarnessPolicy.mcpToolsEnabled` switch to remain
  platform-governed under the new requirement — not stated anywhere in code or docs; flagged
  as a decision point in §F item 3 rather than guessed.
